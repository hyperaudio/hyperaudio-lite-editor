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
  let file = join(ROOT, path === '/' ? 'index.html' : path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  let stat;
  try { stat = statSync(file); } catch (e) { res.writeHead(404).end(); return; }
  // a directory serves its index.html, as GitHub Pages does (viewer/, #624)
  if (stat.isDirectory()) {
    file = join(file, 'index.html');
    try { stat = statSync(file); } catch (e) { res.writeHead(404).end(); return; }
    if (stat.isDirectory()) { res.writeHead(404).end(); return; }
  }
  // Range requests, as any real media host serves them: the editor sniffs a
  // URL by its first bytes and mediabunny reads an audio track by ranges
  // (#627), so a server that ignores Range tests neither.
  const type = TYPES[extname(file)] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range !== null && stat.size > 0) {
    const start = range[1] === '' ? Math.max(0, stat.size - Number(range[2])) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? stat.size - 1 : Math.min(Number(range[2]), stat.size - 1);
    if (start >= stat.size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
      return;
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`static server on :${PORT}`));
