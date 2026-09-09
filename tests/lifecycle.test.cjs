const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function setup(fetchImpl) {
  const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '').replace('{{ICON_URL}}', '');
  const dom = new JSDOM(html, { url: 'http://localhost:5001/', runScripts: 'outside-only' });
  const w = dom.window;
  let hidden = false;
  const timers = new Map();
  let next = 0;
  Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => true });
  w.setInterval = (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; };
  w.clearInterval = id => timers.delete(id);
  w.fetch = fetchImpl;
  w.eval(read('js/dashboard-core.js'));
  w.eval(read('js/app.js'));
  const settle = () => new Promise(resolve => w.setTimeout(resolve, 0));
  return {
    w, dom, timers, settle,
    hide(value) { hidden = value; w.document.dispatchEvent(new w.Event('visibilitychange')); },
    close() { dom.window.close(); },
  };
}

const config = { refresh_interval: 2000, queries_refresh_interval: 3000, show_queries: false, show_network_summary: true, show_trends: false, piholes: [] };
const response = data => ({ ok: true, json: async () => data });

test('a visible page recovers when an aborted initialization settles later', async () => {
  let resolveFirst;
  const calls = [];
  const app = setup((url, options) => {
    calls.push({ url, signal: options.signal });
    if (calls.length === 1) return new Promise(resolve => { resolveFirst = resolve; });
    return Promise.resolve(response({ config, data: {}, summary: { instances: 0, contributing_instances: 0, partial: false } }));
  });
  try {
    await app.settle();
    assert.equal(calls.length, 1);
    app.hide(true);
    assert.equal(calls[0].signal.aborted, true);
    app.hide(false);
    await app.settle();
    assert.ok(calls.length >= 2);
    resolveFirst(response({ config, data: {}, summary: { instances: 0 } }));
    await app.settle();
    assert.equal(app.w.document.querySelectorAll('.empty-message').length, 1);
    assert.deepEqual([...app.timers.values()].map(t => t.ms).sort((a, b) => a - b), [1000, 2000]);
  } finally { app.close(); }
});

test('a stale in-flight stats response cannot overwrite a newer foreground snapshot', async () => {
  let resolveOld;
  let statsCalls = 0;
  const data = total => ({ One: { queries: { total, blocked: 0, frequency: 1 }, clients: { active: 1 }, gravity: { domains_being_blocked: 1 }, _pi_dash: { blocking: true } } });
  const cfg = { ...config, piholes: [{ name: 'One', enabled: true, link: false }] };
  const summary = { instances: 1, contributing_instances: 1, total_queries: 1, blocked_queries: 0, partial: false };
  const app = setup(url => {
    if (url === 'init') return Promise.resolve(response({ config: cfg, data: data(1), summary }));
    if (url.startsWith('data?')) {
      statsCalls++;
      if (statsCalls === 1) return new Promise(resolve => { resolveOld = resolve; });
      return Promise.resolve(response({ stats: data(3), summary: { ...summary, total_queries: 3 } }));
    }
    throw new Error('Unexpected request');
  });
  try {
    await app.settle();
    const oldTick = [...app.timers.values()].find(t => t.ms === 2000).fn();
    await app.settle();
    app.hide(true);
    app.hide(false);
    await app.settle();
    assert.equal(app.w.document.querySelector('.instance-details [data-value="total"]').textContent, '3');
    resolveOld(response({ stats: data(2), summary: { ...summary, total_queries: 2 } }));
    await oldTick;
    await app.settle();
    assert.equal(app.w.document.querySelector('.instance-details [data-value="total"]').textContent, '3');
  } finally { app.close(); }
});

test('a late initialization error cannot overwrite successful recovery', async () => {
  let rejectOld;
  let requests = 0;
  const app = setup(() => {
    if (++requests === 1) return new Promise((_, reject) => { rejectOld = reject; });
    return Promise.resolve(response({ config, data: {}, summary: { instances: 0 } }));
  });
  try {
    await app.settle();
    app.hide(true); app.hide(false); await app.settle();
    const current = app.w.document.getElementById('last-updated').textContent;
    rejectOld(new Error('late network failure'));
    await app.settle();
    assert.equal(app.w.document.getElementById('last-updated').textContent, current);
    assert.equal(app.timers.size, 2);
  } finally { app.close(); }
});
