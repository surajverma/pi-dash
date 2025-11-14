from flask import Flask, jsonify, send_from_directory, request, Blueprint
from markupsafe import escape
import requests
from flask_cors import CORS
import os
import json
import concurrent.futures

# Constants
NO_PASSWORD = "NO_PASSWORD"
# Define blocked status codes according to Pi-hole API documentation
BLOCKED_STATUSES = {
    'GRAVITY', 'REGEX', 'DENYLIST', 
    'EXTERNAL_BLOCKED_IP', 'EXTERNAL_BLOCKED_NULL', 'EXTERNAL_BLOCKED_NXRA',
    'GRAVITY_CNAME', 'REGEX_CNAME', 'DENYLIST_CNAME',
    'DBBUSY', 'SPECIAL_DOMAIN', 'EXTERNAL_BLOCKED_EDE15'
}

app = Flask(__name__)
CORS(app)


APP_ROOT = os.path.dirname(os.path.realpath(__file__))


with open(os.path.join(APP_ROOT, 'config.json')) as f:
    config = json.load(f)

with open(os.path.join(APP_ROOT, 'manifest.json')) as f:
    manifest_data = json.load(f)

with open(os.path.join(APP_ROOT, 'index.html')) as f:
    index_template = f.read()

with open(os.path.join(APP_ROOT, 'sw.js')) as f:
    sw_template = f.read()


base_path_config = config.get('base_path', '/')
url_prefix = base_path_config
if url_prefix != '/' and url_prefix.endswith('/'):
    url_prefix = url_prefix[:-1]

html_base = base_path_config
if not html_base.endswith('/'):
    html_base += '/'

bp = Blueprint('pi-dash', __name__)
pihole_sessions = {}


def authenticate_and_get_sid(address, password):
    auth_url = f"{address}/api/auth"
    payload = {"password": password}
    try:
        response = requests.post(auth_url, json=payload, timeout=10, verify=False)
        if response.status_code == 200:
            data = response.json()
            new_sid = data.get("session", {}).get("sid")            
            if new_sid:
                print(f"Successfully authenticated with {address} and got new SID.")
                return new_sid
            elif data.get("session", {}).get("message") == "no password set":
                print(f"Pi-hole at {address} has no password set.")
                return NO_PASSWORD
            else:
                print(f"Authentication with {address} returned 200 OK but no SID found. Response: {data}")
                return None
        elif response.status_code == 401:
            print(f"Authentication failed for {address}: Incorrect Password (401 Unauthorized). Please check your password in config.json.")
            return None
        else:
            print(f"Authentication failed for {address} with status code {response.status_code}. Response: {response.text}")
            return None
    except requests.exceptions.RequestException as e:
        print(f"A network error occurred during authentication with {address}: {e}")
        return None

# -- Frontend Routes --
@bp.route('/')
def index():
    
    icon_url = ''
    if manifest_data.get('icons'):
        icon_url = manifest_data['icons'][0].get('src', '')
    
    
    base_tag = f'<base href="{escape(html_base)}">' 
    temp_html = index_template.replace('<head>', f'<head>\n    {base_tag}')
    final_html = temp_html.replace('{{ICON_URL}}', escape(icon_url))
    
    return final_html

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

# -- API Routes --
def get_filtered_config():
    
    piholes_filtered = []
    for p in config["piholes"]:
        if not p.get("enabled", True):
            continue
        item = {
            "name": p["name"],
            "enabled": p["enabled"],
            "link": p.get("link", False)
        }
        if item["link"]:
            
            item["address"] = p["address"]
        piholes_filtered.append(item)
    return {
        "refresh_interval": config.get("refresh_interval", 5000),
        "piholes": piholes_filtered,
        "show_queries": config.get("show_queries", False)
    }

def get_pihole_data(address, sid):
    url = f"{address}/api/stats/summary"
    headers = {} if sid == NO_PASSWORD else {'X-FTL-SID': sid}
    return requests.get(url, headers=headers, timeout=10, verify=False)

def fetch_all_pihole_data():
    enabled_piholes = [p for p in config['piholes'] if p.get('enabled', True)]
    results = {}
    
    def fetch_single_pihole(pihole_config):
        name = pihole_config['name']
        address = pihole_config['address']
        password = pihole_config['password']
        
        
        sid = pihole_sessions.get(name)
        if not sid:
            sid = authenticate_and_get_sid(address, password)
            if not sid:
                return name, {"error": f"Authentication failed for Pi-hole '{name}'"}
            pihole_sessions[name] = sid
        
        try:
            response = get_pihole_data(address, sid)
            if response.status_code == 401 and sid != NO_PASSWORD:
                
                print(f"SID for Pi-hole '{name}' expired. Re-authenticating...")
                sid = authenticate_and_get_sid(address, password)
                if not sid:
                    return name, {"error": f"Re-authentication failed for Pi-hole '{name}'"}
                pihole_sessions[name] = sid
                response = get_pihole_data(address, sid)
            
            response.raise_for_status()
            return name, response.json()
        except requests.exceptions.RequestException as e:
            return name, {"error": str(e)}
    
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(enabled_piholes), 10)) as executor:
        future_to_pihole = {
            executor.submit(fetch_single_pihole, pihole): pihole 
            for pihole in enabled_piholes
        }
        
        for future in concurrent.futures.as_completed(future_to_pihole):
            name, data = future.result()
            results[name] = data
    
    return results

def fetch_recent_queries(length=50):
    """Fetch recent queries from all enabled Pi-holes.

    Returns a dict mapping pihole name to list of queries. Each query is
    represented minimally with keys: domain, status (blocked or allowed)
    and optionally type/time if available.
    """
    enabled_piholes = [p for p in config['piholes'] if p.get('enabled', True)]
    results = {}
    
    # Extract all Pi-hole hostnames to filter cross-Pi-hole queries
    from urllib.parse import urlparse
    pihole_hostnames = set()
    for p in enabled_piholes:
        parsed = urlparse(p['address'])
        hostname = parsed.hostname or parsed.netloc.split(':')[0] if parsed.netloc else None
        if hostname:
            pihole_hostnames.add(hostname.lower())

    def fetch_queries_for_pihole(pihole_config):
        name = pihole_config['name']
        address = pihole_config['address']
        password = pihole_config['password']

        sid = pihole_sessions.get(name)
        if not sid:
            sid = authenticate_and_get_sid(address, password)
            if not sid:
                return name, []
            pihole_sessions[name] = sid
        headers = {} if sid == NO_PASSWORD else {'X-FTL-SID': sid}
        url = f"{address}/api/queries?length={length}"
        try:
            r = requests.get(url, headers=headers, timeout=10, verify=False)
            if r.status_code == 401 and sid != NO_PASSWORD:
                # attempt re-auth
                sid = authenticate_and_get_sid(address, password)
                if not sid:
                    return name, []
                pihole_sessions[name] = sid
                headers = {} if sid == NO_PASSWORD else {'X-FTL-SID': sid}
                r = requests.get(url, headers=headers, timeout=10, verify=False)
            r.raise_for_status()
            data = r.json()
            
            normalized = []
            filtered_count = 0
            for q in data.get('queries', [])[:length]:
                original_domain = q.get('domain', '')
                domain = original_domain.lower().strip()
                status = (q.get('status') or '').upper()
                ts = q.get('time') or q.get('timestamp')
                upstream = q.get('upstream', '')
                qid = q.get('id')
                
                # Skip queries to ANY Pi-hole hostname (not just this one)
                if domain in pihole_hostnames:
                    continue
                
                # Check if status matches any blocked status
                blocked = status in BLOCKED_STATUSES
                
                normalized.append({
                    'id': qid,
                    'domain': original_domain,  # preserve original casing for display
                    'blocked': blocked,
                    'time': ts,
                    'timestamp': ts,  # legacy compatibility
                    'upstream': upstream
                })
            
            return name, normalized
        except requests.exceptions.RequestException:
            return name, []

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(enabled_piholes), 10)) as executor:
        future_to_pihole = {executor.submit(fetch_queries_for_pihole, p): p for p in enabled_piholes}
        for future in concurrent.futures.as_completed(future_to_pihole):
            name, data = future.result()
            results[name] = data
    return results

@bp.route('/init')
def init():
    try:
        filtered_config = get_filtered_config()
        pihole_data = fetch_all_pihole_data()
        
        return jsonify({
            "config": filtered_config,
            "data": pihole_data
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@bp.route('/data')
def data():
    try:
        pihole_data = fetch_all_pihole_data()
        
        
        include_queries = request.args.get('include_queries', 'false').lower() == 'true'
        if include_queries:
            length = int(request.args.get('length', 50))
            length = max(1, min(length, 200))
            queries_data = fetch_recent_queries(length=length)
            return jsonify({
                "stats": pihole_data,
                "queries": queries_data
            })
        
        return jsonify(pihole_data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@bp.route('/queries')
def queries():
    try:
        length = int(request.args.get('length', 50))
        length = max(1, min(length, 200))  # clamp
        queries_data = fetch_recent_queries(length=length)
        return jsonify(queries_data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


app.register_blueprint(bp, url_prefix=url_prefix)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001)
