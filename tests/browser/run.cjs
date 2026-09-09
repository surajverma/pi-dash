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
    // Actual navigator offline/online events, with real browser timers.
    await page.goto('http://localhost:5011/fixture/?native=true');
    await page.waitForFunction(() => document.querySelector('#native-polling')?.textContent.includes('"timers":3'));
    await page.context().setOffline(true);
    await page.waitForFunction(() => document.querySelector('#native-polling')?.textContent.includes('"timers":0'));
    const offlineCalls = JSON.parse(await page.locator('#native-polling').innerText()).calls;
    await page.waitForTimeout(3200);
    if (JSON.parse(await page.locator('#native-polling').innerText()).calls !== offlineCalls) throw new Error('Browser offline state still polls');
    await page.context().setOffline(false);
    await page.waitForFunction(() => document.querySelector('#native-polling')?.textContent.includes('"timers":3'));
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
