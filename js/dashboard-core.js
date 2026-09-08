/* Pure dashboard helpers shared by the browser and Node regression tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PiDashCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function summaryStats(raw) {
    const q = raw?.queries || {};
    const clients = raw?.clients || {};
    const gravity = raw?.gravity || {};
    return {
      total: finite(q.total), blocked: finite(q.blocked),
      percentage: finite(q.percent_blocked), clients: finite(clients.active),
      rate: finite(q.frequency), cached: finite(q.cached),
      forwarded: finite(q.forwarded), unique: finite(q.unique_domains),
      domains: finite(gravity.domains_being_blocked),
    };
  }

  function formatRate(rate) {
    const value = Math.max(0, finite(rate));
    return value < 1 ? `${(value * 60).toFixed(1)}/min` : `${value.toFixed(1)}/sec`;
  }

  function healthPresentation(meta = {}, hasError = false) {
    if (hasError || meta.health === 'auth_error') {
      return { state: 'danger', text: meta.health === 'auth_error' ? 'Auth failed' : 'Offline' };
    }
    if (meta.health === 'unreachable') return { state: 'danger', text: 'Offline' };
    if (meta.blocking === false || meta.health === 'blocking_disabled') {
      return { state: 'warning', text: 'Blocking OFF' };
    }
    if (meta.blocking === true) return { state: 'success', text: 'Blocking ON' };
    return { state: 'neutral', text: 'Online · blocking unknown' };
  }

  function networkStatus(summary) {
    const total = finite(summary?.instances);
    const reporting = finite(summary?.contributing_instances, total - finite(summary?.offline_instances));
    if (!total) return 'No active Pi-holes';
    const parts = [`${reporting} of ${total} reporting`];
    if (summary?.blocking_disabled_instances) parts.push(`${summary.blocking_disabled_instances} blocking off`);
    if (summary?.offline_instances) parts.push(`${summary.offline_instances} offline`);
    if (summary?.blocking_unknown_instances) parts.push(`${summary.blocking_unknown_instances} blocking unknown`);
    if (!summary?.partial && !summary?.blocking_disabled_instances && !summary?.offline_instances && !summary?.blocking_unknown_instances) {
      return `${total} healthy`;
    }
    return parts.join(' · ');
  }

  function queryTimestamp(query) {
    return finite(query.time ?? query.timestamp, 0);
  }

  function queryIdentity(query) {
    const id = query.id;
    if (id !== null && id !== undefined && id !== '' && Number.isFinite(Number(id))) {
      return `id:${String(id)}`;
    }
    const client = typeof query.client === 'object' ? query.client?.ip : query.client;
    return JSON.stringify(['time', query.time ?? query.timestamp ?? '', query.type ?? '', client ?? '', query.domain ?? '', Boolean(query.blocked)]);
  }

  function queryKey(query) {
    return JSON.stringify([query.piholeName, String(query.domain || '').toLowerCase(), Boolean(query.blocked)]);
  }

  function queryLabel(query) {
    return `[${query.piholeName}] ${query.domain || ''}`;
  }

  function groupConsecutiveQueries(events) {
    const groups = [];
    for (const event of events) {
      const key = queryKey(event);
      const previous = groups[groups.length - 1];
      if (previous && previous.key === key) previous.count += 1;
      else groups.push({ key, label: queryLabel(event), blocked: Boolean(event.blocked), count: 1 });
    }
    return groups;
  }

  function mergeConsecutiveGroups(existing, incoming, maxRows = 100) {
    const rows = existing.map(row => ({ ...row }));
    for (const group of incoming) {
      const last = rows[rows.length - 1];
      if (last && last.key === group.key) last.count += group.count;
      else rows.push({ ...group });
    }
    return rows.slice(-maxRows);
  }

  function createQueryTracker() {
    return { cursors: new Map(), seen: new Map() };
  }

  function collectNewQueries(tracker, allQueries, maxSeen = 1000) {
    const incoming = [];
    let order = 0;
    for (const [piholeName, queries] of Object.entries(allQueries || {})) {
      if (!Array.isArray(queries)) continue;
      let cursor = tracker.cursors.get(piholeName) || { id: null, time: -Infinity };
      let seen = tracker.seen.get(piholeName) || new Map();
      const valid = queries.filter(q => q && typeof q === 'object');
      const ids = valid.filter(q => q.id != null && q.id !== '' && Number.isFinite(Number(q.id))).map(q => Number(q.id));
      const newestTime = valid.reduce((max, q) => Math.max(max, queryTimestamp(q)), cursor.time);
      // A newer snapshot whose entire ID range is lower may indicate a DB reset.
      if (cursor.id !== null && ids.length && Math.max(...ids) < cursor.id && newestTime > cursor.time) {
        cursor = { id: null, time: cursor.time };
        seen = new Map();
      }
      let maxId = cursor.id;
      let maxTime = cursor.time;
      for (const query of valid) {
        const identity = queryIdentity(query);
        const timestamp = queryTimestamp(query);
        const id = query.id != null && query.id !== '' && Number.isFinite(Number(query.id)) ? Number(query.id) : null;
        const isNew = id !== null ? (cursor.id === null || id > cursor.id) : timestamp > cursor.time;
        if (isNew && !seen.has(identity)) {
          incoming.push({ ...query, piholeName, __order: order++, __time: timestamp, __id: id ?? 0 });
        }
        seen.delete(identity);
        seen.set(identity, true);
        if (id !== null && (maxId === null || id > maxId)) maxId = id;
        maxTime = Math.max(maxTime, timestamp);
      }
      while (seen.size > maxSeen) seen.delete(seen.keys().next().value);
      tracker.cursors.set(piholeName, { id: maxId, time: maxTime });
      tracker.seen.set(piholeName, seen);
    }
    // IDs are local to each Pi-hole database, never a cross-instance clock.
    incoming.sort((a, b) => a.__time - b.__time ||
      (a.piholeName === b.piholeName ? a.__id - b.__id : 0) || a.__order - b.__order);
    return incoming;
  }

  return {
    summaryStats, formatRate, healthPresentation, networkStatus,
    queryIdentity, queryTimestamp, queryKey, queryLabel,
    groupConsecutiveQueries, mergeConsecutiveGroups,
    createQueryTracker, collectNewQueries,
  };
});