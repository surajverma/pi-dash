"""Small, nullable views of optional Pi-hole v6 metrics (no credentials returned)."""
import ipaddress
import math

RANK_LIMIT = 1000
HISTORY_BUCKET = 600


def number(value, minimum=0):
    if value is None or isinstance(value, bool):
        return None
    try:
        value = float(value)
        return value if math.isfinite(value) and value >= minimum else None
    except (TypeError, ValueError):
        return None


def device_view(parts):
    system = parts.get('system', {}).get('system') or {}
    cpu = system.get('cpu') or {}
    ram = (system.get('memory') or {}).get('ram') or {}
    sensors = parts.get('sensors', {}).get('sensors') or {}
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
    limited = False
    for parts in snapshots.values():
        data = parts.get(kind)
        # Negative totals are Pi-hole's privacy sentinel. Never turn these into zeros.
        if not isinstance(data, dict) or number(data.get(denominator)) is None:
            continue
        rows = data.get(field)
        if not isinstance(rows, list):
            continue
        contributors += 1
        total += data[denominator]
        limited |= len(rows) >= RANK_LIMIT
        for row in rows:
            identity = _identity(row.get('ip') if kind == 'clients' else row.get('domain'))
            count = number(row.get('count'), 1)
            if not identity or count is None:
                continue
            label = str(row.get('name') or identity) if kind == 'clients' else identity
            item = merged.setdefault(identity, {'id': identity, 'label': label, 'count': 0})
            if item['label'] == identity and label != identity:
                item['label'] = label
            item['count'] += int(count)
    ranked = sorted(merged.values(), key=lambda row: (-row['count'], row['id']))[:5]
    for row in ranked:
        row['share'] = min(100, row['count'] / total * 100) if total else 0
    return {'items': ranked, 'contributors': contributors, 'instances': instance_count,
            'partial': contributors < instance_count or limited, 'limited': limited}


def combine_history(snapshots, instance_count):
    buckets = {}
    contributors = 0
    for parts in snapshots.values():
        data = parts.get('history', {}).get('history')
        if not isinstance(data, list):
            continue
        contributors += 1
        local = {}
        for row in data:
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
