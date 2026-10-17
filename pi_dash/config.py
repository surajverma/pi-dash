import json
import os

APP_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
WEB_ROOT = os.path.join(APP_ROOT, 'web')
DEFAULT_REFRESH_INTERVAL = 5000
DEFAULT_REQUEST_TIMEOUT = 10
DEFAULT_CACHE_TTL = 1000
DEFAULT_BLOCKING_TTL = 30000
OPTIONAL_REFRESH_MS = 30000


def _load_json(name):
    with open(os.path.join(APP_ROOT, name), encoding='utf-8') as handle:
        return json.load(handle)


config = _load_json('config.json')
with open(os.path.join(WEB_ROOT, 'manifest.json'), encoding='utf-8') as handle:
    manifest_data = json.load(handle)
base_path_config = config.get('base_path', '/')
url_prefix = base_path_config[:-1] if base_path_config != '/' and base_path_config.endswith('/') else base_path_config
html_base = base_path_config if base_path_config.endswith('/') else base_path_config + '/'


def _int(value, default, minimum=100):
    try:
        value = int(value)
        return value if value >= minimum else default
    except (TypeError, ValueError):
        return default


def _bounded_int(value, default, minimum, maximum):
    try:
        return max(minimum, min(int(value), maximum))
    except (TypeError, ValueError):
        return default


def get_refresh_interval():
    return _int(config.get('refresh_interval'), DEFAULT_REFRESH_INTERVAL)


def get_queries_refresh_interval():
    # An old configuration keeps its original query refresh cadence.
    return _int(config.get('queries_refresh_interval'), get_refresh_interval())


def get_cache_ttl():
    if 'cache_ttl' in config:
        return _int(config.get('cache_ttl'), DEFAULT_CACHE_TTL, 0)
    return min(DEFAULT_CACHE_TTL, max(100, min(get_refresh_interval(), get_queries_refresh_interval()) // 2))


def resolve_secret(value):
    if isinstance(value, str) and value.startswith('${') and value.endswith('}'):
        return os.environ.get(value[2:-1], value)
    return value


def get_verify_setting(pihole):
    value = pihole.get('verify_ssl', False)
    if isinstance(value, str):
        if value.lower() == 'true':
            return True
        if value.lower() == 'false':
            return False
        return resolve_secret(value)
    return bool(value)


def enabled():
    return [p for p in config.get('piholes', []) if p.get('enabled', True)]


def filtered_config():
    out = []
    for pihole in enabled():
        item = {'name': pihole['name'], 'enabled': True, 'link': pihole.get('link', False)}
        if item['link']:
            item['address'] = pihole['address']
        out.append(item)
    return {
        'refresh_interval': get_refresh_interval(),
        'queries_refresh_interval': get_queries_refresh_interval(),
        'show_queries': config.get('show_queries', False),
        'show_network_summary': config.get('show_network_summary', True),
        'show_trends': config.get('show_trends', True),
        'show_network_insights': config.get('show_network_insights', False),
        'show_device_metrics': config.get('show_device_metrics', True),
        'optional_refresh_interval': OPTIONAL_REFRESH_MS,
        'piholes': out,
    }
