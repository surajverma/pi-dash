from flask import Flask, jsonify, send_from_directory, request, Blueprint
from markupsafe import escape
import requests
import os
import json
import concurrent.futures
import threading
import time
from urllib.parse import urlparse

NO_PASSWORD = "NO_PASSWORD"
DEFAULT_REFRESH_INTERVAL = 5000
DEFAULT_REQUEST_TIMEOUT = 10
DEFAULT_CACHE_TTL = 1000
DEFAULT_BLOCKING_TTL = 30000
BLOCKED_STATUSES = {
    'GRAVITY', 'REGEX', 'DENYLIST', 'EXTERNAL_BLOCKED_IP',
    'EXTERNAL_BLOCKED_NULL', 'EXTERNAL_BLOCKED_NXRA', 'GRAVITY_CNAME',
    'REGEX_CNAME', 'DENYLIST_CNAME', 'DBBUSY', 'SPECIAL_DOMAIN',
    'EXTERNAL_BLOCKED_EDE15',
}

app = Flask(__name__)
APP_ROOT = os.path.dirname(os.path.realpath(__file__))


def _load_json(name):
    with open(os.path.join(APP_ROOT, name), encoding='utf-8') as handle:
        return json.load(handle)


config = _load_json('config.json')
manifest_data = _load_json('manifest.json')
with open(os.path.join(APP_ROOT, 'index.html'), encoding='utf-8') as handle:
    index_template = handle.read()
with open(os.path.join(APP_ROOT, 'sw.js'), encoding='utf-8') as handle:
    sw_template = handle.read()

base_path_config = config.get('base_path', '/')
url_prefix = base_path_config[:-1] if base_path_config != '/' and base_path_config.endswith('/') else base_path_config
html_base = base_path_config if base_path_config.endswith('/') else base_path_config + '/'
bp = Blueprint('pi-dash', __name__)
pihole_sessions = {}
_sessions_lock = threading.Lock()
_cache_lock = threading.Lock()
_stats_refresh_lock = threading.Lock()
_queries_refresh_lock = threading.Lock()
_blocking_lock = threading.Lock()
_stats_cache = {'time': 0.0, 'data': None}
_queries_cache = {}
_blocking_cache = {}


def _int(value, default, minimum=100):
    try:
        value = int(value)
        return value if value >= minimum else default
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


def headers(sid):
    return {} if sid == NO_PASSWORD else {'X-FTL-SID': sid}


def authenticate_and_get_sid(pihole):
    address = pihole['address'].rstrip('/')
    response = requests.post(
        address + '/api/auth',
        json={'password': resolve_secret(pihole.get('password', ''))},
        timeout=DEFAULT_REQUEST_TIMEOUT,
        verify=get_verify_setting(pihole),
    )
    if response.status_code == 200:
        data = response.json()
        sid = data.get('session', {}).get('sid')
        if sid:
            return sid
        if data.get('session', {}).get('message') == 'no password set':
            return NO_PASSWORD
    response.raise_for_status()
    return None


def get_sid(pihole, force=False):
    name = pihole['name']
    with _sessions_lock:
        if force:
            pihole_sessions.pop(name, None)
        sid = pihole_sessions.get(name)
    if sid:
        return sid
    sid = authenticate_and_get_sid(pihole)
    if sid:
        with _sessions_lock:
            pihole_sessions[name] = sid
    return sid


def pihole_get(pihole, path, params=None):
    sid = get_sid(pihole)
    if not sid:
        raise RuntimeError('authentication failed')
    args = {
        'headers': headers(sid), 'params': params,
        'timeout': DEFAULT_REQUEST_TIMEOUT,
        'verify': get_verify_setting(pihole),
    }
    url = pihole['address'].rstrip('/') + path
    response = requests.get(url, **args)
    if response.status_code == 401 and sid != NO_PASSWORD:
        sid = get_sid(pihole, True)
        if not sid:
            raise RuntimeError('re-authentication failed')
        args['headers'] = headers(sid)
        response = requests.get(url, **args)
    response.raise_for_status()
    return response


# -- Frontend routes --
@bp.route('/')
def index():
    icon = (manifest_data.get('icons') or [{}])[0].get('src', '')
    return index_template.replace('<head>', f'<head>\n    <base href="{escape(html_base)}">').replace('{{ICON_URL}}', escape(icon))


@bp.route('/manifest.json')
def serve_manifest():
    data = manifest_data.copy()
    data['start_url'] = html_base
    return jsonify(data)


@bp.route('/sw.js')
def serve_sw():
    return sw_template.replace('{{CACHE_URL}}', html_base), 200, {'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache'}


@bp.route('/css/<path:path>')
def send_css(path):
    return send_from_directory(os.path.join(APP_ROOT, 'css'), path)


@bp.route('/js/<path:path>')
def send_js(path):
    return send_from_directory(os.path.join(APP_ROOT, 'js'), path)


@bp.route('/favicon.ico')
def favicon():
    return '', 204


# -- API helpers --
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
        'piholes': out,
    }


def normalize_blocking(value):
    """Pi-hole v6 returns enabled/disabled strings; accept booleans as well."""
    if value is True or value is False:
        return value
    if isinstance(value, str):
        if value.lower() in ('enabled', 'on', 'true'):
            return True
        if value.lower() in ('disabled', 'off', 'false'):
            return False
    return None


def get_blocking(pihole):
    name = pihole['name']
    now = time.monotonic()
    with _cache_lock:
        cached = _blocking_cache.get(name)
        if cached and now - cached['time'] < DEFAULT_BLOCKING_TTL / 1000:
            return cached['value']
    with _blocking_lock:
        # Coalesce simultaneous misses, as with the statistics cache.
        now = time.monotonic()
        with _cache_lock:
            cached = _blocking_cache.get(name)
            if cached and now - cached['time'] < DEFAULT_BLOCKING_TTL / 1000:
                return cached['value']
        try:
            value = normalize_blocking(pihole_get(pihole, '/api/dns/blocking').json().get('blocking'))
        except (requests.exceptions.RequestException, RuntimeError, ValueError):
            value = None
        with _cache_lock:
            _blocking_cache[name] = {'time': time.monotonic(), 'value': value}
        return value


def fetch_one(pihole):
    name = pihole['name']
    try:
        data = pihole_get(pihole, '/api/stats/summary').json()
        blocking = get_blocking(pihole)
        data['_pi_dash'] = {
            'blocking': blocking,
            'health': 'blocking_disabled' if blocking is False else 'healthy',
        }
        return name, data
    except RuntimeError as exc:
        return name, {'error': str(exc), '_pi_dash': {'health': 'auth_error'}}
    except (requests.exceptions.RequestException, ValueError) as exc:
        status = getattr(getattr(exc, 'response', None), 'status_code', None)
        health = 'auth_error' if status in (401, 403) else 'unreachable'
        return name, {'error': str(exc), '_pi_dash': {'health': health}}


def _stats_uncached():
    items = enabled()
    results = {}
    if not items:
        return results
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(items), 10)) as executor:
        futures = [executor.submit(fetch_one, pihole) for pihole in items]
        for future in concurrent.futures.as_completed(futures):
            name, data = future.result()
            results[name] = data
    return results


def fetch_stats(force=False):
    ttl = get_cache_ttl() / 1000
    now = time.monotonic()
    with _cache_lock:
        if not force and _stats_cache['data'] is not None and now - _stats_cache['time'] < ttl:
            return _stats_cache['data']
    with _stats_refresh_lock:
        now = time.monotonic()
        with _cache_lock:
            if not force and _stats_cache['data'] is not None and now - _stats_cache['time'] < ttl:
                return _stats_cache['data']
        data = _stats_uncached()
        with _cache_lock:
            _stats_cache.update(time=time.monotonic(), data=data)
        return data


def _queries_uncached(length):
    items = enabled()
    results = {}
    if not items:
        return results
    hosts = {urlparse(p['address']).hostname.lower() for p in items if urlparse(p['address']).hostname}

    def one(pihole):
        try:
            data = pihole_get(pihole, '/api/queries', {'length': length}).json()
            out = []
            for query in data.get('queries', [])[:length]:
                domain = query.get('domain', '')
                timestamp = query.get('time') if query.get('time') is not None else query.get('timestamp')
                if domain.lower().strip() in hosts:
                    continue
                out.append({
                    'id': query.get('id'),
                    'domain': domain,
                    'blocked': (query.get('status') or '').upper() in BLOCKED_STATUSES,
                    'time': timestamp,
                    'timestamp': timestamp,
                    'upstream': query.get('upstream', ''),
                })
            return pihole['name'], out
        except (requests.exceptions.RequestException, RuntimeError, ValueError):
            return pihole['name'], []

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(items), 10)) as executor:
        futures = [executor.submit(one, pihole) for pihole in items]
        for future in concurrent.futures.as_completed(futures):
            name, data = future.result()
            results[name] = data
    return results


def fetch_queries(length=50, force=False):
    ttl = get_cache_ttl() / 1000
    now = time.monotonic()
    with _cache_lock:
        cached = _queries_cache.get(length)
        if not force and cached and now - cached['time'] < ttl:
            return cached['data']
    with _queries_refresh_lock:
        now = time.monotonic()
        with _cache_lock:
            cached = _queries_cache.get(length)
            if not force and cached and now - cached['time'] < ttl:
                return cached['data']
        data = _queries_uncached(length)
        with _cache_lock:
            _queries_cache[length] = {'time': time.monotonic(), 'data': data}
        return data


def network_summary(data):
    total = blocked = cached = forwarded = healthy = offline = disabled = unknown = 0
    contributing = 0
    for item in data.values():
        if item.get('error') or not isinstance(item.get('queries'), dict):
            offline += 1
            continue
        contributing += 1
        queries = item['queries']
        total += int(queries.get('total') or 0)
        blocked += int(queries.get('blocked') or 0)
        cached += int(queries.get('cached') or 0)
        forwarded += int(queries.get('forwarded') or 0)
        blocking = item.get('_pi_dash', {}).get('blocking')
        if blocking is False:
            disabled += 1
        elif blocking is None:
            unknown += 1
        else:
            healthy += 1
    return {
        'total_queries': total,
        'blocked_queries': blocked,
        'percent_blocked': round(blocked / total * 100, 1) if total else 0,
        'cached_queries': cached,
        'forwarded_queries': forwarded,
        'instances': len(data),
        'contributing_instances': contributing,
        'healthy_instances': healthy,
        'blocking_disabled_instances': disabled,
        'blocking_unknown_instances': unknown,
        'offline_instances': offline,
        'partial': contributing != len(data),
    }


# -- API routes --
@bp.route('/init')
def init():
    try:
        stats = fetch_stats()
        result = {'config': filtered_config(), 'data': stats, 'summary': network_summary(stats)}
        if config.get('show_queries', False):
            result['queries'] = fetch_queries(50)
        return jsonify(result)
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@bp.route('/data')
def data():
    try:
        stats = fetch_stats()
        include_summary = request.args.get('include_summary', 'false').lower() == 'true'
        include_queries = request.args.get('include_queries', 'false').lower() == 'true'
        if not include_summary and not include_queries:
            return jsonify(stats)
        result = {'stats': stats}
        if include_summary:
            result['summary'] = network_summary(stats)
        if include_queries:
            length = max(1, min(int(request.args.get('length', 50)), 200))
            result['queries'] = fetch_queries(length)
        return jsonify(result)
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@bp.route('/queries')
def queries():
    try:
        length = max(1, min(int(request.args.get('length', 50)), 200))
        return jsonify(fetch_queries(length))
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@bp.route('/health')
def health():
    return jsonify({'status': 'ok', 'enabled_piholes': len(enabled()), 'cache_ttl_ms': get_cache_ttl()})


app.register_blueprint(bp, url_prefix=url_prefix)
if url_prefix not in ('', '/'):
    app.add_url_rule('/health', 'root_health', health)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001)
