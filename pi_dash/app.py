from flask import Flask, jsonify, send_from_directory, request, Blueprint
from markupsafe import escape
import requests
import os
import json
import concurrent.futures
import threading
import time
from urllib.parse import urlparse
from .aggregate import RANK_LIMIT, device_view, combine_history, combine_rankings

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
APP_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
WEB_ROOT = os.path.join(APP_ROOT, 'web')


def _load_json(name):
    with open(os.path.join(APP_ROOT, name), encoding='utf-8') as handle:
        return json.load(handle)


config = _load_json('config.json')
with open(os.path.join(WEB_ROOT, 'manifest.json'), encoding='utf-8') as handle:
    manifest_data = json.load(handle)
with open(os.path.join(WEB_ROOT, 'index.html'), encoding='utf-8') as handle:
    index_template = handle.read()
with open(os.path.join(WEB_ROOT, 'sw.js'), encoding='utf-8') as handle:
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
_blocking_locks_lock = threading.Lock()
_blocking_locks = {}
_stats_cache = {'time': 0.0, 'data': None}
_queries_cache = {}
_blocking_cache = {}
_auth_locks = {}
_auth_locks_lock = threading.Lock()
_auth_failures = {}
_optional_cache = {}
_optional_locks = {'devices': threading.Lock(), 'insights': threading.Lock()}
OPTIONAL_REFRESH_MS = 30000


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


def get_sid(pihole, force=False, expired_sid=None):
    name = pihole['name']
    with _auth_locks_lock:
        lock = _auth_locks.setdefault(name, threading.Lock())
    # Optional metrics and live stats can arrive together. Share authentication,
    # including a replacement SID already obtained by another 401 retry.
    with lock:
        with _sessions_lock:
            sid = pihole_sessions.get(name)
        if sid and (not force or (expired_sid is not None and sid != expired_sid)):
            return sid
        failure = _auth_failures.get(name)
        if failure and time.monotonic() - failure['time'] < 3:
            raise failure['error']
        try:
            sid = authenticate_and_get_sid(pihole)
        except (requests.exceptions.RequestException, RuntimeError, ValueError) as exc:
            # Waiting parallel requests share this failure instead of each
            # spending another full timeout on an unreachable auth endpoint.
            _auth_failures[name] = {'time': time.monotonic(), 'error': exc}
            raise
        if sid:
            _auth_failures.pop(name, None)
            with _sessions_lock:
                pihole_sessions[name] = sid
        return sid


def pihole_get(pihole, path, params=None, timeout=DEFAULT_REQUEST_TIMEOUT):
    sid = get_sid(pihole)
    if not sid:
        raise RuntimeError('authentication failed')
    args = {
        'headers': headers(sid), 'params': params,
        'timeout': timeout,
        'verify': get_verify_setting(pihole),
    }
    url = pihole['address'].rstrip('/') + path
    response = requests.get(url, **args)
    if response.status_code == 401 and sid != NO_PASSWORD:
        sid = get_sid(pihole, True, expired_sid=sid)
        if not sid:
            raise RuntimeError('re-authentication failed')
        args['headers'] = headers(sid)
        response = requests.get(url, **args)
    response.raise_for_status()
    return response


# -- Frontend routes --
@bp.route('/')
def index():
    return index_template.replace('<head>', f'<head>\n    <base href="{escape(html_base)}">')


@bp.route('/manifest.json')
def serve_manifest():
    data = manifest_data.copy()
    data['start_url'] = html_base
    data['scope'] = html_base
    data['id'] = html_base
    return jsonify(data)


@bp.route('/sw.js')
def serve_sw():
    return sw_template.replace('{{CACHE_URL}}', html_base), 200, {'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache'}


@bp.route('/css/<path:path>')
def send_css(path):
    return send_from_directory(os.path.join(WEB_ROOT, 'css'), path)


@bp.route('/js/<path:path>')
def send_js(path):
    return send_from_directory(os.path.join(WEB_ROOT, 'js'), path)


@bp.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(WEB_ROOT, 'icons'), 'favicon.ico')


@bp.route('/icons/<path:path>')
def send_icon(path):
    return send_from_directory(os.path.join(WEB_ROOT, 'icons'), path)


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
        'show_network_insights': config.get('show_network_insights', False),
        'show_device_metrics': config.get('show_device_metrics', True),
        'optional_refresh_interval': OPTIONAL_REFRESH_MS,
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


def _blocking_lock_for(name):
    with _blocking_locks_lock:
        return _blocking_locks.setdefault(name, threading.Lock())


def get_blocking(pihole):
    name = pihole['name']
    now = time.monotonic()
    with _cache_lock:
        cached = _blocking_cache.get(name)
        if cached and now - cached['time'] < DEFAULT_BLOCKING_TTL / 1000:
            return cached['value']
    with _blocking_lock_for(name):
        # Coalesce misses for the same Pi-hole without delaying other instances.
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
        previous = (_stats_cache.get('data') or {}).get(name, {})
        if previous.get('error'):
            # A real DNS recovery expires failed optional readings immediately.
            for kind in ('devices', 'insights'):
                cached = _optional_cache.get(kind)
                if cached:
                    _optional_cache[kind] = dict(cached, time=0)
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
    total = blocked = cached = forwarded = healthy = offline = auth_errors = disabled = unknown = 0
    contributing = 0
    for item in data.values():
        if item.get('error') or not isinstance(item.get('queries'), dict):
            if item.get('_pi_dash', {}).get('health') == 'auth_error':
                auth_errors += 1
            else:
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
        'auth_error_instances': auth_errors,
        'offline_instances': offline,
        'partial': contributing != len(data),
    }


def _refresh_optional(kind):
    """Fetch one optional snapshot on behalf of the refresh owner."""
    items = enabled()
    parts = {p['name']: {} for p in items}
    paths = (
        [('system', '/api/info/system', None), ('sensors', '/api/info/sensors', None)] if kind == 'devices' else
        [('history', '/api/history', None),
         ('clients', '/api/stats/top_clients', {'count': RANK_LIMIT}),
         ('domains', '/api/stats/top_domains', {'count': RANK_LIMIT, 'blocked': 'true'})]
    )

    def read_part(pihole, key, path, params):
        try:
            data = pihole_get(pihole, path, params=params, timeout=4).json()
            expected = list if key in ('history', 'clients', 'domains') else dict
            if isinstance(data, dict) and 'error' not in data and isinstance(data.get(key), expected):
                return pihole['name'], key, data
        except (requests.exceptions.RequestException, RuntimeError, ValueError):
            pass
        return pihole['name'], key, None

    if items:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(10, len(items) * len(paths))) as pool:
            futures = [pool.submit(read_part, p, *path) for p in items for path in paths]
            for future in concurrent.futures.as_completed(futures):
                name, key, data = future.result()
                if data is not None:
                    parts[name][key] = data
    try:
        if kind == 'devices':
            result = {'devices': {name: device_view(data) for name, data in parts.items()}}
        else:
            result = {'history': combine_history(parts, len(items)),
                      'clients': combine_rankings(parts, 'clients', len(items)),
                      'domains': combine_rankings(parts, 'domains', len(items))}
    except (TypeError, ValueError, AttributeError, KeyError, OverflowError):
        app.logger.warning('Malformed optional Pi-hole readings: %s', kind)
        result = _empty_optional(kind)
    result['updated_at'] = time.time()
    _optional_cache[kind] = {'time': time.monotonic(), 'data': result}
    return result


def _empty_optional(kind):
    if kind == 'devices':
        return {'devices': {p['name']: device_view({}) for p in enabled()}}
    count = len(enabled())
    return {'history': combine_history({}, count),
            'clients': combine_rankings({}, 'clients', count),
            'domains': combine_rankings({}, 'domains', count)}


def fetch_optional(kind):
    """Only the refresh owner waits on upstream IO; other HTTP threads return."""
    cached = _optional_cache.get(kind)
    if cached and time.monotonic() - cached['time'] < OPTIONAL_REFRESH_MS / 1000:
        return cached['data']
    lock = _optional_locks[kind]
    if not lock.acquire(blocking=False):
        cached = _optional_cache.get(kind)
        return dict(cached['data'] if cached else _empty_optional(kind),
                    refreshing=True, stale=bool(cached),
                    updated_at=cached['data'].get('updated_at') if cached else None)
    try:
        cached = _optional_cache.get(kind)
        if cached and time.monotonic() - cached['time'] < OPTIONAL_REFRESH_MS / 1000:
            return cached['data']
        return _refresh_optional(kind)
    finally:
        lock.release()


@bp.route('/devices')
def devices():
    if not config.get('show_device_metrics', True):
        return jsonify({'devices': {}}), 200, {'Cache-Control': 'no-store'}
    return jsonify(fetch_optional('devices')), 200, {'Cache-Control': 'no-store'}


@bp.route('/insights')
def insights():
    if not config.get('show_network_summary', True) or not config.get('show_network_insights', False):
        return jsonify({'disabled': True}), 200, {'Cache-Control': 'no-store'}
    return jsonify(fetch_optional('insights')), 200, {'Cache-Control': 'no-store'}


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
            length = _bounded_int(request.args.get('length'), 50, 1, 200)
            result['queries'] = fetch_queries(length)
        return jsonify(result)
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@bp.route('/queries')
def queries():
    try:
        length = _bounded_int(request.args.get('length'), 50, 1, 200)
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
