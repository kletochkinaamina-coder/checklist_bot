'use strict';
/**
 * HTTP API Al Musk. Один обработчик (req, res) для Vercel и локального сервера.
 */
const crypto = require('crypto');
const Calc = require('../public/calc.js');
const { createStore } = require('./store');
const { mutateDay, HttpError, K, DATE_RE } = require('./db');

let cached = null;
function getStore() {
  if (!cached) cached = createStore();
  return cached;
}
function setStore(s) {
  cached = s;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 6 * 1024 * 1024) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(c);
  }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

function pinOk(given) {
  const pin = process.env.ACCESS_PIN;
  if (!pin) return true;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(pin));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
}

async function checkAuth(req, store) {
  if (!process.env.ACCESS_PIN) return;
  const failKey = `am:fail:${clientIp(req)}`;
  if (pinOk(req.headers['x-pin'])) return;
  const n = await store.incr(failKey, 15 * 60);
  if (n > 20) throw new HttpError(429, 'Слишком много неверных попыток. Подождите 15 минут.');
  throw new HttpError(401, 'Неверный PIN');
}

function cleanSettings(v) {
  const s = Calc.withDefaults(v);
  if (!(Calc.num(s.basePrice) > 0)) throw new HttpError(400, 'Цена основы должна быть больше нуля');
  s.basePrice = Calc.num(s.basePrice);
  for (const t of ['concentration', 'perfumeBottles', 'oilBottles']) {
    const out = {};
    for (const [k, val] of Object.entries(s[t] || {})) {
      const vol = Calc.num(k);
      if (vol > 0 && !Calc.blank(val)) out[String(vol)] = Calc.num(val);
    }
    s[t] = out;
  }
  const seen = new Set();
  s.oils = (s.oils || []).filter((o) => o && !Calc.blank(o.name)).map((o) => ({
    id: o.id || crypto.randomBytes(5).toString('hex'),
    name: String(o.name).trim(),
    price: Calc.num(o.price),
    updated: String(o.updated || ''),
    history: Array.isArray(o.history) ? o.history.slice(-50) : [],
  }));
  for (const o of s.oils) {
    const k = Calc.norm(o.name);
    if (seen.has(k)) throw new HttpError(400, `Аромат «${o.name}» записан в справочнике дважды`);
    seen.add(k);
  }
  s.goods = (s.goods || []).filter((g) => g && !Calc.blank(g.name)).map((g) => ({
    id: g.id || crypto.randomBytes(5).toString('hex'),
    name: String(g.name).trim(),
    cost: Calc.num(g.cost),
    updated: String(g.updated || ''),
    history: Array.isArray(g.history) ? g.history.slice(-50) : [],
  }));
  s.sellers = (s.sellers || []).filter((x) => x && !Calc.blank(x.name)).map((x) => ({ name: String(x.name).trim(), salary: Calc.num(x.salary) }));
  s.changeLog = Array.isArray(s.changeLog) ? s.changeLog.slice(-200) : [];
  return s;
}

async function handle(req, res) {
  const { store, kind } = getStore();
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '');
    const m = req.method;

    if (p === '/api/health') {
      return send(res, 200, { ok: true, store: kind, auth: !!process.env.ACCESS_PIN });
    }
    if (p === '/api/login' && m === 'POST') {
      await checkAuth(req, store);
      return send(res, 200, { ok: true });
    }

    await checkAuth(req, store);

    if (p === '/api/settings') {
      if (m === 'GET') {
        const cur = await store.get(K.settings);
        return send(res, 200, { rev: cur ? cur.rev : 0, value: Calc.withDefaults(cur && cur.value) });
      }
      if (m === 'PUT') {
        const body = await readBody(req);
        const value = cleanSettings(body.value);
        const ok = await store.cas(K.settings, Number(body.rev) || 0, value);
        if (!ok) throw new HttpError(409, 'Справочник изменили с другого устройства. Обновите страницу и повторите.');
        return send(res, 200, { rev: (Number(body.rev) || 0) + 1, value });
      }
    }

    if (p === '/api/index' && m === 'GET') {
      return send(res, 200, await store.hgetall(K.index));
    }

    let mm = p.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/);
    if (mm) {
      const date = mm[1];
      if (m === 'GET') {
        const cur = await store.get(K.day(date));
        return send(res, 200, cur || { rev: 0, value: null });
      }
      if (m === 'POST') {
        const body = await readBody(req);
        return send(res, 200, await mutateDay(store, date, body));
      }
    }

    if (p === '/api/range' && m === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) throw new HttpError(400, 'Неверный период');
      const idx = await store.hgetall(K.index);
      const dates = Object.keys(idx).filter((d) => d >= from && d <= to).sort();
      if (dates.length > 400) throw new HttpError(400, 'Период слишком длинный');
      const docs = await store.mget(dates.map(K.day));
      return send(res, 200, docs.filter(Boolean).map((d) => d.value));
    }

    mm = p.match(/^\/api\/photo\/(\d{4}-\d{2}-\d{2})$/);
    if (mm) {
      const date = mm[1];
      if (m === 'GET') return send(res, 200, { dataUrl: await store.getRaw(K.photo(date)) });
      if (m === 'PUT') {
        const body = await readBody(req);
        const dataUrl = String(body.dataUrl || '');
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl)) throw new HttpError(400, 'Нужна картинка');
        if (dataUrl.length > 3 * 1024 * 1024) throw new HttpError(413, 'Фото слишком большое');
        const day = await mutateDay(store, date, { type: 'setPhoto', has: true });
        await store.setRaw(K.photo(date), dataUrl);
        return send(res, 200, day);
      }
      if (m === 'DELETE') {
        const day = await mutateDay(store, date, { type: 'setPhoto', has: false });
        await store.delRaw(K.photo(date));
        return send(res, 200, day);
      }
    }

    if (p === '/api/export' && m === 'GET') {
      const settings = await store.get(K.settings);
      const idx = await store.hgetall(K.index);
      const dates = Object.keys(idx).sort();
      const docs = await store.mget(dates.map(K.day));
      return send(res, 200, {
        exportedAt: new Date().toISOString(),
        settings: Calc.withDefaults(settings && settings.value),
        days: docs.filter(Boolean).map((d) => d.value),
      });
    }

    throw new HttpError(404, 'Не найдено');
  } catch (e) {
    if (e instanceof SyntaxError) return send(res, 400, { error: 'Неверный JSON' });
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Ошибка сервера. Данные не изменены.' });
  }
}

module.exports = { handle, setStore, cleanSettings };
