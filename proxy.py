from flask import Flask, jsonify, send_from_directory, request, Blueprint
from markupsafe import escape
import requests
import os, json, concurrent.futures, threading, time
from urllib.parse import urlparse

NO_PASSWORD = "NO_PASSWORD"
DEFAULT_REFRESH_INTERVAL = 5000
DEFAULT_REQUEST_TIMEOUT = 10
DEFAULT_CACHE_TTL = 1000
DEFAULT_BLOCKING_TTL = 30000
SLOW_RESPONSE_MS = 500
BLOCKED_STATUSES = {'GRAVITY','REGEX','DENYLIST','EXTERNAL_BLOCKED_IP','EXTERNAL_BLOCKED_NULL','EXTERNAL_BLOCKED_NXRA','GRAVITY_CNAME','REGEX_CNAME','DENYLIST_CNAME','DBBUSY','SPECIAL_DOMAIN','EXTERNAL_BLOCKED_EDE15'}

app = Flask(__name__)
APP_ROOT = os.path.dirname(os.path.realpath(__file__))

def _load_json(name):
    with open(os.path.join(APP_ROOT, name), encoding='utf-8') as f: return json.load(f)
config = _load_json('config.json')
manifest_data = _load_json('manifest.json')
with open(os.path.join(APP_ROOT,'index.html'),encoding='utf-8') as f: index_template=f.read()
with open(os.path.join(APP_ROOT,'sw.js'),encoding='utf-8') as f: sw_template=f.read()

base_path_config=config.get('base_path','/')
url_prefix=base_path_config[:-1] if base_path_config!='/' and base_path_config.endswith('/') else base_path_config
html_base=base_path_config if base_path_config.endswith('/') else base_path_config+'/'
bp=Blueprint('pi-dash',__name__)
pihole_sessions={}; _sessions_lock=threading.Lock(); _cache_lock=threading.Lock(); _stats_refresh_lock=threading.Lock(); _queries_refresh_lock=threading.Lock(); _blocking_lock=threading.Lock()
_stats_cache={'time':0.0,'data':None}; _queries_cache={}; _blocking_cache={}

def _int(value, default, minimum=100):
    try:
        value=int(value); return value if value>=minimum else default
    except (TypeError,ValueError): return default

def get_refresh_interval(): return _int(config.get('refresh_interval'),DEFAULT_REFRESH_INTERVAL)
def get_queries_refresh_interval(): return _int(config.get('queries_refresh_interval'),get_refresh_interval())
def get_cache_ttl():
    if 'cache_ttl' in config: return _int(config.get('cache_ttl'),DEFAULT_CACHE_TTL,0)
    return min(DEFAULT_CACHE_TTL,max(100,min(get_refresh_interval(),get_queries_refresh_interval())//2))
def resolve_secret(value):
    if isinstance(value,str) and value.startswith('${') and value.endswith('}'):
        return os.environ.get(value[2:-1],value)
    return value
def get_verify_setting(p):
    v=p.get('verify_ssl',False)
    if isinstance(v,str):
        if v.lower()=='true': return True
        if v.lower()=='false': return False
        return resolve_secret(v)
    return bool(v)
def headers(sid): return {} if sid==NO_PASSWORD else {'X-FTL-SID':sid}

def authenticate_and_get_sid(p):
    address=p['address'].rstrip('/')
    try:
        r=requests.post(address+'/api/auth',json={'password':resolve_secret(p.get('password',''))},timeout=DEFAULT_REQUEST_TIMEOUT,verify=get_verify_setting(p))
        if r.status_code==200:
            d=r.json(); sid=d.get('session',{}).get('sid')
            if sid: return sid
            if d.get('session',{}).get('message')=='no password set': return NO_PASSWORD
        return None
    except requests.exceptions.RequestException: return None

def get_sid(p,force=False):
    name=p['name']
    with _sessions_lock:
        if force: pihole_sessions.pop(name,None)
        sid=pihole_sessions.get(name)
    if sid: return sid
    sid=authenticate_and_get_sid(p)
    if sid:
        with _sessions_lock: pihole_sessions[name]=sid
    return sid

def pihole_get(p,path,params=None):
    sid=get_sid(p)
    if not sid: raise RuntimeError('authentication failed')
    args={'headers':headers(sid),'params':params,'timeout':DEFAULT_REQUEST_TIMEOUT,'verify':get_verify_setting(p)}
    r=requests.get(p['address'].rstrip('/')+path,**args)
    if r.status_code==401 and sid!=NO_PASSWORD:
        sid=get_sid(p,True)
        if not sid: raise RuntimeError('re-authentication failed')
        args['headers']=headers(sid); r=requests.get(p['address'].rstrip('/')+path,**args)
    r.raise_for_status(); return r

@bp.route('/')
def index():
    icon=(manifest_data.get('icons') or [{}])[0].get('src','')
    return index_template.replace('<head>',f'<head>\n    <base href="{escape(html_base)}">').replace('{{ICON_URL}}',escape(icon))
@bp.route('/manifest.json')
def serve_manifest():
    d=manifest_data.copy(); d['start_url']=html_base; return jsonify(d)
@bp.route('/sw.js')
def serve_sw(): return sw_template.replace('{{CACHE_URL}}',html_base),200,{'Content-Type':'application/javascript','Cache-Control':'no-cache'}
@bp.route('/css/<path:path>')
def send_css(path): return send_from_directory(os.path.join(APP_ROOT,'css'),path)
@bp.route('/js/<path:path>')
def send_js(path): return send_from_directory(os.path.join(APP_ROOT,'js'),path)
@bp.route('/favicon.ico')
def favicon(): return '',204

def enabled(): return [p for p in config.get('piholes',[]) if p.get('enabled',True)]
def filtered_config():
    out=[]
    for p in enabled():
        item={'name':p['name'],'enabled':True,'link':p.get('link',False)}
        if item['link']: item['address']=p['address']
        out.append(item)
    return {'refresh_interval':get_refresh_interval(),'queries_refresh_interval':get_queries_refresh_interval(),'show_queries':config.get('show_queries',False),'show_network_summary':config.get('show_network_summary',True),'show_trends':config.get('show_trends',True),'piholes':out}

def get_blocking(p):
    name=p['name']; now=time.monotonic()
    with _cache_lock:
        c=_blocking_cache.get(name)
        if c and now-c['time']<DEFAULT_BLOCKING_TTL/1000: return c['value']
    with _blocking_lock:
        try: value=pihole_get(p,'/api/dns/blocking').json().get('blocking')
        except Exception: value=None
        with _cache_lock: _blocking_cache[name]={'time':time.monotonic(),'value':value}
        return value

def fetch_one(p):
    start=time.perf_counter(); name=p['name']
    try:
        r=pihole_get(p,'/api/stats/summary'); latency=round((time.perf_counter()-start)*1000,1); d=r.json()
        d['_pi_dash']={'latency_ms':latency,'blocking':get_blocking(p),'health':'slow' if latency>=SLOW_RESPONSE_MS else 'healthy'}
        return name,d
    except RuntimeError as e: return name,{'error':str(e),'_pi_dash':{'health':'auth_error'}}
    except Exception as e: return name,{'error':str(e),'_pi_dash':{'health':'unreachable'}}

def _stats_uncached():
    items=enabled(); results={}
    if not items: return results
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(items),10)) as ex:
        for f in concurrent.futures.as_completed([ex.submit(fetch_one,p) for p in items]):
            n,d=f.result(); results[n]=d
    return results

def fetch_stats(force=False):
    ttl=get_cache_ttl()/1000; now=time.monotonic()
    with _cache_lock:
        if not force and _stats_cache['data'] is not None and now-_stats_cache['time']<ttl: return _stats_cache['data']
    with _stats_refresh_lock:
        now=time.monotonic()
        with _cache_lock:
            if not force and _stats_cache['data'] is not None and now-_stats_cache['time']<ttl: return _stats_cache['data']
        d=_stats_uncached()
        with _cache_lock: _stats_cache.update(time=time.monotonic(),data=d)
        return d

def _queries_uncached(length):
    items=enabled(); results={}
    if not items: return results
    hosts={urlparse(p['address']).hostname.lower() for p in items if urlparse(p['address']).hostname}
    def one(p):
        try:
            data=pihole_get(p,'/api/queries',{'length':length}).json(); out=[]
            for q in data.get('queries',[])[:length]:
                domain=q.get('domain',''); ts=q.get('time') or q.get('timestamp')
                if domain.lower().strip() in hosts: continue
                out.append({'id':q.get('id'),'domain':domain,'blocked':(q.get('status') or '').upper() in BLOCKED_STATUSES,'time':ts,'timestamp':ts,'upstream':q.get('upstream','')})
            return p['name'],out
        except Exception: return p['name'],[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(items),10)) as ex:
        for f in concurrent.futures.as_completed([ex.submit(one,p) for p in items]):
            n,d=f.result(); results[n]=d
    return results

def fetch_queries(length=50,force=False):
    ttl=get_cache_ttl()/1000; now=time.monotonic()
    with _cache_lock:
        c=_queries_cache.get(length)
        if not force and c and now-c['time']<ttl: return c['data']
    with _queries_refresh_lock:
        now=time.monotonic()
        with _cache_lock:
            c=_queries_cache.get(length)
            if not force and c and now-c['time']<ttl: return c['data']
        d=_queries_uncached(length)
        with _cache_lock: _queries_cache[length]={'time':time.monotonic(),'data':d}
        return d

def network_summary(data):
    total=blocked=cached=forwarded=healthy=slow=offline=0
    for d in data.values():
        if d.get('error') or not d.get('queries'): offline+=1; continue
        q=d['queries']; total+=int(q.get('total') or 0); blocked+=int(q.get('blocked') or 0); cached+=int(q.get('cached') or 0); forwarded+=int(q.get('forwarded') or 0)
        if d.get('_pi_dash',{}).get('health')=='slow': slow+=1
        else: healthy+=1
    return {'total_queries':total,'blocked_queries':blocked,'percent_blocked':round(blocked/total*100,1) if total else 0,'cached_queries':cached,'forwarded_queries':forwarded,'instances':len(data),'healthy_instances':healthy,'slow_instances':slow,'offline_instances':offline}

@bp.route('/init')
def init():
    try:
        stats=fetch_stats(); res={'config':filtered_config(),'data':stats,'summary':network_summary(stats)}
        if config.get('show_queries',False): res['queries']=fetch_queries(50)
        return jsonify(res)
    except Exception as e: return jsonify({'error':str(e)}),500
@bp.route('/data')
def data():
    try:
        stats=fetch_stats(); summary=request.args.get('include_summary','false').lower()=='true'; queries=request.args.get('include_queries','false').lower()=='true'
        if not summary and not queries: return jsonify(stats)
        res={'stats':stats}
        if summary: res['summary']=network_summary(stats)
        if queries: res['queries']=fetch_queries(max(1,min(int(request.args.get('length',50)),200)))
        return jsonify(res)
    except Exception as e: return jsonify({'error':str(e)}),500
@bp.route('/queries')
def queries():
    try: return jsonify(fetch_queries(max(1,min(int(request.args.get('length',50)),200))))
    except Exception as e: return jsonify({'error':str(e)}),500
@bp.route('/health')
def health(): return jsonify({'status':'ok','enabled_piholes':len(enabled()),'cache_ttl_ms':get_cache_ttl()})

app.register_blueprint(bp,url_prefix=url_prefix)

# Keep a root health endpoint for Docker/orchestrators even when the UI is
# hosted below a configured base_path such as /pi-dash/.
if url_prefix not in ('', '/'):
    app.add_url_rule('/health','root_health',health)

if __name__=='__main__': app.run(host='0.0.0.0',port=5001)
