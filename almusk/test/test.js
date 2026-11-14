'use strict';
/* Тесты Al Musk: формулы из PROMPT.md, цикл смены через API, хранилище Upstash. */
const assert = require('assert/strict');
const http = require('http');
const { spawn } = require('child_process');
const C = require('../public/calc.js');
const { MemoryStore, UpstashStore } = require('../lib/store');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    throw e;
  }
}

const perfume = (o) => ({ type: 'perfume', name: 'Black Opium', volume: 30, conc: 40, oilPrice: 50, basePrice: 2.5, bottleCost: 300, price: 10000, ...o });

async function calcTests() {
  console.log('Расчёты');
  await test('духи 30 мл 40%: масло, основа, флакон', () => {
    const c = C.itemCalc(perfume());
    assert.equal(c.oilMl, 12);
    assert.equal(c.baseMl, 18);
    assert.equal(c.cost, 12 * 50 + 18 * 2.5 + 300); // 945
    assert.equal(c.profit, 10000 - 945);
  });
  await test('духи 50 мл 35%', () => {
    const c = C.itemCalc(perfume({ volume: 50, conc: 35, bottleCost: 350 }));
    assert.equal(c.oilMl, 17.5);
    assert.equal(c.baseMl, 32.5);
    assert.equal(c.cost, C.r2(17.5 * 50 + 32.5 * 2.5 + 350));
  });
  await test('чистое масло 100%, без основы', () => {
    const c = C.itemCalc({ type: 'oil', name: 'X', volume: 6, oilPrice: 50, bottleCost: 120, price: 3000 });
    assert.equal(c.oilMl, 6);
    assert.equal(c.baseMl, 0);
    assert.equal(c.cost, 420);
  });
  await test('товар считается по своей закупке, без формулы духов', () => {
    const c = C.itemCalc({ type: 'other', name: 'Фиксатор', unitCost: 500, qty: 2, price: 3000 });
    assert.equal(c.cost, 1000);
    assert.equal(c.oilMl, 0);
  });
  await test('скидка: цена продажи фактическая, скидка не вычитается повторно', () => {
    const c = C.itemCalc(perfume({ fullPrice: 12000, price: 10000 }));
    assert.equal(c.price, 10000);
    assert.equal(c.discount, 2000);
  });
  await test('акция 2+1: подарок без выручки, себестоимость учтена', () => {
    const sale = {
      promo: '2+1',
      items: [perfume(), perfume({ name: 'Baccarat', oilPrice: 100 }), perfume({ name: 'Gift', gift: true, price: 999 })],
      pay: { kaspi: 20000 },
    };
    const c = C.saleCalc(sale);
    assert.equal(c.revenue, 20000);
    assert.equal(c.gifts, 1);
    assert.equal(c.giftCost, 945);
    assert.equal(c.cost, 945 + (12 * 100 + 45 + 300) + 945);
    assert.equal(c.positions, 2);
    assert.ok(c.payOk);
  });
  await test('проверка обязательных полей позиции', () => {
    assert.deepEqual(C.itemMissing(perfume()), []);
    assert.ok(C.itemMissing(perfume({ oilPrice: '' })).includes('закупочная цена масла за 1 мл'));
    assert.ok(C.itemMissing(perfume({ bottleCost: '' })).includes('стоимость флакона'));
    assert.ok(C.itemMissing(perfume({ price: '' })).includes('фактическая цена продажи'));
    assert.deepEqual(C.itemMissing(perfume({ price: '', gift: true })), []);
  });

  await test('остатки: наличные, Kaspi, переводы раздельно; личное не в результате', () => {
    const day = {
      date: '2026-11-14',
      status: 'open',
      opening: { cash: 10000, kaspi: 20000, transfer: 5000, transferTracked: true },
      sellers: [
        { name: 'Айгерим', salary: 6000, paid: true, paidAmount: 6000, paidFrom: 'cash' },
        { name: 'Дана', salary: 5000, paid: false },
      ],
      sales: [
        { id: 's1', seller: 'Айгерим', items: [perfume({ price: 5000 })], pay: { cash: 5000 } },
        { id: 's2', seller: 'Дана', items: [perfume({ price: 8000 })], pay: { kaspi: 8000 } },
        { id: 's3', seller: 'Дана', items: [perfume({ price: 4000 })], pay: { transfer: 1000, cash: 3000 } },
      ],
      ops: [
        { kind: 'business', category: 'Аренда', amount: 1000, account: 'cash' },
        { kind: 'personal', category: 'Еда', amount: 500, account: 'cash' },
        { kind: 'personal', category: 'Снятие на личные нужды', amount: 3000, account: 'kaspi' },
        { kind: 'transfer', category: 'Снятие с Kaspi в кассу', amount: 2000, account: 'kaspi', to: 'cash' },
        { kind: 'purchase', category: 'Масла', amount: 7000, account: 'transfer' },
      ],
      closing: { commission: 100, cashActual: 12500, kaspiActual: 22900, transferActual: -1000 },
    };
    const t = C.dayTotals(day);
    assert.equal(t.revenue, 17000);
    assert.deepEqual(t.pay, { kaspi: 8000, transfer: 1000, cash: 8000 });
    // 10000 + 8000 нал. продаж + 2000 перемещение − 1000 аренда − 500 еда − 6000 зарплата
    assert.equal(t.balances.cash.calc, 12500);
    assert.equal(t.balances.cash.diff, 0);
    // 20000 + 8000 − 100 комиссия − 3000 снятие − 2000 перемещение
    assert.equal(t.balances.kaspi.calc, 22900);
    // 5000 + 1000 − 7000 закупка
    assert.equal(t.balances.transfer.calc, -1000);
    assert.equal(t.cogs, 945 * 3);
    assert.equal(t.gross, 17000 - 945 * 3);
    // результат: валовая − зарплата обоих − комиссия − аренда; личное и закупка не входят
    assert.equal(t.result, t.gross - 11000 - 100 - 1000);
    assert.equal(t.personal, 3500);
    assert.equal(t.personalKaspiWithdraw, 3000);
    assert.equal(t.purchases, 7000);
    assert.equal(t.salaryUnpaid, 5000);
    assert.equal(t.sellers['Дана'].revenue, 12000);
    assert.equal(t.sellers['Дана'].pay.transfer, 1000);
    assert.equal(t.sellers['Айгерим'].receipts, 1);
  });
  await test('расхождение показывается, а не исправляется', () => {
    const day = {
      date: '2026-11-14',
      opening: { cash: 1000, kaspi: 0, transfer: 0 },
      sellers: [{ name: 'A', salary: 0 }],
      sales: [{ seller: 'A', items: [perfume({ price: 2000 })], pay: { cash: 2000, kaspi: 0 } }],
      ops: [],
      closing: { cashActual: 2500, kaspiTerminal: 500 },
    };
    const t = C.dayTotals(day);
    assert.equal(t.balances.cash.diff, -500);
    const d = C.dayDiscrepancies(day);
    assert.equal(d.find((x) => x.key === 'cash').diff, -500);
    assert.equal(d.find((x) => x.key === 'terminal').diff, 500);
  });
  await test('разбор списка цен', () => {
    const r = C.parsePriceList('Baccarat Rouge 540 — 120\nBlack Opium; 85,5\nTom Ford Oud Wood 140 тг\nмусор');
    assert.deepEqual(r.rows, [
      { name: 'Baccarat Rouge 540', price: 120 },
      { name: 'Black Opium', price: 85.5 },
      { name: 'Tom Ford Oud Wood', price: 140 },
    ]);
    assert.deepEqual(r.bad, ['мусор']);
  });
  await test('отчёт за день содержит все 7 разделов', () => {
    const day = { date: '2026-11-14', status: 'closed', opening: {}, sellers: [{ name: 'A', salary: 1 }], sales: [], ops: [], closing: {} };
    const txt = C.dailyReportText(day);
    for (const h of ['1. Продажи', '2. Себестоимость', '3. Прибыль', '4. Денежные остатки', '5. Личные операции', '6. Продавцы', '7. Контроль']) assert.ok(txt.includes(h), h);
  });
}

/* ---------- API ---------- */

function startServer(store, env = {}) {
  Object.assign(process.env, env);
  const api = require('../lib/api');
  api.setStore({ store, kind: 'memory' });
  const srv = http.createServer((req, res) => api.handle(req, res));
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function apiTests() {
  console.log('API');
  const srv = await startServer(new MemoryStore(), { OWNER_PIN: '4321' });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body, pin = '4321') => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-pin': pin }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const D = '2020-10-14'; // прошлая дата: продавцу недоступна
  try {
    await test('без PIN доступа нет', async () => {
      assert.equal((await call('GET', '/api/settings', null, '')).status, 401);
      assert.equal((await call('GET', '/api/settings', null, '0000')).status, 401);
      assert.equal((await call('GET', '/api/health', null, '')).body.auth, true);
    });
    await test('справочник: значения по умолчанию из промта', async () => {
      const r = await call('GET', '/api/settings');
      assert.equal(r.body.value.basePrice, 2.5);
      assert.equal(r.body.value.concentration['50'], 35);
      assert.equal(r.body.value.perfumeBottles['100'], 650);
      assert.equal(r.body.value.oilBottles['4.5'], 100);
    });
    await test('справочник: защита от одновременной записи', async () => {
      const cur = (await call('GET', '/api/settings')).body;
      const v = { ...cur.value, oils: [{ name: 'Black Opium', price: 50 }] };
      assert.equal((await call('PUT', '/api/settings', { rev: cur.rev, value: v })).status, 200);
      assert.equal((await call('PUT', '/api/settings', { rev: cur.rev, value: v })).status, 409);
    });
    await test('нельзя продавать без открытой смены', async () => {
      const r = await call('POST', `/api/day/${D}`, { type: 'upsertSale', sale: { items: [perfume()], pay: { cash: 10000 } } });
      assert.equal(r.status, 404);
    });
    await test('открытие смены', async () => {
      const r = await call('POST', `/api/day/${D}`, {
        type: 'open',
        opening: { time: '10:00', cash: 10000, kaspi: 0, transfer: 0 },
        sellers: [{ name: 'Айгерим', salary: 6000, start: '10:00' }],
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.value.status, 'open');
      assert.equal((await call('POST', `/api/day/${D}`, { type: 'open', opening: {}, sellers: [] })).status, 409);
    });
    await test('продажа без закупочной цены отклоняется', async () => {
      const r = await call('POST', `/api/day/${D}`, { type: 'upsertSale', sale: { items: [perfume({ oilPrice: '' })], pay: { cash: 10000 } } });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /закупочная цена/);
    });
    await test('оплата должна совпадать с суммой', async () => {
      const r = await call('POST', `/api/day/${D}`, { type: 'upsertSale', sale: { items: [perfume()], pay: { cash: 9000 } } });
      assert.equal(r.status, 400);
    });
    await test('продажа и операция записываются, индекс обновляется', async () => {
      let r = await call('POST', `/api/day/${D}`, { type: 'upsertSale', sale: { id: 's1', seller: 'Айгерим', items: [perfume()], pay: { kaspi: 6000, cash: 4000 } } });
      assert.equal(r.status, 200);
      assert.equal(r.body.value.sales.length, 1);
      r = await call('POST', `/api/day/${D}`, { type: 'upsertOp', op: { kind: 'personal', category: 'Еда', amount: 1500, account: 'cash' } });
      assert.equal(r.status, 200);
      const idx = (await call('GET', '/api/index')).body;
      assert.equal(idx[D].revenue, 10000);
    });
    await test('удаление продажи пишется в журнал', async () => {
      await call('POST', `/api/day/${D}`, { type: 'upsertSale', sale: { id: 's2', seller: 'Айгерим', items: [perfume()], pay: { cash: 10000 } } });
      const r = await call('POST', `/api/day/${D}`, { type: 'removeSale', id: 's2', reason: 'ошибка ввода' });
      const entry = r.body.value.log.find((l) => l.a === 'removeSale');
      assert.equal(entry.d.removed.id, 's2');
      assert.equal(entry.d.reason, 'ошибка ввода');
    });
    await test('закрытие без данных не проходит, с явным согласием проходит', async () => {
      let r = await call('POST', `/api/day/${D}`, { type: 'close' });
      assert.equal(r.status, 422);
      assert.match(r.body.error, /Фото сверки/);
      r = await call('PUT', `/api/photo/${D}`, { dataUrl: 'data:image/jpeg;base64,AAAA' });
      assert.equal(r.status, 200);
      assert.equal(r.body.value.closing.photo, true);
      r = await call('POST', `/api/day/${D}`, { type: 'setClosing', closing: { kaspiTerminal: 6000, cashActual: 12000, commission: 60 } });
      assert.equal(r.status, 200);
      r = await call('POST', `/api/day/${D}`, { type: 'close', withGaps: true });
      assert.equal(r.status, 200);
      assert.equal(r.body.value.status, 'closed');
      assert.ok(r.body.value.closing.closedWithGaps);
    });
    await test('закрытую смену нельзя менять без открытия с причиной', async () => {
      let r = await call('POST', `/api/day/${D}`, { type: 'upsertOp', op: { kind: 'business', amount: 1, account: 'cash' } });
      assert.equal(r.status, 423);
      r = await call('POST', `/api/day/${D}`, { type: 'reopen' });
      assert.equal(r.status, 400);
      r = await call('POST', `/api/day/${D}`, { type: 'setDiscNote', key: 'cash', comment: 'пересчитали', resolved: true });
      assert.equal(r.status, 200);
      r = await call('POST', `/api/day/${D}`, { type: 'reopen', reason: 'забыли расход' });
      assert.equal(r.body.value.status, 'open');
    });
    await test('расхождения в индексе: касса 10000 + 4000 − 1500 = 12500, факт 12000', async () => {
      const idx = (await call('GET', '/api/index')).body;
      const cash = idx[D].disc.find((d) => d.key === 'cash');
      assert.equal(cash.diff, -500);
      assert.equal(cash.resolved, true);
    });
    await test('отчёт за период', async () => {
      const r = await call('GET', '/api/range?from=2020-10-01&to=2020-10-31');
      assert.equal(r.body.length, 1);
      const R = C.rangeTotals(r.body);
      assert.equal(R.revenue, 10000);
      assert.equal(R.sellerRank[0].name, 'Айгерим');
      assert.equal(R.topAromas[0].name, 'Black Opium');
    });
    await test('экспорт', async () => {
      const r = await call('GET', '/api/export');
      assert.equal(r.body.days.length, 1);
      assert.equal(r.body.settings.oils[0].name, 'Black Opium');
    });

    /* ---------- Продавец ---------- */
    const T = (await call('GET', '/api/health')).body.today;
    const S = '1111';
    await test('руководитель задаёт PIN продавцов, роли определяются по PIN', async () => {
      assert.equal((await call('PUT', '/api/seller-pin', { pin: '4321' })).status, 400);
      assert.equal((await call('PUT', '/api/seller-pin', { pin: S })).status, 200);
      assert.equal((await call('POST', '/api/login', {}, S)).body.role, 'seller');
      assert.equal((await call('POST', '/api/login', {})).body.role, 'owner');
      assert.equal((await call('PUT', '/api/seller-pin', { pin: '2222' }, S)).status, 403);
    });
    await test('продавцу закрыты отчёты, справочник с ценами, экспорт, чужие даты', async () => {
      for (const path of ['/api/index', '/api/export', `/api/range?from=${T}&to=${T}`, `/api/day/${D}`]) {
        assert.equal((await call('GET', path, null, S)).status, 403, path);
      }
      const st = (await call('GET', '/api/settings', null, S)).body.value;
      assert.equal(st.oils[0].price, undefined);
      assert.equal(st.basePrice, null);
      assert.equal(JSON.stringify(st).includes('50'), true); // объёмы флаконов видны, цены нет
      assert.equal(Object.values(st.perfumeBottles).every((v) => v === null), true);
      assert.equal((await call('PUT', '/api/settings', { rev: 0, value: st }, S)).status, 403);
    });
    await test('продавец открывает смену: зарплата из справочника, остатки Kaspi не подтверждены', async () => {
      const cur = (await call('GET', '/api/settings')).body;
      await call('PUT', '/api/settings', { rev: cur.rev, value: { ...cur.value, sellers: [{ name: 'Дана', salary: 5000 }] } });
      let r = await call('POST', `/api/day/${T}`, { type: 'open', opening: { cash: 12000 }, sellers: [{ name: 'Неизвестная' }] }, S);
      assert.equal(r.status, 400);
      r = await call('POST', `/api/day/${T}`, { type: 'open', opening: { time: '10:00', cash: 12000, kaspi: 999999 }, sellers: [{ name: 'дана', start: '10:00' }] }, S);
      assert.equal(r.status, 200);
      assert.equal(r.body.value.sellers[0].salary, undefined);
      assert.equal(r.body.value.opening.kaspi, undefined);
      const own = (await call('GET', `/api/day/${T}`)).body.value;
      assert.equal(own.sellers[0].salary, 5000);
      assert.equal(own.opening.confirmed, false);
      assert.notEqual(own.opening.kaspi, 999999);
    });
    await test('продажа продавца: себестоимость считает сервер, продавец её не видит', async () => {
      const r = await call('POST', `/api/day/${T}`, { type: 'upsertSale', sale: { id: 'p1', seller: 'Дана', items: [{ id: 'i1', type: 'perfume', name: 'black opium', volume: 30, price: 10000, oilPrice: 1 }], pay: { cash: 10000 } } }, S);
      assert.equal(r.status, 200);
      assert.equal(r.body.value.sales[0].items[0].oilPrice, undefined);
      const it = (await call('GET', `/api/day/${T}`)).body.value.sales[0].items[0];
      assert.equal(it.oilPrice, 50);
      assert.equal(it.conc, 40);
      assert.equal(it.bottleCost, 300);
      assert.equal(C.itemCalc(it).cost, 945);
    });
    await test('аромата нет в справочнике: продажа сохраняется, себестоимость ждёт руководителя', async () => {
      let r = await call('POST', `/api/day/${T}`, { type: 'upsertSale', sale: { id: 'p2', seller: 'Дана', items: [{ id: 'i2', type: 'oil', name: 'Новинка', volume: 6, price: 4000 }], pay: { kaspi: 4000 } } }, S);
      assert.equal(r.status, 200);
      let idx = (await call('GET', '/api/index')).body;
      assert.equal(idx[T].pendingCost, 1);
      const cur = (await call('GET', '/api/settings')).body;
      await call('PUT', '/api/settings', { rev: cur.rev, value: { ...cur.value, oils: cur.value.oils.concat({ name: 'Новинка', price: 30 }) } });
      r = await call('POST', `/api/day/${T}`, { type: 'fillPending' });
      const it = r.body.value.sales[1].items[0];
      assert.equal(it.costPending, undefined);
      assert.equal(C.itemCalc(it).cost, 6 * 30 + 120);
      idx = (await call('GET', '/api/index')).body;
      assert.equal(idx[T].pendingCost, 0);
      assert.equal((await call('POST', `/api/day/${T}`, { type: 'fillPending' }, S)).status, 403);
    });
    await test('продавцу недоступны личные операции и перемещения', async () => {
      assert.equal((await call('POST', `/api/day/${T}`, { type: 'upsertOp', op: { kind: 'personal', amount: 100, account: 'cash' } }, S)).status, 403);
      assert.equal((await call('POST', `/api/day/${T}`, { type: 'upsertOp', op: { kind: 'transfer', amount: 100, account: 'kaspi', to: 'cash' } }, S)).status, 403);
      await call('POST', `/api/day/${T}`, { type: 'upsertOp', op: { kind: 'personal', category: 'Еда', amount: 700, account: 'kaspi' } });
      const r = await call('POST', `/api/day/${T}`, { type: 'upsertOp', op: { id: 'o1', kind: 'business', category: 'Хозяйственные нужды', amount: 300, account: 'cash' } }, S);
      assert.equal(r.status, 200);
      assert.equal(r.body.value.ops.length, 1, 'продавец видит только свои операции');
    });
    await test('удаление продажи продавцом видно руководителю', async () => {
      await call('POST', `/api/day/${T}`, { type: 'upsertSale', sale: { id: 'p3', seller: 'Дана', items: [{ type: 'perfume', name: 'Black Opium', volume: 10, price: 5000 }], pay: { cash: 5000 } } }, S);
      assert.equal((await call('POST', `/api/day/${T}`, { type: 'removeSale', id: 'p3' }, S)).status, 400);
      await call('POST', `/api/day/${T}`, { type: 'removeSale', id: 'p3', reason: 'клиент передумал' }, S);
      const idx = (await call('GET', '/api/index')).body;
      assert.deepEqual(idx[T].sellerDeletions, { count: 1, sum: 5000 });
    });
    await test('продавец сдаёт смену вслепую, затем изменения закрыты', async () => {
      let r = await call('POST', `/api/day/${T}`, { type: 'submit', closing: { kaspiTerminal: 4000, transfersReported: 0, cashSalesReported: 10000, cashActual: 21700 } }, S);
      assert.equal(r.status, 422);
      await call('PUT', `/api/photo/${T}`, { dataUrl: 'data:image/jpeg;base64,AAAA' }, S);
      r = await call('POST', `/api/day/${T}`, { type: 'submit', time: '21:00', closing: { kaspiTerminal: 4000, transfersReported: 0, cashSalesReported: 10000, cashActual: 21700 } }, S);
      assert.equal(r.status, 200);
      assert.ok(r.body.value.closing.submittedAt);
      assert.equal(r.body.value.closing.commission, undefined);
      assert.equal((await call('POST', `/api/day/${T}`, { type: 'upsertSale', sale: { items: [perfume()], pay: { cash: 10000 } } }, S)).status, 423);
      const own = (await call('GET', `/api/day/${T}`)).body.value;
      const t = C.dayTotals(own);
      // 12000 + 10000 наличными − 300 расход продавца
      assert.equal(t.balances.cash.calc, 21700);
      assert.equal(t.balances.cash.diff, 0);
      assert.equal(own.sellers[0].end, '21:00');
    });
    await test('руководитель подтверждает остатки и закрывает смену', async () => {
      const own = (await call('GET', `/api/day/${T}`)).body.value;
      await call('POST', `/api/day/${T}`, { type: 'setOpening', opening: { ...own.opening, kaspi: 0, transfer: 0 } });
      await call('POST', `/api/day/${T}`, { type: 'setClosing', closing: { commission: 40, kaspiActual: 3260, transferActual: 0 } });
      const r = await call('POST', `/api/day/${T}`, { type: 'close' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const idx = (await call('GET', '/api/index')).body;
      assert.equal(idx[T].openingUnconfirmed, false);
      assert.equal(idx[T].disc.length, 0);
    });
  } finally {
    srv.close();
    delete process.env.OWNER_PIN;
  }
}

/* ---------- Upstash через локальный redis ---------- */

async function upstashTests() {
  let redisProc;
  let shim;
  try {
    require.resolve('redis');
  } catch (e) {
    console.log('Upstash: пропущено (нет пакета redis для имитации)');
    return;
  }
  const port = 6390 + Math.floor(Math.random() * 100);
  try {
    redisProc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    await new Promise((r, j) => {
      redisProc.on('error', j);
      setTimeout(r, 400);
    });
  } catch (e) {
    console.log('Upstash: пропущено (нет redis-server)');
    return;
  }
  try {
    console.log('Upstash (имитация REST поверх redis)');
    const { startShim } = require('../../test/upstash-shim.js');
    shim = await startShim(`redis://127.0.0.1:${port}`);
    const { Redis } = require('@upstash/redis');
    const store = new UpstashStore(new Redis({ url: shim.url, token: 'x', automaticDeserialization: false }));
    await test('CAS: первая запись, конфликт, обновление', async () => {
      assert.equal(await store.cas('am:t', 0, { a: 1 }), true);
      assert.equal(await store.cas('am:t', 0, { a: 2 }), false);
      assert.equal(await store.cas('am:t', 1, { a: 3 }), true);
      assert.deepEqual(await store.get('am:t'), { rev: 2, value: { a: 3 } });
    });
    await test('mget, hash, raw, incr', async () => {
      const got = await store.mget(['am:t', 'am:none']);
      assert.equal(got[0].value.a, 3);
      assert.equal(got[1], null);
      await store.hset('am:i', '2026-11-14', { x: 1 });
      assert.deepEqual(await store.hgetall('am:i'), { '2026-11-14': { x: 1 } });
      await store.setRaw('am:p', 'data:image/jpeg;base64,AAA');
      assert.equal(await store.getRaw('am:p'), 'data:image/jpeg;base64,AAA');
      assert.equal(await store.incr('am:f', 60), 1);
      assert.equal(await store.incr('am:f', 60), 2);
    });
  } finally {
    if (shim) await shim.close();
    if (redisProc) redisProc.kill();
  }
}

(async () => {
  await calcTests();
  await apiTests();
  await upstashTests();
  console.log(`\nВсе тесты пройдены: ${passed}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
