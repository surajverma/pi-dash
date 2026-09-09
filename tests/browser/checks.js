/* Run in a real browser: jsdom cannot validate these geometry assertions. */
const result = document.querySelector('#result');
const settle = () => new Promise(resolve => setTimeout(resolve, 35));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const shown = e => e.getClientRects().length > 0;
const bounds = e => e.getBoundingClientRect();
const overlap = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
function geometry(d, stage) {
  const width = d.documentElement.clientWidth;
  assert(d.documentElement.scrollWidth <= width, `${stage}: page overflows horizontally`);
  assert(bounds(d.querySelector('header')).top >= -1, `${stage}: header is clipped at top`);
  assert(bounds(d.querySelector('#network-summary')).top >= -1, `${stage}: summary is clipped at top`);
  const cards = [...d.querySelectorAll('.instance-card')];
  const panelElement = d.querySelector('#query-panel');
  const panel = bounds(panelElement);
  const ambient = d.defaultView.getComputedStyle(panelElement).position === 'fixed';
  if (ambient) {
    assert(Math.abs(bounds(d.querySelector('#main-wrapper')).width - 576) < 1, `${stage}: original desktop width changed`);
    assert(Math.abs(panel.left) < 1 && Math.abs(panel.width - width) < 1, `${stage}: background feed is not viewport-wide`);
    assert(!shown(d.querySelector('.query-panel-header')), `${stage}: desktop feed became a foreground panel`);
  }
  for (const card of cards) {
    const r = bounds(card);
    assert(r.left >= -1 && r.right <= width + 1, `${stage}: card exceeds viewport`);
    if (!ambient) assert(!overlap(r, panel), `${stage}: query feed overlaps compact card`);
    else if (r.top < d.documentElement.clientHeight) {
      const hit = d.elementFromPoint(r.left + 5, Math.max(0, r.top) + 5);
      assert(hit && card.contains(hit), `${stage}: background queries obscure desktop card`);
    }
    for (const e of card.querySelectorAll('.metric-label,.metric-value,.pihole-rate,.pihole-health,.instance-toggle')) {
      if (!shown(e)) continue;
      const rects = [...e.getClientRects()];
      assert(rects.every(b => b.left >= r.left - 1 && b.right <= r.right + 1), `${stage}: ${e.className} exceeds card`);
      assert(e.scrollWidth <= e.clientWidth + 1 || e.tagName === 'SPAN', `${stage}: text is clipped`);
    }
    for (const row of card.querySelectorAll('.metric-row')) {
      if (shown(row)) assert(!overlap(bounds(row.firstElementChild), bounds(row.lastElementChild)), `${stage}: metric label overlaps value`);
    }
  }
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) assert(!overlap(bounds(cards[i]), bounds(cards[j])), `${stage}: cards overlap`);
  for (const e of d.querySelectorAll('.network-metrics > div')) assert(e.scrollWidth <= e.clientWidth + 1, `${stage}: network metric overflow`);
  const list = d.querySelector('#background-queries');
  if (shown(list)) assert(list.scrollWidth <= list.clientWidth + 1, `${stage}: query text overflow`);
}
async function loadViewport(width, height, scenario, dark) {
  frame.width = width;
  frame.height = height;
  await new Promise(resolve => {
    frame.onload = resolve;
    frame.src = `/fixture/?scenario=${scenario}&dark=${dark}&run=${Date.now()}`;
  });
  await settle();
  const d = frame.contentDocument;
  assert(d.querySelector('.instance-card,.empty-message'), 'dashboard did not initialize');
  return d;
}
async function checkLayout(width, height, scenario, dark) {
  const d = await loadViewport(width, height, scenario, dark);
  const compact = width <= 767 || width <= 1024 && height <= 500;
  assert((d.defaultView.getComputedStyle(d.querySelector('#query-panel')).position === 'fixed') === !compact, 'wrong background/panel presentation');
  geometry(d, 'default');
  assert(frame.contentWindow.getComputedStyle(d.body).backgroundColor === (dark ? 'rgb(31, 41, 55)' : 'rgb(243, 244, 246)'), 'theme does not match saved preference');
  const toggles = [...d.querySelectorAll('.instance-toggle')];
  for (const toggle of toggles) {
    assert(shown(toggle) === compact, 'wrong compact/desktop mode');
    assert(toggle.getAttribute('aria-expanded') === 'false', 'initial expanded state');
    const details = d.getElementById(toggle.getAttribute('aria-controls'));
    assert(shown(details) === !compact, 'wrong metric visibility');
    assert(details.children.length === 7, 'missing desktop metrics');
    assert(toggle.getAttribute('aria-label').includes('details for '), 'missing per-instance accessible name');
    if (compact) {
      toggle.click();
      assert(shown(details) && toggle.getAttribute('aria-expanded') === 'true', 'details did not expand');
    }
  }
  geometry(d, 'expanded');
  const queryToggle = d.querySelector('#query-toggle');
  if (compact) queryToggle.click();
  assert(shown(d.querySelector('#background-queries')), 'query feed did not open');
  geometry(d, 'queries open');
  if (scenario !== 'zero') assert(d.querySelector('#background-queries').textContent.includes('(x3)'), 'consecutive grouping missing');
  if (scenario === 'states') {
    for (const state of ['Blocking ON', 'Blocking OFF', 'Offline', 'Auth failed', 'blocking unknown']) assert(d.querySelector('main').textContent.includes(state), `missing ${state}`);
    assert(shown(d.querySelector('.network-partial')), 'missing partial summary');
  }
  if (scenario === 'zero') assert(d.querySelector('.empty-message') && !toggles.length, 'zero instances failed');
  if (compact) {
    for (const toggle of toggles) toggle.click();
    queryToggle.click();
    geometry(d, 'collapsed again');
  }
  // Resize the same live document across the breakpoint with details expanded.
  if (toggles.length && compact) {
    toggles[0].click();
    frame.width = 1280; frame.height = 900;
    await settle();
    assert([...d.querySelectorAll('.instance-details')].every(shown), 'desktop lost full metrics after resize');
    frame.width = width; frame.height = height;
    await settle();
    assert(shown(d.querySelector('.instance-details')), 'expanded state lost after resize');
    toggles[0].click();
  }
}
async function checkLifecycle() {
  const d = await loadViewport(375, 667, 'normal', false);
  const w = frame.contentWindow, f = w.fixture;
  const expectedTimers = () => assert(JSON.stringify([...f.timers.values()].map(t => t.ms).sort((a,b)=>a-b)) === '[1000,2000,3000]', 'duplicate or missing polling timers');
  expectedTimers();
  // Keep requests pending even after abort, like a late response/body or ignored abort.
  const oldStats = f.defer('data'), oldQueries = f.defer('queries');
  const statsTick = f.tick(2000), queryTick = f.tick(3000);
  await settle();
  f.hide(true);
  assert(f.timers.size === 0, 'hidden page retains timers');
  assert(f.calls.slice(-2).every(c => c.signal.aborted), 'hidden page does not abort both requests');
  const hiddenCalls = f.calls.length;
  await f.tick(2000); await f.tick(3000);
  assert(f.calls.length === hiddenCalls, 'hidden page polls');
  f.release('data'); f.release('queries');
  f.data.Primary.queries.total = 999;
  f.queries.Primary = [{ id: 100, time: 100, domain: 'fresh.test', blocked: false }];
  f.hide(false); await settle(); expectedTimers();
  const value = () => d.querySelector('.instance-details [data-value="total"]').textContent;
  assert(value() === '999', 'resume did not refresh stats');
  oldStats.resolve({ ok: true, json: async () => ({ stats: { Primary: { queries: { total: 111 } } } }) });
  oldQueries.resolve({ ok: true, json: async () => ({ Primary: [{ id: 999, time: 999, domain: 'stale.test' }] }) });
  await Promise.all([statsTick, queryTick]);
  assert(value() === '999' && !d.querySelector('#background-queries').textContent.includes('stale.test'), 'late response overwrote foreground state');
  for (let i=0; i<3; i++) {
    f.online(false); assert(f.timers.size === 0, 'offline page retains timers');
    const count = f.calls.length; await f.tick(2000); await f.tick(3000);
    assert(f.calls.length === count, 'offline page polls');
    f.hide(true); f.online(true); assert(f.timers.size === 0, 'online event resumes hidden page');
    f.hide(false); await settle(); expectedTimers();
  }
  f.hide(true);
  const held = f.defer('data');
  f.hide(false); await settle();
  const count = f.calls.length;
  await f.tick(2000);
  assert(f.calls.length === count, 'overlapping stats request');
  f.release('data'); held.resolve({ ok: true, json: async () => ({ stats: f.data, summary: f.summary }) });
  await settle();
  w.dispatchEvent(new Event('pagehide')); assert(f.timers.size === 0, 'pagehide retains timers');
  w.dispatchEvent(new Event('pageshow')); await settle(); expectedTimers();
}
document.querySelector('#run').addEventListener('click', async () => {
  const button = document.querySelector('#run'); button.disabled = true;
  result.dataset.status = 'running'; result.textContent = 'Running rendered checks...';
  const sizes = [[320,568],[568,320],[375,667],[667,375],[430,932],[932,430],[768,1024],[1024,768],[768,375],[800,600],[1024,500],[1280,720],[1440,900],[1920,1080]];
  const failures = []; let passed = 0;
  for (const [width,height] of sizes) for (const scenario of ['normal','long','many','zero','states']) for (const dark of [false,true]) {
    const name = `${width}×${height} ${scenario} ${dark ? 'dark' : 'light'}`;
    try { await checkLayout(width,height,scenario,dark); passed++; }
    catch(error) { failures.push(`${name}: ${error.message}`); }
    result.textContent = `${passed} passed; ${failures.length} failed. Checking ${name}\n${failures.join('\n')}`;
  }
  try { await checkLifecycle(); passed++; } catch(error) { failures.push(`Polling lifecycle: ${error.message}`); }
  result.textContent = `${passed} passed; ${failures.length} failed.\n${failures.join('\n')}`;
  result.dataset.status = failures.length ? 'failed' : 'passed'; button.disabled = false;
});
