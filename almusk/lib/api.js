'use strict';
/**
 * HTTP API Al Musk. Один обработчик (req, res) для Vercel и локального сервера.
 */
const crypto = require('crypto');
const Calc = require('../public/calc.js');
const { createStore } = require('./store');
const { mutateDay, viewFor, HttpError, K, DATE_RE } = require('./db');
const SEED = require('../public/seed.js');

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

const ownerPin = () => process.env.OWNER_PIN || process.env.ACCESS_PIN || '';
const sha = (salt, pin) => crypto.createHash('sha256').update(`${salt}:${pin}`).digest('hex');

function same(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
}

/**
 * Роль по PIN: руководитель (OWNER_PIN в переменных Vercel) или продавец
 * (PIN продавцов задаёт руководитель в кабинете, хранится в виде хэша).
 * Если OWNER_PIN не задан, все входят как руководитель (локальная работа).
 */
async function resolveRole(req, store) {
  const owner = ownerPin();
  if (!owner) return 'owner';
  const given = String(req.headers['x-pin'] || '');
  if (given && same(given, owner)) return 'owner';
  if (given) {
    const rec = await store.getRaw(K.sellerPin);
    if (rec) {
      const [salt, hash] = String(rec).split(':');
      if (same(sha(salt, given), hash)) return 'seller';
    }
  }
  const n = await store.incr(`am:fail:${clientIp(req)}`, 15 * 60);
  if (n > 20) throw new HttpError(429, 'Слишком много неверных попыток. Подождите 15 минут.');
  throw new HttpError(401, 'Неверный PIN');
}

const ownerOnly = (role) => {
  if (role !== 'owner') throw new HttpError(403, 'Доступно только руководителю');
};

/** Дата по времени Казахстана (UTC+5). Продавцу доступны только сегодня и соседние дни. */
function kzToday(now = Date.now()) {
  return new Date(now + 5 * 3600 * 1000).toISOString().slice(0, 10);
}
function sellerDateOk(date) {
  const t = Date.parse(`${kzToday()}T00:00:00Z`);
  const d = Date.parse(`${date}T00:00:00Z`);
  return Math.abs(d - t) <= 86400 * 1000;
}

/** Справочник для продавца: названия без закупочных цен и без зарплат. */
function settingsForSeller(s) {
  return {
    basePrice: null,
    concentration: s.concentration,
    perfumeBottles: Object.fromEntries(Object.keys(s.perfumeBottles || {}).map((k) => [k, null])),
    oilBottles: Object.fromEntries(Object.keys(s.oilBottles || {}).map((k) => [k, null])),
    oils: (s.oils || []).map((o) => ({ id: o.id, name: o.name })),
    goods: (s.goods || []).map((g) => ({ id: g.id, name: g.name })),
    sellers: (s.sellers || []).map((x) => ({ name: x.name })).concat(
      s.ownerName && !(s.sellers || []).some((x) => Calc.norm(x.name) === Calc.norm(s.ownerName)) ? [{ name: s.ownerName, owner: true }] : [],
    ),
    ownerName: s.ownerName || '',
    changeLog: [],
  };
}

async function prevBalances(store, date) {
  const idx = await store.hgetall(K.index);
  const dates = Object.keys(idx).filter((d) => d < date).sort();
  if (!dates.length) return {};
  const c = idx[dates[dates.length - 1]].closing || {};
  const v = (acc) => (c[acc] ? (c[acc].fact === null ? c[acc].calc : c[acc].fact) : 0);
  return { kaspi: v('kaspi'), transfer: v('transfer'), transferTracked: !c.transfer || c.transfer.tracked !== false };
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
    price: Calc.blank(o.price) || !(Calc.num(o.price) > 0) ? null : Calc.num(o.price),
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
  s.ownerName = String(s.ownerName || '').trim();
  return s;
}

function seedOils() {
  const seen = new Set();
  return Calc.parsePriceList(SEED.TEXT).rows
    .filter((r) => !seen.has(Calc.norm(r.name)) && seen.add(Calc.norm(r.name)))
    .map((r) => ({ name: r.name, price: r.price, updated: SEED.DATE, history: r.price ? [{ date: SEED.DATE, price: r.price }] : [] }));
}

async function handle(req, res) {
  const { store, kind } = getStore();
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '');
    const m = req.method;

    if (p === '/api/health') {
      return send(res, 200, { ok: true, store: kind, auth: !!ownerPin(), today: kzToday() });
    }

    const role = await resolveRole(req, store);

    if ((p === '/api/login' && m === 'POST') || p === '/api/me') {
      const sp = role === 'owner' ? !!(await store.getRaw(K.sellerPin)) : undefined;
      return send(res, 200, { ok: true, role, today: kzToday(), sellerPinSet: sp });
    }

    if (p === '/api/seller-pin' && m === 'PUT') {
      ownerOnly(role);
      const body = await readBody(req);
      const pin = String(body.pin || '').trim();
      if (!pin) {
        await store.delRaw(K.sellerPin);
        return send(res, 200, { ok: true, set: false });
      }
      if (!/^\d{4,12}$/.test(pin)) throw new HttpError(400, 'PIN продавцов: от 4 до 12 цифр');
      if (same(pin, ownerPin())) throw new HttpError(400, 'PIN продавцов не должен совпадать с PIN руководителя');
      const salt = crypto.randomBytes(8).toString('hex');
      await store.setRaw(K.sellerPin, `${salt}:${sha(salt, pin)}`);
      return send(res, 200, { ok: true, set: true });
    }

    if (p === '/api/settings') {
      if (m === 'GET') {
        let cur = await store.get(K.settings);
        if (!cur) {
          // Первый запуск: справочник ароматов из стартового списка
          const value = cleanSettings({ oils: seedOils() });
          if (await store.cas(K.settings, 0, value)) cur = { rev: 1, value };
          else cur = await store.get(K.settings);
        }
        const value = Calc.withDefaults(cur && cur.value);
        return send(res, 200, { rev: cur ? cur.rev : 0, value: role === 'owner' ? value : settingsForSeller(value) });
      }
      if (m === 'PUT') {
        ownerOnly(role);
        const body = await readBody(req);
        const value = cleanSettings(body.value);
        const ok = await store.cas(K.settings, Number(body.rev) || 0, value);
        if (!ok) throw new HttpError(409, 'Справочник изменили с другого устройства. Обновите страницу и повторите.');
        return send(res, 200, { rev: (Number(body.rev) || 0) + 1, value });
      }
    }

    if (p === '/api/index' && m === 'GET') {
      ownerOnly(role);
      return send(res, 200, await store.hgetall(K.index));
    }

    let mm = p.match(/^\/api\/(day|photo)\/(\d{4}-\d{2}-\d{2})$/);
    if (mm && role === 'seller' && !sellerDateOk(mm[2])) {
      throw new HttpError(403, 'Продавцу доступна только текущая смена');
    }

    mm = p.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/);
    if (mm) {
      const date = mm[1];
      if (m === 'GET') {
        const cur = await store.get(K.day(date));
        return send(res, 200, cur ? { rev: cur.rev, value: viewFor(cur.value, role) } : { rev: 0, value: null });
      }
      if (m === 'POST') {
        const body = await readBody(req);
        const cur = await store.get(K.settings);
        const ctx = { role, settings: Calc.withDefaults(cur && cur.value) };
        if (body.type === 'open' && role === 'seller') ctx.prev = await prevBalances(store, date);
        const r = await mutateDay(store, date, body, ctx);
        return send(res, 200, { rev: r.rev, value: viewFor(r.value, role) });
      }
    }

    if (p === '/api/range' && m === 'GET') {
      ownerOnly(role);
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
        const day = await mutateDay(store, date, { type: 'setPhoto', has: true }, { role });
        await store.setRaw(K.photo(date), dataUrl);
        return send(res, 200, { rev: day.rev, value: viewFor(day.value, role) });
      }
      if (m === 'DELETE') {
        const day = await mutateDay(store, date, { type: 'setPhoto', has: false }, { role });
        await store.delRaw(K.photo(date));
        return send(res, 200, { rev: day.rev, value: viewFor(day.value, role) });
      }
    }

    if (p === '/api/reprice' && m === 'POST') {
      ownerOnly(role);
      const body = await readBody(req);
      const from = String(body.from || '');
      const to = String(body.to || '');
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new HttpError(400, 'Неверный период');
      if (Calc.blank(body.name) || !(Calc.num(body.price) > 0)) throw new HttpError(400, 'Укажите аромат и цену');
      const idx = await store.hgetall(K.index);
      const dates = Object.keys(idx).filter((d) => d >= from && d <= to).sort();
      const docs = await store.mget(dates.map(K.day));
      const key = Calc.norm(body.name);
      let days = 0;
      for (let i = 0; i < dates.length; i++) {
        const d = docs[i] && docs[i].value;
        if (!d || !d.sales.some((s) => s.items.some((it) => it.type !== 'other' && Calc.norm(it.name) === key))) continue;
        await mutateDay(store, dates[i], { type: 'reprice', name: body.name, price: body.price }, { role });
        days += 1;
      }
      return send(res, 200, { ok: true, days });
    }

    if (p === '/api/export' && m === 'GET') {
      ownerOnly(role);
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
