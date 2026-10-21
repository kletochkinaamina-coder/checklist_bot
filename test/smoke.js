'use strict';
// Сквозной тест по HTTP: ведущий + 2 игрока проходят игру из 2 вопросов.
// Запускается дважды: с памятью и (если доступен redis-server) с Upstash клиентом через локальный шим.
const { spawn } = require('child_process');
const path = require('path');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runScenario(base) {
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json()) };
  };
  const questions = [
    { text: 'Q1', answers: ['a', 'b', 'c', 'd'], correct: 1 },
    { text: 'Q2', answers: ['a', 'b', 'c', 'd'], correct: 2 },
  ];
  const bad = await api('POST', '/api/game', { questions: [{ text: 'x', answers: ['a', 'b'], correct: 5 }] });
  assert(bad.status === 400, 'rejects bad question');
  const created = await api('POST', '/api/game', { questions, timeLimit: 5 });
  assert(created.ok && /^\d{6}$/.test(created.pin), 'game created with 6-digit pin');
  const { pin, hostToken } = created;
  const host = (action, body) => api('POST', `/api/host/${pin}/${action}`, { token: hostToken, ...(body || {}) });
  const hostGet = () => api('GET', `/api/host/${pin}?token=${hostToken}`);

  assert((await api('GET', `/api/host/${pin}?token=wrong`)).status === 404, 'bad host token rejected');
  assert((await api('POST', '/api/player/000000/join', { name: 'X' })).status === 404, 'unknown pin rejected');

  const j1 = await api('POST', `/api/player/${pin}/join`, { name: '  Аня  ' });
  assert(j1.ok && j1.snapshot.name === 'Аня' && j1.snapshot.state === 'lobby', 'player 1 joined, name trimmed');
  assert((await api('POST', `/api/player/${pin}/join`, { name: 'аня' })).status === 400, 'duplicate name rejected');
  const j2 = await api('POST', `/api/player/${pin}/join`, { name: 'Боб' });
  assert(j2.ok, 'player 2 joined');
  const p1 = (m, url, body) => api(m, url, body);
  const pGet = (j) => api('GET', `/api/player/${pin}?playerId=${j.playerId}&token=${j.playerToken}`);
  const pAnswer = (j, i) => api('POST', `/api/player/${pin}/answer`, { playerId: j.playerId, token: j.playerToken, answerIndex: i });

  let h = await hostGet();
  assert(h.ok && h.snapshot.players.length === 2 && h.snapshot.players.every((p) => p.online), 'host sees 2 online players');

  // вопрос 1
  const started = await host('start');
  assert(started.ok && started.snapshot.state === 'question' && started.snapshot.question.text === 'Q1', 'game started');
  assert((await host('start')).status === 400, 'cannot start twice');
  let s1 = await pGet(j1);
  assert(s1.snapshot.state === 'question' && s1.snapshot.question.index === 0 && s1.snapshot.answered === false, 'player sees question 1');
  assert((await api('POST', `/api/player/${pin}/join`, { name: 'Late' })).status === 400, 'no join after start');

  assert((await pAnswer(j1, 1)).ok, 'p1 answer accepted');
  assert((await pAnswer(j1, 1)).status === 400, 'second answer rejected');
  assert((await pAnswer(j2, 9)).status === 400, 'invalid index rejected');
  h = await hostGet();
  assert(h.snapshot.state === 'question' && h.snapshot.question.answered === 1, 'host sees 1 answered');
  assert((await pAnswer(j2, 0)).ok, 'p2 answer accepted');

  // все ответили -> разбор при следующем опросе
  h = await hostGet();
  assert(h.snapshot.state === 'reveal', 'reveal after everyone answered');
  const r = h.snapshot.reveal;
  assert(r.correct === 1 && r.counts.join() === '1,1,0,0' && r.text === 'Q1' && r.leaderboard[0].name === 'Аня', 'host reveal data');
  s1 = await pGet(j1);
  assert(s1.snapshot.state === 'reveal' && s1.snapshot.reveal.isCorrect && s1.snapshot.reveal.gained >= 900 && s1.snapshot.reveal.rank === 1, `p1 correct, rank 1 (${s1.snapshot.reveal.gained})`);
  const s2 = await pGet(j2);
  assert(!s2.snapshot.reveal.isCorrect && s2.snapshot.reveal.gained === 0 && s2.snapshot.reveal.rank === 2, 'p2 wrong, rank 2');
  assert((await pAnswer(j2, 2)).status === 400, 'answer after reveal rejected');

  // переподключение p2 по токену
  const rj = await api('POST', `/api/player/${pin}/join`, { playerToken: j2.playerToken });
  assert(rj.ok && rj.playerId === j2.playerId && rj.snapshot.state === 'reveal', 'p2 reconnected by token');

  // вопрос 2: никто не отвечает, ждём таймаут (5 c)
  h = await host('next');
  assert(h.snapshot.state === 'question' && h.snapshot.question.index === 1, 'question 2 started');
  await sleep(1200);
  h = await hostGet();
  assert(h.snapshot.state === 'question', 'still question before timeout');
  await sleep(4500);
  s1 = await pGet(j1);
  assert(s1.snapshot.state === 'reveal' && s1.snapshot.reveal.answerIndex === null && s1.snapshot.reveal.isLast, 'timeout reveal for player');
  h = await hostGet();
  assert(h.snapshot.reveal.counts.join() === '0,0,0,0' && h.snapshot.reveal.text === 'Q2', 'host reveal after timeout');

  // кик
  const j3 = j2;
  assert((await host('kick', { playerId: j3.playerId })).ok, 'kick ok');
  assert((await pGet(j3)).status === 403, 'kicked player gets 403');

  // финал
  h = await host('next');
  assert(h.snapshot.state === 'end' && h.snapshot.end.leaderboard.length === 1 && h.snapshot.end.leaderboard[0].name === 'Аня', 'final leaderboard');
  s1 = await pGet(j1);
  assert(s1.snapshot.state === 'end' && s1.snapshot.end.rank === 1, 'player sees end');

  assert((await host('end')).ok, 'host ended game');
  assert((await pGet(j1)).status === 404, 'game removed after end');
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => { if (String(d).includes('Квиз запущен')) resolve(child); });
    child.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
}

async function withServer(env, fn) {
  const child = await startServer(env);
  try { await fn(`http://localhost:${env.PORT}`); } finally { child.kill(); }
}

(async () => {
  const { scoreFor } = require('../server.js');
  assert(scoreFor(true, 0, 20, 1) === 1000, 'instant correct = 1000');
  assert(scoreFor(true, 20000, 20, 1) === 500, 'last-second correct = 500');
  assert(scoreFor(false, 0, 20, 0) === 0, 'wrong = 0');
  assert(scoreFor(true, 0, 20, 3) === 1200, 'streak bonus');

  await withServer({ PORT: '3998' }, runScenario);
  console.log('memory store: OK');

  let shim = null;
  try {
    const { startShim } = require('./upstash-shim');
    shim = await startShim();
  } catch (e) {
    console.log('redis-server недоступен, пропускаем проверку Upstash:', e.message);
  }
  if (shim) {
    await withServer({ PORT: '3997', KV_REST_API_URL: shim.url, KV_REST_API_TOKEN: 'test' }, runScenario);
    await shim.close();
    console.log('upstash store (via local redis): OK');
  }
  console.log('ALL SMOKE TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

setTimeout(() => { console.error('FAIL: timeout'); process.exit(1); }, 60000).unref();
