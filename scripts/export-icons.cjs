/* Reproducible transparent PNG/ICO exports from the checked-in SVG master.
   Run npm run build:icons after installing Playwright Chromium. */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const source = fs.readFileSync(path.join(root, 'icons/icon.svg'), 'utf8');
  const favicon = source.replace(/<g fill="#fff" id="bars">[\s\S]*?<\/g>/, '<g fill="#fff" id="bars"><rect x="176" y="256" width="48" height="48"/><rect x="240" y="208" width="48" height="96"/><rect x="304" y="240" width="48" height="64"/></g>');
  fs.writeFileSync(path.join(root, 'icons/favicon.svg'), favicon);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({deviceScaleFactor:1});
    for (const size of [16,32,180,192,512]) {
      let svg = size <= 32 ? favicon : source;
      if (size === 16) svg = svg.replace(/<g fill="#fff" id="bars">[\s\S]*?<\/g>/, '<g fill="#fff" id="bars"><rect x="160" y="256" width="32" height="64"/><rect x="224" y="192" width="64" height="128"/><rect x="320" y="224" width="32" height="96"/></g>');
      await page.setViewportSize({width:size,height:size});
      await page.setContent('<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>'+svg);
      await page.screenshot({path:path.join(root,'icons',size===180?'apple-touch-icon.png':`icon-${size}.png`),omitBackground:true});
    }
    const maskable = source.replace(/<svg[^>]*>/, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1f2937"/><g transform="translate(82 82) scale(.68)">').replace('</svg>', '</g></svg>');
    fs.writeFileSync(path.join(root,'icons/icon-maskable.svg'),maskable);
    await page.setViewportSize({width:512,height:512});
    await page.setContent('<style>html,body{margin:0}svg{display:block;width:100%;height:100%}</style>'+maskable);
    await page.screenshot({path:path.join(root,'icons/icon-maskable-512.png')});
    const images = [16,32].map(size=>({size,data:fs.readFileSync(path.join(root,`icons/icon-${size}.png`))}));
    const header=Buffer.alloc(6+16*images.length); header.writeUInt16LE(1,2); header.writeUInt16LE(images.length,4);
    let offset=header.length;
    images.forEach(({size,data},i)=>{const entry=6+16*i;header[entry]=size;header[entry+1]=size;header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);header.writeUInt32LE(data.length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=data.length;});
    fs.writeFileSync(path.join(root,'icons/favicon.ico'),Buffer.concat([header,...images.map(i=>i.data)]));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
