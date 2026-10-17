import unittest
from unittest.mock import patch
import requests

import pi_dash.app as routes
from pi_dash import cache, pihole


class ErrorPrivacyTests(unittest.TestCase):
    detail = 'https://private-pihole.example:8443/api/auth?secret=hidden'

    def failures(self):
        response = requests.Response()
        response.status_code = 401
        return [(requests.exceptions.ConnectionError(self.detail), 'Pi-hole unreachable', 'unreachable'),
                (requests.exceptions.HTTPError(self.detail, response=response), 'Authentication failed', 'auth_error'),
                (RuntimeError(self.detail), 'Authentication failed', 'auth_error'),
                (ValueError(self.detail), 'Pi-hole unreachable', 'unreachable')]

    def test_stats_errors_hide_details_but_log_full_exception_and_preserve_health(self):
        for error, message, health in self.failures():
            with self.subTest(error=type(error)), patch.object(pihole, 'pihole_get', side_effect=error), \
                    self.assertLogs(cache.logger, level='ERROR') as logs:
                _, data = cache.fetch_one({'name': 'One', 'address': 'https://private-pihole.example'})
            self.assertEqual(data, {'error': message, '_pi_dash': {'health': health}})
            self.assertIn(self.detail, '\n'.join(logs.output))
            self.assertNotIn(self.detail, str(data))

    def test_api_errors_hide_details_and_log_full_exception(self):
        for path, fetch in (('/init', 'fetch_stats'), ('/data', 'fetch_stats'), ('/queries', 'fetch_queries')):
            for error, message, _ in self.failures():
                if isinstance(error, (RuntimeError, ValueError)):
                    message = 'Internal error'
                with self.subTest(path=path, error=type(error)), routes.app.test_client() as client, \
                        patch.object(cache, fetch, side_effect=error), self.assertLogs(routes.app.logger, level='ERROR') as logs:
                    response = client.get(path)
                self.assertEqual(response.status_code, 500)
                self.assertEqual(response.get_json(), {'error': message})
                self.assertNotIn(self.detail, response.get_data(as_text=True))
                self.assertIn(self.detail, '\n'.join(logs.output))
