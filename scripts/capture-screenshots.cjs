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
        Object.assign(f.data.Primary.queries,{total:169752,blocked:25219,percent_blocked:14.9,cached:138402,forwarded:6131});
        Object.assign(f.data.Secondary.queries,{total:7031,blocked:208,percent_blocked:3.0,cached:4264,forwarded:2559});
        f.data.Primary.clients.active=20; f.data.Secondary.clients.active=10;
        f.data.Primary.gravity.domains_being_blocked=2355639; f.data.Secondary.gravity.domains_being_blocked=2355751;
        Object.assign(f.summary,{total_queries:176783,blocked_queries:25427,percent_blocked:14.4,cached_queries:142666,forwarded_queries:8690});
        Object.assign(f.devices.Primary,{cpu_percent:3.1,ram_percent:34.6,temperature:47.8,uptime_seconds:435600});
        Object.assign(f.devices.Secondary,{cpu_percent:0.6,ram_percent:20.8,temperature:43.3,uptime_seconds:273600});
        let seed=42;
        const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
        const last=Math.floor(Date.now()/600000)*600;
        const weights=Array.from({length:144},(_,i)=>{
          const hour=new Date((last-(143-i)*600)*1000).getUTCHours();
          return (hour<6?220:hour<9?900:hour<18?1600:1100)*(0.65+random()*0.7)+(i===106?2400:i===107?3300:i===131?1800:0);
        });
        const allocate=(total,weights)=>{const sum=weights.reduce((a,b)=>a+b,0), values=weights.map(w=>Math.floor(w/sum*total));let remaining=total-values.reduce((a,b)=>a+b,0);for(let i=0;remaining;i++,remaining--)values[i%values.length]++;return values;};
        const totals=allocate(176783,weights), blocked=allocate(25427,totals.map(t=>t*(0.1+random()*0.12)));
        f.insights.history.points=totals.map((total,i)=>({timestamp:last-(143-i)*600,total,blocked:blocked[i],contributors:2}));
        f.insights.clients.items=['Work laptop','Living room TV','Home server','Mobile phone','Router'].map((label,i)=>({id:'192.0.2.'+(10+i),label,count:[75314,50789,12071,11550,9272][i],share:[75314,50789,12071,11550,9272][i]/176783*100}));
        f.insights.domains.items=['telemetry','ads','metrics','tracking','events'].map((label,i)=>({id:label+'.example.test',label:label+'.example.test',count:[9012,7118,3224,987,734][i],share:[9012,7118,3224,987,734][i]/25427*100}));
        for(const instance of Object.values(f.data))instance.gravity.last_update=Date.now()/1000-183600;
        const names=['home.example.test','media.example.test','updates.example.test','ads.example.test','telemetry.example.test','sync.example.test'];
        f.queries.Primary=Array.from({length:100},(_,i)=>({id:1000+i,time:1000+i,domain:names[Math.floor(random()*names.length)],blocked:i%4===0}));
        await f.tick(3000);
        f.hide(true);f.hide(false);
        for(const rate of [1.2,1.4,1.1,1.8,1.5,1.3,1.7,1.5,2.1,2.0,2.5,2.3,2.4,5.8,6.2,5.5,5.9,5.2,5.8,5.6]){
          f.data.Primary.queries.frequency=rate;f.data.Secondary.queries.frequency=rate/20;await f.tick(2000);
        }
      });
      if (shot.details) await page.locator('.instance-toggle').first().click();
      if (shot.width>767 || shot.details) await page.locator('[data-device="cpu_percent"]').first().filter({hasText:'3.1%'}).waitFor();
      if (shot.insights) await page.locator('#network-clients .ranking-row').first().waitFor();
      if (await page.locator('#network-insights').isVisible() !== shot.insights) throw new Error('Wrong insights state in '+shot.name);
      if (await page.locator('body').evaluate(el=>el.scrollWidth>document.documentElement.clientWidth)) throw new Error('Horizontal overflow in '+shot.name);
      await page.screenshot({path:path.join(output,shot.name+'.png'),fullPage:true,animations:'disabled'});
      console.log('Captured '+shot.name);
    }
    if(errors.length) throw new Error(errors.join('\n'));
  } finally {if(browser) await browser.close();server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
