document.addEventListener('DOMContentLoaded', () => {
  'use strict';
  const core = window.PiDashCore;
  const insights = window.PiDashInsights;
  if (!core) throw new Error('Pi-Dash core is missing');

  const MAX_ROWS = 100;
  const MAX_PENDING = 1000;
  const MAX_TREND_POINTS = 30;
  const metrics = [
    ['total', 'Total Queries', 'text-blue-500'],
    ['blocked', 'Queries Blocked', 'text-red-500'],
    ['percentage', 'Percent Blocked', 'text-yellow-600 dark:text-yellow-500'],
    ['cache', 'Cached / Forwarded', 'text-indigo-500'],
    ['domains', 'Domains on Lists', 'text-green-600 dark:text-green-500'],
  ];
  const cards = new Map();
  const trendHistory = new Map();
  const queryTracker = core.createQueryTracker();
  const queryRows = [];
  let pendingQueries = [];
  let appConfig = null;
  let statsTimer = null, queriesTimer = null, stalenessTimer = null, optionalTimer = null;
  let statsController = null, queriesController = null, initController = null;
  const optionalControllers = new Map(), optionalUpdated = new Map();
  const compactViewport = window.matchMedia?.('(max-width: 767px), (max-width: 1024px) and (max-height: 500px)');
  let lastUpdateTime = null, manualPause = false, hoverPause = false;
  let foregroundGeneration = 0;
  let pollingPaused = false;

  const main = document.querySelector('main');
  const network = document.getElementById('network-summary');
  const queryContainer = document.getElementById('background-queries');
  const queryPanel = document.getElementById('query-panel');
  const queryToggle = document.getElementById('query-toggle');
  const pauseButton = document.getElementById('query-pause');
  const timestamp = document.getElementById('last-updated');
  const insightsPanel = document.getElementById('network-insights');
  const insightsToggle = document.getElementById('insights-toggle');
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
    healthLine.append(dot, health, element('span', 'instance-clients', '· -- active clients'));
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
    const dns = element('div', 'metric-group');
    for (const [key, label, color] of metrics) {
      addMetric(dns, key, label, color);
    }
    const gravityAge = element('div', 'metric-row');
    gravityAge.append(element('span', 'metric-label', 'Lists updated'), element('span', 'metric-value gravity-age', 'Unavailable'));
    dns.append(gravityAge);
    if (appConfig.show_device_metrics) {
      const device = element('div', 'metric-group device-group');
      device.setAttribute('role', 'group');
      device.setAttribute('aria-label', 'Device health');
      for (const [key, label] of [['cpu_percent', 'CPU'], ['ram_percent', 'RAM'], ['temperature', 'Temp'], ['uptime_seconds', 'Up']]) {
        const row = element('div', 'metric-row');
        const value = element('span', 'metric-value', 'Loading…');
        value.dataset.device = key;
        row.title = key === 'uptime_seconds' ? 'System uptime' : key === 'temperature' ? 'CPU temperature' : label;
        row.append(element('span', 'metric-label', label), value);
        device.append(row);
      }
      const note = element('p', 'device-note insight-status');
      device.append(note);
      details.append(dns, device);
    } else details.append(dns);
    section.append(details);
    const toggle = element('button', 'instance-toggle', 'Show details');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', details.id);
    toggle.setAttribute('aria-label', `Show details for ${pihole.name}`);
    toggle.addEventListener('click', () => {
      const expanded = section.classList.toggle('is-expanded');
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.textContent = expanded ? 'Hide details' : 'Show details';
      toggle.setAttribute('aria-label', `${toggle.textContent} for ${pihole.name}`);
      if (expanded) refreshOptional();
    });
    section.append(toggle);
    cards.set(pihole.name, section);
    return section;
  }

  function renderSparkline(name, section, rate) {
    const target = section.querySelector('.pihole-sparkline');
    target.hidden = !appConfig.show_trends;
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
    section.dataset.healthState = status.state;
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
      domains: number(stats.domains),
    };
    section.querySelectorAll('[data-value]').forEach(node => {
      node.textContent = values[node.dataset.value] ?? (node.dataset.value === 'percentage' ? '--%' : '--');
    });
    section.querySelector('.instance-clients').textContent = failed ? '· Clients unavailable' : `· ${number(stats.clients)} active clients`;
    section.querySelector('.gravity-age').textContent = failed ? 'Unavailable' : insights.age(raw?.gravity?.last_update);
    if (failed) {
      section.querySelectorAll('[data-device]').forEach(node => { node.textContent = 'Unavailable'; });
      const note = section.querySelector('.device-note');
      if (note) note.textContent = 'Device readings unavailable while Pi-hole is offline';
    }
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
    updateStaleness();
  }
  function updateStaleness() {
    if (!lastUpdateTime || !appConfig) return;
    const stale = pollingPaused || !visible() || Date.now() - lastUpdateTime > Math.max(10000, appConfig.refresh_interval * 2);
    timestamp.classList.toggle('is-stale', stale);
    for (const section of cards.values()) {
      const dot = section.querySelector('.status-dot');
      const state = section.dataset.healthState || 'neutral';
      dot.className = `status-dot status-${stale && state === 'success' ? 'neutral' : state}`;
      dot.classList.toggle('is-live', !stale && state === 'success');
      if (state === 'success') {
        const health = section.querySelector('.pihole-health');
        health.className = `pihole-health status-text-${stale ? 'neutral' : 'success'}`;
        if (stale) health.textContent = navigator.onLine === false ? 'Offline · last known ON' : 'Stale · last known ON';
      }
    }
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
    queryContainer.scrollTop = queryContainer.scrollHeight;
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
      if (canApply(generation, controller.signal) && error.name !== 'AbortError') console.error('Failed to refresh stats:', error);
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
      if (canApply(generation, controller.signal) && error.name !== 'AbortError') console.error('Failed to refresh queries:', error);
    } finally {
      if (queriesController === controller) queriesController = null;
    }
  }

  function insightsEnabled() { return appConfig?.show_network_summary && appConfig?.show_network_insights; }
  function insightsVisible() { return !compactViewport?.matches || network.classList.contains('insights-open'); }

  async function refreshOptionalKind(kind) {
    if (!visible() || optionalControllers.has(kind) || !cards.size) return;
    if (Date.now() - (optionalUpdated.get(kind) || 0) < (appConfig.optional_refresh_interval || 30000)) return;
    const generation = foregroundGeneration, controller = new AbortController();
    optionalControllers.set(kind, controller);
    try {
      const payload = await fetchData(kind, controller.signal);
      if (!canApply(generation, controller.signal)) return;
      optionalUpdated.set(kind, Date.now());
      if (kind === 'devices') {
        for (const [name, section] of cards) {
          if (section.dataset.healthState === 'danger') continue;
          const data = payload.devices?.[name] || {};
          const values = insights.deviceValues(data);
          section.querySelectorAll('[data-device]').forEach(node => { node.textContent = values[node.dataset.device]; });
          const note = section.querySelector('.device-note');
          const age = typeof payload.updated_at === 'number' ? insights.age(payload.updated_at) : '';
          if (note) note.textContent = data.unavailable?.length ? 'Some readings are unavailable' : age && age !== 'Just now' ? `Readings: ${age}` : '';
        }
      } else if (!payload.disabled) {
        insights.renderHistory(document.getElementById('network-history'), document.getElementById('history-status'), payload.history);
        insights.renderRanking(document.getElementById('network-clients'), document.getElementById('clients-status'), payload.clients, 'Clients');
        insights.renderRanking(document.getElementById('network-domains'), document.getElementById('domains-status'), payload.domains, 'Blocked domains');
      }
    } catch (error) {
      if (!canApply(generation, controller.signal) || error.name === 'AbortError') return;
      if (kind === 'devices') {
        for (const section of cards.values()) {
          section.querySelectorAll('[data-device]').forEach(node => { node.textContent = 'Unavailable'; });
          const note = section.querySelector('.device-note');
          if (note) note.textContent = 'Unable to refresh device readings';
        }
      } else {
        for (const id of ['history-status', 'clients-status', 'domains-status']) document.getElementById(id).textContent = 'Unable to refresh · previous data may be stale';
      }
    } finally { if (optionalControllers.get(kind) === controller) optionalControllers.delete(kind); }
  }
  function refreshOptional() {
    if (!appConfig) return;
    if (insightsEnabled() && insightsVisible()) refreshOptionalKind('insights');
    if (appConfig.show_device_metrics && (!compactViewport?.matches || [...cards.values()].some(card => card.classList.contains('is-expanded')))) refreshOptionalKind('devices');
  }

  function stopTimers() {
    pollingPaused = true;
    foregroundGeneration++;
    clearInterval(statsTimer); clearInterval(queriesTimer); clearInterval(stalenessTimer);
    clearInterval(optionalTimer); optionalTimer = null;
    statsTimer = queriesTimer = stalenessTimer = null;
    initController?.abort(); statsController?.abort(); queriesController?.abort();
    initController = statsController = queriesController = null;
    optionalControllers.forEach(controller => controller.abort()); optionalControllers.clear();
    updateStaleness();
  }

  function startTimers() {
    if (!appConfig || !visible() || statsTimer) return;
    statsTimer = setInterval(refreshStats, appConfig.refresh_interval);
    if (appConfig.show_queries) queriesTimer = setInterval(refreshQueries, appConfig.queries_refresh_interval);
    stalenessTimer = setInterval(updateStaleness, 1000);
    if (insightsEnabled() || appConfig.show_device_metrics) optionalTimer = setInterval(refreshOptional, appConfig.optional_refresh_interval || 30000);
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
      document.getElementById('main-wrapper').classList.toggle('has-network-insights', Boolean(insightsEnabled()));
      pollingPaused = false;
      optionalUpdated.clear();
      insightsPanel.hidden = !insightsEnabled();
      insightsToggle.hidden = !insightsEnabled();
      main.replaceChildren(); cards.clear();
      for (const [index, pihole] of (appConfig.piholes || []).entries()) main.append(createCard(pihole, index));
      if (!cards.size) main.append(element('p', 'empty-message', 'No Pi-holes are enabled. Check config.json.'));
      if (!cards.size) { insightsPanel.hidden = true; insightsToggle.hidden = true; }
      for (const [name, raw] of Object.entries(data.data || {})) updatePiholeUI(name, raw);
      updateNetworkSummary(data.summary);
      queryPanel.hidden = !appConfig.show_queries;
      if (data.queries) renderQueries(data.queries);
      updateTimestamp();
      startTimers();
      refreshOptional();
    } catch (error) {
      if (canApply(generation, controller.signal) && error.name !== 'AbortError') {
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
    pollingPaused = false;
    if (!appConfig) { init(); return; }
    optionalUpdated.clear();
    refreshStats(); refreshQueries(); refreshOptional(); startTimers();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopTimers(); else resumeForeground();
  });
  window.addEventListener('offline', stopTimers);
  window.addEventListener('online', resumeForeground);
  window.addEventListener('pagehide', stopTimers);
  window.addEventListener('pageshow', resumeForeground);

  insightsToggle.addEventListener('click', () => {
    const open = network.classList.toggle('insights-open');
    insightsToggle.setAttribute('aria-expanded', String(open));
    insightsToggle.textContent = open ? 'Hide network insights' : 'Show network insights';
    if (open) refreshOptional();
  });
  compactViewport?.addEventListener?.('change', refreshOptional);

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
