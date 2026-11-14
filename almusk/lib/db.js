'use strict';
/**
 * Изменения дня. Каждое действие проверяется на сервере с учётом роли,
 * записывается через compare-and-set и попадает в журнал дня.
 *
 * Роли:
 *  - owner: руководитель, может всё;
 *  - seller: продавец, ведёт продажи своей смены и сдаёт её. Не видит и не задаёт
 *    себестоимость, остатки счетов, зарплаты и личные операции.
 */
const crypto = require('crypto');
const Calc = require('../public/calc.js');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const K = {
  settings: 'am:settings',
  day: (d) => `am:day:${d}`,
  photo: (d) => `am:photo:${d}`,
  index: 'am:index',
  sellerPin: 'am:sellerpin',
  stock: 'am:stock',
  cons: 'am:cons',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const id = () => crypto.randomBytes(6).toString('hex');
const clone = (o) => JSON.parse(JSON.stringify(o));

const SELLER_ACTIONS = new Set(['open', 'addSeller', 'upsertSale', 'removeSale', 'upsertOp', 'removeOp', 'setPhoto', 'submit']);
const SELLER_OP_KINDS = new Set(['business', 'purchase', 'refund']);
const OWNER_ON_CLOSED = new Set(['reopen', 'setDiscNote', 'fillPending', 'reprice']);
const COST_FIELDS = ['oilPrice', 'basePrice', 'bottleCost', 'unitCost'];
const SELLER_CLOSING = ['kaspiTerminal', 'transfersReported', 'cashSalesReported', 'cashActual'];
const CLOSING_FIELDS = [...SELLER_CLOSING, 'kaspiActual', 'transferActual', 'commission'];

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
  const names = out.map((s) => Calc.norm(s.name));
  if (new Set(names).size !== names.length) throw new HttpError(400, 'Продавец указан дважды');
  return out;
}

/** Продавцы из справочника руководителя: зарплату продавец не задаёт сам. */
function sellersFromDirectory(list, settings) {
  const dir = ((settings && settings.sellers) || []).slice();
  // Руководитель тоже может работать в смене: без зарплаты
  const owner = settings && String(settings.ownerName || '').trim();
  if (owner && !dir.some((x) => Calc.norm(x.name) === Calc.norm(owner))) dir.push({ name: owner, salary: 0 });
  if (!dir.length) throw new HttpError(400, 'Руководитель ещё не добавил продавцов в справочник');
  return (list || []).map((s) => {
    const d = dir.find((x) => Calc.norm(x.name) === Calc.norm(s.name));
    if (!d) throw new HttpError(400, `Продавца «${s.name}» нет в справочнике. Обратитесь к руководителю.`);
    return { id: id(), name: d.name, salary: Calc.num(d.salary), start: String(s.start || ''), end: '' };
  });
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

/** Подставляет себестоимость из справочника (для продавца и для «заполнить из справочника»). */
function priceFromSettings(it, settings) {
  const out = { ...it };
  for (const f of COST_FIELDS) delete out[f];
  const vol = Calc.num(it.volume);
  if (it.type === 'perfume' || it.type === 'oil') {
    const oil = Calc.findOil(settings, it.name);
    let bottle;
    if (it.type === 'perfume') {
      if (Calc.blank(it.conc)) {
        const c = Calc.tableValue(settings.concentration, vol);
        if (c === null) throw new HttpError(400, `Для объёма ${vol} мл нет стандартной концентрации. Укажите её.`);
        out.conc = c;
      }
      out.basePrice = settings.basePrice;
      bottle = Calc.tableValue(settings.perfumeBottles, vol);
    } else {
      bottle = Calc.tableValue(settings.oilBottles, vol);
    }
    const priced = Calc.hasPrice(oil);
    out.oilPrice = priced ? oil.price : '';
    out.bottleCost = bottle === null ? '' : bottle;
    if (oil) out.name = oil.name;
    out.costPending = !priced || bottle === null;
  } else {
    const g = Calc.findGood(settings, it.name);
    out.unitCost = g ? g.cost : '';
    if (g) out.name = g.name;
    out.costPending = !g;
  }
  return out;
}

function sameItem(a, b) {
  return a && b && a.type === b.type && Calc.norm(a.name) === Calc.norm(b.name) && Calc.num(a.volume) === Calc.num(b.volume) &&
    (a.type !== 'perfume' || Calc.blank(b.conc) || Calc.num(a.conc) === Calc.num(b.conc));
}

function validateSale(sale, { role = 'owner', settings, old } = {}) {
  if (!sale || !Array.isArray(sale.items) || !sale.items.length) throw new HttpError(400, 'В продаже нет товаров');
  const oldItems = (old && old.items) || [];
  let items = sale.items.map((it) => ({ ...it, id: it.id || id() }));
  if (role === 'seller') {
    // Продавец не передаёт цены закупки: берём из справочника или из прошлой версии позиции
    items = items.map((it) => {
      const prev = oldItems.find((o) => o.id === it.id);
      if (sameItem(prev, it)) {
        const keep = { ...it, conc: prev.conc, costPending: !!prev.costPending };
        for (const f of COST_FIELDS) keep[f] = prev[f];
        return keep;
      }
      return priceFromSettings(it, settings || Calc.withDefaults(null));
    });
  } else {
    // Руководитель: позиция может остаться без цены, только если она уже была такой
    items = items.map((it) => {
      const prev = oldItems.find((o) => o.id === it.id);
      const pending = !!(prev && prev.costPending && Calc.costMissing(it).length);
      return { ...it, costPending: pending };
    });
  }
  for (const it of items) {
    const m = Calc.itemMissing(it);
    if (m.length) throw new HttpError(400, `Позиция «${it.name || 'без названия'}»: не заполнено ${m.join(', ')}`);
  }
  const c = Calc.saleCalc({ ...sale, items });
  if (!c.payOk) throw new HttpError(400, `Сумма оплаты ${Calc.money(c.paySum)} не равна сумме продажи ${Calc.money(c.revenue)}`);
  const n = (v) => (Calc.blank(v) ? '' : Calc.num(v));
  return {
    id: sale.id || id(),
    time: String(sale.time || ''),
    seller: String(sale.seller || ''),
    promo: String(sale.promo || ''),
    note: String(sale.note || ''),
    by: old ? old.by || role : role,
    pay: { kaspi: c.pay.kaspi, transfer: c.pay.transfer, cash: c.pay.cash },
    items: items.map((it) => ({
      id: it.id,
      type: it.type,
      name: String(it.name).trim(),
      volume: it.type === 'other' ? undefined : Calc.num(it.volume),
      conc: it.type === 'perfume' ? Calc.num(it.conc) : undefined,
      oilPrice: it.type === 'other' ? undefined : n(it.oilPrice),
      basePrice: it.type === 'perfume' ? n(it.basePrice) : undefined,
      bottleCost: it.type === 'other' ? undefined : n(it.bottleCost),
      unitCost: it.type === 'other' ? n(it.unitCost) : undefined,
      costPending: it.costPending ? true : undefined,
      qty: it.type === 'other' ? Math.max(1, Calc.num(it.qty) || 1) : undefined,
      gift: !!it.gift,
      fullPrice: it.gift || Calc.blank(it.fullPrice) ? undefined : Calc.num(it.fullPrice),
      price: it.gift ? 0 : Calc.num(it.price),
    })),
  };
}

function validateOp(op, role = 'owner', old) {
  if (!op || !Calc.OP_KINDS[op.kind]) throw new HttpError(400, 'Не указан вид операции');
  if (role === 'seller' && !SELLER_OP_KINDS.has(op.kind)) throw new HttpError(403, 'Эту операцию вносит руководитель');
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
    by: old ? old.by || role : role,
  };
}

/**
 * Применяет действие к дню. Возвращает новый день.
 * ctx: { role, settings, prev } — prev это остатки на конец прошлой смены (для открытия продавцом).
 */
function applyAction(day, action, now = new Date(), ctx = {}) {
  const role = ctx.role || 'owner';
  const t = now.toISOString();
  const type = action && action.type;
  if (!type) throw new HttpError(400, 'Не указано действие');
  if (role === 'seller' && !SELLER_ACTIONS.has(type)) throw new HttpError(403, 'Это действие доступно только руководителю');

  if (type === 'open') {
    if (day) throw new HttpError(409, 'Смена за эту дату уже открыта');
    let opening;
    let sellers;
    if (role === 'seller') {
      const o = action.opening || {};
      if (Calc.blank(o.cash)) throw new HttpError(400, 'Укажите наличные в кассе на начало смены');
      const prev = ctx.prev || {};
      opening = {
        time: String(o.time || ''),
        cash: Calc.num(o.cash),
        kaspi: Calc.num(prev.kaspi),
        transfer: Calc.num(prev.transfer),
        transferTracked: prev.transferTracked !== false,
        note: String(o.note || ''),
        confirmed: false, // Kaspi и переводы подтверждает руководитель
      };
      sellers = sellersFromDirectory(action.sellers, ctx.settings);
      if (!sellers.length) throw new HttpError(400, 'Выберите продавца смены');
    } else {
      opening = cleanOpening(action.opening || {});
      sellers = validateSellers(action.sellers || []);
    }
    return {
      date: action.date,
      status: 'open',
      createdAt: t,
      openedBy: role,
      opening,
      sellers,
      sales: [],
      ops: [],
      closing: {},
      discNotes: {},
      log: [{ t, a: 'open', by: role }],
    };
  }
  if (!day) throw new HttpError(404, 'Смена за эту дату ещё не открыта');
  day = clone(day);
  if (day.status === 'closed' && !(role === 'owner' && OWNER_ON_CLOSED.has(type))) {
    throw new HttpError(423, role === 'seller' ? 'Смена закрыта руководителем.' : 'Смена закрыта. Чтобы внести изменения, откройте её для исправления.');
  }
  if (role === 'seller' && day.closing && day.closing.submittedAt) {
    throw new HttpError(423, 'Смена уже сдана. Изменения вносит руководитель.');
  }
  const log = (a, d) => {
    day.log = (day.log || []).concat({ t, a, by: role, ...(d ? { d } : {}) }).slice(-300);
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
    case 'addSeller': {
      const [s] = sellersFromDirectory([{ name: action.name, start: action.start }], ctx.settings);
      if ((day.sellers || []).some((x) => Calc.norm(x.name) === Calc.norm(s.name))) throw new HttpError(409, `${s.name} уже в смене`);
      day.sellers = (day.sellers || []).concat(s);
      log('addSeller', { name: s.name });
      break;
    }
    case 'upsertSale': {
      const i = day.sales.findIndex((s) => action.sale && s.id === action.sale.id);
      const old = i >= 0 ? day.sales[i] : null;
      const sale = validateSale(action.sale, { role, settings: ctx.settings, old });
      if (i >= 0) {
        log('editSale', { before: old });
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
      if (Calc.blank(action.reason)) throw new HttpError(400, 'Укажите причину удаления');
      log('removeSale', { removed: day.sales[i], reason: String(action.reason) });
      day.sales.splice(i, 1);
      break;
    }
    case 'upsertOp': {
      const i = day.ops.findIndex((o) => action.op && o.id === action.op.id);
      const old = i >= 0 ? day.ops[i] : null;
      if (old && role === 'seller' && old.by !== 'seller') throw new HttpError(403, 'Эту операцию может изменить только руководитель');
      const op = validateOp(action.op, role, old);
      if (i >= 0) {
        log('editOp', { before: old });
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
      if (role === 'seller' && day.ops[i].by !== 'seller') throw new HttpError(403, 'Эту операцию может удалить только руководитель');
      if (Calc.blank(action.reason)) throw new HttpError(400, 'Укажите причину удаления');
      log('removeOp', { removed: day.ops[i], reason: String(action.reason) });
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
    case 'submit': {
      // Продавец сдаёт смену: свои суммы и пересчёт кассы, без расчётных остатков
      const c = action.closing || {};
      const next = { ...(day.closing || {}) };
      for (const f of SELLER_CLOSING) if (f in c) next[f] = Calc.blank(c[f]) ? '' : Calc.num(c[f]);
      next.sellerNote = String(c.note || '');
      const time = String(action.time || c.time || '');
      const missing = [];
      if (!next.photo) missing.push('Фото сверки с терминала');
      if (Calc.blank(next.kaspiTerminal)) missing.push('Сумма Kaspi Pay по терминалу');
      if (Calc.blank(next.transfersReported)) missing.push('Сумма переводов');
      if (Calc.blank(next.cashSalesReported)) missing.push('Сумма продаж наличными');
      if (Calc.blank(next.cashActual)) missing.push('Наличные по факту пересчёта');
      if (missing.length && !action.withGaps) throw new HttpError(422, `Для сдачи смены не хватает: ${missing.join(', ')}`);
      next.submittedAt = t;
      next.submittedTime = time;
      next.submitGaps = missing;
      if (!next.time) next.time = time;
      day.closing = next;
      day.sellers = (day.sellers || []).map((s) => ({ ...s, end: s.end || time }));
      log('submit', missing.length ? { gaps: missing } : undefined);
      break;
    }
    case 'unsubmit':
      if (!day.closing || !day.closing.submittedAt) throw new HttpError(409, 'Смена не сдана');
      day.closing = { ...day.closing, submittedAt: undefined, submittedTime: undefined, submitGaps: undefined };
      log('unsubmit', { reason: String(action.reason || '') });
      break;
    case 'fillPending': {
      let n = 0;
      for (const sale of day.sales) {
        sale.items = sale.items.map((it) => {
          if (!it.costPending) return it;
          const p = priceFromSettings(it, ctx.settings || Calc.withDefaults(null));
          if (p.costPending) return it;
          n += 1;
          const out = { ...p };
          delete out.costPending;
          return out;
        });
      }
      if (n) log('fillPending', { filled: n });
      break;
    }
    case 'reprice': {
      // Исправление ошибочной закупочной цены аромата с согласия руководителя
      const price = Calc.num(action.price);
      if (!(price > 0)) throw new HttpError(400, 'Укажите цену');
      let n = 0;
      for (const sale of day.sales) {
        for (const it of sale.items) {
          if (it.type === 'other' || Calc.norm(it.name) !== Calc.norm(action.name)) continue;
          if (Calc.num(it.oilPrice) === price && !it.costPending) continue;
          it.oilPrice = price;
          if (it.costPending && !Calc.costMissing(it).length) delete it.costPending;
          n += 1;
        }
      }
      if (n) log('reprice', { name: String(action.name), price, items: n });
      break;
    }
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

/** Что из дня видит продавец. Всё лишнее вырезается на сервере. */
function viewFor(day, role) {
  if (!day || role !== 'seller') return day;
  const cl = day.closing || {};
  return {
    date: day.date,
    status: day.status,
    opening: { time: day.opening.time, cash: day.opening.cash, note: day.opening.note },
    sellers: (day.sellers || []).map((s) => ({ id: s.id, name: s.name, start: s.start, end: s.end })),
    sales: (day.sales || []).map((s) => ({
      ...s,
      items: s.items.map((it) => {
        const o = { ...it };
        for (const f of COST_FIELDS) delete o[f];
        return o;
      }),
    })),
    ops: (day.ops || []).filter((o) => o.by === 'seller'),
    closing: {
      photo: cl.photo,
      kaspiTerminal: cl.kaspiTerminal,
      transfersReported: cl.transfersReported,
      cashSalesReported: cl.cashSalesReported,
      cashActual: cl.cashActual,
      sellerNote: cl.sellerNote,
      submittedAt: cl.submittedAt,
      submittedTime: cl.submittedTime,
    },
  };
}

/** Применяет действие с повтором при одновременной записи. */
async function mutateDay(store, date, action, ctx = {}) {
  if (!DATE_RE.test(date)) throw new HttpError(400, 'Неверная дата');
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await store.get(K.day(date));
    const next = applyAction(cur ? cur.value : null, { ...action, date }, new Date(), ctx);
    const rev = cur ? cur.rev : 0;
    if (await store.cas(K.day(date), rev, next)) {
      await store.hset(K.index, date, Calc.daySummary(next));
      // Расход материалов дня для склада: всегда в соответствии с продажами
      await store.hset(K.cons, date, Calc.dayConsumption(next));
      return { rev: rev + 1, value: next };
    }
  }
  throw new HttpError(409, 'Данные одновременно меняли с другого устройства. Повторите.');
}

module.exports = { applyAction, mutateDay, viewFor, priceFromSettings, HttpError, K, DATE_RE, validateSale, validateOp };
