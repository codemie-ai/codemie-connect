// Minimal static file server for ui/ so ES module <script type="module"> tags
// load over http (file:// blocks cross-origin module imports). Used only by
// the dynamic Playwright verification for EPMCDME-14511 — not part of the app.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..', '..', '..', '..', 'ui');
const port = Number(process.env.STATIC_PORT || 8934);

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (req.url === '/') p = path.join(root, 'index.html');
  fs.readFile(p, (err, data) => {
    if (err) {
      res.statusCode = 404;
      return res.end('not found: ' + p);
    }
    res.setHeader('Content-Type', mime[path.extname(p)] || 'application/octet-stream');
    res.end(data);
  });
});

server.listen(port, () => console.log(`static server up on :${port}, serving ${root}`));
