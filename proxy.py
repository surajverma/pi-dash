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
DEFAULT_CACHE_TTL = 1000
DEFAULT_REQUEST_TIMEOUT = 10
SLOW_RESPONSE_MS = 500

BLOCKED_STATUSES = {
    'GRAVITY', 'REGEX', 'DENYLIST',
    'EXTERNAL_BLOCKED_IP', 'EXTERNAL_BLOCKED_NULL', 'EXTERNAL_BLOCKED_NXRA',
    'GRAVITY_CNAME', 'REGEX_CNAME', 'DENYLIST_CNAME',
    'DBBUSY', 'SPECIAL_DOMAIN', 'EXTERNAL_BLOCKED_EDE15'
}

app = Flask(__name__)
APP_ROOT = os.path.dirname(os.path.realpath(__file__))


def _load_json(filename):
    with open(os.path.join(APP_ROOT, filename), encoding='utf-8') as handle:
        return json.load(handle)


config = _load_json('config.json')
manifest_data = _load_json('manifest.json')

with open(os.path.join(APP_ROOT, 'index.html'), encoding='utf-8') as handle:
    index_template = handle.read()

with open(os.path.join(APP_ROOT, 'sw.js'), encoding='utf-8') as handle:
    sw_template = handle.read()

base_path_config = config.get('base_path', '/')
url_prefix = base_path_config
if url_prefix != '/' and url_prefix.endswith('/'):
    url_prefix = url_prefix[:-1]

html_base = base_path_config
if not html_base.endswith('/'):
    html_base += '/'

bp = Blueprint('pi-dash', __name__)
pihole_sessions = {}
_sessions_lock = threading.Lock()
_cache_lock = threading.Lock()
_stats_refresh_lock = threading.Lock()
_queries_refresh_lock = threading.Lock()
_stats_cache = {'time': 0.0, 'data': None}
_queries_cache = {}


def _positive_int(value, default, minimum=100):
    try:
        parsed = int(value)
        return parsed if parsed >= minimum else default
    except (TypeError, ValueError):
        return default


def get_refresh_interval():
    return _positive_int(config.get('refresh_interval'), DEFAULT_REFRESH_INTERVAL)


def get_queries_refresh_interval():
    # Backward compatibility: old configs only have refresh_interval, so query
    # polling keeps the exact same cadence until this new option is configured.
    return _positive_int(config.get('queries_refresh_interval'), get_refresh_interval())


def get_cache_ttl():
    return _positive_int(config.get('cache_ttl'), DEFAULT_CACHE_TTL, minimum=0)


def resolve_secret(value):
    """Resolve ${ENV_VAR} secrets while leaving normal config values unchanged."""
    if not isinstance(value, str):
        return value
    if value.startswith('${') and value.endswith('}') and len(value) > 3:
        env_name = value[2:-1]
        return os.environ.get(env_name, value)
    return value


def get_verify_setting(pihole_config):
    """Return a requests-compatible TLS verification setting.

    verify_ssl is optional and defaults to False to preserve existing installs.
    It may be true/false or a path to a CA bundle.
    """
    verify = pihole_config.get('verify_ssl', False)
    if isinstance(verify, str):
        lowered = verify.strip().lower()
        if lowered == 'true':
            return True
        if lowered == 'false':
            return False
        return resolve_secret(verify)
    return bool(verify)


def get_headers(sid):
    return {} if sid == NO_PASSWORD else {'X-FTL-SID': sid}


def authenticate_and_get_sid(pihole_config):
    address = pihole_config['address'].rstrip('/')
    password = resolve_secret(pihole_config.get('password', ''))
    auth_url = f"{address}/api/auth"
    payload = {"password": password}
    verify = get_verify_setting(pihole_config)

    try:
        response = requests.post(
            auth_url,
            json=payload,
            timeout=DEFAULT_REQUEST_TIMEOUT,
            verify=verify,
        )
        if response.status_code == 200:
            data = response.json()
            new_sid = data.get('session', {}).get('sid')
            if new_sid:
                return new_sid
            if data.get('session', {}).get('message') == 'no password set':
                return NO_PASSWORD
            print(f"Authentication with {address} returned 200 but no SID was found.")
            return None
        if response.status_code == 401:
            print(f"Authentication failed for {address}: incorrect password.")
            return None
        print(f"Authentication failed for {address} with HTTP {response.status_code}.")
        return None
    except requests.exceptions.RequestException as exc:
        print(f"Network error while authenticating with {address}: {exc}")
        return None


def get_sid(pihole_config, force=False):
    name = pihole_config['name']
    if force:
        with _sessions_lock:
            pihole_sessions.pop(name, None)

    with _sessions_lock:
        sid = pihole_sessions.get(name)
    if sid:
        return sid

    sid = authenticate_and_get_sid(pihole_config)
    if sid:
        with _sessions_lock:
            pihole_sessions[name] = sid
    return sid


def pihole_get(pihole_config, api_path, params=None):
    address = pihole_config['address'].rstrip('/')
    sid = get_sid(pihole_config)
    if not sid:
        raise RuntimeError('authentication failed')

    request_args = {
        'headers': get_headers(sid),
        'params': params,
        'timeout': DEFAULT_REQUEST_TIMEOUT,
        'verify': get_verify_setting(pihole_config),
    }
    response = requests.get(f"{address}{api_path}", **request_args)

    if response.status_code == 401 and sid != NO_PASSWORD:
        sid = get_sid(pihole_config, force=True)
        if not sid:
            raise RuntimeError('re-authentication failed')
        request_args['headers'] = get_headers(sid)
        response = requests.get(f"{address}{api_path}", **request_args)

    response.raise_for_status()
    return response


# -- Frontend Routes --
@bp.route('/')
def index():
    icon_url = ''
    if manifest_data.get('icons'):
        icon_url = manifest_data['icons'][0].get('src', '')

    base_tag = f'<base href="{escape(html_base)}">'
    temp_html = index_template.replace('<head>', f'<head>\n    {base_tag}')
    return temp_html.replace('{{ICON_URL}}', escape(icon_url))


@bp.route('/manifest.json')
def serve_manifest():
    manifest_copy = manifest_data.copy()
    manifest_copy['start_url'] = html_base
    return jsonify(manifest_copy)


@bp.route('/sw.js')
def serve_sw():
    sw_content = sw_template.replace('{{CACHE_URL}}', html_base)
    return sw_content, 200, {'Content-Type': 'application/javascript'}


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
def get_enabled_piholes():
    return [p for p in config.get('piholes', []) if p.get('enabled', True)]


def get_filtered_config():
    piholes_filtered = []
    for pihole in get_enabled_piholes():
        item = {
            'name': pihole['name'],
            'enabled': True,
            'link': pihole.get('link', False),
        }
        if item['link']:
            item['address'] = pihole['address']
        piholes_filtered.append(item)

    return {
        'refresh_interval': get_refresh_interval(),
        'queries_refresh_interval': get_queries_refresh_interval(),
        'show_queries': config.get('show_queries', False),
        'show_network_summary': config.get('show_network_summary', True),
        'show_trends': config.get('show_trends', True),
        'piholes': piholes_filtered,
    }


def fetch_single_pihole(pihole_config):
    name = pihole_config['name']
    start = time.perf_counter()
    try:
        response = pihole_get(pihole_config, '/api/stats/summary')
        latency_ms = round((time.perf_counter() - start) * 1000, 1)
        data = response.json()

        # Blocking status is useful health information but must not make the
        # whole card fail if an older/changed Pi-hole API does not provide it.
        blocking = None
        try:
            blocking_response = pihole_get(pihole_config, '/api/dns/blocking')
            blocking = blocking_response.json().get('blocking')
        except (requests.exceptions.RequestException, RuntimeError, ValueError):
            pass

        data['_pi_dash'] = {
            'latency_ms': latency_ms,
            'blocking': blocking,
            'health': 'slow' if latency_ms >= SLOW_RESPONSE_MS else 'healthy',
        }
        return name, data
    except RuntimeError as exc:
        return name, {'error': str(exc), '_pi_dash': {'health': 'auth_error'}}
    except requests.exceptions.RequestException as exc:
        return name, {'error': str(exc), '_pi_dash': {'health': 'unreachable'}}
    except ValueError as exc:
        return name, {'error': f'Invalid JSON response: {exc}', '_pi_dash': {'health': 'unreachable'}}


def _fetch_all_pihole_data_uncached():
    enabled_piholes = get_enabled_piholes()
    if not enabled_piholes:
        return {}

    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(enabled_piholes), 10)) as executor:
        futures = [executor.submit(fetch_single_pihole, pihole) for pihole in enabled_piholes]
        for future in concurrent.futures.as_completed(futures):
            name, data = future.result()
            results[name] = data
    return results


def fetch_all_pihole_data(force=False):
    ttl_seconds = get_cache_ttl() / 1000.0
    now = time.monotonic()
    with _cache_lock:
        if not force and _stats_cache['data'] is not None and now - _stats_cache['time'] < ttl_seconds:
            return _stats_cache['data']

    with _stats_refresh_lock:
        now = time.monotonic()
        with _cache_lock:
            if not force and _stats_cache['data'] is not None and now - _stats_cache['time'] < ttl_seconds:
                return _stats_cache['data']

        data = _fetch_all_pihole_data_uncached()
        with _cache_lock:
            _stats_cache['time'] = time.monotonic()
            _stats_cache['data'] = data
        return data


def _fetch_recent_queries_uncached(length=50):
    enabled_piholes = get_enabled_piholes()
    if not enabled_piholes:
        return {}

    results = {}
    pihole_hostnames = set()
    for pihole in enabled_piholes:
        parsed = urlparse(pihole['address'])
        hostname = parsed.hostname or (parsed.netloc.split(':')[0] if parsed.netloc else None)
        if hostname:
            pihole_hostnames.add(hostname.lower())

    def fetch_queries_for_pihole(pihole_config):
        name = pihole_config['name']
        try:
            response = pihole_get(pihole_config, '/api/queries', params={'length': length})
            data = response.json()
            normalized = []
            for query in data.get('queries', [])[:length]:
                original_domain = query.get('domain', '')
                domain = original_domain.lower().strip()
                if domain in pihole_hostnames:
                    continue

                status = (query.get('status') or '').upper()
                timestamp = query.get('time') or query.get('timestamp')
                normalized.append({
                    'id': query.get('id'),
                    'domain': original_domain,
                    'blocked': status in BLOCKED_STATUSES,
                    'time': timestamp,
                    'timestamp': timestamp,
                    'upstream': query.get('upstream', ''),
                })
            return name, normalized
        except (requests.exceptions.RequestException, RuntimeError, ValueError):
            return name, []

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(enabled_piholes), 10)) as executor:
        futures = [executor.submit(fetch_queries_for_pihole, pihole) for pihole in enabled_piholes]
        for future in concurrent.futures.as_completed(futures):
            name, data = future.result()
            results[name] = data
    return results


def fetch_recent_queries(length=50, force=False):
    ttl_seconds = get_cache_ttl() / 1000.0
    now = time.monotonic()
    with _cache_lock:
        cached = _queries_cache.get(length)
        if not force and cached and now - cached['time'] < ttl_seconds:
            return cached['data']

    with _queries_refresh_lock:
        now = time.monotonic()
        with _cache_lock:
            cached = _queries_cache.get(length)
            if not force and cached and now - cached['time'] < ttl_seconds:
                return cached['data']

        data = _fetch_recent_queries_uncached(length)
        with _cache_lock:
            _queries_cache[length] = {'time': time.monotonic(), 'data': data}
        return data


def build_network_summary(pihole_data):
    total = blocked = cached = forwarded = 0
    healthy = slow = offline = 0
    contributing = 0

    for data in pihole_data.values():
        if data.get('error') or not data.get('queries'):
            offline += 1
            continue
        contributing += 1
        queries = data.get('queries', {})
        total += int(queries.get('total') or 0)
        blocked += int(queries.get('blocked') or 0)
        cached += int(queries.get('cached') or 0)
        forwarded += int(queries.get('forwarded') or 0)
        if data.get('_pi_dash', {}).get('health') == 'slow':
            slow += 1
        else:
            healthy += 1

    return {
        'total_queries': total,
        'blocked_queries': blocked,
        'percent_blocked': round((blocked / total * 100), 1) if total else 0,
        'cached_queries': cached,
        'forwarded_queries': forwarded,
        'instances': len(pihole_data),
        'contributing_instances': contributing,
        'healthy_instances': healthy,
        'slow_instances': slow,
        'offline_instances': offline,
    }


# -- API Routes --
@bp.route('/init')
def init():
    try:
        filtered_config = get_filtered_config()
        pihole_data = fetch_all_pihole_data()
        response_data = {
            'config': filtered_config,
            'data': pihole_data,
            'summary': build_network_summary(pihole_data),
        }
        if config.get('show_queries', False):
            response_data['queries'] = fetch_recent_queries(length=50)
        return jsonify(response_data)
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@bp.route('/data')
def data():
    try:
        pihole_data = fetch_all_pihole_data()
        # Preserve the legacy bare-object response unless callers explicitly
        # request the richer payload.
        include_summary = request.args.get('include_summary', 'false').lower() == 'true'
        include_queries = request.args.get('include_queries', 'false').lower() == 'true'
        if not include_summary and not include_queries:
            return jsonify(pihole_data)

        response_data = {'stats': pihole_data}
        if include_summary:
            response_data['summary'] = build_network_summary(pihole_data)
        if include_queries:
            length = max(1, min(int(request.args.get('length', 50)), 200))
            response_data['queries'] = fetch_recent_queries(length=length)
        return jsonify(response_data)
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@bp.route('/queries')
def queries():
    try:
        length = max(1, min(int(request.args.get('length', 50)), 200))
        return jsonify(fetch_recent_queries(length=length))
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@bp.route('/health')
def health():
    enabled = get_enabled_piholes()
    return jsonify({
        'status': 'ok',
        'enabled_piholes': len(enabled),
        'cache_ttl_ms': get_cache_ttl(),
    })


app.register_blueprint(bp, url_prefix=url_prefix)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001)
