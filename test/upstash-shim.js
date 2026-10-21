'use strict';
// Локальная имитация Upstash REST API поверх обычного redis-server.
// Нужна только для тестов: проверяем настоящий клиент @upstash/redis и Lua скрипт CAS.
const http = require('http');
const { createClient } = require('redis');

async function startShim(redisUrl = 'redis://127.0.0.1:6379', port = 0) {
  const client = createClient({ url: redisUrl });
  await client.connect();
  const run = (cmd) => client.sendCommand(cmd.map(String));
  // Upstash по умолчанию отдаёт строки в base64 (заголовок Upstash-Encoding), SDK их декодирует.
  const enc = (v) => (typeof v === 'string' ? (v === 'OK' ? v : Buffer.from(v, 'utf8').toString('base64'))
    : Array.isArray(v) ? v.map(enc) : v);
  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '[]');
        let out;
        const b64 = String(req.headers['upstash-encoding'] || '') === 'base64';
        const wrap = (r) => ({ result: b64 ? enc(r) : r });
        if (req.url.startsWith('/pipeline')) out = await Promise.all(parsed.map(async (c) => wrap(await run(c))));
        else out = wrap(await run(parsed));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(out));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(e.message) }));
      }
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => { server.close(); await client.quit(); } };
}

module.exports = { startShim };
