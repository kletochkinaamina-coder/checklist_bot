'use strict';
/**
 * Хранилище Al Musk.
 *  - UpstashStore: Vercel (Upstash Redis по REST). Данные хранятся бессрочно.
 *  - FileStore: локальный запуск, всё в data/almusk.json.
 *  - MemoryStore: тесты.
 *
 * Документы (настройки, дни) хранятся как "<rev>|<json>".
 * Запись идёт через compare-and-set, чтобы два телефона не затёрли данные друг друга.
 */
const fs = require('fs');
const path = require('path');

const CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
local rev = 0
if cur then rev = tonumber(string.match(cur, '^(%d+)|')) end
if rev ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

const pack = (rev, obj) => `${rev}|${JSON.stringify(obj)}`;
function unpack(str) {
  if (str === null || str === undefined) return null;
  const s = String(str);
  const i = s.indexOf('|');
  return { rev: Number(s.slice(0, i)), value: JSON.parse(s.slice(i + 1)) };
}

class MemoryStore {
  constructor() {
    this.kv = new Map();
    this.h = new Map();
    this.exp = new Map();
  }
  _changed() {}
  async get(key) {
    return unpack(this.kv.get(key));
  }
  async mget(keys) {
    return keys.map((k) => unpack(this.kv.get(k)));
  }
  async cas(key, rev, value) {
    const cur = unpack(this.kv.get(key));
    if ((cur ? cur.rev : 0) !== rev) return false;
    this.kv.set(key, pack(rev + 1, value));
    this._changed();
    return true;
  }
  async getRaw(key) {
    return this.kv.has(key) ? this.kv.get(key) : null;
  }
  async setRaw(key, str) {
    this.kv.set(key, str);
    this._changed();
  }
  async delRaw(key) {
    this.kv.delete(key);
    this._changed();
  }
  async hset(key, field, obj) {
    if (!this.h.has(key)) this.h.set(key, new Map());
    this.h.get(key).set(field, JSON.stringify(obj));
    this._changed();
  }
  async hgetall(key) {
    const out = {};
    for (const [f, v] of this.h.get(key) || []) out[f] = JSON.parse(v);
    return out;
  }
  async incr(key, ttlSec) {
    const now = Date.now();
    const e = this.exp.get(key);
    if (!e || e.until < now) this.exp.set(key, { n: 0, until: now + ttlSec * 1000 });
    const x = this.exp.get(key);
    x.n += 1;
    return x.n;
  }
}

class FileStore extends MemoryStore {
  constructor(file) {
    super();
    this.file = file;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(data.kv || {})) this.kv.set(k, v);
      for (const [k, h] of Object.entries(data.h || {})) this.h.set(k, new Map(Object.entries(h)));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  _changed() {
    const data = { kv: Object.fromEntries(this.kv), h: {} };
    for (const [k, m] of this.h) data.h[k] = Object.fromEntries(m);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
  }
}

class UpstashStore {
  constructor(redis) {
    this.redis = redis;
  }
  async get(key) {
    return unpack(await this.redis.get(key));
  }
  async mget(keys) {
    if (!keys.length) return [];
    const out = [];
    // Пачками, чтобы не упираться в лимит размера ответа
    for (let i = 0; i < keys.length; i += 20) {
      const part = await this.redis.mget(...keys.slice(i, i + 20));
      for (const s of part) out.push(unpack(s));
    }
    return out;
  }
  async cas(key, rev, value) {
    const r = await this.redis.eval(CAS_LUA, [key], [String(rev), pack(rev + 1, value)]);
    return Number(r) === 1;
  }
  async getRaw(key) {
    return this.redis.get(key);
  }
  async setRaw(key, str) {
    await this.redis.set(key, str);
  }
  async delRaw(key) {
    await this.redis.del(key);
  }
  async hset(key, field, obj) {
    await this.redis.hset(key, { [field]: JSON.stringify(obj) });
  }
  async hgetall(key) {
    const raw = (await this.redis.hgetall(key)) || [];
    const out = {};
    if (Array.isArray(raw)) {
      for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = JSON.parse(raw[i + 1]);
    } else {
      for (const [f, v] of Object.entries(raw)) out[f] = typeof v === 'string' ? JSON.parse(v) : v;
    }
    return out;
  }
  async incr(key, ttlSec) {
    const n = Number(await this.redis.incr(key));
    if (n === 1) await this.redis.expire(key, ttlSec);
    return n;
  }
}

function createStore(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const { Redis } = require('@upstash/redis');
    return { store: new UpstashStore(new Redis({ url, token, automaticDeserialization: false })), kind: 'upstash' };
  }
  // На Vercel файловая система только для чтения и память не сохраняется между вызовами
  if (env.VERCEL) return { store: new MemoryStore(), kind: 'memory' };
  const file = env.ALMUSK_DATA_FILE || path.join(__dirname, '..', 'data', 'almusk.json');
  return { store: new FileStore(file), kind: 'file' };
}

module.exports = { createStore, MemoryStore, FileStore, UpstashStore, pack, unpack };
