'use strict';
// Сквозной тест: ведущий + 2 игрока проходят игру из 2 вопросов.
process.env.PORT = process.env.PORT || '3999';
const { server, games, scoreFor, validateQuestions } = require('../server.js');
const { io } = require('socket.io-client');

const URL = `http://localhost:${process.env.PORT}`;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };
const emit = (sock, ev, data) => new Promise((res) => sock.emit(ev, data, res));
const once = (sock, ev) => new Promise((res) => sock.once(ev, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // unit: scoring
  assert(scoreFor(true, 0, 20, 1) === 1000, 'instant correct = 1000');
  assert(scoreFor(true, 20000, 20, 1) === 500, 'last-second correct = 500');
  assert(scoreFor(false, 0, 20, 0) === 0, 'wrong = 0');
  assert(scoreFor(true, 0, 20, 3) === 1200, 'streak bonus');
  assert(validateQuestions([{ text: 'x', answers: ['a', 'b'], correct: 5 }]) === null, 'rejects bad correct');
  assert(validateQuestions([]) === null, 'rejects empty');

  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));

  const host = io(URL);
  const p1 = io(URL);
  const p2 = io(URL);

  const questions = [
    { text: 'Q1', answers: ['a', 'b', 'c', 'd'], correct: 1 },
    { text: 'Q2', answers: ['a', 'b', 'c', 'd'], correct: 2 },
  ];
  const created = await emit(host, 'host:create', { questions, timeLimit: 5 });
  assert(created.ok && /^\d{6}$/.test(created.pin), 'game created with 6-digit pin');
  const pin = created.pin;

  const bad = await emit(p1, 'player:join', { pin: '000000', name: 'X' });
  assert(!bad.ok, 'unknown pin rejected');

  const lobbyP = once(host, 'game:lobby');
  const j1 = await emit(p1, 'player:join', { pin, name: '  Аня  ' });
  assert(j1.ok && j1.snapshot.name === 'Аня', 'player 1 joined, name trimmed');
  assert((await lobbyP).players.length === 1, 'host sees 1 player');
  const dup = await emit(p2, 'player:join', { pin, name: 'аня' });
  assert(!dup.ok, 'duplicate name rejected');
  const j2 = await emit(p2, 'player:join', { pin, name: 'Боб' });
  assert(j2.ok, 'player 2 joined');

  // question 1
  const qHost = once(host, 'game:question');
  const q1p1 = once(p1, 'game:question');
  const q1p2 = once(p2, 'game:question');
  const started = await emit(host, 'host:start', {});
  assert(started.ok, 'game started');
  const [qh, q1] = await Promise.all([qHost, q1p1, q1p2]);
  assert(qh.text === 'Q1' && q1.index === 0 && q1.timeLimit === 5, 'question 1 delivered');

  const earlyAgain = await emit(host, 'host:start', {});
  assert(!earlyAgain.ok, 'cannot start twice');

  const r1p1 = once(p1, 'game:reveal');
  const r1p2 = once(p2, 'game:reveal');
  const r1h = once(host, 'game:reveal');
  const a1 = await emit(p1, 'player:answer', { answerIndex: 1 }); // correct
  assert(a1.ok, 'p1 answer accepted');
  const twice = await emit(p1, 'player:answer', { answerIndex: 1 });
  assert(!twice.ok, 'second answer rejected');
  const a2 = await emit(p2, 'player:answer', { answerIndex: 0 }); // wrong
  assert(a2.ok, 'p2 answer accepted');
  // everyone answered -> reveal early (600ms), well before 5s limit
  const [rp1, rp2, rh] = await Promise.all([r1p1, r1p2, r1h]);
  assert(rp1.isCorrect && rp1.gained >= 900 && rp1.rank === 1, `p1 correct, fast, rank 1 (${rp1.gained})`);
  assert(!rp2.isCorrect && rp2.gained === 0 && rp2.rank === 2, 'p2 wrong, rank 2');
  assert(rh.correct === 1 && rh.counts.join() === '1,1,0,0' && rh.text === 'Q1', 'host reveal has counts and text');

  const late = await emit(p2, 'player:answer', { answerIndex: 2 });
  assert(!late.ok, 'answer after reveal rejected');

  // reconnect of p2 with token during reveal
  p2.disconnect();
  const p2b = io(URL);
  const rj = await emit(p2b, 'player:join', { pin, playerToken: j2.playerToken });
  assert(rj.ok && rj.snapshot.state === 'reveal' && rj.snapshot.reveal.score === 0, 'p2 reconnected into reveal state');

  // question 2: nobody answers -> timeout reveal
  const q2p = once(p1, 'game:question');
  await emit(host, 'host:next', {});
  const q2 = await q2p;
  assert(q2.index === 1 && q2.text === 'Q2', 'question 2 delivered');
  const r2h = await once(host, 'game:reveal');
  assert(r2h.isLast === true && r2h.counts.join() === '0,0,0,0', 'timeout reveal with no answers');

  // host reload during reveal
  host.disconnect();
  const host2 = io(URL);
  const resumed = await emit(host2, 'host:resume', { pin, hostToken: created.hostToken });
  assert(resumed.ok && resumed.snapshot.state === 'reveal' && resumed.snapshot.reveal.text === 'Q2', 'host resumed with question text');
  const badResume = await emit(io(URL), 'host:resume', { pin, hostToken: 'nope' });
  assert(!badResume.ok, 'bad host token rejected');

  const endP1 = once(p1, 'game:end');
  const endH = once(host2, 'game:end');
  await emit(host2, 'host:next', {});
  const [e1, eh] = await Promise.all([endP1, endH]);
  assert(e1.rank === 1 && eh.leaderboard[0].name === 'Аня' && eh.leaderboard.length === 2, 'final leaderboard');

  const closed = once(p1, 'game:closed');
  await emit(host2, 'host:end', {});
  await closed;
  assert(!games.has(pin), 'game removed after end');

  console.log('ALL SMOKE TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

setTimeout(() => { console.error('FAIL: timeout'); process.exit(1); }, 20000).unref();
