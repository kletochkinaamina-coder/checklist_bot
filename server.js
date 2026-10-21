'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { createStore } = require('./lib/store');

const PORT = process.env.PORT || 3000;
const DEFAULT_TIME_LIMIT = 20; // секунд на вопрос
const REVEAL_GRACE_MS = 400; // запас на сетевую задержку
const ONLINE_WINDOW_MS = 8000; // игрок считается онлайн, если опрашивал сервер недавно
const MAX_PLAYERS = 100;
const MAX_NAME_LEN = 16;

const { store, kind: storeKind } = createStore();

const app = express();
app.set('trust proxy', true);
// Express 4 не ловит ошибки async обработчиков: заворачиваем их, чтобы ошибка ушла в error handler
for (const method of ['get', 'post']) {
  const orig = app[method].bind(app);
  app[method] = (p, ...fns) => (fns.length === 0 ? orig(p) : orig(p, ...fns.map((f) => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next))));
}
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// На Vercel без Redis каждый вызов функции получил бы свою память: игра бы не работала.
app.use('/api', (req, res, next) => {
  if (process.env.VERCEL && storeKind === 'memory') {
    return res.status(503).json({
      ok: false,
      error: 'Подключи Upstash Redis в Vercel: проект → Storage → Upstash for Redis → Connect. Затем Redeploy.',
    });
  }
  next();
});

app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/health', (_req, res) => res.json({ ok: true, store: storeKind }));

// QR код со ссылкой на вход в игру (генерируем на сервере, без внешних CDN)
app.get('/qr/:pin.png', async (req, res) => {
  const pin = String(req.params.pin).replace(/\D/g, '').slice(0, 6);
  const link = `${req.protocol}://${req.get('host')}/play?pin=${pin}`;
  try {
    const png = await QRCode.toBuffer(link, { width: 220, margin: 1 });
    res.type('png').send(png);
  } catch (e) {
    res.status(500).end();
  }
});

// ---------------- Утилиты ----------------

const token = () => crypto.randomBytes(16).toString('hex');
const keys = (pin) => ({ meta: `g:${pin}`, players: `g:${pin}:p`, answers: `g:${pin}:a` });

function cleanName(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

function validateQuestions(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = [];
  for (const q of list.slice(0, 100)) {
    if (!q || typeof q.text !== 'string' || !Array.isArray(q.answers)) return null;
    const answers = q.answers.map((a) => String(a).slice(0, 80)).slice(0, 4);
    if (answers.length < 2) return null;
    const correct = Number(q.correct);
    if (!Number.isInteger(correct) || correct < 0 || correct >= answers.length) return null;
    out.push({ text: q.text.slice(0, 200), answers, correct });
  }
  return out;
}

/**
 * Очки за ответ: до 1000 за мгновенный правильный ответ, минимум 500 за правильный
 * в последнюю секунду, плюс бонус за серию. Как в Kahoot.
 */
function scoreFor(correct, elapsedMs, timeLimitSec, streak) {
  if (!correct) return 0;
  const frac = Math.min(1, Math.max(0, elapsedMs / (timeLimitSec * 1000)));
  const base = Math.round(1000 * (1 - frac / 2));
  const bonus = Math.min(streak - 1, 5) * 100;
  return base + Math.max(0, bonus);
}

async function genPin() {
  for (let i = 0; i < 20; i++) {
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    if (!(await store.getMeta(keys(pin).meta))) return pin;
  }
  throw new Error('Не удалось выбрать PIN');
}

// ---------------- Загрузка и расчёт состояния ----------------

async function loadGame(pin) {
  const k = keys(pin);
  const [meta, players, answers] = await Promise.all([
    store.getMeta(k.meta),
    store.hgetall(k.players),
    store.hgetall(k.answers),
  ]);
  if (!meta) return null;
  return { pin, rev: meta.rev, meta: meta.value, players, answers };
}

/** Считает очки, серии и результат каждого ответа. */
function computeScores(game) {
  const { meta, players, answers } = game;
  const result = {}; // playerId -> { score, streak, byQuestion: {i: {index, correct, gained}} }
  for (const p of Object.values(players)) {
    let score = 0;
    let streak = 0;
    const byQuestion = {};
    for (let i = 0; i <= meta.index && i < meta.questions.length; i++) {
      const a = answers[`${i}:${p.id}`];
      if (!a) { streak = 0; continue; }
      const correct = a.index === meta.questions[i].correct;
      streak = correct ? streak + 1 : 0;
      const gained = scoreFor(correct, a.elapsed, meta.timeLimit, streak);
      score += gained;
      byQuestion[i] = { index: a.index, correct, gained };
    }
    result[p.id] = { score, streak, byQuestion };
  }
  return result;
}

function leaderboard(game, scores) {
  return Object.values(game.players)
    .sort((a, b) => scores[b.id].score - scores[a.id].score || a.joinedAt - b.joinedAt)
    .map((p, i) => ({ id: p.id, name: p.name, score: scores[p.id].score, rank: i + 1 }));
}

const isOnline = (p, now) => now - (p.lastSeen || 0) < ONLINE_WINDOW_MS;

function answeredCount(game) {
  return Object.values(game.players).filter((p) => game.answers[`${game.meta.index}:${p.id}`]).length;
}

function questionExpired(meta, now) {
  return now >= meta.startedAt + meta.timeLimit * 1000 + REVEAL_GRACE_MS;
}

function everyoneAnswered(game, now) {
  const online = Object.values(game.players).filter((p) => isOnline(p, now));
  return online.length > 0 && online.every((p) => game.answers[`${game.meta.index}:${p.id}`]);
}

/** Пытается применить изменение meta с compare-and-set. Возвращает актуальную игру. */
async function updateMeta(pin, mutate, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const game = await loadGame(pin);
    if (!game) return null;
    const next = mutate(game);
    if (!next) return game; // менять нечего
    next.lastActivity = Date.now();
    if (await store.casMeta(keys(pin).meta, game.rev, next)) {
      return { ...game, meta: next, rev: game.rev + 1 };
    }
  }
  return loadGame(pin);
}

/** Время вышло или все ответили: переводим вопрос в разбор. */
async function settle(game) {
  const now = Date.now();
  if (game.meta.state !== 'question') return game;
  if (!questionExpired(game.meta, now) && !everyoneAnswered(game, now)) return game;
  return updateMeta(game.pin, (g) => {
    if (g.meta.state !== 'question' || g.meta.index !== game.meta.index) return null;
    return { ...g.meta, state: 'reveal', revealAt: Date.now() };
  });
}

// ---------------- Снимки состояния ----------------

function questionPayload(meta) {
  const q = meta.questions[meta.index];
  return {
    index: meta.index,
    total: meta.questions.length,
    text: q.text,
    answers: q.answers,
    timeLimit: meta.timeLimit,
    startedAt: meta.startedAt,
  };
}

function hostSnapshot(game) {
  const { meta } = game;
  const now = Date.now();
  const scores = computeScores(game);
  const players = Object.values(game.players).map((p) => ({
    id: p.id, name: p.name, score: scores[p.id].score, online: isOnline(p, now),
  }));
  const base = { state: meta.state, pin: game.pin, players, total: meta.questions.length, timeLimit: meta.timeLimit, serverNow: now };
  if (meta.state === 'question') {
    return { ...base, question: { ...questionPayload(meta), answered: answeredCount(game), players: players.length } };
  }
  if (meta.state === 'reveal') {
    const q = meta.questions[meta.index];
    const counts = q.answers.map(() => 0);
    for (const p of Object.values(game.players)) {
      const a = game.answers[`${meta.index}:${p.id}`];
      if (a) counts[a.index] += 1;
    }
    return {
      ...base,
      reveal: {
        index: meta.index, total: meta.questions.length, text: q.text, answers: q.answers, correct: q.correct,
        counts, leaderboard: leaderboard(game, scores).slice(0, 5), isLast: meta.index === meta.questions.length - 1,
      },
    };
  }
  if (meta.state === 'end') return { ...base, end: { leaderboard: leaderboard(game, scores) } };
  return base;
}

function playerSnapshot(game, player) {
  const { meta } = game;
  const scores = computeScores(game);
  const mine = scores[player.id];
  const base = { state: meta.state, pin: game.pin, name: player.name, score: mine.score, serverNow: Date.now() };
  if (meta.state === 'question') {
    return { ...base, question: questionPayload(meta), answered: Boolean(game.answers[`${meta.index}:${player.id}`]) };
  }
  if (meta.state === 'reveal' || meta.state === 'end') {
    const board = leaderboard(game, scores);
    const rank = board.find((r) => r.id === player.id)?.rank ?? null;
    const total = Object.keys(game.players).length;
    if (meta.state === 'end') return { ...base, end: { leaderboard: board.slice(0, 3), score: mine.score, rank, players: total } };
    const q = meta.questions[meta.index];
    const a = mine.byQuestion[meta.index];
    return {
      ...base,
      reveal: {
        index: meta.index, total: meta.questions.length, correct: q.correct,
        answerIndex: a ? a.index : null, isCorrect: a ? a.correct : false, gained: a ? a.gained : 0,
        score: mine.score, rank, players: total, streak: mine.streak, isLast: meta.index === meta.questions.length - 1,
      },
    };
  }
  return base;
}

// ---------------- API: ведущий ----------------

const fail = (res, status, error) => res.status(status).json({ ok: false, error });

app.post('/api/game', async (req, res) => {
  const questions = validateQuestions(req.body && req.body.questions);
  if (!questions) return fail(res, 400, 'Нужен хотя бы один корректный вопрос');
  let timeLimit = Number(req.body.timeLimit) || DEFAULT_TIME_LIMIT;
  timeLimit = Math.min(120, Math.max(5, Math.round(timeLimit)));
  const pin = await genPin();
  const meta = {
    pin, hostToken: token(), questions, timeLimit, state: 'lobby', index: -1,
    startedAt: 0, revealAt: 0, createdAt: Date.now(), lastActivity: Date.now(),
  };
  await store.setMeta(keys(pin).meta, meta);
  res.json({ ok: true, pin, hostToken: meta.hostToken, total: questions.length, timeLimit });
});

async function hostGame(req, res) {
  const pin = String(req.params.pin || '');
  const hostToken = (req.body && req.body.token) || req.query.token;
  const game = await loadGame(pin);
  if (!game || game.meta.hostToken !== hostToken) {
    fail(res, 404, 'Игра не найдена');
    return null;
  }
  return game;
}

app.get('/api/host/:pin', async (req, res) => {
  let game = await hostGame(req, res);
  if (!game) return;
  game = await settle(game);
  res.json({ ok: true, snapshot: hostSnapshot(game) });
});

app.post('/api/host/:pin/start', async (req, res) => {
  const game = await hostGame(req, res);
  if (!game) return;
  if (game.meta.state !== 'lobby') return fail(res, 400, 'Игра уже идёт');
  if (Object.keys(game.players).length === 0) return fail(res, 400, 'Нет игроков');
  const updated = await updateMeta(game.pin, (g) => (g.meta.state === 'lobby'
    ? { ...g.meta, state: 'question', index: 0, startedAt: Date.now() } : null));
  const k = keys(game.pin);
  await store.touch(k.meta, k.players, k.answers);
  res.json({ ok: true, snapshot: hostSnapshot(updated) });
});

app.post('/api/host/:pin/next', async (req, res) => {
  const game = await hostGame(req, res);
  if (!game) return;
  const updated = await updateMeta(game.pin, (g) => {
    const m = g.meta;
    if (m.state === 'question') return { ...m, state: 'reveal', revealAt: Date.now() };
    if (m.state === 'reveal') {
      if (m.index >= m.questions.length - 1) return { ...m, state: 'end' };
      return { ...m, state: 'question', index: m.index + 1, startedAt: Date.now() };
    }
    return null;
  });
  res.json({ ok: true, snapshot: hostSnapshot(updated) });
});

app.post('/api/host/:pin/kick', async (req, res) => {
  const game = await hostGame(req, res);
  if (!game) return;
  const playerId = String((req.body && req.body.playerId) || '');
  if (game.players[playerId]) await store.hdel(keys(game.pin).players, playerId);
  res.json({ ok: true });
});

app.post('/api/host/:pin/end', async (req, res) => {
  const game = await hostGame(req, res);
  if (!game) return;
  const k = keys(game.pin);
  await store.del(k.meta, k.players, k.answers);
  res.json({ ok: true });
});

// ---------------- API: игрок ----------------

app.post('/api/player/:pin/join', async (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const game = await loadGame(pin);
  if (!game) return fail(res, 404, 'Игра с таким PIN не найдена');
  const body = req.body || {};
  const k = keys(pin);

  // Повторное подключение
  if (body.playerToken) {
    const existing = Object.values(game.players).find((p) => p.token === body.playerToken);
    if (existing) {
      existing.lastSeen = Date.now();
      await store.hset(k.players, existing.id, existing);
      const settled = await settle({ ...game, players: { ...game.players, [existing.id]: existing } });
      return res.json({ ok: true, playerId: existing.id, playerToken: existing.token, snapshot: playerSnapshot(settled, existing) });
    }
  }

  if (game.meta.state !== 'lobby') return fail(res, 400, 'Игра уже началась');
  if (Object.keys(game.players).length >= MAX_PLAYERS) return fail(res, 400, 'Игра заполнена');
  const name = cleanName(body.name);
  if (!name) return fail(res, 400, 'Введите имя');
  if (Object.values(game.players).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return fail(res, 400, 'Это имя уже занято');
  }
  const player = { id: token().slice(0, 12), token: token(), name, joinedAt: Date.now(), lastSeen: Date.now() };
  await store.hset(k.players, player.id, player);
  game.players[player.id] = player;
  res.json({ ok: true, playerId: player.id, playerToken: player.token, snapshot: playerSnapshot(game, player) });
});

async function playerGame(req, res) {
  const pin = String(req.params.pin || '');
  const playerId = String((req.body && req.body.playerId) || req.query.playerId || '');
  const playerToken = (req.body && req.body.token) || req.query.token;
  const game = await loadGame(pin);
  if (!game) {
    fail(res, 404, 'Игра завершена');
    return null;
  }
  const player = game.players[playerId];
  if (!player || player.token !== playerToken) {
    fail(res, 403, 'Ведущий удалил вас из игры');
    return null;
  }
  return { game, player };
}

app.get('/api/player/:pin', async (req, res) => {
  const ctx = await playerGame(req, res);
  if (!ctx) return;
  const { player } = ctx;
  player.lastSeen = Date.now();
  await store.hset(keys(ctx.game.pin).players, player.id, player);
  const game = await settle(ctx.game);
  res.json({ ok: true, snapshot: playerSnapshot(game, player) });
});

app.post('/api/player/:pin/answer', async (req, res) => {
  const ctx = await playerGame(req, res);
  if (!ctx) return;
  const { game, player } = ctx;
  const { meta } = game;
  const now = Date.now();
  if (meta.state !== 'question' || questionExpired(meta, now)) return fail(res, 400, 'Приём ответов закрыт');
  const answerIndex = Number(req.body && req.body.answerIndex);
  const q = meta.questions[meta.index];
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= q.answers.length) {
    return fail(res, 400, 'Некорректный ответ');
  }
  const stored = await store.hsetnx(keys(game.pin).answers, `${meta.index}:${player.id}`, {
    index: answerIndex, elapsed: Math.max(0, now - meta.startedAt),
  });
  if (!stored) return fail(res, 400, 'Ответ уже принят');
  res.json({ ok: true });
});

app.use('/api', (_req, res) => fail(res, 404, 'Не найдено'));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  fail(res, 500, 'Ошибка сервера');
});

const server = http.createServer(app);
if (require.main === module) {
  server.listen(PORT, () => console.log(`Квиз запущен: http://localhost:${PORT} (хранилище: ${storeKind})`));
}

module.exports = { app, server, store, storeKind, scoreFor, validateQuestions };
