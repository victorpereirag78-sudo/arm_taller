// ================================================================
// tools/serve.js — Servidor estático para desarrollo local
// Uso:  node tools/serve.js   →  http://localhost:4173
// El sitio no tiene build: esto solo sirve los archivos tal cual,
// igual que Cloudflare Pages en producción.
// ================================================================
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT   = path.resolve(__dirname, '..');
const PUERTO = Number(process.env.PORT) || 4173;
const TIPOS  = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon'
};

http.createServer((req, res) => {
    const rel  = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'login.html';
    const file = path.resolve(ROOT, rel);

    // No servir nada fuera del proyecto
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('403'); return; }

    fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404).end('404 ' + rel); return; }
        res.writeHead(200, {
            'Content-Type':  TIPOS[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        res.end(buf);
    });
}).listen(PUERTO, () => console.log('ARM Taller → http://localhost:' + PUERTO));
