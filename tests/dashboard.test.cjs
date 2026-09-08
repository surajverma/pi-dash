const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const core = require('../js/dashboard-core.js');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sample = {
  queries: { total: 100, blocked: 25, percent_blocked: 25, frequency: 2, cached: 40, forwarded: 35, unique_domains: 20 },
  clients: { active: 4 }, gravity: { domains_being_blocked: 1000 },
  _pi_dash: { blocking: true, health: 'healthy' },
};
const event = (id, domain, time = id, blocked = false) => ({ id, domain, time, blocked });

function makeBrowser(options = {}) {
  const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '').replace('{{ICON_URL}}', '');
  const dom = new JSDOM(html, { url: 'http://localhost:5001/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  let hidden = false, online = true;
  let nextTimer = 0;
  const timers = new Map();
  const calls = [];
  const config = {
    refresh_interval: 2000, queries_refresh_interval: 3000,
    show_queries: true, show_network_summary: true, show_trends: true,
    piholes: [{ name: 'One', enabled: true, link: false }, { name: 'Zero', enabled: true, link: false }],
    ...options,
  };
  const snapshots = { One: sample, Zero: sample };
  const summary = { total_queries: 200, blocked_queries: 50, percent_blocked: 25, cached_queries: 80, forwarded_queries: 70, instances: 2, contributing_instances: 2, healthy_instances: 2, blocking_disabled_instances: 0, blocking_unknown_instances: 0, offline_instances: 0, partial: false };
  let queries = { One: [event(1, 'example.org', 1), event(2, 'example.org', 2)], Zero: [] };
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  window.setInterval = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
  window.clearInterval = id => timers.delete(id);
  window.fetch = async (url, request = {}) => {
    calls.push({ url: String(url), signal: request.signal });
    let data;
    if (String(url) === 'init') data = { config, data: snapshots, summary, queries };
    else if (String(url).startsWith('data?')) data = { stats: snapshots, summary };
    else if (String(url).startsWith('queries?')) data = queries;
    else throw new Error('Unexpected URL: ' + url);
    return { ok: true, json: async () => data };
  };
  window.eval(read('js/dashboard-core.js'));
  window.eval(read('js/app.js'));
  const settle = async () => { await new Promise(resolve => window.setTimeout(resolve, 0)); };
  return {
    dom, window, calls, timers, settle, config,
    setHidden(value) { hidden = value; window.document.dispatchEvent(new window.Event('visibilitychange')); },
    setOnline(value) { online = value; window.dispatchEvent(new window.Event(value ? 'online' : 'offline')); },
    setQueries(value) { queries = value; },
    async tick(ms) { for (const timer of [...timers.values()].filter(t => t.ms === ms)) await timer.fn(); await settle(); },
    close() { dom.window.close(); },
  };
}

test('consecutive grouping retains real events, separates blocked status and merges across batches', () => {
  const items = [event(1, 'a.test'), event(2, 'a.test'), event(3, 'b.test'), event(4, 'a.test')].map(q => ({ ...q, piholeName: 'One' }));
  const groups = core.groupConsecutiveQueries(items);
  assert.deepEqual(groups.map(g => g.count), [2, 1, 1]);
  const more = core.groupConsecutiveQueries([{ ...event(5, 'a.test'), piholeName: 'One' }]);
  assert.deepEqual(core.mergeConsecutiveGroups(groups, more).map(g => g.count), [2, 1, 2]);
  assert.equal(core.groupConsecutiveQueries([{ ...items[0], blocked: false }, { ...items[1], blocked: true }]).length, 2);
  assert.equal(core.mergeConsecutiveGroups(groups, more, 2).length, 2);
});

test('query tracker handles overlapping polls and independent database IDs', () => {
  const tracker = core.createQueryTracker();
  const first = core.collectNewQueries(tracker, { One: [event(10, 'a.test', 100), event(11, 'b.test', 101)], Zero: [event(900, 'z.test', 99)] });
  assert.deepEqual(first.map(q => q.domain), ['z.test', 'a.test', 'b.test']);
  assert.equal(core.collectNewQueries(tracker, { One: [event(10, 'a.test', 100), event(11, 'b.test', 101)], Zero: [event(900, 'z.test', 99)] }).length, 0);
  assert.deepEqual(core.collectNewQueries(tracker, { One: [event(12, 'c.test', 102)], Zero: [event(901, 'd.test', 103)] }).map(q => q.domain), ['c.test', 'd.test']);
  assert.equal(core.queryIdentity({ id: null, time: 1, type: 'A', client: { ip: '1.2.3.4' }, domain: 'a' }) === core.queryIdentity({ id: null, time: 1, type: 'AAAA', client: { ip: '1.2.3.4' }, domain: 'a' }), false);
});

test('health presentation does not infer network speed from API latency', () => {
  assert.equal(core.healthPresentation({ blocking: true, latency_ms: 1000 }).text, 'Blocking ON');
  assert.equal(core.healthPresentation({ blocking: false }).text, 'Blocking OFF');
  assert.equal(core.healthPresentation({ health: 'auth_error' }, true).text, 'Auth failed');
  assert.match(core.networkStatus({ instances: 2, contributing_instances: 1, offline_instances: 1, partial: true }), /1 of 2 reporting/);
});

test('mobile card starts compact and expands all desktop metrics', async () => {
  const app = makeBrowser();
  try {
    await app.settle();
    const doc = app.window.document;
    const card = doc.querySelector('.instance-card');
    assert.equal(card.querySelectorAll('.mobile-metric').length, 3);
    assert.equal(card.querySelectorAll('.instance-details .metric-row').length, 7);
    assert.equal(card.querySelector('.pihole-latency'), null);
    const toggle = card.querySelector('.instance-toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(card.classList.contains('is-expanded'), true);
    assert.match(card.textContent, /Cached \/ Forwarded/);
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(doc.querySelector('#network-summary').hidden, false);
  } finally { app.close(); }
});

test('the feed restores xN grouping and stays compact on mobile', async () => {
  const app = makeBrowser();
  try {
    await app.settle();
    const doc = app.window.document;
    let rows = [...doc.querySelectorAll('#background-queries li')];
    assert.equal(rows.length, 1);
    assert.match(rows[0].textContent, /\(x2\)/);
    const toggle = doc.getElementById('query-toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(doc.getElementById('query-panel').classList.contains('is-open'), true);
    app.setQueries({ One: [event(3, 'example.org', 3)], Zero: [] });
    await app.tick(3000);
    rows = [...doc.querySelectorAll('#background-queries li')];
    assert.equal(rows.length, 1);
    assert.match(rows[0].textContent, /\(x3\)/);
  } finally { app.close(); }
});

test('hidden and offline pages stop both polling intervals and reject stale responses', async () => {
  const app = makeBrowser();
  try {
    await app.settle();
    assert.deepEqual([...app.timers.values()].map(t => t.ms).sort((a, b) => a - b), [1000, 2000, 3000]);
    app.setHidden(true);
    assert.equal(app.timers.size, 0);
    const count = app.calls.length;
    await app.tick(2000);
    assert.equal(app.calls.length, count);
    app.setHidden(false);
    await app.settle();
    assert.equal(app.timers.size, 3);
    app.setOnline(false);
    assert.equal(app.timers.size, 0);
    app.setOnline(true);
    await app.settle();
    assert.equal(app.timers.size, 3);
  } finally { app.close(); }
});

test('disabled query feed never requests query data', async () => {
  const app = makeBrowser({ show_queries: false });
  try {
    await app.settle();
    assert.equal(app.window.document.getElementById('query-panel').hidden, true);
    assert.equal([...app.timers.values()].some(t => t.ms === 3000), false);
    assert.equal(app.calls.some(c => c.url.startsWith('queries?')), false);
  } finally { app.close(); }
});

test('instance names are treated as text, not executable markup', async () => {
  const app = makeBrowser({ piholes: [{ name: '<img src=x onerror=alert(1)>', enabled: true, link: false }] });
  try {
    await app.settle();
    assert.equal(app.window.document.querySelectorAll('.instance-card img').length, 0);
    assert.match(app.window.document.querySelector('.instance-name').textContent, /<img/);
  } finally { app.close(); }
});
