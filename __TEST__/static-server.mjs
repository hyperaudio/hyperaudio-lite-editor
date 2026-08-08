// Static file server for the e2e suite. Replaces `python3 -m http.server`,
// whose single-threaded handling under Playwright load produced broken pipes,
// three-minute runs, and phantom single-test failures. Node http with
// keep-alive; serves the repo root; no dependencies.
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 4173);
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.vtt': 'text/vtt',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

http.createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  let stat;
  try { stat = statSync(file); } catch (e) { res.writeHead(404).end(); return; }
  if (stat.isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`static server on :${PORT}`));
