"""Small, nullable views of optional Pi-hole v6 metrics (no credentials returned)."""
import ipaddress
import math

RANK_LIMIT = 100
HISTORY_BUCKET = 600


def number(value, minimum=0):
    if value is None or isinstance(value, bool):
        return None
    try:
        value = float(value)
        return value if math.isfinite(value) and value >= minimum else None
    except (TypeError, ValueError):
        return None


def mapping(value):
    return value if isinstance(value, dict) else {}


def device_view(parts):
    system = mapping(mapping(parts.get('system')).get('system'))
    cpu = mapping(system.get('cpu'))
    ram = mapping(mapping(system.get('memory')).get('ram'))
    sensors = mapping(mapping(parts.get('sensors')).get('sensors'))
    # Pi-hole reports summed CPU use across cores; show a device-wide 0-100%.
    usage, cores = number(cpu.get('%cpu')), number(cpu.get('nprocs'), 1)
    cpu_percent = min(100, usage / cores) if usage is not None and cores else None
    ram_percent = number(ram.get('%used'))
    if ram_percent is not None and ram_percent > 100:
        ram_percent = None
    return {
        'cpu_percent': cpu_percent,
        'ram_percent': ram_percent,
        'temperature': number(sensors.get('cpu_temp'), -100),
        'temperature_unit': sensors.get('unit') if sensors.get('unit') in ('C', 'F', 'K') else 'C',
        'uptime_seconds': number(system.get('uptime')),
        'unavailable': [key for key in ('system', 'sensors') if key not in parts],
    }


def _identity(value):
    value = str(value or '').strip()
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return value.casefold().rstrip('.')


def combine_rankings(snapshots, kind, instance_count):
    field = 'clients' if kind == 'clients' else 'domains'
    denominator = 'total_queries' if kind == 'clients' else 'blocked_queries'
    merged = {}
    total = contributors = 0
    sources = []
    for parts in snapshots.values():
        data = parts.get(kind)
        # Negative totals are Pi-hole's privacy sentinel. Never turn these into zeros.
        if not isinstance(data, dict) or number(data.get(denominator)) is None:
            continue
        rows = data.get(field)
        if not isinstance(rows, list):
            continue
        contributors += 1
        total += number(data[denominator])
        seen = set()
        counts = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            threshold_count = number(row.get('count'))
            if threshold_count is not None:
                counts.append(threshold_count)
            identity = _identity(row.get('ip') if kind == 'clients' else row.get('domain'))
            count = number(row.get('count'), 1)
            if not identity or count is None:
                continue
            seen.add(identity)
            label = str(row.get('name') or identity) if kind == 'clients' else identity
            item = merged.setdefault(identity, {'id': identity, 'label': label, 'count': 0})
            if item['label'] == identity and label != identity:
                item['label'] = label
            item['count'] += int(count)
        sources.append((min(counts) if len(rows) >= RANK_LIMIT and counts else 0, seen))
    ordered = sorted(merged.values(), key=lambda row: (-row['count'], row['id']))
    ranked = ordered[:5]
    # Omitted items cannot exceed the smallest returned count on each source.
    def upper(row):
        return row['count'] + sum(threshold for threshold, seen in sources if row['id'] not in seen)
    unseen = sum(threshold for threshold, _ in sources)
    outside = max([unseen, *[upper(row) for row in ordered[5:]]]) if len(ranked) == 5 else unseen
    cutoff = ranked[-1]['count'] if ranked else 0
    limited = contributors > 1 and cutoff < outside
    for row in ranked:
        row['share'] = min(100, row['count'] / total * 100) if total else 0
    return {'items': ranked, 'contributors': contributors, 'instances': instance_count,
            'partial': contributors < instance_count, 'limited': limited}


def combine_history(snapshots, instance_count):
    buckets = {}
    contributors = 0
    for parts in snapshots.values():
        data = mapping(parts.get('history')).get('history')
        if not isinstance(data, list):
            continue
        contributors += 1
        local = {}
        for row in data:
            if not isinstance(row, dict):
                continue
            stamp, total, blocked = (number(row.get(key)) for key in ('timestamp', 'total', 'blocked'))
            if stamp is None or total is None or blocked is None:
                continue
            stamp = int(stamp // HISTORY_BUCKET * HISTORY_BUCKET)
            point = local.setdefault(stamp, {'total': 0, 'blocked': 0})
            point['total'] += total
            point['blocked'] += blocked
        for stamp, point in local.items():
            target = buckets.setdefault(stamp, {'timestamp': stamp, 'total': 0, 'blocked': 0, 'contributors': 0})
            target['total'] += int(point['total'])
            target['blocked'] += int(point['blocked'])
            target['contributors'] += 1
    points = [buckets[stamp] for stamp in sorted(buckets)]
    # A single very old point must not stretch the whole graph indefinitely.
    if points:
        points = [p for p in points if p['timestamp'] >= points[-1]['timestamp'] - 86400]
    return {'points': points, 'contributors': contributors, 'instances': instance_count,
            'partial': contributors < instance_count or any(p['contributors'] < instance_count for p in points)}


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
