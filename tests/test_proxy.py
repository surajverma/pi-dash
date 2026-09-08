import os
import unittest
from unittest.mock import patch

os.environ.setdefault('PIHOLE_PRIMARY_PASSWORD', 'test-secret')

import proxy


class ConfigCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.original = proxy.config

    def tearDown(self):
        proxy.config = self.original

    def test_query_interval_inherits_existing_refresh_interval(self):
        proxy.config = {'refresh_interval': 1234, 'piholes': []}
        self.assertEqual(proxy.get_refresh_interval(), 1234)
        self.assertEqual(proxy.get_queries_refresh_interval(), 1234)

    def test_code_defaults_work_without_optional_flags(self):
        proxy.config = {'piholes': []}
        self.assertEqual(proxy.get_refresh_interval(), proxy.DEFAULT_REFRESH_INTERVAL)
        self.assertEqual(proxy.get_queries_refresh_interval(), proxy.DEFAULT_REFRESH_INTERVAL)
        self.assertFalse(proxy.filtered_config()['show_queries'])

    def test_new_query_interval_overrides_old_refresh_interval(self):
        proxy.config = {'refresh_interval': 2000, 'queries_refresh_interval': 3000, 'piholes': []}
        self.assertEqual(proxy.get_queries_refresh_interval(), 3000)

    def test_default_cache_never_exceeds_half_fastest_poll(self):
        proxy.config = {'refresh_interval': 1000, 'queries_refresh_interval': 3000, 'piholes': []}
        self.assertLessEqual(proxy.get_cache_ttl(), 500)

    def test_zero_enabled_piholes_is_valid(self):
        proxy.config = {'piholes': [{'name': 'Off', 'enabled': False}]}
        self.assertEqual(proxy._stats_uncached(), {})
        self.assertEqual(proxy._queries_uncached(50), {})

    def test_environment_secret_resolution(self):
        os.environ['PI_DASH_TEST_SECRET'] = 'resolved'
        self.assertEqual(proxy.resolve_secret('${PI_DASH_TEST_SECRET}'), 'resolved')
        self.assertEqual(proxy.resolve_secret('plain'), 'plain')


class SummaryTests(unittest.TestCase):
    def test_network_summary_only_aggregates_safe_metrics(self):
        data = {
            'one': {
                'queries': {'total': 100, 'blocked': 10, 'cached': 60, 'forwarded': 40},
                '_pi_dash': {'health': 'healthy'},
            },
            'two': {
                'queries': {'total': 50, 'blocked': 15, 'cached': 20, 'forwarded': 30},
                '_pi_dash': {'health': 'slow'},
            },
            'three': {'error': 'offline', '_pi_dash': {'health': 'unreachable'}},
        }
        result = proxy.network_summary(data)
        self.assertEqual(result['total_queries'], 150)
        self.assertEqual(result['blocked_queries'], 25)
        self.assertEqual(result['percent_blocked'], 16.7)
        self.assertEqual(result['cached_queries'], 80)
        self.assertEqual(result['forwarded_queries'], 70)
        self.assertEqual(result['healthy_instances'], 1)
        self.assertEqual(result['slow_instances'], 1)
        self.assertEqual(result['offline_instances'], 1)
        self.assertNotIn('clients', result)
        self.assertNotIn('unique_domains', result)


class RouteCompatibilityTests(unittest.TestCase):
    def test_legacy_data_shape_is_preserved(self):
        sample = {'Primary': {'queries': {'total': 1}}}
        with proxy.app.test_client() as client, patch.object(proxy, 'fetch_stats', return_value=sample):
            response = client.get('/data')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json(), sample)

    def test_rich_data_shape_is_opt_in(self):
        sample = {'Primary': {'queries': {'total': 10, 'blocked': 2, 'cached': 5, 'forwarded': 5}, '_pi_dash': {'health': 'healthy'}}}
        with proxy.app.test_client() as client, patch.object(proxy, 'fetch_stats', return_value=sample):
            response = client.get('/data?include_summary=true')
            payload = response.get_json()
            self.assertIn('stats', payload)
            self.assertIn('summary', payload)

    def test_health_endpoint_does_not_require_pihole_access(self):
        with proxy.app.test_client() as client:
            response = client.get('/health')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()['status'], 'ok')


if __name__ == '__main__':
    unittest.main()
