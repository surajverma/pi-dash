import concurrent.futures
import logging
import requests
import threading
import time
from urllib.parse import urlparse
from . import config as settings, pihole as pihole_api
from .aggregate import RANK_LIMIT, device_view, combine_history, combine_rankings
from .config import DEFAULT_BLOCKING_TTL, OPTIONAL_REFRESH_MS

BLOCKED_STATUSES = {
    'GRAVITY', 'REGEX', 'DENYLIST', 'EXTERNAL_BLOCKED_IP',
    'EXTERNAL_BLOCKED_NULL', 'EXTERNAL_BLOCKED_NXRA', 'GRAVITY_CNAME',
    'REGEX_CNAME', 'DENYLIST_CNAME', 'DBBUSY', 'SPECIAL_DOMAIN',
    'EXTERNAL_BLOCKED_EDE15',
}
_cache_lock = threading.Lock()
_stats_refresh_lock = threading.Lock()
_queries_refresh_lock = threading.Lock()
_blocking_locks_lock = threading.Lock()
_blocking_locks = {}
_stats_cache = {'time': 0.0, 'data': None}
_queries_cache = {}
_blocking_cache = {}
_optional_cache = {}
_optional_locks = {'devices': threading.Lock(), 'insights': threading.Lock()}
logger = logging.getLogger(__name__)


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
            value = normalize_blocking(pihole_api.pihole_get(pihole, '/api/dns/blocking').json().get('blocking'))
        except (requests.exceptions.RequestException, RuntimeError, ValueError):
            value = None
        with _cache_lock:
            _blocking_cache[name] = {'time': time.monotonic(), 'value': value}
        return value


def fetch_one(pihole):
    name = pihole['name']
    try:
        data = pihole_api.pihole_get(pihole, '/api/stats/summary').json()
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
        logger.exception('Pi-hole authentication failed')
        return name, {'error': 'Authentication failed', '_pi_dash': {'health': 'auth_error'}}
    except (requests.exceptions.RequestException, ValueError) as exc:
        status = getattr(getattr(exc, 'response', None), 'status_code', None)
        health = 'auth_error' if status in (401, 403) else 'unreachable'
        logger.exception('Pi-hole stats request failed')
        message = 'Authentication failed' if health == 'auth_error' else 'Pi-hole unreachable'
        return name, {'error': message, '_pi_dash': {'health': health}}


def _stats_uncached():
    items = settings.enabled()
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
    ttl = settings.get_cache_ttl() / 1000
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
    items = settings.enabled()
    results = {}
    if not items:
        return results
    hosts = {urlparse(p['address']).hostname.lower() for p in items if urlparse(p['address']).hostname}

    def one(pihole):
        try:
            data = pihole_api.pihole_get(pihole, '/api/queries', {'length': length}).json()
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
    ttl = settings.get_cache_ttl() / 1000
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


def _refresh_optional(kind):
    """Fetch one optional snapshot on behalf of the refresh owner."""
    items = settings.enabled()
    parts = {p['name']: {} for p in items}
    paths = (
        [('system', '/api/info/system', None), ('sensors', '/api/info/sensors', None)] if kind == 'devices' else
        [('history', '/api/history', None),
         ('clients', '/api/stats/top_clients', {'count': RANK_LIMIT}),
         ('domains', '/api/stats/top_domains', {'count': RANK_LIMIT, 'blocked': 'true'})]
    )

    def read_part(pihole, key, path, params):
        try:
            data = pihole_api.pihole_get(pihole, path, params=params, timeout=4).json()
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
        logger.warning('Malformed optional Pi-hole readings: %s', kind)
        result = _empty_optional(kind)
    result['updated_at'] = time.time()
    _optional_cache[kind] = {'time': time.monotonic(), 'data': result}
    return result


def _empty_optional(kind):
    if kind == 'devices':
        return {'devices': {p['name']: device_view({}) for p in settings.enabled()}}
    count = len(settings.enabled())
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
