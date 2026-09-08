document.addEventListener('DOMContentLoaded', () => {
  'use strict';
  const core = window.PiDashCore;
  if (!core) throw new Error('Pi-Dash core is missing');

  const MAX_ROWS = 100;
  const MAX_PENDING = 1000;
  const MAX_TREND_POINTS = 30;
  const metrics = [
    ['total', 'Total Queries', 'text-blue-500'],
    ['blocked', 'Queries Blocked', 'text-red-500'],
    ['percentage', 'Percent Blocked', 'text-yellow-600 dark:text-yellow-500'],
    ['cache', 'Cached / Forwarded', 'text-indigo-500'],
    ['unique', 'Unique Domains', 'text-orange-500'],
    ['clients', 'Active Clients', 'text-purple-500'],
    ['domains', 'Domains on Lists', 'text-green-600 dark:text-green-500'],
  ];
  const cards = new Map();
  const trendHistory = new Map();
  const queryTracker = core.createQueryTracker();
  const queryRows = [];
  let pendingQueries = [];
  let appConfig = null;
  let statsTimer = null, queriesTimer = null, stalenessTimer = null;
  let statsController = null, queriesController = null, initController = null;
  let lastUpdateTime = null, manualPause = false, hoverPause = false;
  let foregroundGeneration = 0;

  const main = document.querySelector('main');
  const network = document.getElementById('network-summary');
  const queryContainer = document.getElementById('background-queries');
  const queryPanel = document.getElementById('query-panel');
  const queryToggle = document.getElementById('query-toggle');
  const pauseButton = document.getElementById('query-pause');
  const timestamp = document.getElementById('last-updated');
  const number = value => {
    const parsed = Number(value);
    return (Number.isFinite(parsed) ? parsed : 0).toLocaleString();
  };

  function visible() {
    return !document.hidden && navigator.onLine !== false;
  }

  async function fetchData(url, signal) {
    const response = await fetch(url, { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data?.error) throw new Error(data.error);
    return data;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function addMetric(parent, key, label, color, compact = false) {
    const row = element('div', compact ? 'mobile-metric' : 'metric-row');
    const caption = element('span', 'metric-label', label);
    const value = element('span', `metric-value ${color}`, '--');
    value.dataset.value = key;
    row.append(caption, value);
    parent.append(row);
  }

  function safeAdminUrl(address) {
    try {
      const url = new URL(address);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      url.pathname = url.pathname.replace(/\/$/, '') + '/admin';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch (_) { return null; }
  }

  function createCard(pihole, index) {
    const section = element('section', 'instance-card');
    const heading = element('div', 'instance-heading');
    const identity = element('div', 'instance-identity');
    const nameLine = element('h2', 'instance-name');
    const url = pihole.link ? safeAdminUrl(pihole.address) : null;
    const name = element(url ? 'a' : 'span', '', pihole.name);
    if (url) {
      name.href = url;
      name.target = '_blank';
      name.rel = 'noopener noreferrer';
      name.setAttribute('aria-label', `Open ${pihole.name} Pi-hole Admin`);
    }
    const rate = element('span', 'pihole-rate', '(--/sec)');
    nameLine.append(name, ' ', rate);
    const healthLine = element('div', 'instance-health');
    const dot = element('span', 'status-dot status-neutral');
    const health = element('span', 'pihole-health', 'Checking');
    healthLine.append(dot, health);
    identity.append(nameLine, healthLine);
    const sparkline = element('div', 'pihole-sparkline');
    sparkline.setAttribute('aria-hidden', 'true');
    heading.append(identity, sparkline);
    section.append(heading);

    const compact = element('div', 'mobile-instance-summary');
    addMetric(compact, 'total', 'Queries', 'text-blue-500', true);
    addMetric(compact, 'blocked', 'Blocked', 'text-red-500', true);
    addMetric(compact, 'percentage', 'Blocked %', 'text-yellow-600 dark:text-yellow-500', true);
    section.append(compact);

    const details = element('div', 'instance-details');
    details.id = `instance-details-${index}`;
    for (const [key, label, color] of metrics) addMetric(details, key, label, color);
    section.append(details);
    const toggle = element('button', 'instance-toggle', 'Show details');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', details.id);
    toggle.addEventListener('click', () => {
      const expanded = section.classList.toggle('is-expanded');
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.textContent = expanded ? 'Hide details' : 'Show details';
    });
    section.append(toggle);
    cards.set(pihole.name, section);
    return section;
  }

  function renderSparkline(name, section, rate) {
    const target = section.querySelector('.pihole-sparkline');
    if (!appConfig.show_trends) { target.replaceChildren(); return; }
    const history = trendHistory.get(name) || [];
    history.push(rate);
    if (history.length > MAX_TREND_POINTS) history.shift();
    trendHistory.set(name, history);
    if (history.length < 2) return;
    const min = Math.min(...history), max = Math.max(...history), range = max - min || 1;
    const points = history.map((v, i) => `${i / (history.length - 1) * 100},${24 - (v - min) / range * 20}`).join(' ');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 28');
    svg.setAttribute('preserveAspectRatio', 'none');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', points);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
    target.replaceChildren(svg);
  }

  function updatePiholeUI(name, raw) {
    const section = cards.get(name);
    if (!section) return;
    const meta = raw?._pi_dash || {};
    const failed = !raw || !!raw.error || !raw.queries;
    const status = core.healthPresentation(meta, failed);
    section.querySelector('.status-dot').className = `status-dot status-${status.state}`;
    const health = section.querySelector('.pihole-health');
    health.className = `pihole-health status-text-${status.state}`;
    health.textContent = status.text;
    section.querySelector('.pihole-rate').textContent = failed ? '(--/sec)' : `(${core.formatRate(core.summaryStats(raw).rate)})`;
    const stats = core.summaryStats(failed ? null : raw);
    const values = failed ? {} : {
      total: number(stats.total), blocked: number(stats.blocked),
      percentage: `${stats.percentage.toFixed(1)}%`,
      cache: `${number(stats.cached)} / ${number(stats.forwarded)}`,
      unique: number(stats.unique), clients: number(stats.clients), domains: number(stats.domains),
    };
    section.querySelectorAll('[data-value]').forEach(node => {
      node.textContent = values[node.dataset.value] ?? (node.dataset.value === 'percentage' ? '--%' : '--');
    });
    if (failed) { section.querySelector('.pihole-sparkline').replaceChildren(); trendHistory.delete(name); }
    else renderSparkline(name, section, stats.rate);
  }

  function updateNetworkSummary(summary) {
    if (!appConfig.show_network_summary || !summary) return;
    network.hidden = false;
    network.querySelector('.network-health').textContent = core.networkStatus(summary);
    network.querySelector('.network-total').textContent = number(summary.total_queries);
    network.querySelector('.network-blocked').textContent = number(summary.blocked_queries);
    network.querySelector('.network-percent').textContent = `${Number(summary.percent_blocked || 0).toFixed(1)}%`;
    network.querySelector('.network-cache').textContent = `${number(summary.cached_queries)} / ${number(summary.forwarded_queries)}`;
    const partial = summary.partial || summary.contributing_instances < summary.instances;
    network.querySelector('.network-partial').hidden = !partial;
    network.classList.toggle('is-partial', Boolean(partial));
  }

  function updateTimestamp() {
    lastUpdateTime = Date.now();
    timestamp.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
    timestamp.classList.remove('is-stale');
  }
  function updateStaleness() {
    if (!lastUpdateTime || !appConfig) return;
    timestamp.classList.toggle('is-stale', Date.now() - lastUpdateTime > appConfig.refresh_interval * 2);
  }

  function renderQueryRows() {
    const fragment = document.createDocumentFragment();
    for (const group of queryRows) {
      const row = element('li', group.blocked ? 'query-blocked' : 'query-allowed');
      row.textContent = group.label + (group.count > 1 ? ` (x${group.count})` : '');
      row.title = group.label;
      fragment.append(row);
    }
    queryContainer.replaceChildren(fragment);
    if (queryPanel.classList.contains('is-open')) queryContainer.scrollTop = queryContainer.scrollHeight;
  }

  function isQueryPaused() { return manualPause || hoverPause; }
  function flushQueries() {
    if (isQueryPaused() || !pendingQueries.length) return;
    const groups = core.groupConsecutiveQueries(pendingQueries);
    pendingQueries = [];
    const merged = core.mergeConsecutiveGroups(queryRows, groups, MAX_ROWS);
    queryRows.splice(0, queryRows.length, ...merged);
    renderQueryRows();
  }

  function renderQueries(data) {
    const events = core.collectNewQueries(queryTracker, data);
    if (!events.length) return;
    pendingQueries.push(...events);
    if (pendingQueries.length > MAX_PENDING) pendingQueries = pendingQueries.slice(-MAX_PENDING);
    flushQueries();
  }

  function updatePauseState() {
    pauseButton.textContent = manualPause ? 'Resume' : 'Pause';
    pauseButton.setAttribute('aria-pressed', String(manualPause));
    if (!isQueryPaused()) flushQueries();
  }

  function canApply(generation, signal) {
    return generation === foregroundGeneration && visible() && !signal.aborted;
  }

  async function refreshStats() {
    if (!appConfig || !visible() || (statsController && !statsController.signal.aborted)) return;
    const generation = foregroundGeneration;
    const controller = new AbortController();
    statsController = controller;
    try {
      const payload = await fetchData('data?include_summary=true', controller.signal);
      if (!canApply(generation, controller.signal)) return;
      for (const [name, raw] of Object.entries(payload.stats || {})) updatePiholeUI(name, raw);
      updateNetworkSummary(payload.summary);
      updateTimestamp();
    } catch (error) {
      if (error.name !== 'AbortError') console.error('Failed to refresh stats:', error);
    } finally {
      if (statsController === controller) statsController = null;
    }
  }

  async function refreshQueries() {
    if (!appConfig?.show_queries || !visible() || (queriesController && !queriesController.signal.aborted)) return;
    const generation = foregroundGeneration;
    const controller = new AbortController();
    queriesController = controller;
    try {
      const data = await fetchData('queries?length=50', controller.signal);
      if (canApply(generation, controller.signal)) renderQueries(data);
    } catch (error) {
      if (error.name !== 'AbortError') console.error('Failed to refresh queries:', error);
    } finally {
      if (queriesController === controller) queriesController = null;
    }
  }

  function stopTimers() {
    foregroundGeneration++;
    clearInterval(statsTimer); clearInterval(queriesTimer); clearInterval(stalenessTimer);
    statsTimer = queriesTimer = stalenessTimer = null;
    initController?.abort(); statsController?.abort(); queriesController?.abort();
    initController = statsController = queriesController = null;
  }

  function startTimers() {
    if (!appConfig || !visible() || statsTimer) return;
    statsTimer = setInterval(refreshStats, appConfig.refresh_interval);
    if (appConfig.show_queries) queriesTimer = setInterval(refreshQueries, appConfig.queries_refresh_interval);
    stalenessTimer = setInterval(updateStaleness, 1000);
  }

  async function init() {
    if (!visible() || (initController && !initController.signal.aborted)) return;
    const generation = foregroundGeneration;
    const controller = new AbortController();
    initController = controller;
    try {
      const data = await fetchData('init', controller.signal);
      if (!canApply(generation, controller.signal)) return;
      appConfig = data.config;
      main.replaceChildren(); cards.clear();
      for (const [index, pihole] of (appConfig.piholes || []).entries()) main.append(createCard(pihole, index));
      if (!cards.size) main.append(element('p', 'empty-message', 'No Pi-holes are enabled. Check config.json.'));
      for (const [name, raw] of Object.entries(data.data || {})) updatePiholeUI(name, raw);
      updateNetworkSummary(data.summary);
      queryPanel.hidden = !appConfig.show_queries;
      if (data.queries) renderQueries(data.queries);
      updateTimestamp();
      startTimers();
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Failed to initialize dashboard:', error);
        timestamp.textContent = 'Unable to initialize dashboard';
      }
    } finally {
      if (initController === controller) initController = null;
      // A page can become visible before an aborted initialization settles.
      // Restart only if no newer initialization has already taken ownership.
      if (!appConfig && visible() && generation !== foregroundGeneration && !initController) init();
    }
  }

  function resumeForeground() {
    if (!visible()) return;
    if (!appConfig) { init(); return; }
    refreshStats(); refreshQueries(); startTimers();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopTimers(); else resumeForeground();
  });
  window.addEventListener('offline', stopTimers);
  window.addEventListener('online', resumeForeground);
  window.addEventListener('pagehide', stopTimers);
  window.addEventListener('pageshow', resumeForeground);

  queryToggle.addEventListener('click', () => {
    const open = queryPanel.classList.toggle('is-open');
    queryToggle.setAttribute('aria-expanded', String(open));
    queryToggle.textContent = open ? 'Hide queries' : 'Show queries';
    if (open) queryContainer.scrollTop = queryContainer.scrollHeight;
  });
  pauseButton.addEventListener('click', () => { manualPause = !manualPause; updatePauseState(); });
  if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
    queryContainer.addEventListener('mouseenter', () => { hoverPause = true; updatePauseState(); });
    queryContainer.addEventListener('mouseleave', () => { hoverPause = false; updatePauseState(); });
  }
  if ('serviceWorker' in navigator) window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(error => console.warn('Service worker:', error));
  });
  init();
});