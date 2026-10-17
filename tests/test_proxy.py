import json
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch

os.environ.setdefault('PIHOLE_PRIMARY_PASSWORD', 'test-secret')
import pi_dash.app as proxy
from pi_dash import config as settings, cache, pihole as pihole_api, aggregate


class ConfigCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.original = settings.config

    def tearDown(self):
        settings.config = self.original

    def test_old_query_interval_inherits_refresh(self):
        settings.config = {'refresh_interval': 1234, 'piholes': []}
        self.assertEqual(settings.get_refresh_interval(), 1234)
        self.assertEqual(settings.get_queries_refresh_interval(), 1234)

    def test_code_defaults_without_optional_flags(self):
        settings.config = {'piholes': []}
        self.assertEqual(settings.get_refresh_interval(), 5000)
        self.assertEqual(settings.get_queries_refresh_interval(), 5000)
        self.assertFalse(settings.filtered_config()['show_queries'])
        self.assertTrue(settings.filtered_config()['show_network_summary'])
        self.assertTrue(settings.filtered_config()['show_trends'])

    def test_new_query_interval_overrides_old(self):
        settings.config = {'refresh_interval': 2000, 'queries_refresh_interval': 3000, 'piholes': []}
        self.assertEqual(settings.get_queries_refresh_interval(), 3000)

    def test_default_cache_and_explicit_disable(self):
        settings.config = {'refresh_interval': 1000, 'queries_refresh_interval': 3000, 'piholes': []}
        self.assertEqual(settings.get_cache_ttl(), 500)
        settings.config['cache_ttl'] = 0
        self.assertEqual(settings.get_cache_ttl(), 0)

    def test_zero_enabled_piholes(self):
        settings.config = {'piholes': [{'name': 'Off', 'enabled': False}]}
        self.assertEqual(cache._stats_uncached(), {})
        self.assertEqual(cache._queries_uncached(50), {})

    def test_environment_secret_and_tls_compatibility(self):
        with patch.dict(os.environ, {'PI_DASH_TEST_SECRET': 'resolved'}):
            self.assertEqual(settings.resolve_secret('${PI_DASH_TEST_SECRET}'), 'resolved')
            self.assertEqual(settings.resolve_secret('plain'), 'plain')
            self.assertEqual(settings.get_verify_setting({'verify_ssl': '${PI_DASH_TEST_SECRET}'}), 'resolved')
        self.assertFalse(settings.get_verify_setting({}))
        self.assertTrue(settings.get_verify_setting({'verify_ssl': True}))

    def test_example_is_valid_json_and_comments_are_ignored(self):
        with open(os.path.join(settings.APP_ROOT, 'config-example.json'), encoding='utf-8') as handle:
            example = json.load(handle)
        self.assertNotIn('_comment', example)
        self.assertNotIn('_comment', example['piholes'][0])
        # Older configurations may still contain explanatory fields.
        example['_comment'] = 'legacy documentation'
        example['piholes'][0]['_comment'] = 'legacy instance documentation'
        settings.config = example
        filtered = settings.filtered_config()
        self.assertNotIn('_comment', filtered)
        self.assertTrue(filtered['piholes'])
        self.assertNotIn('password', filtered['piholes'][0])
        self.assertNotIn('_comment', filtered['piholes'][0])


class BlockingAndSummaryTests(unittest.TestCase):
    def test_blocking_states(self):
        self.assertTrue(cache.normalize_blocking('enabled'))
        self.assertFalse(cache.normalize_blocking('disabled'))
        self.assertTrue(cache.normalize_blocking(True))
        self.assertFalse(cache.normalize_blocking(False))
        self.assertIsNone(cache.normalize_blocking('unexpected'))

    def test_summary_is_partial_and_does_not_sum_unique_values(self):
        data = {
            'one': {'queries': {'total': 100, 'blocked': 10, 'cached': 60, 'forwarded': 40}, '_pi_dash': {'blocking': True}},
            'two': {'queries': {'total': 50, 'blocked': 15, 'cached': 20, 'forwarded': 30}, '_pi_dash': {'blocking': False}},
            'three': {'error': 'offline', '_pi_dash': {'health': 'unreachable'}},
            'four': {'error': 'authentication failed', '_pi_dash': {'health': 'auth_error'}},
        }
        result = aggregate.network_summary(data)
        self.assertEqual(result['total_queries'], 150)
        self.assertEqual(result['blocked_queries'], 25)
        self.assertEqual(result['percent_blocked'], 16.7)
        self.assertEqual(result['cached_queries'], 80)
        self.assertEqual(result['forwarded_queries'], 70)
        self.assertEqual(result['contributing_instances'], 2)
        self.assertEqual(result['healthy_instances'], 1)
        self.assertEqual(result['blocking_disabled_instances'], 1)
        self.assertEqual(result['auth_error_instances'], 1)
        self.assertEqual(result['offline_instances'], 1)
        self.assertTrue(result['partial'])
        self.assertNotIn('clients', result)
        self.assertNotIn('unique_domains', result)
        self.assertNotIn('slow_instances', result)

    def test_unknown_blocking_is_not_reported_healthy(self):
        result = aggregate.network_summary({'one': {'queries': {'total': 0}, '_pi_dash': {'blocking': None}}})
        self.assertEqual(result['healthy_instances'], 0)
        self.assertEqual(result['blocking_unknown_instances'], 1)
        self.assertFalse(result['partial'])

    def test_unreachable_during_initial_auth_is_not_bad_credentials(self):
        with patch.object(pihole_api.requests, 'post', side_effect=pihole_api.requests.exceptions.ConnectionError('connection refused')):
            data = cache.fetch_one({'name': 'Unreachable', 'address': 'http://localhost'})[1]
        self.assertEqual(data['_pi_dash']['health'], 'unreachable')

    def test_http_auth_errors_remain_auth_errors(self):
        for status in (401, 403):
            response = pihole_api.requests.Response()
            response.status_code = status
            error = pihole_api.requests.exceptions.HTTPError(response=response)
            with patch.object(pihole_api, 'pihole_get', side_effect=error):
                data = cache.fetch_one({'name': 'Auth', 'address': 'http://localhost'})[1]
            self.assertEqual(data['_pi_dash']['health'], 'auth_error')

    def test_fetch_one_has_no_latency_metric(self):
        class Response:
            def json(self):
                return {'queries': {'total': 1}}
        with patch.object(pihole_api, 'pihole_get', return_value=Response()), patch.object(cache, 'get_blocking', return_value=True):
            data = cache.fetch_one({'name': 'One', 'address': 'http://localhost'})[1]
        self.assertEqual(data['_pi_dash']['health'], 'healthy')
        self.assertNotIn('latency_ms', data['_pi_dash'])


class BlockingCacheTests(unittest.TestCase):
    class Response:
        def json(self):
            return {'blocking': 'enabled'}

    def setUp(self):
        cache._blocking_cache.clear()
        cache._blocking_locks.clear()

    def tearDown(self):
        cache._blocking_cache.clear()
        cache._blocking_locks.clear()

    def test_distinct_piholes_check_blocking_in_parallel(self):
        entered = {'One': Event(), 'Two': Event()}
        release = Event()

        def slow_get(pihole, path):
            self.assertEqual(path, '/api/dns/blocking')
            entered[pihole['name']].set()
            release.wait(3)
            return self.Response()

        with patch.object(pihole_api, 'pihole_get', side_effect=slow_get):
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [
                    pool.submit(cache.get_blocking, {'name': name, 'address': 'http://localhost'})
                    for name in ('One', 'Two')
                ]
                both_entered = entered['One'].wait(2) and entered['Two'].wait(2)
                release.set()
                values = [future.result(timeout=3) for future in futures]

        self.assertTrue(both_entered)
        self.assertEqual(values, [True, True])

    def test_same_pihole_coalesces_simultaneous_blocking_checks(self):
        entered = Event()
        release = Event()

        def slow_get(_pihole, _path):
            entered.set()
            release.wait(3)
            return self.Response()

        pihole = {'name': 'One', 'address': 'http://localhost'}
        with patch.object(pihole_api, 'pihole_get', side_effect=slow_get) as fetch:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(cache.get_blocking, pihole)
                self.assertTrue(entered.wait(2))
                second = pool.submit(cache.get_blocking, pihole)
                release.set()
                self.assertTrue(first.result(timeout=3))
                self.assertTrue(second.result(timeout=3))

        self.assertEqual(fetch.call_count, 1)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.original = settings.config
        settings.config = {'piholes': [], 'cache_ttl': 1000}
        cache._stats_cache.update(time=0.0, data=None)
        cache._queries_cache.clear()

    def tearDown(self):
        settings.config = self.original
        cache._stats_cache.update(time=0.0, data=None)
        cache._queries_cache.clear()

    def test_stats_cache_reuses_snapshot(self):
        with patch.object(cache, '_stats_uncached', return_value={'one': 1}) as fetch:
            self.assertEqual(cache.fetch_stats(), {'one': 1})
            self.assertEqual(cache.fetch_stats(), {'one': 1})
            self.assertEqual(fetch.call_count, 1)

    def test_query_cache_reuses_snapshot(self):
        with patch.object(cache, '_queries_uncached', return_value={'one': []}) as fetch:
            cache.fetch_queries(50)
            cache.fetch_queries(50)
            self.assertEqual(fetch.call_count, 1)

    def test_simultaneous_stats_requests_share_one_fetch(self):
        entered = Event()
        release = Event()
        def slow_fetch():
            entered.set()
            release.wait(3)
            return {'one': 1}
        with patch.object(cache, '_stats_uncached', side_effect=slow_fetch) as fetch:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(cache.fetch_stats)
                self.assertTrue(entered.wait(3))
                second = pool.submit(cache.fetch_stats)
                release.set()
                self.assertEqual(first.result(timeout=3), second.result(timeout=3))
            self.assertEqual(fetch.call_count, 1)


class RouteCompatibilityTests(unittest.TestCase):
    def test_legacy_data_shape_is_preserved(self):
        sample = {'Primary': {'queries': {'total': 1}}}
        with proxy.app.test_client() as client, patch.object(cache, 'fetch_stats', return_value=sample):
            self.assertEqual(client.get('/data').get_json(), sample)

    def test_rich_data_shape_is_opt_in(self):
        sample = {'Primary': {'queries': {'total': 10, 'blocked': 2}, '_pi_dash': {'blocking': True}}}
        with proxy.app.test_client() as client, patch.object(cache, 'fetch_stats', return_value=sample):
            payload = client.get('/data?include_summary=true').get_json()
            self.assertEqual(payload['stats'], sample)
            self.assertIn('summary', payload)

    def test_query_length_defaults_on_invalid_input(self):
        with proxy.app.test_client() as client, \
                patch.object(cache, 'fetch_stats', return_value={}), \
                patch.object(cache, 'fetch_queries', return_value={}) as fetch:
            self.assertEqual(client.get('/queries?length=invalid').status_code, 200)
            fetch.assert_called_once_with(50)

        with proxy.app.test_client() as client, \
                patch.object(cache, 'fetch_stats', return_value={}), \
                patch.object(cache, 'fetch_queries', return_value={}) as fetch:
            self.assertEqual(client.get('/data?include_queries=true&length=invalid').status_code, 200)
            fetch.assert_called_once_with(50)

    def test_query_length_is_clamped(self):
        cases = (('/queries?length=0', 1), ('/queries?length=999', 200))
        for url, expected in cases:
            with self.subTest(url=url), proxy.app.test_client() as client, \
                    patch.object(cache, 'fetch_queries', return_value={}) as fetch:
                self.assertEqual(client.get(url).status_code, 200)
                fetch.assert_called_once_with(expected)

    def test_health_does_not_contact_piholes(self):
        with proxy.app.test_client() as client, patch.object(cache, 'fetch_stats') as fetch:
            self.assertEqual(client.get('/health').status_code, 200)
            fetch.assert_not_called()

    def test_disabled_queries_do_not_fetch_on_init(self):
        original = settings.config
        try:
            settings.config = {'piholes': [], 'show_queries': False}
            with proxy.app.test_client() as client, patch.object(cache, 'fetch_stats', return_value={}), patch.object(cache, 'fetch_queries') as fetch:
                self.assertEqual(client.get('/init').status_code, 200)
                fetch.assert_not_called()
        finally:
            settings.config = original


if __name__ == '__main__':
    unittest.main()
