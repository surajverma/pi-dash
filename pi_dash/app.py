from flask import Flask, jsonify, send_from_directory, request, Blueprint
from markupsafe import escape
import os
from . import cache, config as settings
from .aggregate import network_summary

app = Flask(__name__)
bp = Blueprint('pi-dash', __name__)
with open(os.path.join(settings.WEB_ROOT, 'index.html'), encoding='utf-8') as handle:
    index_template = handle.read()
with open(os.path.join(settings.WEB_ROOT, 'sw.js'), encoding='utf-8') as handle:
    sw_template = handle.read()


@bp.route('/')
def index():
    return index_template.replace('<head>', f'<head>\n    <base href="{escape(settings.html_base)}">')


@bp.route('/manifest.json')
def serve_manifest():
    data = settings.manifest_data.copy()
    data['start_url'] = settings.html_base
    data['scope'] = settings.html_base
    data['id'] = settings.html_base
    return jsonify(data)


@bp.route('/sw.js')
def serve_sw():
    return sw_template.replace('{{CACHE_URL}}', settings.html_base), 200, {'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache'}


@bp.route('/css/<path:path>')
def send_css(path):
    return send_from_directory(os.path.join(settings.WEB_ROOT, 'css'), path)


@bp.route('/js/<path:path>')
def send_js(path):
    return send_from_directory(os.path.join(settings.WEB_ROOT, 'js'), path)


@bp.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(settings.WEB_ROOT, 'icons'), 'favicon.ico')


@bp.route('/icons/<path:path>')
def send_icon(path):
    return send_from_directory(os.path.join(settings.WEB_ROOT, 'icons'), path)


@bp.route('/devices')
def devices():
    if not settings.config.get('show_device_metrics', True):
        return jsonify({'devices': {}}), 200, {'Cache-Control': 'no-store'}
    return jsonify(cache.fetch_optional('devices')), 200, {'Cache-Control': 'no-store'}


@bp.route('/insights')
def insights():
    if not settings.config.get('show_network_summary', True) or not settings.config.get('show_network_insights', False):
        return jsonify({'disabled': True}), 200, {'Cache-Control': 'no-store'}
    return jsonify(cache.fetch_optional('insights')), 200, {'Cache-Control': 'no-store'}


@bp.route('/init')
def init():
    try:
        stats = cache.fetch_stats()
        result = {'config': settings.filtered_config(), 'data': stats, 'summary': network_summary(stats)}
        if settings.config.get('show_queries', False):
            result['queries'] = cache.fetch_queries(50)
        return jsonify(result)
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@bp.route('/data')
def data():
    try:
        stats = cache.fetch_stats()
        include_summary = request.args.get('include_summary', 'false').lower() == 'true'
        include_queries = request.args.get('include_queries', 'false').lower() == 'true'
        if not include_summary and not include_queries:
            return jsonify(stats)
        result = {'stats': stats}
        if include_summary:
            result['summary'] = network_summary(stats)
        if include_queries:
            length = settings._bounded_int(request.args.get('length'), 50, 1, 200)
            result['queries'] = cache.fetch_queries(length)
        return jsonify(result)
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@bp.route('/queries')
def queries():
    try:
        length = settings._bounded_int(request.args.get('length'), 50, 1, 200)
        return jsonify(cache.fetch_queries(length))
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@bp.route('/health')
def health():
    return jsonify({'status': 'ok', 'enabled_piholes': len(settings.enabled()), 'cache_ttl_ms': settings.get_cache_ttl()})


app.register_blueprint(bp, url_prefix=settings.url_prefix)
if settings.url_prefix not in ('', '/'):
    app.add_url_rule('/health', 'root_health', health)
