document.addEventListener('DOMContentLoaded', () => {
  let statsTimer = null;
  let queriesTimer = null;
  let stalenessTimer = null;
  let appConfig = null;
  let statsFetching = false;
  let queriesFetching = false;
  let lastUpdateTime = null;
  let queryFeedPaused = false;
  const lastCursorByPihole = {};
  const trendHistory = {};
  const MAX_TREND_POINTS = 30;

  async function fetchData(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function summaryStats(raw) {
    if (!raw || !raw.queries) return { total: 0, blocked: 0, percentage: 0, clients: 0, rate: 0, cached: 0, forwarded: 0, unique: 0, domains: 0 };
    const q = raw.queries || {};
    const clients = raw.clients || {};
    const gravity = raw.gravity || {};
    return {
      total: Number(q.total) || 0,
      blocked: Number(q.blocked) || 0,
      percentage: Number(q.percent_blocked) || 0,
      clients: Number(clients.active) || 0,
      rate: Number(q.frequency) || 0,
      cached: Number(q.cached) || 0,
      forwarded: Number(q.forwarded) || 0,
      unique: Number(q.unique_domains) || 0,
      domains: Number(gravity.domains_being_blocked) || 0,
    };
  }

  function healthPresentation(meta = {}, hasError = false) {
    if (hasError || meta.health === 'unreachable' || meta.health === 'auth_error') return { dot: 'bg-red-500', text: meta.health === 'auth_error' ? 'Auth failed' : 'Offline', textClass: 'text-red-500' };
    if (meta.blocking === false) return { dot: 'bg-yellow-500', text: 'Blocking OFF', textClass: 'text-yellow-600 dark:text-yellow-500' };
    if (meta.health === 'slow') return { dot: 'bg-yellow-500', text: 'Slow', textClass: 'text-yellow-600 dark:text-yellow-500' };
    return { dot: 'bg-green-500', text: meta.blocking === true ? 'Blocking ON' : 'Online', textClass: 'text-green-600 dark:text-green-500' };
  }

  function addTrend(name, value) {
    if (!trendHistory[name]) trendHistory[name] = [];
    trendHistory[name].push(value);
    if (trendHistory[name].length > MAX_TREND_POINTS) trendHistory[name].shift();
  }

  function renderSparkline(name, el) {
    if (!el || !appConfig.show_trends) return;
    const values = trendHistory[name] || [];
    if (values.length < 2) { el.innerHTML = ''; return; }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${24 - ((v - min) / range) * 20}`).join(' ');
    el.innerHTML = `<svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" /></svg>`;
  }

  function updatePiholeUI(name, raw) {
    const section = document.getElementById(`pihole-${CSS.escape(name)}-section`);
    if (!section) return;
    const meta = raw?._pi_dash || {};
    const hasError = !!raw?.error;
    const status = healthPresentation(meta, hasError);
    const dot = section.querySelector('.status-dot');
    const health = section.querySelector('.pihole-health');
    const latency = section.querySelector('.pihole-latency');
    dot.className = `status-dot ${status.dot}`;
    health.className = `pihole-health text-xs ${status.textClass}`;
    health.textContent = status.text;
    latency.textContent = Number.isFinite(Number(meta.latency_ms)) ? `${Number(meta.latency_ms).toFixed(0)} ms` : '-- ms';

    if (hasError) {
      section.querySelectorAll('[data-metric]').forEach(el => el.textContent = el.dataset.metric === 'percent' ? '--%' : '--');
      section.querySelector('.pihole-cache').textContent = '-- / --';
      section.querySelector('.pihole-rate').textContent = '(--/sec)';
      return;
    }

    const s = summaryStats(raw);
    let rateValue, rateUnit;
    if (s.rate < 1) { rateValue = (s.rate * 60).toFixed(1); rateUnit = '/min'; }
    else { rateValue = s.rate.toFixed(1); rateUnit = '/sec'; }
    section.querySelector('.pihole-rate').textContent = `(${rateValue}${rateUnit})`;
    section.querySelector('.pihole-total').textContent = s.total.toLocaleString();
    section.querySelector('.pihole-blocked').textContent = s.blocked.toLocaleString();
    section.querySelector('.pihole-percent').textContent = `${s.percentage.toFixed(1)}%`;
    section.querySelector('.pihole-clients').textContent = s.clients.toLocaleString();
    section.querySelector('.pihole-cache').textContent = `${s.cached.toLocaleString()} / ${s.forwarded.toLocaleString()}`;
    section.querySelector('.pihole-unique').textContent = s.unique.toLocaleString();
    section.querySelector('.pihole-domains').textContent = s.domains.toLocaleString();
    addTrend(name, s.rate);
    renderSparkline(name, section.querySelector('.pihole-sparkline'));
  }

  function updateNetworkSummary(summary) {
    const el = document.getElementById('network-summary');
    if (!el || !appConfig.show_network_summary || !summary) return;
    el.classList.remove('hidden');
    el.querySelector('.network-total').textContent = Number(summary.total_queries || 0).toLocaleString();
    el.querySelector('.network-blocked').textContent = Number(summary.blocked_queries || 0).toLocaleString();
    el.querySelector('.network-percent').textContent = `${Number(summary.percent_blocked || 0).toFixed(1)}%`;
    el.querySelector('.network-cache').textContent = `${Number(summary.cached_queries || 0).toLocaleString()} / ${Number(summary.forwarded_queries || 0).toLocaleString()}`;
    const parts = [];
    if (summary.healthy_instances) parts.push(`${summary.healthy_instances} healthy`);
    if (summary.slow_instances) parts.push(`${summary.slow_instances} slow`);
    if (summary.offline_instances) parts.push(`${summary.offline_instances} offline`);
    el.querySelector('.network-health').textContent = parts.join(' · ') || 'No active Pi-holes';
  }

  function updateTimestamp() {
    lastUpdateTime = Date.now();
    const el = document.getElementById('last-updated');
    el.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
    el.className = 'text-xs text-gray-500 dark:text-gray-400';
  }

  function updateStaleness() {
    if (!lastUpdateTime || !appConfig) return;
    if (Date.now() - lastUpdateTime > (appConfig.refresh_interval || 5000) * 2) {
      document.getElementById('last-updated').className = 'text-xs text-yellow-600 dark:text-yellow-500';
    }
  }

  async function refreshStats() {
    if (statsFetching) return;
    statsFetching = true;
    try {
      const payload = await fetchData('data?include_summary=true');
      for (const [name, raw] of Object.entries(payload.stats || {})) updatePiholeUI(name, raw);
      updateNetworkSummary(payload.summary);
      updateTimestamp();
    } catch (e) {
      console.error('Failed to refresh stats:', e);
    } finally { statsFetching = false; }
  }

  async function refreshQueries() {
    if (!appConfig?.show_queries || queriesFetching) return;
    queriesFetching = true;
    try { renderQueries(await fetchData('queries?length=50')); }
    catch (e) { console.error('Failed to refresh queries:', e); }
    finally { queriesFetching = false; }
  }

  function startTimers() {
    if (!appConfig) return;
    if (!statsTimer) statsTimer = setInterval(refreshStats, appConfig.refresh_interval || 5000);
    if (appConfig.show_queries && !queriesTimer) queriesTimer = setInterval(refreshQueries, appConfig.queries_refresh_interval || appConfig.refresh_interval || 5000);
    if (!stalenessTimer) stalenessTimer = setInterval(updateStaleness, 1000);
  }

  function stopTimers() {
    clearInterval(statsTimer); clearInterval(queriesTimer); clearInterval(stalenessTimer);
    statsTimer = queriesTimer = stalenessTimer = null;
  }

  function renderQueries(allQueries) {
    const container = document.getElementById('background-queries');
    if (!container || queryFeedPaused) return;
    const newItems = [];
    const pending = {};
    for (const [name, queries] of Object.entries(allQueries || {})) {
      if (!Array.isArray(queries)) continue;
      const last = lastCursorByPihole[name] ?? -Infinity;
      let max = last;
      for (const q of queries) {
        const id = q.id !== null && q.id !== undefined ? Number(q.id) : null;
        const time = q.time !== null && q.time !== undefined ? Number(q.time) : null;
        const cursor = id !== null ? id : (time !== null ? time : -Infinity);
        if (cursor > last) newItems.push({ ...q, piholeName: name, __cursor: cursor });
        if (cursor > max) max = cursor;
      }
      pending[name] = max;
    }
    if (!newItems.length) return;
    Object.assign(lastCursorByPihole, pending);
    newItems.sort((a,b) => a.__cursor - b.__cursor);
    for (const item of newItems) {
      const li = document.createElement('li');
      li.className = `query-row ${item.blocked ? 'text-red-600 dark:text-red-500' : 'text-green-600 dark:text-green-500'}`;
      li.textContent = `[${item.piholeName}] ${item.domain || ''}`;
      container.appendChild(li);
    }
    while (container.children.length > 100) container.removeChild(container.firstChild);
  }

  function createCard(p) {
    const section = document.createElement('section');
    section.id = `pihole-${p.name}-section`;
    section.className = 'bg-white dark:bg-gray-900 p-4 rounded-lg shadow-lg w-full';
    const safeName = escapeHtml(p.name);
    const name = p.link ? `<a href="${escapeHtml(p.address)}/admin" target="_blank" rel="noopener noreferrer" class="hover:text-teal-500">${safeName}</a>` : safeName;
    section.innerHTML = `
      <div class="flex justify-between gap-3 mb-3">
        <div><h2 class="text-xl font-semibold text-gray-700 dark:text-cyan-400">${name} <span class="pihole-rate text-sm font-normal text-gray-500 dark:text-gray-400">(--/sec)</span></h2><div class="flex gap-2 items-center"><span class="status-dot bg-gray-500"></span><span class="pihole-health text-xs text-gray-500">Checking</span><span class="pihole-latency text-xs text-gray-400">-- ms</span></div></div>
        <div class="pihole-sparkline text-teal-500 w-20 h-7"></div>
      </div>
      <div class="space-y-1.5 text-sm">
        <div class="metric-row"><span>Total Queries</span><span data-metric="total" class="pihole-total text-blue-500">--</span></div>
        <div class="metric-row"><span>Queries Blocked</span><span data-metric="blocked" class="pihole-blocked text-red-500">--</span></div>
        <div class="metric-row"><span>Percent Blocked</span><span data-metric="percent" class="pihole-percent text-yellow-600 dark:text-yellow-500">--%</span></div>
        <div class="metric-row"><span>Cached / Forwarded</span><span class="pihole-cache text-indigo-500">-- / --</span></div>
        <div class="metric-row"><span>Unique Domains</span><span data-metric="unique" class="pihole-unique text-orange-500">--</span></div>
        <div class="metric-row"><span>Active Clients</span><span data-metric="clients" class="pihole-clients text-purple-500">--</span></div>
        <div class="metric-row"><span>Domains on Lists</span><span data-metric="domains" class="pihole-domains text-green-600 dark:text-green-500">--</span></div>
      </div>`;
    return section;
  }

  async function init() {
    try {
      const data = await fetchData('init');
      appConfig = data.config;
      const main = document.querySelector('main');
      main.innerHTML = '';
      for (const p of appConfig.piholes || []) main.appendChild(createCard(p));
      for (const [name, raw] of Object.entries(data.data || {})) updatePiholeUI(name, raw);
      updateNetworkSummary(data.summary);
      if (data.queries) renderQueries(data.queries);
      updateTimestamp();
      startTimers();
    } catch (e) {
      console.error('Failed to initialize dashboard:', e);
      document.getElementById('last-updated').textContent = 'Unable to initialize dashboard';
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopTimers();
    else { refreshStats(); refreshQueries(); startTimers(); }
  });
  window.addEventListener('offline', stopTimers);
  window.addEventListener('online', () => { refreshStats(); refreshQueries(); startTimers(); });
  const queries = document.getElementById('background-queries');
  queries?.addEventListener('mouseenter', () => { queryFeedPaused = true; });
  queries?.addEventListener('mouseleave', () => { queryFeedPaused = false; });
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(console.error));
  init();
});
