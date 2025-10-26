document.addEventListener('DOMContentLoaded', () => {
  let refreshIntervalId = null;
  let appConfig = null;
  const lastCursorByPihole = {};

  async function fetchData(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  }

  function processSummaryData(summaryData) {
    if (!summaryData || !summaryData.queries) {
      return {
        total: 0,
        blocked: 0,
        percentage: 0,
        clients: 0,
        rate: 0,
        cached: 0,
        forwarded: 0,
        unique: 0,
        domains: 0,
      };
    }

    const queries = summaryData.queries;
    const clients = summaryData.clients;
    const gravity = summaryData.gravity;

    return {
      total: Number(queries.total) || 0,
      blocked: Number(queries.blocked) || 0,
      percentage: Number(queries.percent_blocked) || 0,
      clients: Number(clients.active) || 0,
      rate: Number(queries.frequency) || 0,
      cached: Number(queries.cached) || 0,
      forwarded: Number(queries.forwarded) || 0,
      unique: Number(queries.unique_domains) || 0,
      domains: Number(gravity.domains_being_blocked) || 0,
    };
  }

  async function updatePiholeUI(piholeName, rawData) {
    const section = document.getElementById(`pihole-${piholeName}-section`);
    if (!section) return;

    const nameEl = section.querySelector('.pihole-name');
    const rateEl = section.querySelector('.pihole-rate');
    const totalEl = section.querySelector('.pihole-total');
    const blockedEl = section.querySelector('.pihole-blocked');
    const percentEl = section.querySelector('.pihole-percent');
    const clientsEl = section.querySelector('.pihole-clients');
    const statusDotEl = section.querySelector('.status-dot');
    const cacheEl = section.querySelector('.pihole-cache');
    const uniqueEl = section.querySelector('.pihole-unique');
    const domainsEl = section.querySelector('.pihole-domains');

    try {
      if (rawData.error) throw new Error(rawData.error);

      const stats = processSummaryData(rawData);

      let rateValue;
      let rateUnit;
      if (stats.rate < 1.0) {
        rateValue = (stats.rate * 60).toFixed(1);
        rateUnit = '/min';
      } else {
        rateValue = stats.rate.toFixed(1);
        rateUnit = '/sec';
      }
      if (rateEl) {
        rateEl.textContent = `(${rateValue}${rateUnit})`;
        rateEl.classList.remove('text-gray-500', 'dark:text-gray-400');
        rateEl.classList.add('text-teal-500', 'dark:text-teal-400');
      } else {
        
        nameEl.innerHTML = `${piholeName} <span class="text-sm font-normal text-teal-500 dark:text-teal-400">(${rateValue}${rateUnit})</span>`;
      }

      totalEl.textContent = stats.total.toLocaleString();
      blockedEl.textContent = stats.blocked.toLocaleString();
      percentEl.textContent = `${stats.percentage.toFixed(1)}%`;
      clientsEl.textContent = stats.clients.toLocaleString();
      cacheEl.textContent = `${stats.cached.toLocaleString()} / ${stats.forwarded.toLocaleString()}`;
      uniqueEl.textContent = stats.unique.toLocaleString();
      domainsEl.textContent = stats.domains.toLocaleString();

      statusDotEl.classList.remove('bg-gray-500', 'bg-red-500');
      statusDotEl.classList.add('bg-green-500');
    } catch (error) {
      console.error(`Failed to update Pi-hole ${piholeName} data:`, error);
      if (rateEl) {
        rateEl.textContent = `(--/sec)`;
        rateEl.classList.remove('text-teal-500', 'dark:text-teal-400');
        rateEl.classList.add('text-gray-500', 'dark:text-gray-400');
      } else {
        nameEl.innerHTML = `${piholeName} <span class="text-sm font-normal text-gray-500 dark:text-gray-400">(--/sec)</span>`;
      }
      [totalEl, blockedEl, clientsEl, uniqueEl, domainsEl].forEach((el) => (el.textContent = '--'));
      percentEl.textContent = '--%';
      cacheEl.textContent = '-- / --';
      statusDotEl.classList.remove('bg-gray-500', 'bg-green-500');
      statusDotEl.classList.add('bg-red-500');
    }
  }

  function updateTimestamp() {
    const timestampEl = document.getElementById('last-updated');
    const now = new Date();
    timestampEl.textContent = `Last updated: ${now.toLocaleTimeString()}`;
  }

  async function refreshDashboard() {
    try {
      
  const includeQueries = appConfig && appConfig.show_queries;
  const endpoint = includeQueries ? 'data?include_queries=true&length=50' : 'data';
      const data = await fetchData(endpoint);
      
      
      const statsData = data.stats || data;
      const queriesData = data.queries;
      
      
      for (const [piholeName, piholeData] of Object.entries(statsData)) {
        await updatePiholeUI(piholeName, piholeData);
      }
      updateTimestamp();
      
      
      if (queriesData) {
        renderQueries(queriesData);
      }
    } catch (error) {
      console.error('Failed to refresh dashboard:', error);
    }
  }

  function startTimer() {
    if (refreshIntervalId || !appConfig) return;
    const interval = appConfig.refresh_interval || 5000;
    refreshIntervalId = setInterval(refreshDashboard, interval);
  }

  function stopTimer() {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }

  function renderQueries(allQueries) {
    const container = document.getElementById('background-queries');
    if (!container) return;
    const isDark = document.documentElement.classList.contains('dark');
    container.classList.toggle('dark-mode', isDark);

    const newItems = [];
    for (const [piholeName, queries] of Object.entries(allQueries)) {
      if (!Array.isArray(queries) || queries.length === 0) continue;
      const lastCursor = lastCursorByPihole[piholeName] ?? -Infinity;
      let maxCursor = lastCursor;
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const id = (q.id !== undefined && q.id !== null) ? Number(q.id) : null;
        const timeVal = (q.time !== undefined && q.time !== null) ? Number(q.time) : (q.timestamp ? Number(q.timestamp) : null);
        const cursor = (id !== null) ? id : (timeVal !== null ? timeVal : -Infinity);
        if (cursor > lastCursor) {
          newItems.push({ piholeName, ...q, __cursor: cursor });
        }
        if (cursor > maxCursor) maxCursor = cursor;
      }
      lastCursorByPihole[piholeName] = maxCursor;
    }

    if (newItems.length === 0) return; 

    
    newItems.sort((a, b) => a.__cursor - b.__cursor);

    const groups = [];
    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i];
      const domain = item.domain || '';
      const piholeName = item.piholeName || '';
      const label = `[${piholeName}] ${domain}`;
      const blocked = !!item.blocked;
      if (groups.length > 0 && groups[groups.length - 1].label === label) {
        const g = groups[groups.length - 1];
        g.count += 1;
        g.blocked = g.blocked || blocked;
      } else {
        groups.push({ label, domain, piholeName, blocked, count: 1 });
      }
    }

    const MAX_ROWS = 100;
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      const lastLi = container.lastElementChild;
      if (lastLi && lastLi.dataset && lastLi.dataset.label === group.label) {
        const prev = Number(lastLi.dataset.count || '1');
        const nextCount = prev + group.count;
        lastLi.dataset.count = String(nextCount);
        lastLi.textContent = `${group.label} (x${nextCount})`;
        if (group.blocked) {
          lastLi.classList.remove('text-green-600', 'dark:text-green-500');
          lastLi.classList.add('text-red-600', 'dark:text-red-500');
          lastLi.style.filter = 'drop-shadow(0 0 2px rgba(220, 38, 38, 0.3))';
        }
      } else {
        const li = document.createElement('li');
        li.className = 'opacity-0 translate-y-1 text-[10px] leading-tight px-1 whitespace-nowrap';
        li.style.textOverflow = 'ellipsis';
        li.dataset.label = group.label;
        li.dataset.count = String(group.count);
        li.textContent = group.count > 1 ? `${group.label} (x${group.count})` : group.label;
        if (group.blocked) {
          li.classList.add('text-red-600', 'dark:text-red-500');
          li.style.filter = 'drop-shadow(0 0 2px rgba(220, 38, 38, 0.3))';
        } else {
          li.classList.add('text-green-600', 'dark:text-green-500');
          li.style.filter = 'drop-shadow(0 0 2px rgba(22, 163, 74, 0.25))';
        }
        const delay = Math.min(index * 15, 300);
        setTimeout(() => {
          requestAnimationFrame(() => {
            li.style.transition = 'opacity .3s ease, transform .3s ease';
            li.style.opacity = '0.9';
            li.style.transform = 'translateY(0)';
          });
        }, delay);
        container.appendChild(li);
      }
    }

    while (container.children.length > MAX_ROWS) {
      container.removeChild(container.firstChild);
    }
  }

  async function init() {
    try {
      
      const initData = await fetchData('init');
      appConfig = initData.config;
      
      const mainContent = document.querySelector('main');
      mainContent.innerHTML = '';

      const enabledPiholes = appConfig.piholes.filter((p) => p.enabled);

      
      enabledPiholes.forEach((pihole) => {
        const section = document.createElement('section');
        section.id = `pihole-${pihole.name}-section`;
        section.className = 'bg-white dark:bg-gray-900 p-4 rounded-lg shadow-lg w-full';
        
        const nameContent = pihole.link
          ? `<a href="${pihole.address}/admin" target="_blank" rel="noopener noreferrer" class="hover:text-teal-500 focus:text-teal-500 outline-none transition-colors" aria-label="Open ${pihole.name} Pi-hole UI">${pihole.name}</a>`
          : `${pihole.name}`;
        section.innerHTML = `
                  <div class="flex justify-between items-baseline mb-3">
                      <h2 class="text-xl font-semibold text-gray-700 dark:text-cyan-400 pihole-name">${nameContent} <span class="pihole-rate text-sm font-normal text-gray-500 dark:text-gray-400">(--/sec)</span></h2>
                      <span class="status-dot bg-gray-500"></span>
                  </div>
                  <div class="space-y-1.5 text-sm">
                      <div class="flex justify-between items-center">
                          <span class="text-gray-500 dark:text-gray-400">Total Queries</span>
                          <span class="font-medium text-blue-500 dark:text-blue-400 pihole-total">--</span>
                      </div>
                      <div class="flex justify-between items-center">
                          <span class="text-gray-500 dark:text-gray-400">Queries Blocked</span>
                          <span class="font-medium text-red-500 dark:text-red-400 pihole-blocked">--</span>
                      </div>
                      <div class="flex justify-between items-center">
                          <span class="text-gray-500 dark:text-gray-400">Percent Blocked</span>
                          <span class="font-medium text-yellow-600 dark:text-yellow-500 pihole-percent">--%</span>
                      </div>
                      <div class="flex justify-between items-center">
                          <span class="text-gray-500 dark:text-gray-400">Cachd / Fwded</span>
                          <span class="font-medium text-indigo-500 dark:text-indigo-400 pihole-cache">-- / --</span>
                      </div>
                      <div class="flex justify-between items-center">
                          <span class="text-gray-500 dark:text-gray-400">Unique Domains</span>
                          <span class="font-medium text-orange-500 dark:text-orange-400 pihole-unique">--</span>
                      </div>
                      <div class="flex justify-between items-center">
                          <span class="text-gray-500 dark:text-gray-400">Active Clients</span>
                          <span class="font-medium text-purple-500 dark:text-purple-400 pihole-clients">--</span>
                      </div>
                      <div class="flex justify-between items-center">
                          <span class="text-gray-500 dark:text-gray-400">Domains on Lists</span>
                          <span class="font-medium text-green-600 dark:text-green-500 pihole-domains">--</span>
                      </div>
                  </div>
              `;
        mainContent.appendChild(section);
      });

      
      for (const [piholeName, piholeData] of Object.entries(initData.data)) {
        await updatePiholeUI(piholeName, piholeData);
      }
      updateTimestamp();

      startTimer();
    } catch (error) {
      console.error('Failed to initialize dashboard:', error);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopTimer();
    } else {
      startTimer();
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then(
        (registration) => {
          console.log('ServiceWorker registration successful with scope: ', registration.scope);
        },
        (err) => {
          console.log('ServiceWorker registration failed: ', err);
        }
      );
    });
  }

  init();
});