const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const insights = require('../web/js/network-insights.js');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'web', name), 'utf8');

test('missing readings stay unavailable and real zero readings remain zero', () => {
  assert.equal(insights.deviceValues({}).temperature, 'Unavailable');
  assert.equal(insights.deviceValues({cpu_percent: null}).cpu_percent, 'Unavailable');
  assert.equal(insights.deviceValues({cpu_percent: 0, temperature: 0, temperature_unit: 'C'}).cpu_percent, '0.0%');
  assert.equal(insights.deviceValues({temperature: 0}).temperature, '0.0°C');
  assert.equal(insights.duration(90061), '1d 1h');
  assert.equal(insights.age(0), 'Unavailable');
  assert.equal(insights.age(null), 'Unavailable');
  assert.equal(insights.age(100, 160000), '1 min ago');
});

test('rankings safely display full names and graph gaps are not drawn as continuous data', () => {
  const dom = new JSDOM('<ol></ol><p></p><div></div>');
  const d = dom.window.document;
  insights.renderRanking(d.querySelector('ol'), d.querySelector('p'), {contributors: 1, instances: 2, partial: true, items: [{id: '192.0.2.1', label: '<img src=x onerror=alert(1)>', count: 50, share: 25}]}, 'Clients');
  assert.equal(d.querySelector('img'), null);
  assert.match(d.querySelector('p').textContent, /Partial data/);
  const button = d.querySelector('button'); button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.match(button.textContent, /192.0.2.1/);
  insights.renderHistory(d.querySelector('div'), d.querySelector('p'), {contributors:1, instances:1, points:[{timestamp:600,total:20,blocked:5},{timestamp:1200,total:30,blocked:7},{timestamp:3600,total:40,blocked:8},{timestamp:4200,total:50,blocked:10}]});
  assert.equal(d.querySelectorAll('.history-total').length, 2);
  dom.window.close();
});

test('ranking counts stay plain and uncertainty and missing-source warnings remain distinct', () => {
  const dom = new JSDOM('<ol></ol><p></p>'), d = dom.window.document;
  const data = {contributors:2, instances:2, partial:false, limited:false,
    items:[{id:'example.test', label:'example.test', count:120, share:10}]};
  const render = () => insights.renderRanking(d.querySelector('ol'), d.querySelector('p'), data, 'Domains');
  render();
  const assertPlainCount = () => {
    assert.equal(d.querySelector('.rank-count').textContent, '120');
    assert.equal(d.querySelector('button').title, 'example.test');
    assert.equal(d.querySelector('button').getAttribute('aria-label'), 'example.test: 120 queries, 10.0 percent. Expand name');
  };
  assertPlainCount();
  assert.equal(d.querySelector('p').textContent, '');
  data.limited = true; render();
  assertPlainCount();
  assert.equal(d.querySelector('p').textContent, 'Approximate ranking · counts near the cut-off');
  data.partial = true; data.contributors = 1; render();
  assertPlainCount();
  assert.equal(d.querySelector('p').textContent, 'Partial data · 1 of 2 reporting');
  data.partial = false; data.limited = false; render();
  assertPlainCount();
  dom.window.close();
});

function themeBrowser(saved, blocked = false) {
  const dom = new JSDOM('<meta id="theme-color-meta"><button id="theme-toggle"></button>', {url:'https://test.invalid', runScripts:'outside-only'});
  const w = dom.window;
  if (saved) w.localStorage.theme = saved;
  if (blocked) Object.defineProperty(w, 'localStorage', {get() {throw new Error('denied');}});
  let change;
  const media = {matches: false, addEventListener(_, fn) {change = fn;}};
  w.matchMedia = () => media;
  w.eval(read('js/theme.js'));
  return {dom, w, system(dark) {media.matches = dark; change();}};
}
test('system theme follows live changes, saved system works, and explicit choice is respected', async () => {
  for (const saved of [undefined, 'system', 'invalid']) {
    const app = themeBrowser(saved);
    app.system(true); assert.equal(app.w.document.documentElement.classList.contains('dark'), true);
    app.system(false); assert.equal(app.w.document.documentElement.classList.contains('dark'), false);
    app.dom.window.close();
  }
  const app = themeBrowser('light');
  app.system(true); assert.equal(app.w.document.documentElement.classList.contains('dark'), false);
  await new Promise(resolve => app.w.setTimeout(resolve,0));
  app.w.document.querySelector('button').click();
  assert.equal(app.w.localStorage.theme, 'dark');
  assert.equal(app.w.document.documentElement.style.colorScheme, 'dark');
  app.w.document.querySelector('button').click();
  app.system(false); assert.equal(app.w.document.documentElement.classList.contains('dark'), false);
  app.dom.window.close();
  const restricted = themeBrowser(null,true);
  restricted.system(true); assert.equal(restricted.w.document.documentElement.classList.contains('dark'),true);
  restricted.dom.window.close();
});

test('optional mobile data loads on expansion and late responses cannot survive hiding', async () => {
  const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, {url:'https://test.invalid', runScripts:'outside-only'}), w = dom.window;
  let hidden = false, resolveOld;
  const calls = [], timers = new Map(); let next = 0;
  Object.defineProperty(w.document,'hidden',{get:()=>hidden});
  Object.defineProperty(w.navigator,'onLine',{get:()=>true});
  w.matchMedia = query => ({matches:query.includes('max-width'), addEventListener(){}});
  w.setInterval = (fn,ms) => {const id=++next;timers.set(id,{fn,ms});return id;};
  w.clearInterval = id=>timers.delete(id);
  const config = {refresh_interval:2000,optional_refresh_interval:30000,show_network_summary:true,show_network_insights:true,show_device_metrics:true,piholes:[{name:'One'}]};
  const stats = {One:{queries:{total:1},_pi_dash:{blocking:true}}};
  const result = data=>({ok:true,json:async()=>data});
  w.fetch = (url, options) => {
    calls.push({url,signal:options.signal});
    if (url==='init') return Promise.resolve(result({config,data:stats,summary:{instances:1}}));
    if (url.startsWith('data')) return Promise.resolve(result({stats,summary:{instances:1}}));
    if (url==='devices' && !resolveOld) return new Promise(resolve=>{resolveOld=resolve;});
    if (url==='devices') return Promise.resolve(result({devices:{One:{cpu_percent:42}}}));
    if (url==='insights') return Promise.resolve(result({history:{},clients:{},domains:{}}));
    throw new Error(url);
  };
  for (const name of ['dashboard-core','network-insights','app']) w.eval(read(`js/${name}.js`));
  const settle=()=>new Promise(resolve=>w.setTimeout(resolve,0));
  try {
    await settle();
    assert.deepEqual(calls.map(c=>c.url),['init']);
    assert.equal(w.document.querySelector('.status-dot').classList.contains('is-live'),true);
    w.document.querySelector('.instance-toggle').click(); await settle();
    assert.equal(calls.filter(c=>c.url==='devices').length,1);
    hidden=true;w.document.dispatchEvent(new w.Event('visibilitychange'));
    assert.equal(calls.find(c=>c.url==='devices').signal.aborted,true);
    assert.equal(w.document.querySelector('.status-dot').classList.contains('is-live'),false);
    assert.equal(timers.size,0);
    hidden=false;w.document.dispatchEvent(new w.Event('visibilitychange'));await settle();
    assert.equal(w.document.querySelector('[data-device="cpu_percent"]').textContent,'42.0%');
    resolveOld(result({devices:{One:{cpu_percent:99}}}));await settle();
    assert.equal(w.document.querySelector('[data-device="cpu_percent"]').textContent,'42.0%');
    w.document.querySelector('#insights-toggle').click();await settle();
    assert.equal(calls.filter(c=>c.url==='insights').length,1);
  } finally {dom.window.close();}
});
