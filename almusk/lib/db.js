'use strict';
/**
 * Изменения дня. Каждое действие проверяется на сервере,
 * записывается через compare-and-set и попадает в журнал дня.
 */
const crypto = require('crypto');
const Calc = require('../public/calc.js');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const K = {
  settings: 'am:settings',
  day: (d) => `am:day:${d}`,
  photo: (d) => `am:photo:${d}`,
  index: 'am:index',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const id = () => crypto.randomBytes(6).toString('hex');
const clone = (o) => JSON.parse(JSON.stringify(o));
const LOCKED_OK = new Set(['reopen', 'setDiscNote']);

function cleanSeller(s) {
  return {
    id: s.id || id(),
    name: String(s.name || '').trim(),
    salary: Calc.num(s.salary),
    start: String(s.start || ''),
    end: String(s.end || ''),
    paid: !!s.paid,
    paidAmount: s.paid ? Calc.num(s.paidAmount === undefined || s.paidAmount === '' ? s.salary : s.paidAmount) : undefined,
    paidFrom: s.paid ? (Calc.ACCOUNTS.includes(s.paidFrom) ? s.paidFrom : 'cash') : undefined,
    paidAt: s.paid ? String(s.paidAt || '') : undefined,
  };
}

function validateSellers(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Список продавцов не передан');
  const out = list.map(cleanSeller);
  for (const s of out) if (!s.name) throw new HttpError(400, 'У продавца нет имени');
  const names = out.map((s) => s.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new HttpError(400, 'Продавец указан дважды');
  return out;
}

function cleanOpening(o) {
  return {
    time: String(o.time || ''),
    cash: Calc.num(o.cash),
    kaspi: Calc.num(o.kaspi),
    transfer: Calc.num(o.transfer),
    transferTracked: o.transferTracked !== false,
    note: String(o.note || ''),
    confirmed: true,
  };
}

function validateSale(sale) {
  if (!sale || !Array.isArray(sale.items) || !sale.items.length) throw new HttpError(400, 'В продаже нет товаров');
  for (const it of sale.items) {
    const m = Calc.itemMissing(it);
    if (m.length) throw new HttpError(400, `Позиция «${it.name || 'без названия'}»: не заполнено ${m.join(', ')}`);
  }
  const c = Calc.saleCalc(sale);
  if (!c.payOk) throw new HttpError(400, `Сумма оплаты ${Calc.money(c.paySum)} не равна сумме продажи ${Calc.money(c.revenue)}`);
  return {
    id: sale.id || id(),
    time: String(sale.time || ''),
    seller: String(sale.seller || ''),
    promo: String(sale.promo || ''),
    note: String(sale.note || ''),
    pay: { kaspi: c.pay.kaspi, transfer: c.pay.transfer, cash: c.pay.cash },
    items: sale.items.map((it) => ({
      id: it.id || id(),
      type: it.type,
      name: String(it.name).trim(),
      volume: it.type === 'other' ? undefined : Calc.num(it.volume),
      conc: it.type === 'perfume' ? Calc.num(it.conc) : undefined,
      oilPrice: it.type === 'other' ? undefined : Calc.num(it.oilPrice),
      basePrice: it.type === 'perfume' ? Calc.num(it.basePrice) : undefined,
      bottleCost: it.type === 'other' ? undefined : Calc.num(it.bottleCost),
      unitCost: it.type === 'other' ? Calc.num(it.unitCost) : undefined,
      qty: it.type === 'other' ? Math.max(1, Calc.num(it.qty) || 1) : undefined,
      gift: !!it.gift,
      fullPrice: it.gift || Calc.blank(it.fullPrice) ? undefined : Calc.num(it.fullPrice),
      price: it.gift ? 0 : Calc.num(it.price),
    })),
  };
}

function validateOp(op) {
  if (!op || !Calc.OP_KINDS[op.kind]) throw new HttpError(400, 'Не указан вид операции');
  const amount = Calc.num(op.amount);
  if (!(amount > 0)) throw new HttpError(400, 'Сумма операции должна быть больше нуля');
  if (!Calc.ACCOUNTS.includes(op.account)) throw new HttpError(400, 'Не указан счёт');
  if (op.kind === 'transfer') {
    if (!Calc.ACCOUNTS.includes(op.to)) throw new HttpError(400, 'Не указан счёт получателя');
    if (op.to === op.account) throw new HttpError(400, 'Счета отправителя и получателя совпадают');
  }
  return {
    id: op.id || id(),
    time: String(op.time || ''),
    kind: op.kind,
    category: String(op.category || ''),
    amount,
    account: op.account,
    to: op.kind === 'transfer' ? op.to : undefined,
    note: String(op.note || ''),
    unclear: !!op.unclear,
  };
}

const CLOSING_FIELDS = ['kaspiTerminal', 'transfersReported', 'cashSalesReported', 'cashActual', 'kaspiActual', 'transferActual', 'commission'];

/** Применяет действие к дню. Возвращает новый день. */
function applyAction(day, action, now = new Date()) {
  const t = now.toISOString();
  const type = action && action.type;
  if (!type) throw new HttpError(400, 'Не указано действие');

  if (type === 'open') {
    if (day) throw new HttpError(409, 'Смена за эту дату уже открыта');
    return {
      date: action.date,
      status: 'open',
      createdAt: t,
      opening: cleanOpening(action.opening || {}),
      sellers: validateSellers(action.sellers || []),
      sales: [],
      ops: [],
      closing: {},
      discNotes: {},
      log: [{ t, a: 'open' }],
    };
  }
  if (!day) throw new HttpError(404, 'Смена за эту дату ещё не открыта');
  day = clone(day);
  if (day.status === 'closed' && !LOCKED_OK.has(type)) {
    throw new HttpError(423, 'Смена закрыта. Чтобы внести изменения, откройте её для исправления.');
  }
  const log = (a, d) => {
    day.log = (day.log || []).concat({ t, a, ...(d ? { d } : {}) }).slice(-300);
  };

  switch (type) {
    case 'setOpening': {
      const before = day.opening;
      day.opening = cleanOpening(action.opening || {});
      log('setOpening', { before });
      break;
    }
    case 'setSellers':
      day.sellers = validateSellers(action.sellers);
      log('setSellers');
      break;
    case 'upsertSale': {
      const sale = validateSale(action.sale);
      const i = day.sales.findIndex((s) => s.id === sale.id);
      if (i >= 0) {
        log('editSale', { before: day.sales[i] });
        day.sales[i] = sale;
      } else {
        day.sales.push(sale);
        log('addSale', { id: sale.id });
      }
      break;
    }
    case 'removeSale': {
      const i = day.sales.findIndex((s) => s.id === action.id);
      if (i < 0) throw new HttpError(404, 'Продажа не найдена');
      log('removeSale', { removed: day.sales[i], reason: String(action.reason || '') });
      day.sales.splice(i, 1);
      break;
    }
    case 'upsertOp': {
      const op = validateOp(action.op);
      const i = day.ops.findIndex((o) => o.id === op.id);
      if (i >= 0) {
        log('editOp', { before: day.ops[i] });
        day.ops[i] = op;
      } else {
        day.ops.push(op);
        log('addOp', { id: op.id });
      }
      break;
    }
    case 'removeOp': {
      const i = day.ops.findIndex((o) => o.id === action.id);
      if (i < 0) throw new HttpError(404, 'Операция не найдена');
      log('removeOp', { removed: day.ops[i], reason: String(action.reason || '') });
      day.ops.splice(i, 1);
      break;
    }
    case 'setClosing': {
      const c = action.closing || {};
      const next = { ...(day.closing || {}) };
      for (const f of CLOSING_FIELDS) {
        if (f in c) next[f] = Calc.blank(c[f]) ? '' : Calc.num(c[f]);
      }
      if ('note' in c) next.note = String(c.note || '');
      if ('time' in c) next.time = String(c.time || '');
      day.closing = next;
      log('setClosing');
      break;
    }
    case 'setPhoto':
      day.closing = { ...(day.closing || {}), photo: !!action.has, photoAt: action.has ? t : undefined };
      log(action.has ? 'addPhoto' : 'removePhoto');
      break;
    case 'close': {
      const missing = Calc.closingMissing(day);
      if (missing.length && !action.withGaps) {
        throw new HttpError(422, `Для закрытия не хватает: ${missing.join(', ')}`);
      }
      day.status = 'closed';
      day.closing = { ...(day.closing || {}), closedAt: t, closedWithGaps: missing.length > 0, gaps: missing };
      if (action.time) day.closing.time = String(action.time);
      log('close', missing.length ? { gaps: missing } : undefined);
      break;
    }
    case 'reopen':
      if (day.status !== 'closed') throw new HttpError(409, 'Смена и так открыта');
      if (Calc.blank(action.reason)) throw new HttpError(400, 'Укажите причину исправления');
      day.status = 'open';
      log('reopen', { reason: String(action.reason) });
      break;
    case 'setDiscNote': {
      if (!action.key) throw new HttpError(400, 'Не указано расхождение');
      day.discNotes = { ...(day.discNotes || {}) };
      day.discNotes[action.key] = { resolved: !!action.resolved, comment: String(action.comment || ''), at: t };
      log('setDiscNote', { key: action.key, resolved: !!action.resolved });
      break;
    }
    default:
      throw new HttpError(400, `Неизвестное действие: ${type}`);
  }
  return day;
}

/** Применяет действие с повтором при одновременной записи. */
async function mutateDay(store, date, action) {
  if (!DATE_RE.test(date)) throw new HttpError(400, 'Неверная дата');
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await store.get(K.day(date));
    const next = applyAction(cur ? cur.value : null, { ...action, date });
    const rev = cur ? cur.rev : 0;
    if (await store.cas(K.day(date), rev, next)) {
      await store.hset(K.index, date, Calc.daySummary(next));
      return { rev: rev + 1, value: next };
    }
  }
  throw new HttpError(409, 'Данные одновременно меняли с другого устройства. Повторите.');
}

module.exports = { applyAction, mutateDay, HttpError, K, DATE_RE, validateSale, validateOp };
