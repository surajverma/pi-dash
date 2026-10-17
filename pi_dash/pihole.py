import requests
import threading
import time
from .config import DEFAULT_REQUEST_TIMEOUT, get_verify_setting, resolve_secret

NO_PASSWORD = 'NO_PASSWORD'
pihole_sessions = {}
_sessions_lock = threading.Lock()
_auth_locks = {}
_auth_locks_lock = threading.Lock()
_auth_failures = {}


def error_message(exc):
    status = getattr(getattr(exc, 'response', None), 'status_code', None)
    if status in (401, 403):
        return 'Authentication failed'
    if isinstance(exc, requests.exceptions.RequestException):
        return 'Pi-hole unreachable'
    return 'Internal error'


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
