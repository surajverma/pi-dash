/* Local-only fixture: real production assets, synthetic Pi-hole API responses. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const arg = process.argv.indexOf('--port');
const port = arg < 0 ? 5011 : Number(process.argv[arg + 1]);
http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (pathname.startsWith('/fixture/')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace('{{ICON_URL}}', '/favicon.ico').replace('<head>', '<head><base href="/"><script src="tests/browser/mock.js"></script>'));
    return;
  }
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const relative = pathname === '/' ? '/tests/browser/index.html' : pathname.endsWith('/') ? pathname + 'index.html' : pathname;
  const file = path.resolve(root, '.' + relative);
  // Only public assets and this synthetic test harness may be served.
  if (!file.startsWith(root + path.sep) || !/^\/(css|js|tests\/browser)\//.test(relative)) { res.writeHead(404); res.end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'text/plain');
    res.end(data);
  });
}).listen(port, '0.0.0.0', () => console.log(`Rendered regression suite: http://localhost:${port}/tests/browser/`));
