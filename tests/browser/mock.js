/* Synthetic data only. Loaded before the unmodified production scripts. */
(() => {
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario') || 'normal';
  localStorage.theme = params.get('dark') === 'true' ? 'dark' : 'light';
  const count = scenario === 'zero' ? 0 : scenario === 'many' ? 6 : scenario === 'states' ? 5 : 2;
  const names = Array.from({ length: count }, (_, i) => scenario === 'long' ? `Pi-hole-${i}-with-a-very-long-unbroken-instance-name` : ['Primary', 'Secondary', 'Unreachable', 'Authentication', 'Unknown', 'Spare'][i]);
  const sample = () => ({ queries: { total: scenario === 'long' ? 987654321098765 : 89151, blocked: 23808, percent_blocked: 26.7, frequency: scenario === 'long' ? 123456789.1 : 5.6, cached: scenario === 'long' ? 123456789012345 : 45402, forwarded: scenario === 'long' ? 987654321098765 : 42939, unique_domains: 4281 }, clients: { active: 18 }, gravity: { domains_being_blocked: scenario === 'long' ? 987654321098765 : 1284390 }, _pi_dash: { blocking: true } });
  const data = Object.fromEntries(names.map(name => [name, sample()]));
  if (scenario === 'states') {
    data.Secondary._pi_dash.blocking = false;
    data.Unreachable = { error: 'unreachable', _pi_dash: { health: 'unreachable' } };
    data.Authentication = { error: 'authentication failed', _pi_dash: { health: 'auth_error' } };
    data.Unknown._pi_dash.blocking = null;
  }
  const queries = count ? { [names[0]]: Array.from({ length: 36 }, (_, i) => ({ id: i + 1, time: i + 1, domain: i > 32 ? 'repeat.example.org' : `query-${i}.example.org`, blocked: i < 10 })) } : {};
  const cfg = { refresh_interval: 2000, queries_refresh_interval: 3000, show_queries: true, show_network_summary: true, show_trends: true, piholes: names.map(name => ({ name, link: false, enabled: true })) };
  const summary = { total_queries: count * sample().queries.total, blocked_queries: count * 23808, percent_blocked: 26.7, cached_queries: count * sample().queries.cached, forwarded_queries: count * sample().queries.forwarded, instances: count, contributing_instances: scenario === 'states' ? 3 : count, offline_instances: scenario === 'states' ? 2 : 0, blocking_disabled_instances: scenario === 'states' ? 1 : 0, blocking_unknown_instances: scenario === 'states' ? 1 : 0, partial: scenario === 'states' };
  const native = params.get('native') === 'true';
  const realSetInterval = window.setInterval.bind(window), realClearInterval = window.clearInterval.bind(window);
  let hidden = false, online = true, nextTimer = 0;
  const timers = new Map(), calls = [], deferred = new Map();
  if (!native) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  }
  Object.defineProperty(navigator, 'serviceWorker', { value: { register: async () => ({}) } });
  window.setInterval = (fn, ms) => { const id = native ? realSetInterval(fn, ms) : ++nextTimer; timers.set(id, { fn, ms }); return id; };
  window.clearInterval = id => { if (native) realClearInterval(id); timers.delete(id); };
  window.fetch = async (url, options) => {
    const type = url.split('?')[0];
    calls.push({ type, signal: options.signal });
    if (deferred.has(type)) return new Promise((resolve, reject) => Object.assign(deferred.get(type), { resolve, reject }));
    return { ok: true, json: async () => type === 'init' ? { config: cfg, data, summary, queries } : type === 'data' ? { stats: data, summary } : queries };
  };
  if (native) document.addEventListener('DOMContentLoaded', () => {
    const output = document.createElement('output');
    output.id = 'native-polling';
    output.style.cssText = 'display:block;overflow-wrap:anywhere;font:12px monospace';
    document.body.append(output);
    const transitions = [];
    const report = () => { output.textContent = JSON.stringify({ hidden: document.hidden, online: navigator.onLine, calls: calls.length, timers: timers.size, transitions }); };
    document.addEventListener('visibilitychange', () => {
      setTimeout(() => { transitions.push({ hidden: document.hidden, calls: calls.length, timers: timers.size }); report(); }, 0);
    });
    realSetInterval(report, 250);
  });
  window.fixture = {
    timers, calls, data, queries, summary,
    hide(value) { hidden = value; document.dispatchEvent(new Event('visibilitychange')); },
    online(value) { online = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')); },
    defer(type) { const request = {}; deferred.set(type, request); return request; },
    release(type) { deferred.delete(type); },
    async tick(ms) { await Promise.all([...timers.values()].filter(t => t.ms === ms).map(t => t.fn())); },
  };
})();
