'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const DEFAULT_TIME_LIMIT = 20; // секунд на вопрос
const REVEAL_GRACE_MS = 400; // запас на сетевую задержку
const MAX_PLAYERS = 100;
const MAX_NAME_LEN = 16;

const QUESTION_BANK = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'),
);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));
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
app.get('/questions.json', (_req, res) => res.json(QUESTION_BANK));
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/health', (_req, res) => res.json({ ok: true, games: games.size }));

/** @type {Map<string, Game>} */
const games = new Map();

function genPin() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (games.has(pin));
  return pin;
}

function token() {
  return crypto.randomBytes(16).toString('hex');
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN);
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
 * в последнюю секунду. Как в Kahoot.
 */
function scoreFor(correct, elapsedMs, timeLimitSec, streak) {
  if (!correct) return 0;
  const frac = Math.min(1, Math.max(0, elapsedMs / (timeLimitSec * 1000)));
  const base = Math.round(1000 * (1 - frac / 2));
  const bonus = Math.min(streak - 1, 5) * 100; // серия правильных ответов
  return base + Math.max(0, bonus);
}

class Game {
  constructor(hostSocket, questions, timeLimit) {
    this.pin = genPin();
    this.hostToken = token();
    this.hostSocketId = hostSocket.id;
    this.questions = questions;
    this.timeLimit = timeLimit;
    this.players = new Map(); // playerId -> player
    this.index = -1;
    this.state = 'lobby'; // lobby | question | reveal | end
    this.startedAt = 0;
    this.timer = null;
    this.lastActivity = Date.now();
    this.createdAt = Date.now();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  get current() {
    return this.questions[this.index];
  }

  publicPlayers() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      online: Boolean(p.socketId),
    }));
  }

  leaderboard() {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
      .map((p, i) => ({ id: p.id, name: p.name, score: p.score, rank: i + 1 }));
  }

  rankOf(playerId) {
    return this.leaderboard().find((r) => r.id === playerId)?.rank ?? null;
  }

  questionPayload() {
    const q = this.current;
    return {
      index: this.index,
      total: this.questions.length,
      text: q.text,
      answers: q.answers,
      timeLimit: this.timeLimit,
      startedAt: this.startedAt,
      serverNow: Date.now(),
    };
  }

  answerCounts() {
    const q = this.current;
    const counts = q.answers.map(() => 0);
    for (const p of this.players.values()) {
      const a = p.answers[this.index];
      if (a) counts[a.index] += 1;
    }
    return counts;
  }

  emitHost(event, payload) {
    if (this.hostSocketId) io.to(this.hostSocketId).emit(event, payload);
  }

  emitPlayers(event, payload) {
    io.to(`game:${this.pin}:players`).emit(event, payload);
  }

  emitLobby() {
    this.emitHost('game:lobby', { pin: this.pin, players: this.publicPlayers() });
  }

  startQuestion() {
    this.index += 1;
    if (this.index >= this.questions.length) return this.finish();
    this.state = 'question';
    this.startedAt = Date.now();
    this.touch();
    const payload = this.questionPayload();
    this.emitHost('game:question', { ...payload, answered: 0, players: this.players.size });
    this.emitPlayers('game:question', payload);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reveal(), this.timeLimit * 1000 + REVEAL_GRACE_MS);
  }

  everyoneAnswered() {
    let online = 0;
    let answered = 0;
    for (const p of this.players.values()) {
      if (!p.socketId) continue;
      online += 1;
      if (p.answers[this.index]) answered += 1;
    }
    return online > 0 && answered >= online;
  }

  submitAnswer(player, answerIndex) {
    if (this.state !== 'question') return { ok: false, error: 'Приём ответов закрыт' };
    if (player.answers[this.index]) return { ok: false, error: 'Ответ уже принят' };
    const q = this.current;
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= q.answers.length) {
      return { ok: false, error: 'Некорректный ответ' };
    }
    const elapsed = Date.now() - this.startedAt;
    const correct = answerIndex === q.correct;
    player.streak = correct ? player.streak + 1 : 0;
    const gained = scoreFor(correct, elapsed, this.timeLimit, player.streak);
    player.score += gained;
    player.answers[this.index] = { index: answerIndex, correct, gained, elapsed };
    this.touch();

    const answered = [...this.players.values()].filter((p) => p.answers[this.index]).length;
    this.emitHost('game:answered', { answered, players: this.players.size });

    if (this.everyoneAnswered()) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.reveal(), 600);
    }
    return { ok: true };
  }

  reveal() {
    if (this.state !== 'question') return;
    clearTimeout(this.timer);
    this.state = 'reveal';
    this.touch();
    const q = this.current;
    const board = this.leaderboard();
    this.emitHost('game:reveal', {
      index: this.index,
      total: this.questions.length,
      text: q.text,
      answers: q.answers,
      correct: q.correct,
      counts: this.answerCounts(),
      leaderboard: board.slice(0, 5),
      isLast: this.index === this.questions.length - 1,
    });
    for (const p of this.players.values()) {
      if (!p.socketId) continue;
      const a = p.answers[this.index];
      io.to(p.socketId).emit('game:reveal', {
        index: this.index,
        total: this.questions.length,
        correct: q.correct,
        answerIndex: a ? a.index : null,
        isCorrect: a ? a.correct : false,
        gained: a ? a.gained : 0,
        score: p.score,
        rank: board.find((r) => r.id === p.id)?.rank ?? null,
        players: this.players.size,
        streak: p.streak,
        isLast: this.index === this.questions.length - 1,
      });
    }
  }

  finish() {
    clearTimeout(this.timer);
    this.state = 'end';
    this.touch();
    const board = this.leaderboard();
    this.emitHost('game:end', { leaderboard: board });
    for (const p of this.players.values()) {
      if (!p.socketId) continue;
      io.to(p.socketId).emit('game:end', {
        leaderboard: board.slice(0, 3),
        score: p.score,
        rank: board.find((r) => r.id === p.id)?.rank ?? null,
        players: this.players.size,
      });
    }
  }

  snapshotForPlayer(player) {
    const base = { state: this.state, pin: this.pin, name: player.name, score: player.score };
    if (this.state === 'question') {
      return { ...base, question: this.questionPayload(), answered: Boolean(player.answers[this.index]) };
    }
    if (this.state === 'reveal') {
      const a = player.answers[this.index];
      const board = this.leaderboard();
      return {
        ...base,
        reveal: {
          index: this.index,
          total: this.questions.length,
          correct: this.current.correct,
          answerIndex: a ? a.index : null,
          isCorrect: a ? a.correct : false,
          gained: a ? a.gained : 0,
          score: player.score,
          rank: board.find((r) => r.id === player.id)?.rank ?? null,
          players: this.players.size,
          streak: player.streak,
          isLast: this.index === this.questions.length - 1,
        },
      };
    }
    if (this.state === 'end') {
      const board = this.leaderboard();
      return {
        ...base,
        end: {
          leaderboard: board.slice(0, 3),
          score: player.score,
          rank: board.find((r) => r.id === player.id)?.rank ?? null,
          players: this.players.size,
        },
      };
    }
    return base;
  }

  snapshotForHost() {
    const base = {
      state: this.state,
      pin: this.pin,
      players: this.publicPlayers(),
      total: this.questions.length,
      timeLimit: this.timeLimit,
    };
    if (this.state === 'question') {
      const answered = [...this.players.values()].filter((p) => p.answers[this.index]).length;
      return { ...base, question: { ...this.questionPayload(), answered, players: this.players.size } };
    }
    if (this.state === 'reveal') {
      return {
        ...base,
        reveal: {
          index: this.index,
          total: this.questions.length,
          text: this.current.text,
          answers: this.current.answers,
          correct: this.current.correct,
          counts: this.answerCounts(),
          leaderboard: this.leaderboard().slice(0, 5),
          isLast: this.index === this.questions.length - 1,
        },
      };
    }
    if (this.state === 'end') return { ...base, end: { leaderboard: this.leaderboard() } };
    return base;
  }

  destroy() {
    clearTimeout(this.timer);
    this.emitPlayers('game:closed', { reason: 'Ведущий завершил игру' });
    games.delete(this.pin);
  }
}

function findGameByHost(socket) {
  const pin = socket.data.hostPin;
  const game = pin && games.get(pin);
  if (!game || game.hostSocketId !== socket.id) return null;
  return game;
}

io.on('connection', (socket) => {
  // ---------- Ведущий ----------
  socket.on('host:create', (opts, cb = () => {}) => {
    const questions = validateQuestions(opts && opts.questions);
    if (!questions) return cb({ ok: false, error: 'Нужен хотя бы один корректный вопрос' });
    let timeLimit = Number(opts.timeLimit) || DEFAULT_TIME_LIMIT;
    timeLimit = Math.min(120, Math.max(5, Math.round(timeLimit)));
    const game = new Game(socket, questions, timeLimit);
    games.set(game.pin, game);
    socket.data.hostPin = game.pin;
    socket.join(`game:${game.pin}:host`);
    cb({ ok: true, pin: game.pin, hostToken: game.hostToken, total: questions.length, timeLimit });
  });

  socket.on('host:resume', ({ pin, hostToken } = {}, cb = () => {}) => {
    const game = games.get(String(pin || ''));
    if (!game || game.hostToken !== hostToken) return cb({ ok: false, error: 'Игра не найдена' });
    game.hostSocketId = socket.id;
    socket.data.hostPin = game.pin;
    game.touch();
    cb({ ok: true, snapshot: game.snapshotForHost() });
  });

  socket.on('host:start', (_, cb = () => {}) => {
    const game = findGameByHost(socket);
    if (!game) return cb({ ok: false, error: 'Игра не найдена' });
    if (game.state !== 'lobby') return cb({ ok: false, error: 'Игра уже идёт' });
    if (game.players.size === 0) return cb({ ok: false, error: 'Нет игроков' });
    game.startQuestion();
    cb({ ok: true });
  });

  socket.on('host:next', (_, cb = () => {}) => {
    const game = findGameByHost(socket);
    if (!game) return cb({ ok: false, error: 'Игра не найдена' });
    if (game.state === 'question') game.reveal();
    else if (game.state === 'reveal') game.startQuestion();
    cb({ ok: true });
  });

  socket.on('host:kick', ({ playerId } = {}, cb = () => {}) => {
    const game = findGameByHost(socket);
    if (!game) return cb({ ok: false });
    const p = game.players.get(playerId);
    if (p) {
      if (p.socketId) io.to(p.socketId).emit('game:closed', { reason: 'Ведущий удалил вас из игры' });
      game.players.delete(playerId);
      game.emitLobby();
    }
    cb({ ok: true });
  });

  socket.on('host:end', (_, cb = () => {}) => {
    const game = findGameByHost(socket);
    if (game) game.destroy();
    cb({ ok: true });
  });

  // ---------- Игрок ----------
  socket.on('player:join', ({ pin, name, playerToken } = {}, cb = () => {}) => {
    const game = games.get(String(pin || '').trim());
    if (!game) return cb({ ok: false, error: 'Игра с таким PIN не найдена' });

    // Повторное подключение
    if (playerToken) {
      const existing = [...game.players.values()].find((p) => p.token === playerToken);
      if (existing) {
        existing.socketId = socket.id;
        socket.data.pin = game.pin;
        socket.data.playerId = existing.id;
        socket.join(`game:${game.pin}:players`);
        game.emitLobby();
        return cb({ ok: true, playerId: existing.id, playerToken, snapshot: game.snapshotForPlayer(existing) });
      }
    }

    if (game.state !== 'lobby') return cb({ ok: false, error: 'Игра уже началась' });
    if (game.players.size >= MAX_PLAYERS) return cb({ ok: false, error: 'Игра заполнена' });
    const cleaned = cleanName(name);
    if (!cleaned) return cb({ ok: false, error: 'Введите имя' });
    const taken = [...game.players.values()].some((p) => p.name.toLowerCase() === cleaned.toLowerCase());
    if (taken) return cb({ ok: false, error: 'Это имя уже занято' });

    const player = {
      id: token().slice(0, 12),
      token: token(),
      name: cleaned,
      score: 0,
      streak: 0,
      answers: [],
      socketId: socket.id,
      joinedAt: Date.now(),
    };
    game.players.set(player.id, player);
    socket.data.pin = game.pin;
    socket.data.playerId = player.id;
    socket.join(`game:${game.pin}:players`);
    game.touch();
    game.emitLobby();
    cb({ ok: true, playerId: player.id, playerToken: player.token, snapshot: game.snapshotForPlayer(player) });
  });

  socket.on('player:answer', ({ answerIndex } = {}, cb = () => {}) => {
    const game = games.get(socket.data.pin);
    const player = game && game.players.get(socket.data.playerId);
    if (!game || !player) return cb({ ok: false, error: 'Вы не в игре' });
    cb(game.submitAnswer(player, Number(answerIndex)));
  });

  socket.on('disconnect', () => {
    const game = games.get(socket.data.pin);
    const player = game && game.players.get(socket.data.playerId);
    if (player && player.socketId === socket.id) {
      player.socketId = null;
      game.emitLobby();
    }
    const hosted = games.get(socket.data.hostPin);
    if (hosted && hosted.hostSocketId === socket.id) hosted.hostSocketId = null;
  });
});

// Чистим брошенные игры
setInterval(() => {
  const now = Date.now();
  for (const game of games.values()) {
    const idle = now - game.lastActivity;
    const hostGone = !game.hostSocketId && idle > 10 * 60 * 1000;
    const finished = game.state === 'end' && idle > 30 * 60 * 1000;
    const stale = idle > 3 * 60 * 60 * 1000;
    if (hostGone || finished || stale) game.destroy();
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Квиз запущен: http://localhost:${PORT}`);
});

module.exports = { app, server, io, games, scoreFor, validateQuestions };
