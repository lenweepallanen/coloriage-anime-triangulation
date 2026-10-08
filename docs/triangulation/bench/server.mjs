import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path'
const PUB = '/Users/nicolasrocher/Documents/claude code projects/PicoPop/apps/admin/public'
const S = path.dirname(new URL(import.meta.url).pathname)   // images dans ./img/, sorties dans ./out/
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.json': 'application/json' }
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let f = null; console.log(new Date().toISOString().slice(11, 19), req.method, u.pathname); res.on('finish', () => console.log('  → fini', u.pathname))
  if (u.pathname === '/opencv-worker.js') {   // worker réel, avec l'opencv.js LOCAL à la place du CDN (banc hors ligne)
    const src = readFileSync(path.join(PUB, 'opencv-worker.js'), 'utf8').replace(/const OPENCV_URLS = \[[^\]]*\]/, "const OPENCV_URLS = ['/opencv.js']")
    res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(src); return
  }
  if (u.pathname === '/opencv.js') f = path.join(PUB, 'opencv.js')
  else if (u.pathname === '/harness.html') f = path.join(S, 'harness.html')
  else if (u.pathname.startsWith('/img/')) f = path.join(S, 'img', path.basename(u.pathname))
  if (!f || !existsSync(f)) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f))
}).listen(8777, '127.0.0.1', () => console.log('serveur 8777 prêt'))
