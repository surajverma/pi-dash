import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch
import pi_dash.app as proxy
from pi_dash import config as settings, cache, pihole as pihole_api, aggregate


class OptionalConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.original = settings.config
        settings.config = {'piholes': [{'name': 'One', 'address': 'https://example.invalid'}], 'show_network_insights': True}
        cache._optional_cache.clear()

    def tearDown(self):
        settings.config = self.original
        cache._optional_cache.clear()

    def test_four_web_threads_leave_live_stats_available_during_two_slow_refreshes(self):
        entered = {kind: Event() for kind in ('devices', 'insights')}
        release = Event()
        def slow(pihole, path, **kwargs):
            entered['devices' if '/info/' in path else 'insights'].set()
            release.wait(5)
            raise pihole_api.requests.exceptions.Timeout('fake slow Pi-hole')
        def request(path):
            with proxy.app.test_client() as client:
                response = client.get(path)
                return response.status_code, response.get_json()
        with patch.object(pihole_api, 'pihole_get', side_effect=slow), patch.object(cache, 'fetch_stats', return_value={'One': {'queries': {'total': 1}}}):
            with ThreadPoolExecutor(max_workers=4) as workers:
                owners = [workers.submit(request, '/'+kind) for kind in entered]
                try:
                    self.assertTrue(all(event.wait(2) for event in entered.values()))
                    followers = [workers.submit(request, '/'+kind) for _ in range(3) for kind in entered]
                    stats = workers.submit(request, '/data')
                    self.assertEqual(stats.result(timeout=1)[0], 200)
                    self.assertFalse(release.is_set(), 'Live stats must finish before slow upstreams are released')
                    for follower in followers:
                        self.assertTrue(follower.result(timeout=1)[1]['refreshing'])
                finally:
                    release.set()
                for owner in owners:
                    self.assertEqual(owner.result(timeout=2)[0], 200)

    def test_waiters_receive_stale_cache_instead_of_waiting(self):
        previous = {'devices': {'One': {'uptime_seconds': 17}}, 'updated_at': 100}
        cache._optional_cache['devices'] = {'time': 0, 'data': previous}
        lock = cache._optional_locks['devices']
        lock.acquire()
        try:
            payload = cache.fetch_optional('devices')
            self.assertEqual(payload['devices'], previous['devices'])
            self.assertTrue(payload['stale'])
            self.assertTrue(payload['refreshing'])
            self.assertEqual(previous, cache._optional_cache['devices']['data'])
        finally:
            lock.release()

    def test_malformed_replies_are_cached_and_do_not_refetch(self):
        class BadReply:
            def json(self):
                return {'system': {'cpu': [], 'memory': 'bad'}, 'sensors': {'cpu_temp': None},
                        'history': [None, 'bad', {'timestamp': None}], 'clients': [None],
                        'domains': ['bad'], 'total_queries': '100', 'blocked_queries': 20}
        with patch.object(pihole_api, 'pihole_get', return_value=BadReply()) as fetch:
            for kind in ('devices', 'insights'):
                first = cache.fetch_optional(kind)
                self.assertEqual(first, cache.fetch_optional(kind))
            self.assertEqual(fetch.call_count, 5)

    def test_normalization_failure_still_obeys_backoff(self):
        real = cache.device_view
        def malformed(data):
            if data:
                raise ValueError('malformed nested metrics')
            return real(data)
        class Reply:
            def json(self):
                return {'system': {}, 'sensors': {}}
        with patch.object(cache, 'device_view', side_effect=malformed), patch.object(pihole_api, 'pihole_get', return_value=Reply()) as fetch:
            first = cache.fetch_optional('devices')
            self.assertEqual(first, cache.fetch_optional('devices'))
            self.assertEqual(fetch.call_count, 2)

    def test_recovery_expires_failed_optional_cache(self):
        previous = cache._stats_cache.copy()
        cache._stats_cache['data'] = {'One': {'error': 'offline'}}
        cache._optional_cache['devices'] = {'time': time.monotonic(), 'data': {}}
        class Reply:
            def json(self):
                return {'queries': {'total': 1}}
        try:
            with patch.object(pihole_api, 'pihole_get', return_value=Reply()), patch.object(cache, 'get_blocking', return_value=True):
                cache.fetch_one(settings.config['piholes'][0])
            self.assertEqual(cache._optional_cache['devices']['time'], 0)
        finally:
            cache._stats_cache.update(previous)
