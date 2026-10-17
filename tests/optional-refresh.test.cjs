const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), {JSDOM}=require('jsdom');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
function setup(offline=false) {
  const dom=new JSDOM(read('index.html').replace(/<script[\s\S]*?<\/script>/g,''),{url:'https://example.test',runScripts:'outside-only'}), w=dom.window;
  let hidden=false, count=0, healthy=!offline, next=0;
  const retries=new Map(), intervals=new Map();
  Object.defineProperty(w.document,'hidden',{get:()=>hidden});Object.defineProperty(w.navigator,'onLine',{get:()=>true});
  w.setTimeout=(fn,ms)=>{const id=++next;retries.set(id,{fn:()=>{retries.delete(id);return fn();},ms});return id;};w.clearTimeout=id=>retries.delete(id);
  w.setInterval=(fn,ms)=>{const id=++next;intervals.set(id,{fn,ms});return id;};w.clearInterval=id=>intervals.delete(id);
  const config={refresh_interval:2000,show_network_summary:true,show_network_insights:false,show_device_metrics:true,piholes:[{name:'One'}]};
  const stats=()=>({One:healthy?{queries:{total:1},_pi_dash:{blocking:true}}:{error:'offline',_pi_dash:{health:'unreachable'}}});
  w.fetch=async url=>({ok:true,json:async()=>url==='init'?{config,data:stats(),summary:{instances:1}}:url.startsWith('data')?{stats:stats(),summary:{instances:1}}:url==='devices'?(++count===1&&!offline?{refreshing:true,updated_at:null}:{devices:{One:{cpu_percent:12}}}):{}});
  for(const name of ['dashboard-core','insights','app'])w.eval(read('js/'+name+'.js'));
  return {w,retries,intervals,settle:()=>new Promise(setImmediate),count:()=>count,
    hide(value){hidden=value;w.document.dispatchEvent(new w.Event('visibilitychange'));},recover(){healthy=true;},close(){dom.window.close();}};
}
test('cold optional refresh retries promptly and hiding cancels its retry',async()=>{
  const a=setup();try{
    await a.settle();assert.equal(a.count(),1);assert.equal(a.retries.size,1);
    const retry=[...a.retries.values()][0];assert.equal(retry.ms,2000);await retry.fn();await a.settle();
    assert.equal(a.count(),2);assert.equal(a.w.document.querySelector('[data-device="cpu_percent"]').textContent,'12.0%');
    assert.equal(a.retries.size,0);
  }finally{a.close();}
  const b=setup();try{await b.settle();b.hide(true);assert.equal(b.retries.size,0);assert.equal(b.count(),1);}finally{b.close();}
});
test('DNS recovery refreshes unavailable device readings without waiting thirty seconds',async()=>{
  const a=setup(true);try{
    await a.settle();assert.equal(a.count(),1);a.recover();
    await [...a.intervals.values()].find(t=>t.ms===2000).fn();await a.settle();
    assert.equal(a.count(),2);assert.equal(a.w.document.querySelector('[data-device="cpu_percent"]').textContent,'12.0%');
  }finally{a.close();}
});
