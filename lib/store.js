'use strict';
/**
 * Хранилище состояния игры.
 *  - MemoryStore: локальный запуск и тесты (один процесс).
 *  - UpstashStore: Vercel и любой serverless хостинг (Upstash Redis по REST).
 *
 * Все значения хранятся строками. Ключ игры хранится как "<rev>|<json>",
 * чтобы делать compare-and-set через Lua без зависимости от cjson.
 */

const TTL_SEC = 6 * 60 * 60;

const CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local rev = string.match(cur, '^(%d+)|')
if rev ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

function pack(rev, obj) {
  return `${rev}|${JSON.stringify(obj)}`;
}
function unpack(str) {
  if (!str) return null;
  const i = str.indexOf('|');
  return { rev: Number(str.slice(0, i)), value: JSON.parse(str.slice(i + 1)) };
}

class MemoryStore {
  constructor() {
    this.kv = new Map();
    this.hashes = new Map();
  }
  hash(key) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    return this.hashes.get(key);
  }
  async getMeta(key) {
    return unpack(this.kv.get(key));
  }
  async setMeta(key, obj) {
    this.kv.set(key, pack(1, obj));
    return true;
  }
  async casMeta(key, rev, obj) {
    const cur = unpack(this.kv.get(key));
    if (!cur || cur.rev !== rev) return false;
    this.kv.set(key, pack(rev + 1, obj));
    return true;
  }
  async hset(key, field, obj) {
    this.hash(key).set(field, JSON.stringify(obj));
  }
  async hsetnx(key, field, obj) {
    const h = this.hash(key);
    if (h.has(field)) return false;
    h.set(field, JSON.stringify(obj));
    return true;
  }
  async hdel(key, field) {
    this.hash(key).delete(field);
  }
  async hgetall(key) {
    const out = {};
    for (const [f, v] of this.hash(key)) out[f] = JSON.parse(v);
    return out;
  }
  async del(...keys) {
    for (const k of keys) {
      this.kv.delete(k);
      this.hashes.delete(k);
    }
  }
  async touch() {}
}

class UpstashStore {
  constructor(redis) {
    this.redis = redis;
  }
  async getMeta(key) {
    return unpack(await this.redis.get(key));
  }
  async setMeta(key, obj) {
    await this.redis.set(key, pack(1, obj), { ex: TTL_SEC });
    return true;
  }
  async casMeta(key, rev, obj) {
    const r = await this.redis.eval(CAS_LUA, [key], [String(rev), pack(rev + 1, obj), String(TTL_SEC)]);
    return Number(r) === 1;
  }
  async hset(key, field, obj) {
    await this.redis.hset(key, { [field]: JSON.stringify(obj) });
  }
  async hsetnx(key, field, obj) {
    const r = await this.redis.hsetnx(key, field, JSON.stringify(obj));
    return Number(r) === 1;
  }
  async hdel(key, field) {
    await this.redis.hdel(key, field);
  }
  async hgetall(key) {
    // Без automaticDeserialization SDK отдаёт плоский массив [поле, значение, ...]
    const raw = (await this.redis.hgetall(key)) || [];
    const out = {};
    if (Array.isArray(raw)) {
      for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = JSON.parse(raw[i + 1]);
    } else {
      for (const [f, v] of Object.entries(raw)) out[f] = typeof v === 'string' ? JSON.parse(v) : v;
    }
    return out;
  }
  async del(...keys) {
    if (keys.length) await this.redis.del(...keys);
  }
  async touch(...keys) {
    const p = this.redis.pipeline();
    for (const k of keys) p.expire(k, TTL_SEC);
    await p.exec();
  }
}

function createStore(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const { Redis } = require('@upstash/redis');
    return { store: new UpstashStore(new Redis({ url, token, automaticDeserialization: false })), kind: 'upstash' };
  }
  return { store: new MemoryStore(), kind: 'memory' };
}

module.exports = { createStore, MemoryStore, UpstashStore, TTL_SEC };
