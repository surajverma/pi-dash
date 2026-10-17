/* Capture production markup with synthetic data only; never contact a Pi-hole. */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  const server = spawn(process.execPath, [path.join(root, 'tests/browser/server.cjs'), '--port', '5012'], {cwd:root,stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(new Error('Fixture server exited: '+code)));});
    browser = await chromium.launch();
    const context = await browser.newContext({deviceScaleFactor:1,locale:'en-US',timezoneId:'UTC',reducedMotion:'reduce'});
    await context.addInitScript(() => {
      const RealDate = Date, fixed = RealDate.parse('2026-10-17T12:30:00Z');
      window.Date = class extends RealDate {constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};
    });
    const page = await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const output = path.join(root,'docs/screenshots');fs.mkdirSync(output,{recursive:true});
    for (const shot of [
      {name:'desktop-default-light',width:1366,height:768,dark:false,insights:false},
      {name:'desktop-insights-dark',width:1366,height:768,dark:true,insights:true},
      {name:'mobile-default-dark',width:390,height:780,dark:true,insights:false},
      {name:'mobile-details-dark',width:390,height:780,dark:true,insights:false,details:true},
    ]) {
      await page.setViewportSize({width:shot.width,height:shot.height});
      await page.goto(`http://localhost:5012/fixture/?dark=${shot.dark}&insights=${shot.insights}`);
      await page.locator('.instance-card').first().waitFor();
      // Seed sample list age and live-rate sparklines through the mock API.
      await page.evaluate(async () => {
        const f=window.fixture;
        Object.assign(f.data.Primary.queries,{total:89151,blocked:23808,percent_blocked:26.7,cached:45402,forwarded:19941});
        Object.assign(f.data.Secondary.queries,{total:6645,blocked:145,percent_blocked:2.2,cached:3854,forwarded:2646});
        f.data.Secondary.clients.active=7;
        Object.assign(f.summary,{total_queries:95796,blocked_queries:23953,percent_blocked:25.0,cached_queries:49256,forwarded_queries:22587});
        for (const instance of Object.values(f.data)) instance.gravity.last_update=Date.now()/1000-183600;
        for (const rate of [2.2,2.5,3.1,2.8,4.3,5.2,4.8,5.6]) {
          f.data.Primary.queries.frequency=rate;
          f.data.Secondary.queries.frequency=rate/20;
          await f.tick(2000);
        }
      });
      if (shot.details) await page.locator('.instance-toggle').first().click();
      if (shot.width>767 || shot.details) await page.locator('[data-device="cpu_percent"]').first().filter({hasText:'7.2%'}).waitFor();
      if (shot.insights) await page.locator('#network-clients .ranking-row').first().waitFor();
      if (await page.locator('#network-insights').isVisible() !== shot.insights) throw new Error('Wrong insights state in '+shot.name);
      if (await page.locator('body').evaluate(el=>el.scrollWidth>document.documentElement.clientWidth)) throw new Error('Horizontal overflow in '+shot.name);
      await page.screenshot({path:path.join(output,shot.name+'.png'),fullPage:true,animations:'disabled'});
      console.log('Captured '+shot.name);
    }
    if(errors.length) throw new Error(errors.join('\n'));
  } finally {if(browser) await browser.close();server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
