'use strict';
// Локальный запуск: npm start, затем http://localhost:3000
// Данные сохраняются в data/almusk.json (или в Upstash, если заданы переменные).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle } = require('./lib/api');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC, u === '/' ? 'index.html' : u));
  if (!file.startsWith(PUBLIC)) {
    res.statusCode = 403;
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}

/** Один обработчик на всё: API и файлы интерфейса. */
function app(req, res) {
  if (req.url.startsWith('/api/')) return handle(req, res);
  return serveStatic(req, res);
}

const server = http.createServer(app);

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(`Al Musk: http://localhost:${port}`));
}

// Экспорт функции-обработчика: так файл работает и на Vercel с пресетом Node
module.exports = app;
module.exports.app = app;
module.exports.server = server;
