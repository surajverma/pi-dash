/* CI/local automation for the same visible, inspectable browser fixture. */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, 'server.cjs'), '--port', '5011'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.stdout.once('data', resolve);
      server.once('exit', code => reject(new Error(`Fixture server exited: ${code}`)));
      server.once('error', reject);
    });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto('http://localhost:5011/tests/browser/');
    await page.getByRole('button', { name: 'Run all rendered checks' }).click();
    await page.locator('#result[data-status="passed"], #result[data-status="failed"]').waitFor({ timeout: 120000 });
    console.log(await page.locator('#result').innerText());
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results/rendered-results.png'), fullPage: true });
    if (await page.locator('#result').getAttribute('data-status') !== 'passed') process.exitCode = 1;
    // The normal two-instance dashboard must fit laptop content viewports.
    for (const height of [768, 680, 640]) {
      await page.setViewportSize({width:1366,height});
      await page.goto('http://localhost:5011/fixture/?dark=true');
      await page.locator('[data-device="cpu_percent"]').first().filter({hasText:'7.2%'}).waitFor();
      const fit = await page.evaluate(() => ({height:document.documentElement.clientHeight, bottom:document.querySelector('main').getBoundingClientRect().bottom, scroll:document.documentElement.scrollHeight}));
      if (fit.bottom > fit.height || fit.scroll > fit.height) throw new Error(`Laptop viewport scrolls at 1366x${height}: ${JSON.stringify(fit)}`);
      if (await page.locator('.rank-track,.metric-group-title,.insights-window,[data-device="upstream_ms"]').count()) throw new Error('Removed decorations remain');
      if (!(await page.locator('.instance-clients').first().innerText()).includes('18 active clients')) throw new Error('Header client count missing');
      await page.screenshot({path:path.join(root,`test-results/compact-1366x${height}.png`),fullPage:true});
    }
    console.log('Laptop fit at 1366x768, 1366x680 and 1366x640: passed');
    // Check the opt-out layout and centered hardware groups with real CSS.
    await page.goto('http://localhost:5011/fixture/?insights=false');
    await page.locator('[data-device="cpu_percent"]').first().filter({hasText:'7.2%'}).waitFor();
    if (await page.locator('#network-insights').isVisible() || await page.locator('#insights-toggle').isVisible()) throw new Error('Insights opt-out is visible');
    const compactWidth = await page.locator('#main-wrapper').evaluate(el=>el.getBoundingClientRect().width);
    if (Math.abs(compactWidth-768)>1) throw new Error('Insights opt-out did not restore the compact 768px desktop width');
    const defaults = await page.evaluate(async () => {
      await window.fixture.tick(30000);
      return {insightCalls:window.fixture.calls.filter(c=>c.type==='insights').length, centered:[...document.querySelectorAll('.device-group .metric-row')].every(row=>{const style=getComputedStyle(row);return style.justifyContent==='center' && (style.flexDirection!=='column' || style.alignItems==='center');})};
    });
    if (defaults.insightCalls || !defaults.centered) throw new Error('Disabled insights poll or hardware alignment is wrong');
    await page.screenshot({path:path.join(root,'test-results/default-insights-off.png'),fullPage:true});
    console.log('Insights opt-out and centered hardware: passed');
    const maskable = await page.evaluate(async () => {
      const image = new Image(); image.src='/icons/icon-maskable-512.png'; await image.decode();
      const canvas=document.createElement('canvas');canvas.width=canvas.height=512;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);
      const pixels=context.getImageData(0,0,512,512).data;
      for(let y=0;y<512;y++)for(let x=0;x<512;x++){
        const i=(y*512+x)*4;
        if(pixels[i+3]!==255)return false;
        const artwork=pixels[i]!==31||pixels[i+1]!==41||pixels[i+2]!==55;
        if(artwork&&Math.hypot(x+.5-256,y+.5-256)>204.8)return false;
      }
      return true;
    });
    if(!maskable)throw new Error('Maskable icon has transparency or artwork outside its safe circle');
    console.log('Maskable icon opacity and safe circle: passed');
    // Actual navigator offline/online events, with real browser timers.
    await page.goto('http://localhost:5011/fixture/?native=true');
    await page.waitForFunction(() => document.querySelector('#native-polling')?.textContent.includes('"timers":4'));
    await page.context().setOffline(true);
    await page.waitForFunction(() => document.querySelector('#native-polling')?.textContent.includes('"timers":0'));
    const offlineCalls = JSON.parse(await page.locator('#native-polling').innerText()).calls;
    await page.waitForTimeout(3200);
    if (JSON.parse(await page.locator('#native-polling').innerText()).calls !== offlineCalls) throw new Error('Browser offline state still polls');
    await page.context().setOffline(false);
    await page.waitForFunction(() => document.querySelector('#native-polling')?.textContent.includes('"timers":4'));
    console.log('Real browser offline/online polling: passed');
    // Keep reviewable screenshots of production markup at actual top-level viewport sizes.
    for (const [width, height] of [[320,568],[375,667],[430,932],[768,375],[768,1024],[1440,900]]) {
      await page.setViewportSize({ width, height });
      await page.goto('http://localhost:5011/fixture/');
      await page.locator('.instance-card').first().waitFor();
      await page.screenshot({ path: path.join(root, `test-results/${width}x${height}.png`), fullPage: true });
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
