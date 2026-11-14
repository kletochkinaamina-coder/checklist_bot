/*
 * Al Musk: все расчёты учёта в одном месте.
 * Работает и в браузере (window.Calc), и в Node (require).
 *
 * Правила взяты из PROMPT.md:
 *  - себестоимость считается по факту продажи и фиксируется в позиции (снимок цен);
 *  - подарки входят в себестоимость, выручки не дают;
 *  - Kaspi Pay, переводы и наличные учитываются раздельно;
 *  - личные операции уменьшают остаток денег, но не влияют на результат магазина;
 *  - закупка товара это движение денег, а не себестоимость.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const r2 = (n) => Math.round((Number(n) || 0) * 100 + Number.EPSILON * 100) / 100;
  const blank = (v) => v === undefined || v === null || String(v).trim() === '';
  const num = (v) => {
    if (blank(v)) return 0;
    const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };
  const numOrNull = (v) => (blank(v) ? null : num(v));
  const fmt = (n) => r2(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/\u00a0|\u202f/g, ' ');

  const ACCOUNTS = ['cash', 'kaspi', 'transfer'];
  const PAY = ['kaspi', 'transfer', 'cash'];
  const PAY_LABEL = { kaspi: 'Kaspi Pay', transfer: 'Перевод', cash: 'Наличные' };
  const ACC_LABEL = { cash: 'Наличная касса', kaspi: 'Kaspi Pay', transfer: 'Счёт переводов' };
  const TYPE_LABEL = { perfume: 'Духи', oil: 'Масло', other: 'Товар' };
  const NO_SELLER = 'Продавец не указан';

  const OP_KINDS = {
    business: {
      label: 'Расход бизнеса',
      cats: ['Аренда', 'Налоги', 'Реклама', 'Связь и интернет', 'Хозяйственные нужды', 'Прочие расходы магазина'],
    },
    purchase: {
      label: 'Закупка товара',
      cats: ['Масла', 'Флаконы', 'Основа и фиксатор', 'Доставка товара', 'Другой товар'],
    },
    personal: {
      label: 'Личное владельца',
      cats: ['Снятие на личные нужды', 'Еда', 'Покупки', 'Маникюр и личные услуги', 'Аптека', 'Погашение личного кредита', 'Другое личное'],
    },
    transfer: {
      label: 'Перемещение между счетами',
      cats: ['Снятие с Kaspi в кассу', 'Внесение наличных на Kaspi', 'Перевод между счетами'],
    },
    income: {
      label: 'Поступление денег',
      cats: ['Внесение владельцем', 'Возврат от поставщика', 'Другое поступление'],
    },
    refund: {
      label: 'Возврат покупателю',
      cats: ['Возврат покупателю'],
    },
  };

  const DEFAULT_SETTINGS = {
    basePrice: 2.5,
    concentration: { 5: 40, 8: 40, 10: 40, 15: 40, 20: 40, 30: 40, 50: 35, 100: 35 },
    perfumeBottles: { 5: 50, 10: 160, 15: 160, 20: 250, 30: 300, 50: 350, 100: 650 },
    oilBottles: { 3: 100, 4.5: 100, 6: 120, 8: 130, 12: 120 },
    oils: [], // { id, name, price, updated, history: [{ date, price }] }
    goods: [], // { id, name, cost, updated, history: [{ date, cost }] }
    sellers: [], // { name, salary }
    changeLog: [], // изменения основы, флаконов, концентраций
  };

  function withDefaults(s) {
    const d = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (!s || typeof s !== 'object') return d;
    return Object.assign(d, s);
  }

  const norm = (s) => String(s || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  const findOil = (settings, name) => (settings.oils || []).find((o) => norm(o.name) === norm(name)) || null;
  const findGood = (settings, name) => (settings.goods || []).find((g) => norm(g.name) === norm(name)) || null;
  const tableValue = (table, vol) => {
    if (!table || blank(vol)) return null;
    const v = table[String(num(vol))];
    return v === undefined ? null : v;
  };

  /* ---------- Позиция ---------- */

  function itemCalc(it) {
    const vol = num(it.volume);
    const qty = it.type === 'other' ? Math.max(1, num(it.qty) || 1) : 1;
    let oilMl = 0;
    let baseMl = 0;
    let cost = 0;
    if (it.type === 'perfume') {
      const c = num(it.conc) / 100;
      oilMl = vol * c;
      baseMl = vol - oilMl;
      cost = oilMl * num(it.oilPrice) + baseMl * num(it.basePrice) + num(it.bottleCost);
    } else if (it.type === 'oil') {
      oilMl = vol;
      cost = vol * num(it.oilPrice) + num(it.bottleCost);
    } else {
      cost = num(it.unitCost) * qty;
    }
    const price = it.gift ? 0 : num(it.price);
    const full = it.gift ? 0 : blank(it.fullPrice) ? price : num(it.fullPrice);
    const discount = full > price ? full - price : 0;
    return {
      oilMl: r2(oilMl),
      baseMl: r2(baseMl),
      cost: r2(cost),
      price: r2(price),
      fullPrice: r2(full),
      discount: r2(discount),
      profit: r2(price - cost),
      qty,
    };
  }

  /** Не заполненные данные себестоимости (их знает только руководитель). */
  function costMissing(it) {
    const m = [];
    if (it.type === 'perfume' || it.type === 'oil') {
      if (!(num(it.oilPrice) > 0)) m.push('закупочная цена масла за 1 мл');
      if (blank(it.bottleCost)) m.push('стоимость флакона');
    }
    if (it.type === 'perfume' && blank(it.basePrice)) m.push('цена основы');
    if (it.type === 'other' && blank(it.unitCost)) m.push('закупочная стоимость товара');
    return m;
  }

  /** Что не заполнено в позиции. Пустой массив = можно сохранять.
   *  Позиция с costPending (продал продавец, цены нет в справочнике) сохраняется без себестоимости. */
  function itemMissing(it) {
    const m = [];
    if (!['perfume', 'oil', 'other'].includes(it.type)) m.push('вид продукта');
    if (blank(it.name)) m.push(it.type === 'other' ? 'название товара' : 'аромат');
    if ((it.type === 'perfume' || it.type === 'oil') && !(num(it.volume) > 0)) m.push('объём');
    if (it.type === 'perfume') {
      const c = num(it.conc);
      if (!(c > 0 && c <= 100)) m.push('концентрация масла');
    }
    if (!it.costPending) m.push(...costMissing(it));
    if (!it.gift && !(num(it.price) > 0)) m.push('фактическая цена продажи');
    if (!it.gift && !blank(it.fullPrice) && num(it.fullPrice) < num(it.price)) m.push('цена до скидки меньше цены продажи');
    return m;
  }

  function itemTitle(it) {
    if (it.type === 'other') {
      const c = itemCalc(it);
      return `${it.name}${c.qty > 1 ? ` × ${c.qty}` : ''}`;
    }
    const vol = `${fmt(num(it.volume))} мл`;
    if (it.type === 'oil') return `${it.name} · масло ${vol}`;
    return `${it.name} · духи ${vol} · ${num(it.conc)}%`;
  }

  /* ---------- Продажа (чек) ---------- */

  function saleCalc(sale) {
    const items = (sale.items || []).map((it) => ({ it, c: itemCalc(it) }));
    const out = {
      items,
      revenue: 0,
      cost: 0,
      giftCost: 0,
      gifts: 0,
      discount: 0,
      discounts: 0,
      positions: 0,
      pay: { kaspi: 0, transfer: 0, cash: 0 },
      pendingCost: 0,
    };
    for (const { it, c } of items) {
      if (it.costPending) out.pendingCost += 1;
      out.revenue += c.price;
      out.cost += c.cost;
      if (it.gift) {
        out.gifts += c.qty;
        out.giftCost += c.cost;
      } else {
        out.positions += c.qty;
      }
      if (c.discount > 0) {
        out.discount += c.discount;
        out.discounts += 1;
      }
    }
    for (const p of PAY) out.pay[p] = r2(num(sale.pay && sale.pay[p]));
    out.revenue = r2(out.revenue);
    out.cost = r2(out.cost);
    out.giftCost = r2(out.giftCost);
    out.discount = r2(out.discount);
    out.profit = r2(out.revenue - out.cost);
    out.paySum = r2(out.pay.kaspi + out.pay.transfer + out.pay.cash);
    out.payOk = Math.abs(out.paySum - out.revenue) < 0.005;
    const used = PAY.filter((p) => out.pay[p] > 0);
    out.method = used.length === 1 ? PAY_LABEL[used[0]] : used.length > 1 ? 'Смешанная оплата' : 'Без оплаты';
    return out;
  }

  /* ---------- День ---------- */

  function emptyAcc() {
    return { cash: 0, kaspi: 0, transfer: 0 };
  }

  function sellerStat(name) {
    return {
      name,
      receipts: 0,
      positions: 0,
      revenue: 0,
      pay: { kaspi: 0, transfer: 0, cash: 0 },
      cost: 0,
      gross: 0,
      gifts: 0,
      salary: 0,
      salaryPaid: 0,
      shifts: [],
      avgCheck: 0,
    };
  }

  function dayTotals(day) {
    const t = {
      date: day.date,
      status: day.status,
      revenue: 0,
      pay: { kaspi: 0, transfer: 0, cash: 0 },
      receipts: 0,
      positions: 0,
      cogs: 0,
      giftCost: 0,
      gifts: 0,
      discount: 0,
      discounts: 0,
      lines: [], // все позиции дня с расчётом
      sellers: {},
      unknownSellerSales: 0,
      payMismatch: 0,
      pendingCost: 0,
    };
    const sellers = day.sellers || [];
    for (const s of sellers) {
      const st = (t.sellers[s.name] = t.sellers[s.name] || sellerStat(s.name));
      st.salary += num(s.salary);
      st.salaryPaid += s.paid ? num(s.paidAmount === undefined ? s.salary : s.paidAmount) : 0;
      st.shifts.push({ start: s.start || '', end: s.end || '' });
    }

    for (const sale of day.sales || []) {
      const c = saleCalc(sale);
      const name = blank(sale.seller) ? NO_SELLER : sale.seller;
      if (name === NO_SELLER) t.unknownSellerSales += 1;
      if (!c.payOk) t.payMismatch += 1;
      t.pendingCost += c.pendingCost;
      const st = (t.sellers[name] = t.sellers[name] || sellerStat(name));
      t.revenue += c.revenue;
      t.receipts += 1;
      t.positions += c.positions;
      t.cogs += c.cost;
      t.giftCost += c.giftCost;
      t.gifts += c.gifts;
      t.discount += c.discount;
      t.discounts += c.discounts;
      for (const p of PAY) {
        t.pay[p] += c.pay[p];
        st.pay[p] += c.pay[p];
      }
      st.receipts += 1;
      st.positions += c.positions;
      st.revenue += c.revenue;
      st.cost += c.cost;
      st.gifts += c.gifts;
      for (const { it, c: ic } of c.items) {
        t.lines.push({ saleId: sale.id, time: sale.time, seller: name, method: c.method, promo: sale.promo || '', it, c: ic });
      }
    }

    for (const st of Object.values(t.sellers)) {
      st.revenue = r2(st.revenue);
      st.cost = r2(st.cost);
      st.gross = r2(st.revenue - st.cost);
      st.avgCheck = st.receipts ? r2(st.revenue / st.receipts) : 0;
      for (const p of PAY) st.pay[p] = r2(st.pay[p]);
    }

    // Зарплата
    t.salaries = r2(sellers.reduce((a, s) => a + num(s.salary), 0));
    t.salaryPaid = emptyAcc();
    t.salaryUnpaid = 0;
    for (const s of sellers) {
      if (s.paid) {
        const acc = ACCOUNTS.includes(s.paidFrom) ? s.paidFrom : 'cash';
        t.salaryPaid[acc] += num(s.paidAmount === undefined ? s.salary : s.paidAmount);
      } else {
        t.salaryUnpaid += num(s.salary);
      }
    }

    // Операции
    const kinds = Object.keys(OP_KINDS);
    t.ops = {};
    for (const k of kinds) t.ops[k] = { total: 0, acc: emptyAcc(), cats: {} };
    t.tin = emptyAcc();
    t.tout = emptyAcc();
    t.unclearOps = 0;
    for (const op of day.ops || []) {
      const amt = num(op.amount);
      const k = OP_KINDS[op.kind] ? op.kind : 'business';
      if (op.unclear) t.unclearOps += 1;
      if (k === 'transfer') {
        if (ACCOUNTS.includes(op.account)) t.tout[op.account] += amt;
        if (ACCOUNTS.includes(op.to)) t.tin[op.to] += amt;
        t.ops.transfer.total += amt;
        continue;
      }
      const acc = ACCOUNTS.includes(op.account) ? op.account : 'cash';
      t.ops[k].total += amt;
      t.ops[k].acc[acc] += amt;
      const cat = op.category || 'Без категории';
      t.ops[k].cats[cat] = (t.ops[k].cats[cat] || 0) + amt;
    }

    const cl = day.closing || {};
    t.commission = numOrNull(cl.commission);
    t.revenue = r2(t.revenue);
    t.cogs = r2(t.cogs);
    t.giftCost = r2(t.giftCost);
    t.discount = r2(t.discount);
    for (const p of PAY) t.pay[p] = r2(t.pay[p]);
    t.gross = r2(t.revenue - t.cogs);
    t.business = r2(t.ops.business.total);
    t.refunds = r2(t.ops.refund.total);
    t.purchases = r2(t.ops.purchase.total);
    t.personal = r2(t.ops.personal.total);
    t.result = r2(t.gross - t.salaries - (t.commission || 0) - t.business - t.refunds);
    t.avgCheck = t.receipts ? r2(t.revenue / t.receipts) : 0;

    // Личные операции для отчёта
    const pc = t.ops.personal.cats;
    t.personalKaspiWithdraw = 0;
    for (const op of day.ops || []) {
      if (op.kind === 'personal' && op.account === 'kaspi' && op.category === 'Снятие на личные нужды') t.personalKaspiWithdraw += num(op.amount);
    }
    t.personalKaspiWithdraw = r2(t.personalKaspiWithdraw);
    t.personalLoans = r2(pc['Погашение личного кредита'] || 0);
    t.personalOther = r2(t.personal - t.personalKaspiWithdraw - t.personalLoans);

    // Остатки
    const op0 = day.opening || {};
    t.transferTracked = op0.transferTracked !== false;
    t.balances = {};
    for (const acc of ACCOUNTS) {
      const open = num(op0[acc]);
      const sales = t.pay[acc];
      const income = t.ops.income.acc[acc] + t.tin[acc];
      const out =
        t.ops.business.acc[acc] +
        t.ops.purchase.acc[acc] +
        t.ops.personal.acc[acc] +
        t.ops.refund.acc[acc] +
        t.tout[acc] +
        t.salaryPaid[acc] +
        (acc === 'kaspi' ? t.commission || 0 : 0);
      const calc = r2(open + sales + income - out);
      const fact = numOrNull(cl[`${acc}Actual`]);
      t.balances[acc] = {
        open: r2(open),
        sales: r2(sales),
        income: r2(income),
        out: r2(out),
        calc,
        fact,
        diff: fact === null ? null : r2(fact - calc),
        tracked: acc !== 'transfer' || t.transferTracked,
      };
    }

    // Сверка с данными закрытия
    const rep = (field, actual) => {
      const v = numOrNull(cl[field]);
      return v === null ? null : { reported: v, entered: actual, diff: r2(v - actual) };
    };
    t.check = {
      terminal: rep('kaspiTerminal', t.pay.kaspi),
      transfers: rep('transfersReported', t.pay.transfer),
      cashSales: rep('cashSalesReported', t.pay.cash),
    };

    t.control = {
      photo: !!cl.photo,
      cashOk: t.balances.cash.diff === null ? null : t.balances.cash.diff === 0,
      kaspiOk: t.balances.kaspi.diff === null ? null : t.balances.kaspi.diff === 0,
      transferOk: !t.transferTracked ? null : t.balances.transfer.diff === null ? null : t.balances.transfer.diff === 0,
      unclearOps: t.unclearOps,
      unknownSellerSales: t.unknownSellerSales,
      payMismatch: t.payMismatch,
      commissionEntered: t.commission !== null,
      closedWithGaps: !!cl.closedWithGaps,
      pendingCost: t.pendingCost,
      openingConfirmed: op0.confirmed !== false,
      submittedAt: cl.submittedAt || null,
    };
    // Удаления продаж продавцом: руководитель видит их в контроле
    t.sellerDeletions = { count: 0, sum: 0 };
    for (const l of day.log || []) {
      if (l.a === 'removeSale' && l.by === 'seller' && l.d && l.d.removed) {
        t.sellerDeletions.count += 1;
        t.sellerDeletions.sum = r2(t.sellerDeletions.sum + saleCalc(l.d.removed).revenue);
      }
    }
    t.missing = closingMissing(day);
    return t;
  }

  /** Поля закрытия, без которых смена не считается закрытой. */
  function closingMissing(day) {
    const cl = day.closing || {};
    const m = [];
    if (!cl.photo) m.push('Фото сверки с терминала');
    if (blank(cl.kaspiTerminal)) m.push('Сумма продаж Kaspi Pay по терминалу');
    if (blank(cl.transfersReported)) m.push('Сумма переводов');
    if (blank(cl.cashSalesReported)) m.push('Сумма продаж наличными');
    if (blank(cl.cashActual)) m.push('Наличные по факту пересчёта');
    if (blank(cl.commission)) m.push('Комиссия терминала');
    if (blank(cl.kaspiActual)) m.push('Остаток Kaspi Pay по факту');
    if ((day.opening || {}).transferTracked !== false && blank(cl.transferActual)) m.push('Остаток счёта переводов по факту');
    if (!(day.sellers || []).length) m.push('Продавец смены');
    return m;
  }

  /** Расхождения дня: только факт против расчёта, ничего не исправляем. */
  function dayDiscrepancies(day, t) {
    t = t || dayTotals(day);
    const notes = day.discNotes || {};
    const out = [];
    for (const acc of ACCOUNTS) {
      const b = t.balances[acc];
      if (!b.tracked || b.diff === null || b.diff === 0) continue;
      out.push({ key: acc, label: ACC_LABEL[acc], calc: b.calc, fact: b.fact, diff: b.diff, ...(notes[acc] || {}) });
    }
    const chk = [
      ['terminal', 'Kaspi Pay: терминал против внесённых продаж'],
      ['transfers', 'Переводы: сообщено против внесённых продаж'],
      ['cashSales', 'Наличные продажи: сообщено против внесённых'],
    ];
    for (const [k, label] of chk) {
      const c = t.check[k];
      if (!c || c.diff === 0) continue;
      out.push({ key: k, label, calc: c.entered, fact: c.reported, diff: c.diff, ...(notes[k] || {}) });
    }
    return out;
  }

  /** Короткая сводка дня для индекса (список дней, расхождения). */
  function daySummary(day) {
    const t = dayTotals(day);
    const disc = dayDiscrepancies(day, t);
    return {
      date: day.date,
      status: day.status,
      revenue: t.revenue,
      gross: t.gross,
      result: t.result,
      receipts: t.receipts,
      sellers: (day.sellers || []).map((s) => s.name),
      closing: ACCOUNTS.reduce((a, acc) => {
        const b = t.balances[acc];
        a[acc] = { calc: b.calc, fact: b.fact, tracked: b.tracked };
        return a;
      }, {}),
      disc: disc.map((d) => ({ key: d.key, label: d.label, diff: d.diff, calc: d.calc, fact: d.fact, resolved: !!d.resolved, comment: d.comment || '' })),
      missing: day.status === 'closed' ? [] : t.missing,
      closedWithGaps: !!(day.closing || {}).closedWithGaps,
      pendingCost: t.pendingCost,
      openingUnconfirmed: !t.control.openingConfirmed,
      submittedAt: t.control.submittedAt,
      sellerDeletions: t.sellerDeletions,
      salaryUnpaid: t.salaryUnpaid,
      unclearOps: t.unclearOps,
      commissionMissing: t.commission === null && t.pay.kaspi > 0,
      payMismatch: t.payMismatch,
      unknownSellerSales: t.unknownSellerSales,
    };
  }

  /* ---------- Период ---------- */

  function rangeTotals(days) {
    days = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
    const R = {
      from: days.length ? days[0].date : null,
      to: days.length ? days[days.length - 1].date : null,
      days: days.length,
      closed: 0,
      revenue: 0,
      pay: { kaspi: 0, transfer: 0, cash: 0 },
      receipts: 0,
      positions: 0,
      cogs: 0,
      giftCost: 0,
      gifts: 0,
      discount: 0,
      discounts: 0,
      pendingCost: 0,
      salaries: 0,
      salaryUnpaid: 0,
      commission: 0,
      commissionMissingDays: 0,
      business: 0,
      businessCats: {},
      refunds: 0,
      purchases: 0,
      purchaseCats: {},
      personal: 0,
      personalCats: {},
      sellers: {},
      aromas: {},
      disc: [],
      perDay: [],
    };
    for (const day of days) {
      const t = dayTotals(day);
      if (day.status === 'closed') R.closed += 1;
      for (const k of ['revenue', 'receipts', 'positions', 'cogs', 'giftCost', 'gifts', 'discount', 'discounts', 'pendingCost', 'salaries', 'salaryUnpaid', 'business', 'refunds', 'purchases', 'personal']) {
        R[k] += t[k];
      }
      for (const p of PAY) R.pay[p] += t.pay[p];
      if (t.commission === null) {
        if (t.pay.kaspi > 0) R.commissionMissingDays += 1;
      } else R.commission += t.commission;
      const addCats = (dst, src) => {
        for (const [c, v] of Object.entries(src)) dst[c] = (dst[c] || 0) + v;
      };
      addCats(R.businessCats, t.ops.business.cats);
      addCats(R.purchaseCats, t.ops.purchase.cats);
      addCats(R.personalCats, t.ops.personal.cats);
      for (const st of Object.values(t.sellers)) {
        const d = (R.sellers[st.name] = R.sellers[st.name] || { ...sellerStat(st.name), days: 0 });
        d.days += st.receipts || st.salary ? 1 : 0;
        for (const k of ['receipts', 'positions', 'revenue', 'cost', 'gifts', 'salary', 'salaryPaid']) d[k] += st[k];
        for (const p of PAY) d.pay[p] += st.pay[p];
      }
      for (const ln of t.lines) {
        if (ln.it.type === 'other') continue;
        const key = norm(ln.it.name);
        const a = (R.aromas[key] = R.aromas[key] || { name: ln.it.name, sold: 0, gifts: 0, revenue: 0, cost: 0, ml: 0 });
        if (ln.it.gift) a.gifts += 1;
        else a.sold += 1;
        a.revenue += ln.c.price;
        a.cost += ln.c.cost;
        a.ml += ln.c.oilMl;
      }
      for (const d of dayDiscrepancies(day, t)) R.disc.push({ date: day.date, ...d });
      R.perDay.push({ date: day.date, status: day.status, revenue: t.revenue, gross: t.gross, result: t.result, receipts: t.receipts });
      R.lastBalances = t.balances;
      R.lastDate = day.date;
      if (!R.firstBalances) R.firstBalances = t.balances;
    }
    for (const k of ['revenue', 'cogs', 'giftCost', 'discount', 'salaries', 'salaryUnpaid', 'commission', 'business', 'refunds', 'purchases', 'personal']) R[k] = r2(R[k]);
    for (const p of PAY) R.pay[p] = r2(R.pay[p]);
    R.gross = r2(R.revenue - R.cogs);
    R.result = r2(R.gross - R.salaries - R.commission - R.business - R.refunds);
    R.avgCheck = R.receipts ? r2(R.revenue / R.receipts) : 0;
    R.sellerRank = Object.values(R.sellers)
      .map((s) => ({ ...s, revenue: r2(s.revenue), cost: r2(s.cost), gross: r2(s.revenue - s.cost), avgCheck: s.receipts ? r2(s.revenue / s.receipts) : 0 }))
      .sort((a, b) => b.revenue - a.revenue);
    R.topAromas = Object.values(R.aromas)
      .map((a) => ({ ...a, revenue: r2(a.revenue), cost: r2(a.cost), ml: r2(a.ml) }))
      .sort((a, b) => b.sold - a.sold || b.revenue - a.revenue);
    return R;
  }

  /* ---------- Форматирование ---------- */

  function money(n) {
    if (n === null || n === undefined) return '—';
    const v = r2(n);
    const s = Math.abs(v).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).replace(/ | /g, ' ');
    return `${v < 0 ? '−' : ''}${s} ₸`;
  }
  const signed = (n) => (n === null || n === undefined ? '—' : n > 0 ? `+${money(n)}` : money(n));
  const dmy = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

  /* ---------- Тексты отчётов ---------- */

  function dailyReportText(day) {
    const t = dayTotals(day);
    const L = [];
    const cl = day.closing || {};
    L.push(`AL MUSK — ОТЧЁТ ЗА ${dmy(day.date)}`);
    L.push(day.status === 'closed' ? `Смена закрыта${cl.time ? ` в ${cl.time}` : ''}${cl.closedWithGaps ? ' (с незаполненными полями)' : ''}` : 'Смена открыта, отчёт предварительный');
    L.push('');
    L.push('1. Продажи');
    L.push(`• Количество позиций: ${t.positions} (чеков: ${t.receipts}${t.gifts ? `, подарков: ${t.gifts}` : ''})`);
    L.push(`• Общая выручка: ${money(t.revenue)}`);
    L.push(`• Kaspi Pay: ${money(t.pay.kaspi)}`);
    L.push(`• Переводы: ${money(t.pay.transfer)}`);
    L.push(`• Наличные: ${money(t.pay.cash)}`);
    if (t.discounts) L.push(`• Скидки: ${t.discounts} шт. на ${money(t.discount)}`);
    L.push('');
    L.push('2. Себестоимость');
    for (const ln of t.lines) {
      L.push(`• ${itemTitle(ln.it)}${ln.it.gift ? ' (подарок)' : ''}: ${ln.it.costPending ? 'не определена, нет закупочной цены' : money(ln.c.cost)}`);
    }
    if (!t.lines.length) L.push('• Продаж нет');
    L.push(`• Себестоимость подарков: ${money(t.giftCost)}`);
    L.push(`• Общая себестоимость: ${money(t.cogs)}${t.pendingCost ? ` (без ${t.pendingCost} поз. без цены)` : ''}`);
    L.push('');
    L.push('3. Прибыль');
    L.push(`• Выручка: ${money(t.revenue)}`);
    L.push(`• Себестоимость: ${money(t.cogs)}`);
    L.push(`• Валовая прибыль: ${money(t.gross)}`);
    L.push(`• Зарплата: ${money(t.salaries)}`);
    L.push(`• Комиссия Kaspi Pay: ${t.commission === null ? 'не указана' : money(t.commission)}`);
    if (t.refunds) L.push(`• Возвраты покупателям: ${money(t.refunds)}`);
    L.push(`• Другие расходы бизнеса: ${money(t.business)}`);
    for (const [c, v] of Object.entries(t.ops.business.cats)) L.push(`   ${c}: ${money(v)}`);
    L.push(`• Результат после расходов: ${money(t.result)}`);
    L.push('');
    L.push('4. Денежные остатки');
    for (const acc of ACCOUNTS) {
      const b = t.balances[acc];
      if (!b.tracked) {
        L.push(`• ${ACC_LABEL[acc]}: отдельно не учитывается`);
        continue;
      }
      L.push(`• ${ACC_LABEL[acc]}: расчёт ${money(b.calc)}, факт ${b.fact === null ? 'не указан' : money(b.fact)}${b.diff ? `, разница ${signed(b.diff)}` : b.diff === 0 ? ', сходится' : ''}`);
    }
    const disc = dayDiscrepancies(day, t);
    L.push(`• Расхождения: ${disc.length ? disc.map((d) => `${d.label} ${signed(d.diff)}`).join('; ') : 'нет'}`);
    if (t.purchases) L.push(`• Закупки товара (в себестоимость не входят): ${money(t.purchases)}`);
    L.push('');
    L.push('5. Личные операции');
    L.push(`• Снятия с Kaspi: ${money(t.personalKaspiWithdraw)}`);
    L.push(`• Личные расходы: ${money(t.personalOther)}`);
    L.push(`• Погашение личных кредитов: ${money(t.personalLoans)}`);
    L.push('');
    L.push('6. Продавцы');
    const sellers = Object.values(t.sellers);
    if (!sellers.length) L.push('• Не указаны');
    for (const st of sellers) {
      const s = (day.sellers || []).find((x) => x.name === st.name);
      const pay = s ? (s.paid ? `выплачена (${PAY_LABEL[s.paidFrom] || ACC_LABEL[s.paidFrom] || 'наличные'})` : 'начислена, не выплачена') : '';
      const time = st.shifts.length ? `, ${st.shifts.map((x) => `${x.start || '?'}–${x.end || '...'}`).join(', ')}` : '';
      L.push(`• ${st.name}: выручка ${money(st.revenue)}, продаж ${st.receipts}, средний чек ${money(st.avgCheck)}, зарплата ${money(st.salary)}${pay ? ` ${pay}` : ''}${time}`);
    }
    L.push('');
    L.push('7. Контроль');
    const yn = (v, ok = 'да', no = 'нет') => (v === null ? 'нет данных' : v ? ok : no);
    L.push(`• Фото терминала: ${t.control.photo ? 'приложено' : 'нет'}`);
    L.push(`• Касса сходится: ${yn(t.control.cashOk)}`);
    L.push(`• Kaspi Pay сходится: ${yn(t.control.kaspiOk)}`);
    if (t.transferTracked) L.push(`• Переводы сходятся: ${yn(t.control.transferOk)}`);
    L.push(`• Терминал против внесённых продаж: ${t.check.terminal ? (t.check.terminal.diff === 0 ? 'сходится' : signed(t.check.terminal.diff)) : 'нет данных'}`);
    L.push(`• Все продажи внесены: ${t.check.terminal && t.check.terminal.diff === 0 && (!t.check.cashSales || t.check.cashSales.diff === 0) && (!t.check.transfers || t.check.transfers.diff === 0) ? 'да' : 'требует проверки'}`);
    L.push(`• Неподтверждённые операции: ${t.unclearOps}`);
    if (t.unknownSellerSales) L.push(`• Продажи без продавца: ${t.unknownSellerSales}`);
    if (t.pendingCost) L.push(`• Позиции без себестоимости: ${t.pendingCost}, прибыль завышена`);
    if (!t.control.openingConfirmed) L.push('• Начальные остатки Kaspi и переводов не подтверждены руководителем');
    if (t.sellerDeletions.count) L.push(`• Продавец удалил продаж: ${t.sellerDeletions.count} на ${money(t.sellerDeletions.sum)}`);
    if (t.payMismatch) L.push(`• Чеки, где оплата не равна сумме: ${t.payMismatch}`);
    if (t.salaryUnpaid) L.push(`• Зарплата не выплачена: ${money(t.salaryUnpaid)}`);
    if (day.status !== 'closed' && t.missing.length) L.push(`• Не хватает для закрытия: ${t.missing.join(', ')}`);
    return L.join('\n');
  }

  function rangeReportText(R, title) {
    const L = [];
    L.push(`AL MUSK — ${title || 'ОТЧЁТ ЗА ПЕРИОД'} ${dmy(R.from)} – ${dmy(R.to)}`);
    L.push(`Дней со сменами: ${R.days}, закрыто: ${R.closed}`);
    L.push('');
    L.push('Финансовый результат');
    L.push(`• Выручка: ${money(R.revenue)} (Kaspi Pay ${money(R.pay.kaspi)}, переводы ${money(R.pay.transfer)}, наличные ${money(R.pay.cash)})`);
    L.push(`• Себестоимость проданных товаров: ${money(R.cogs)} (в т.ч. подарки ${money(R.giftCost)})${R.pendingCost ? `. Без себестоимости: ${R.pendingCost} поз.` : ''}`);
    L.push(`• Валовая прибыль: ${money(R.gross)}`);
    L.push(`• Зарплаты: ${money(R.salaries)}${R.salaryUnpaid ? ` (не выплачено ${money(R.salaryUnpaid)})` : ''}`);
    L.push(`• Комиссии Kaspi: ${money(R.commission)}${R.commissionMissingDays ? ` (не указана за ${R.commissionMissingDays} дн.)` : ''}`);
    L.push(`• Аренда и прочие расходы: ${money(R.business)}`);
    for (const [c, v] of Object.entries(R.businessCats)) L.push(`   ${c}: ${money(v)}`);
    if (R.refunds) L.push(`• Возвраты покупателям: ${money(R.refunds)}`);
    L.push(`• Чистый операционный результат: ${money(R.result)}`);
    L.push('');
    L.push('Деньги (не прибыль)');
    L.push(`• Закупки товара: ${money(R.purchases)}`);
    for (const [c, v] of Object.entries(R.purchaseCats)) L.push(`   ${c}: ${money(v)}`);
    L.push(`• Личные снятия и расходы владельца: ${money(R.personal)}`);
    for (const [c, v] of Object.entries(R.personalCats)) L.push(`   ${c}: ${money(v)}`);
    if (R.lastBalances) {
      L.push(`• Остатки на ${dmy(R.lastDate)}:`);
      for (const acc of ACCOUNTS) {
        const b = R.lastBalances[acc];
        if (!b.tracked) continue;
        L.push(`   ${ACC_LABEL[acc]}: расчёт ${money(b.calc)}, факт ${b.fact === null ? 'не указан' : money(b.fact)}`);
      }
    }
    L.push('');
    L.push('Продажи');
    L.push(`• Чеков: ${R.receipts}, позиций: ${R.positions}, средний чек ${money(R.avgCheck)}`);
    L.push(`• Подарков: ${R.gifts}, скидок: ${R.discounts} на ${money(R.discount)}`);
    L.push('');
    L.push('Рейтинг продавцов');
    R.sellerRank.forEach((s, i) => L.push(`${i + 1}. ${s.name}: ${money(s.revenue)}, продаж ${s.receipts}, средний чек ${money(s.avgCheck)}, валовая прибыль ${money(s.gross)}, зарплата ${money(s.salary)}`));
    L.push('');
    L.push('Самые продаваемые ароматы');
    R.topAromas.slice(0, 10).forEach((a, i) => L.push(`${i + 1}. ${a.name}: ${a.sold} шт.${a.gifts ? ` + ${a.gifts} в подарок` : ''}, ${money(a.revenue)}`));
    L.push('');
    L.push('Расхождения');
    if (!R.disc.length) L.push('• Нет');
    for (const d of R.disc) L.push(`• ${dmy(d.date)} ${d.label}: ${signed(d.diff)}${d.resolved ? ' (выяснено)' : ' (не выяснено)'}${d.comment ? `, ${d.comment}` : ''}`);
    return L.join('\n');
  }

  /** Разбор списка ароматов из текста: «Название — 45», «Название;45», «Название 45 тг». */
  function parsePriceList(text) {
    const rows = [];
    const bad = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^(.*?)[\s;:\t—–=|-]*([0-9]+(?:[.,][0-9]+)?)\s*(?:₸|тг|тенге|kzt)?\.?\s*(?:за\s*1?\s*мл|\/\s*мл)?\s*$/i);
      if (!m || !m[1].trim()) {
        bad.push(line);
        continue;
      }
      rows.push({ name: m[1].trim().replace(/[\s;:\t—–=|-]+$/, ''), price: num(m[2]) });
    }
    return { rows, bad };
  }

  return {
    r2,
    num,
    fmt,
    blank,
    norm,
    ACCOUNTS,
    PAY,
    PAY_LABEL,
    ACC_LABEL,
    TYPE_LABEL,
    OP_KINDS,
    NO_SELLER,
    DEFAULT_SETTINGS,
    withDefaults,
    findOil,
    findGood,
    tableValue,
    itemCalc,
    itemMissing,
    costMissing,
    itemTitle,
    saleCalc,
    dayTotals,
    closingMissing,
    dayDiscrepancies,
    daySummary,
    rangeTotals,
    money,
    signed,
    dmy,
    dailyReportText,
    rangeReportText,
    parsePriceList,
  };
});
