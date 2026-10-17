import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from pi_dash import config as settings


class LookupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=settings.APP_ROOT)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'web').mkdir()
        for name, data in (('config.json', {'source': 'root'}),
                           ('web/manifest.json', {'source': 'built-in'}),
                           ('custom.json', {'source': 'environment'})):
            (self.root / name).write_text(json.dumps(data), encoding='utf-8')
        self.environment = patch.dict(os.environ)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        os.environ.pop('PI_DASH_CONFIG', None)
        os.environ.pop('PI_DASH_MANIFEST', None)

    def test_config_defaults_to_repository_root(self):
        self.assertEqual(settings.load_config(self.root), {'source': 'root'})

    def test_config_environment_overrides_root(self):
        os.environ['PI_DASH_CONFIG'] = str(self.root / 'custom.json')
        self.assertEqual(settings.load_config(self.root), {'source': 'environment'})

    def test_missing_config_fails_clearly_without_falling_back(self):
        (self.root / 'config.json').unlink()
        with self.assertRaisesRegex(RuntimeError, 'Config not found:.*PI_DASH_CONFIG'):
            settings.load_config(self.root)
        os.environ['PI_DASH_CONFIG'] = str(self.root / 'absent.json')
        with self.assertRaisesRegex(RuntimeError, 'absent.json'):
            settings.load_config(self.root)

    def test_manifest_uses_built_in_then_root_override_then_environment(self):
        self.assertEqual(settings.load_manifest(self.root), {'source': 'built-in'})
        (self.root / 'manifest.json').write_text('{"source":"mounted"}', encoding='utf-8')
        self.assertEqual(settings.load_manifest(self.root), {'source': 'mounted'})
        os.environ['PI_DASH_MANIFEST'] = str(self.root / 'custom.json')
        self.assertEqual(settings.load_manifest(self.root), {'source': 'environment'})

    def test_explicit_missing_manifest_does_not_silently_use_default(self):
        os.environ['PI_DASH_MANIFEST'] = str(self.root / 'absent.json')
        with self.assertRaisesRegex(RuntimeError, 'Manifest not found:.*PI_DASH_MANIFEST'):
            settings.load_manifest(self.root)

    def test_environment_lookup_is_used_at_app_startup(self):
        (self.root / 'custom.json').write_text('{"base_path":"/mounted/","piholes":[]}', encoding='utf-8')
        (self.root / 'manifest.json').write_text('{"name":"Mounted manifest"}', encoding='utf-8')
        os.environ.update(PI_DASH_CONFIG=str(self.root / 'custom.json'), PI_DASH_MANIFEST=str(self.root / 'manifest.json'))
        script = '''
from pi_dash.app import app
with app.test_client() as client:
    manifest = client.get('/mounted/manifest.json').get_json()
    assert manifest['name'] == 'Mounted manifest'
    assert manifest['start_url'] == manifest['scope'] == manifest['id'] == '/mounted/'
    for path in ('/', '/sw.js', '/css/style.css', '/js/network-insights.js', '/icons/icon.svg', '/favicon.ico', '/health'):
        assert client.get('/mounted' + path).status_code == 200, path
    assert client.get('/health').status_code == 200
    assert '<base href="/mounted/">' in client.get('/mounted/').get_data(as_text=True)
    assert '{{CACHE_URL}}' not in client.get('/mounted/sw.js').get_data(as_text=True)
'''
        result = subprocess.run([sys.executable, '-c', script], cwd=settings.APP_ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
