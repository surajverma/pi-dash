import json
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch

import pi_dash.app as proxy
from pi_dash import config as settings, cache, pihole as pihole_api, aggregate
from pi_dash.aggregate import combine_history, combine_rankings, device_view, RANK_LIMIT


class AggregateTests(unittest.TestCase):
    def test_device_units_and_nullable_readings(self):
        view = device_view({'system': {'system': {'cpu': {'%cpu': 180, 'nprocs': 4},
                            'memory': {'ram': {'%used': 38}}, 'uptime': 100}},
                            'sensors': {'sensors': {'cpu_temp': None}}})
        self.assertEqual(view['cpu_percent'], 45)
        self.assertEqual(view['ram_percent'], 38)
        self.assertEqual(view['uptime_seconds'], 100)
        self.assertIsNone(view['temperature'])
        self.assertIsNone(device_view({'system': {'system': {'cpu': {'%cpu': -1, 'nprocs': 4}}}})['cpu_percent'])
        self.assertIsNone(device_view({})['ram_percent'])

    def test_client_identity_uses_address_and_canonicalizes_ipv6(self):
        snapshots = {
            'One': {'clients': {'total_queries': 100, 'clients': [
                {'ip': '2001:0db8::1', 'name': 'Computer', 'count': 40},
                {'ip': '192.0.2.1', 'name': 'Same name', 'count': 10}]}},
            'Two': {'clients': {'total_queries': 100, 'clients': [
                {'ip': '2001:db8::1', 'name': None, 'count': 35},
                {'ip': '192.0.2.2', 'name': 'Same name', 'count': 20}]}}}
        result = combine_rankings(snapshots, 'clients', 2)
        self.assertEqual(len(result['items']), 3)
        self.assertEqual(result['items'][0]['count'], 75)
        self.assertEqual(result['items'][0]['share'], 37.5)
        self.assertFalse(result['partial'])

    def test_domains_merge_before_selecting_five_and_mark_privacy_partial(self):
        rows = [{'domain': f'local-{i}.test', 'count': 10-i} for i in range(5)]
        rows.append({'domain': 'Common.TEST.', 'count': 6})
        snapshots = {'One': {'domains': {'blocked_queries': 100, 'domains': rows}},
                     'Two': {'domains': {'blocked_queries': 100, 'domains': [{'domain': 'common.test', 'count': 9}]}},
                     'Private': {'domains': {'blocked_queries': -1, 'domains': []}}}
        result = combine_rankings(snapshots, 'domains', 3)
        self.assertEqual(result['items'][0]['id'], 'common.test')
        self.assertEqual(result['items'][0]['count'], 15)
        self.assertEqual(result['contributors'], 2)
        self.assertTrue(result['partial'])
        limited = {'One': {'domains': {'blocked_queries': RANK_LIMIT, 'domains': [{'domain': str(i), 'count': 1} for i in range(RANK_LIMIT)]}}}
        self.assertFalse(combine_rankings(limited, 'domains', 1)['limited'])

    def ranking_source(self, rows, threshold=None, prefix='tail'):
        rows = [{'domain': name, 'count': count} for name, count in rows]
        if threshold is not None:
            rows += [{'domain': f'{prefix}-{i}.test', 'count': threshold} for i in range(RANK_LIMIT - len(rows))]
        return {'domains': {'blocked_queries': sum(row['count'] for row in rows), 'domains': rows}}

    def test_single_instance_at_limit_is_exact(self):
        result = combine_rankings({'One': self.ranking_source([(f'top-{i}', 100-i) for i in range(5)], 1)}, 'domains', 1)
        self.assertFalse(result['limited'])
        self.assertFalse(result['partial'])
        self.assertTrue(all(not row['approximate'] for row in result['items']))

    def test_two_truncated_sources_with_clear_top_five_are_exact(self):
        top = [(f'top-{i}', 1000-i*100) for i in range(5)]
        result = combine_rankings({'One': self.ranking_source(top, 10, 'one'),
                                   'Two': self.ranking_source(top, 10, 'two')}, 'domains', 2)
        self.assertFalse(result['limited'])
        self.assertFalse(result['partial'])
        self.assertEqual([row['id'] for row in result['items']], [name for name, _ in top])

    def test_cut_off_candidate_could_overtake_fifth(self):
        top = [(f'top-{i}', count) for i, count in enumerate((500, 450, 400, 350, 50))]
        result = combine_rankings({'One': self.ranking_source(top + [('challenger', 99)], 1, 'one'),
                                   'Two': self.ranking_source(top, 10, 'two')}, 'domains', 2)
        self.assertTrue(result['limited'])
        self.assertFalse(result['partial'], 'All sources are reporting; only the ordering is uncertain')

    def test_offline_instance_is_partial_but_not_limited(self):
        result = combine_rankings({'One': self.ranking_source([(f'top-{i}', 100-i) for i in range(5)], 10)}, 'domains', 2)
        self.assertTrue(result['partial'])
        self.assertFalse(result['limited'])

    def test_mixed_sources_mark_understated_counts_without_uncertain_top_five(self):
        top = [(f'top-{i}', 1000-i*100) for i in range(4)]
        result = combine_rankings({'One': self.ranking_source(top, 1),
                                   'Two': self.ranking_source(top + [('only-two', 200)])}, 'domains', 2)
        self.assertFalse(result['limited'])
        self.assertFalse(result['partial'])
        self.assertTrue(result['items'][4]['approximate'])
        self.assertEqual(result['items'][4]['count'], 200)
        self.assertTrue(all(not row['approximate'] for row in result['items'][:4]))

    def test_never_seen_candidate_bound_and_equal_cutoff(self):
        top = [(f'top-{i}', 10) for i in range(5)]
        result = combine_rankings({'One': self.ranking_source(top, 10, 'one'),
                                   'Two': self.ranking_source([], 15, 'two')}, 'domains', 2)
        self.assertTrue(result['limited'], 'A never-seen item may have up to 25 queries')
        result = combine_rankings({'One': self.ranking_source(top, 10, 'one'),
                                   'Two': self.ranking_source(top, 10, 'two')}, 'domains', 2)
        self.assertFalse(result['limited'], 'A tie at the cutoff meets the requested bound')

    def test_fewer_than_five_complete_items_are_exact(self):
        result = combine_rankings({'One': self.ranking_source([('one', 10)]),
                                   'Two': self.ranking_source([('two', 5)])}, 'domains', 2)
        self.assertFalse(result['limited'])
        self.assertEqual(len(result['items']), 2)

    def test_history_aligns_timestamps_and_preserves_missing_coverage(self):
        snapshots = {'One': {'history': {'history': [{'timestamp': 1200, 'total': 10, 'blocked': 2}, {'timestamp': 1800, 'total': 20, 'blocked': 3}]}},
                     'Two': {'history': {'history': [{'timestamp': 1200.5, 'total': 5, 'blocked': 1}]}}}
        result = combine_history(snapshots, 2)
        self.assertEqual(result['points'][0]['total'], 15)
        self.assertEqual(result['points'][0]['blocked'], 3)
        self.assertEqual(result['points'][1]['contributors'], 1)
        self.assertTrue(result['partial'])


class OptionalRouteTests(unittest.TestCase):
    def setUp(self):
        self.original = settings.config
        settings.config = {'piholes': [{'name': 'One', 'address': 'https://test.invalid', 'password': 'secret'}]}
        cache._optional_cache.clear()

    def tearDown(self):
        settings.config = self.original
        cache._optional_cache.clear()

    def test_disabled_routes_do_not_contact_piholes(self):
        settings.config.update(show_device_metrics=False, show_network_insights=False)
        with proxy.app.test_client() as client, patch.object(pihole_api, 'pihole_get') as fetch:
            for path in ('/devices', '/insights'):
                self.assertEqual(client.get(path).headers['Cache-Control'], 'no-store')
            fetch.assert_not_called()

    def test_missing_flags_preserve_simple_defaults(self):
        cfg = settings.filtered_config()
        self.assertTrue(cfg['show_network_summary'])
        self.assertFalse(cfg['show_network_insights'])
        self.assertTrue(cfg['show_device_metrics'])
        self.assertNotIn('show_unique_domains', cfg)
        with proxy.app.test_client() as client, patch.object(cache, 'fetch_optional', return_value={'devices': {}}) as fetch:
            self.assertTrue(client.get('/insights').get_json()['disabled'])
            fetch.assert_not_called()
            self.assertEqual(client.get('/devices').status_code, 200)
            fetch.assert_called_once_with('devices')
        settings.config.update(show_network_summary=False, show_network_insights=True)
        with proxy.app.test_client() as client, patch.object(cache, 'fetch_optional') as fetch:
            self.assertTrue(client.get('/insights').get_json()['disabled'])
            fetch.assert_not_called()

    def test_vector_sources_and_transparent_png_export_sizes(self):
        import pathlib
        import struct
        import xml.etree.ElementTree as ET
        icons = pathlib.Path(settings.WEB_ROOT) / 'icons'
        for name in ('icon.svg', 'favicon.svg'):
            svg = ET.parse(icons / name).getroot()
            self.assertEqual(svg.attrib['viewBox'], '0 0 512 512')
            self.assertFalse(any(node.tag.endswith(('image', 'filter')) for node in svg.iter()))
        for size in (16, 32, 180, 192, 512):
            png = (icons / ('apple-touch-icon.png' if size == 180 else f'icon-{size}.png')).read_bytes()
            self.assertEqual(struct.unpack('>II', png[16:24]), (size, size))
            self.assertEqual(png[25], 6, 'PNG must retain RGBA transparency')

    def test_optional_failure_is_partial_and_cache_coalesces_requests(self):
        class Response:
            def json(self):
                return {'system': {'uptime': 100}}
        def read(pihole, path, **kwargs):
            if path.endswith('system'):
                return Response()
            raise pihole_api.requests.exceptions.Timeout('timeout')
        with patch.object(pihole_api, 'pihole_get', side_effect=read) as fetch:
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: cache.fetch_optional('devices'), range(2)))
            self.assertEqual(fetch.call_count, 2)
            fresh = next(result for result in results if not result.get('refreshing'))
            self.assertEqual(fresh['devices']['One']['uptime_seconds'], 100)
            self.assertEqual(fresh['devices']['One']['unavailable'], ['sensors'])
            self.assertNotIn('secret', json.dumps(results[0]))

    def test_init_does_not_wait_for_optional_metrics(self):
        with proxy.app.test_client() as client, patch.object(cache, 'fetch_stats', return_value={}), patch.object(cache, 'fetch_optional') as optional:
            self.assertEqual(client.get('/init').status_code, 200)
            optional.assert_not_called()

    def test_parallel_auth_and_401_share_one_replacement_session(self):
        pihole = settings.config['piholes'][0]
        entered, release = Event(), Event()
        pihole_api.pihole_sessions.pop('One', None)

        def auth(_):
            entered.set()
            release.wait(3)
            return 'fresh'
        with patch.object(pihole_api, 'authenticate_and_get_sid', side_effect=auth) as fetch:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(pihole_api.get_sid, pihole)
                self.assertTrue(entered.wait(2))
                second = pool.submit(pihole_api.get_sid, pihole)
                release.set()
                self.assertEqual(first.result(3), second.result(3))
            self.assertEqual(pihole_api.get_sid(pihole, True, expired_sid='old'), 'fresh')
            self.assertEqual(fetch.call_count, 1)
        pihole_api.pihole_sessions.pop('One', None)

    def test_auth_timeout_is_shared_without_changing_its_error_type(self):
        pihole = {'name': 'Timeout', 'address': 'https://timeout.invalid'}
        with patch.object(pihole_api, 'authenticate_and_get_sid', side_effect=pihole_api.requests.exceptions.Timeout('unreachable')) as auth:
            for _ in range(3):
                with self.assertRaises(pihole_api.requests.exceptions.Timeout):
                    pihole_api.get_sid(pihole)
            self.assertEqual(auth.call_count, 1)
        pihole_api._auth_failures.pop('Timeout', None)

    def test_local_icons_manifest_and_subpath_assets(self):
        # Import with a temporary, in-memory subpath config in an isolated process.
        script = '''
import builtins, io, json
original = builtins.open
def read(path, *args, **kwargs):
    if str(path).endswith('config.json'):
        return io.StringIO(json.dumps({'base_path':'/dash/', 'piholes':[]}))
    return original(path, *args, **kwargs)
builtins.open = read
import pi_dash.app as proxy
from pi_dash import config as settings, cache, pihole as pihole_api, aggregate
with proxy.app.test_client() as client:
    manifest = client.get('/dash/manifest.json').get_json()
    assert manifest['id'] == manifest['scope'] == manifest['start_url'] == '/dash/'
    for icon in manifest['icons']:
        response = client.get('/dash/' + icon['src'])
        assert response.status_code == 200
        assert response.data[:8] == b'\\x89PNG\\r\\n\\x1a\\n'
    html = client.get('/dash/').get_data(as_text=True)
    assert '<base href="/dash/">' in html
    assert client.get('/dash/js/theme.js').status_code == 200
    assert client.get('/dash/icons/apple-touch-icon.png').status_code == 200
    sw = client.get('/dash/sw.js').get_data(as_text=True)
    assert '{{CACHE_URL}}' not in sw
    assert "'devices', 'insights'" in sw
'''
        result = subprocess.run([sys.executable, '-c', script], cwd=settings.APP_ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
