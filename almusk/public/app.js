/* Al Musk: интерфейс учёта. Все расчёты в calc.js, все записи проверяет сервер. */
(function () {
  'use strict';
  const C = window.Calc;
  const M = C.money;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pad = (n) => String(n).padStart(2, '0');
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const nowTime = () => {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const addDays = (iso, n) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  };
  const LS = {
    get(k) {
      try { return localStorage.getItem(k); } catch (e) { return null; }
    },
    set(k, v) {
      try { localStorage.setItem(k, v); } catch (e) { /* приватный режим */ }
    },
    del(k) {
      try { localStorage.removeItem(k); } catch (e) { /* приватный режим */ }
    },
  };
  const val = (v) => (v === undefined || v === null ? '' : v);
  const fmtNum = (v) => (C.blank(v) ? '' : String(v));

  const S = {
    pin: LS.get('am_pin') || '',
    health: null,
    settings: C.withDefaults(null),
    srev: 0,
    date: today(),
    day: null,
    index: {},
    tab: LS.get('am_tab') || 'shift',
    rep: { mode: 'day', date: null, from: null, to: null, preset: 'month' },
    refSearch: '',
  };

  /* ---------- Сеть ---------- */

  async function api(method, url, body) {
    let r;
    try {
      r = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', 'x-pin': S.pin || '' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('Нет связи с сервером. Данные не сохранены, повторите.');
    }
    let j = {};
    try { j = await r.json(); } catch (e) { /* пустой ответ */ }
    if (r.status === 401) {
      showLogin(j.error);
      const e = new Error(j.error || 'Нужен PIN');
      e.status = 401;
      throw e;
    }
    if (!r.ok) {
      const e = new Error(j.error || `Ошибка ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return j;
  }

  async function loadSettings() {
    const st = await api('GET', '/api/settings');
    S.settings = st.value;
    S.srev = st.rev;
    fillDatalists();
  }
  async function loadIndex() {
    S.index = await api('GET', '/api/index');
  }
  async function loadDay() {
    const d = await api('GET', `/api/day/${S.date}`);
    S.day = d.value;
  }
  async function loadAll() {
    await Promise.all([loadSettings(), loadIndex(), loadDay()]);
    render();
  }

  async function act(action, date = S.date) {
    const d = await api('POST', `/api/day/${date}`, action);
    if (date === S.date) S.day = d.value;
    S.index[date] = C.daySummary(d.value);
    return d.value;
  }

  async function saveSettings(mut) {
    const next = clone(S.settings);
    mut(next);
    try {
      const r = await api('PUT', '/api/settings', { rev: S.srev, value: next });
      S.settings = r.value;
      S.srev = r.rev;
      fillDatalists();
    } catch (e) {
      if (e.status === 409) await loadSettings();
      throw e;
    }
  }

  function fillDatalists() {
    $('#oilList').innerHTML = (S.settings.oils || []).map((o) => `<option value="${esc(o.name)}">`).join('');
    $('#goodsList').innerHTML = (S.settings.goods || []).map((g) => `<option value="${esc(g.name)}">`).join('');
    $('#sellerNames').innerHTML = (S.settings.sellers || []).map((s) => `<option value="${esc(s.name)}">`).join('');
  }

  /* ---------- Мелочи интерфейса ---------- */

  let toastTimer;
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${bad ? ' bad' : ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 2500);
  }
  const fail = (e) => {
    if (e && e.status === 401) return;
    toast(e && e.message ? e.message : String(e), true);
  };

  function modal(title, html, wide) {
    const m = $('#modal');
    m.innerHTML = `<div class="sheet${wide ? ' wide' : ''}" role="dialog" aria-modal="true"><div class="sheet-h"><h2>${esc(title)}</h2><button class="x" data-act="closeModal" aria-label="Закрыть">×</button></div><div class="sheet-b">${html}</div></div>`;
    m.hidden = false;
    document.body.classList.add('noscroll');
    return $('.sheet-b', m);
  }
  function closeModal() {
    const m = $('#modal');
    m.hidden = true;
    m.innerHTML = '';
    document.body.classList.remove('noscroll');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Скопировано');
  }

  function showLogin(err) {
    $('#login').hidden = false;
    $('#loginErr').textContent = err && S.pin ? err : '';
    setTimeout(() => $('#pinInput').focus(), 50);
  }

  function renderBanner() {
    const h = S.health;
    let html = '';
    if (h && h.store === 'memory') html += '<div class="b bad">Данные НЕ сохраняются: не подключена база Upstash Redis. Подключите её в Vercel (Storage) и сделайте Redeploy. Инструкция в README.</div>';
    if (h && !h.auth && h.store === 'upstash') html += '<div class="b warn">PIN не задан: приложение доступно любому, у кого есть ссылка. Добавьте переменную ACCESS_PIN в Vercel.</div>';
    $('#banner').innerHTML = html;
  }

  function unresolvedDisc() {
    const out = [];
    for (const s of Object.values(S.index)) {
      for (const d of s.disc || []) if (!d.resolved) out.push({ date: s.date, ...d });
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : -1));
  }
  function openPastDays() {
    return Object.values(S.index).filter((s) => s.status !== 'closed' && s.date < today()).sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  /* ---------- Рендер ---------- */

  function render() {
    $('#dateInput').value = S.date;
    $('#todayBtn').hidden = S.date === today();
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
    $('#discDot').hidden = !(unresolvedDisc().length || openPastDays().length);
    const v = $('#view');
    if (S.tab === 'shift') v.innerHTML = S.day ? viewDay() : viewOpen();
    else if (S.tab === 'reports') {
      v.innerHTML = viewReports();
      loadReport();
    } else if (S.tab === 'disc') v.innerHTML = viewDisc();
    else v.innerHTML = viewRef();
  }

  const kpi = (l, v, cls = '') => `<div class="kpi ${cls}"><div class="l">${esc(l)}</div><div class="v">${v}</div></div>`;

  /* ----- Открытие смены ----- */

  function sellerRowHtml(s) {
    return `<div class="grid3 seller-in" data-id="${esc(s.id || uid())}">
      <label>Продавец<input name="sname" list="sellerNames" value="${esc(s.name)}" placeholder="Имя" autocomplete="off"></label>
      <label>Зарплата за смену, ₸<input name="ssalary" inputmode="decimal" value="${esc(fmtNum(s.salary))}" placeholder="обязательно"></label>
      <label>Начало работы<input name="sstart" type="time" value="${esc(s.start || '')}"></label>
    </div>`;
  }

  function viewOpen() {
    const dates = Object.keys(S.index).filter((d) => d < S.date).sort();
    const prev = dates.length ? S.index[dates[dates.length - 1]] : null;
    const unres = unresolvedDisc();
    const pastOpen = openPastDays().filter((d) => d.date !== S.date);
    let prevHtml = '<p class="muted small">Предыдущих смен нет. Введите остатки по факту пересчёта.</p>';
    if (prev) {
      const f = (acc) => {
        const c = prev.closing[acc];
        if (!c || !c.tracked) return 'не учитывается';
        return c.fact === null ? `факт не указан (расчёт ${M(c.calc)})` : M(c.fact);
      };
      prevHtml = `<div class="note info small">На конец смены ${C.dmy(prev.date)}${prev.status !== 'closed' ? ' (смена не закрыта)' : ''}: наличные ${f('cash')}, Kaspi Pay ${f('kaspi')}, переводы ${f('transfer')}.
        <div style="margin-top:6px"><button type="button" class="btn sm" data-act="fillPrev" data-date="${prev.date}">Подставить факт прошлой смены</button></div>
        <div class="hint">Проверьте суммы перед открытием: остатки должны совпадать с реальными деньгами.</div></div>`;
    }
    return `<section class="card">
      <h2>Открытие смены · ${C.dmy(S.date)}</h2>
      ${S.date !== today() ? '<div class="note warn">Вы открываете смену не за сегодняшнюю дату.</div>' : ''}
      ${pastOpen.length ? `<div class="note warn">Не закрыты прошлые смены: ${pastOpen.map((d) => `<button class="link" data-act="goDate" data-date="${d.date}">${C.dmy(d.date)}</button>`).join(', ')}</div>` : ''}
      <form id="openForm" autocomplete="off">
        <label style="max-width:200px">Время начала смены<input name="time" type="time" value="${nowTime()}" required></label>
        <h3>Продавцы смены</h3>
        <div id="openSellers">${sellerRowHtml({ start: nowTime() })}</div>
        <button type="button" class="btn ghost sm" data-act="addOpenSeller">+ Ещё продавец</button>
        <h3>Начальные остатки</h3>
        ${prevHtml}
        <div class="grid3">
          <label>Наличные в кассе, ₸<input name="cash" inputmode="decimal" placeholder="обязательно"></label>
          <label>Kaspi Pay, ₸<input name="kaspi" inputmode="decimal" placeholder="обязательно"></label>
          <label>Счёт переводов, ₸<input name="transfer" inputmode="decimal"></label>
        </div>
        <label class="check"><input type="checkbox" name="transferTracked" checked> Учитывать счёт переводов отдельно от Kaspi Pay</label>
        <label>Комментарий<input name="note" placeholder="необязательно"></label>
        <h3>Невыясненные расхождения</h3>
        ${unres.length ? `<div class="note bad"><ul>${unres.slice(0, 8).map((d) => `<li>${C.dmy(d.date)} · ${esc(d.label)}: ${C.signed(d.diff)}</li>`).join('')}</ul>${unres.length > 8 ? `<div>и ещё ${unres.length - 8}</div>` : ''}</div>` : '<p class="muted small">Нет.</p>'}
        <div id="openErr"></div>
        <button class="btn primary big">Открыть смену</button>
      </form>
    </section>`;
  }

  async function submitOpen(form) {
    const fd = new FormData(form);
    const errs = [];
    const sellers = $$('.seller-in', form).map((row) => ({
      id: row.dataset.id,
      name: $('[name=sname]', row).value.trim(),
      salary: $('[name=ssalary]', row).value.trim(),
      start: $('[name=sstart]', row).value,
    })).filter((s) => s.name || s.salary);
    if (!sellers.length) errs.push('Укажите хотя бы одного продавца');
    for (const s of sellers) {
      if (!s.name) errs.push('У продавца не указано имя');
      if (C.blank(s.salary)) errs.push(`Укажите зарплату за смену: ${s.name || 'продавец'}`);
    }
    const tracked = !!fd.get('transferTracked');
    if (C.blank(fd.get('cash'))) errs.push('Укажите начальную сумму наличных');
    if (C.blank(fd.get('kaspi'))) errs.push('Укажите начальный остаток Kaspi Pay');
    if (tracked && C.blank(fd.get('transfer'))) errs.push('Укажите начальный остаток счёта переводов или снимите галочку');
    if (errs.length) {
      $('#openErr').innerHTML = `<div class="note bad"><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
      return;
    }
    const opening = { time: fd.get('time'), cash: fd.get('cash'), kaspi: fd.get('kaspi'), transfer: tracked ? fd.get('transfer') : 0, transferTracked: tracked, note: fd.get('note') };
    await act({ type: 'open', opening, sellers });
    // Запоминаем продавцов для подсказок (без изменения уже записанных смен)
    const known = new Set((S.settings.sellers || []).map((s) => C.norm(s.name)));
    const fresh = sellers.filter((s) => !known.has(C.norm(s.name)));
    if (fresh.length) {
      saveSettings((st) => {
        st.sellers = (st.sellers || []).concat(fresh.map((s) => ({ name: s.name, salary: C.num(s.salary) })));
      }).catch(() => {});
    }
    toast('Смена открыта');
    render();
  }

  /* ----- Карточка дня ----- */

  function payBadges(c) {
    return C.PAY.filter((p) => c.pay[p] > 0).map((p) => `<span class="badge">${C.PAY_LABEL[p]} ${M(c.pay[p])}</span>`).join(' ');
  }

  function saleHtml(sale, open) {
    const c = C.saleCalc(sale);
    const items = c.items.map(({ it, c: ic }) => `<li><span>${esc(C.itemTitle(it))}${it.gift ? ' <span class="badge gold">подарок</span>' : ''}
        <div class="m">себест. ${M(ic.cost)}${it.type !== 'other' ? ` · масло ${C.fmt(ic.oilMl)} мл${it.type === 'perfume' ? ` · основа ${C.fmt(ic.baseMl)} мл` : ''}` : ''}${ic.discount ? ` · скидка ${M(ic.discount)} с ${M(ic.fullPrice)}` : ''}</div></span>
        <span class="num">${it.gift ? '0 ₸' : M(ic.price)}</span></li>`).join('');
    const promo = sale.promo
      ? `<div class="note info small">Акция «${esc(sale.promo)}»: выручка ${M(c.revenue)}, себестоимость товаров ${M(c.cost - c.giftCost)}, подарков ${M(c.giftCost)}, всего ${M(c.cost)}, прибыль ${M(c.profit)}</div>`
      : '';
    return `<div class="li">
      <div class="row between"><b>${esc(sale.time || '')} · ${sale.seller ? esc(sale.seller) : `<span class="badge warn">${C.NO_SELLER}</span>`}</b><b class="num">${M(c.revenue)}</b></div>
      <ul class="sale-items">${items}</ul>
      ${promo}
      <div class="row between wrap small"><span>${payBadges(c)}</span><span class="muted">себест. ${M(c.cost)} · прибыль <b>${M(c.profit)}</b></span></div>
      ${!c.payOk ? `<div class="note bad small">Оплата ${M(c.paySum)} не равна сумме ${M(c.revenue)}</div>` : ''}
      ${sale.note ? `<div class="small muted">${esc(sale.note)}</div>` : ''}
      ${open ? `<div class="row" style="margin-top:8px"><button class="btn sm" data-act="editSale" data-id="${sale.id}">Изменить</button><button class="btn sm danger" data-act="delSale" data-id="${sale.id}">Удалить</button></div>` : ''}
    </div>`;
  }

  function opHtml(op, open) {
    const k = C.OP_KINDS[op.kind] || { label: op.kind };
    const acc = op.kind === 'transfer' ? `${C.ACC_LABEL[op.account]} → ${C.ACC_LABEL[op.to]}` : C.ACC_LABEL[op.account];
    const cls = op.kind === 'personal' ? 'warn' : op.kind === 'purchase' ? 'gold' : op.kind === 'income' ? 'ok' : '';
    return `<div class="li">
      <div class="row between"><span><span class="badge ${cls}">${esc(k.label)}</span> ${esc(op.category)}</span><b class="num">${M(op.amount)}</b></div>
      <div class="small muted">${esc(op.time || '')} · ${esc(acc)}${op.note ? ` · ${esc(op.note)}` : ''}</div>
      ${op.unclear ? '<div class="note warn small">Назначение не уточнено</div>' : ''}
      ${open ? `<div class="row" style="margin-top:8px"><button class="btn sm" data-act="editOp" data-id="${op.id}">Изменить</button><button class="btn sm danger" data-act="delOp" data-id="${op.id}">Удалить</button></div>` : ''}
    </div>`;
  }

  function balancesTable(t) {
    const rows = C.ACCOUNTS.map((acc) => {
      const b = t.balances[acc];
      if (!b.tracked) return `<tr><td>${C.ACC_LABEL[acc]}</td><td colspan="6" class="muted">отдельно не учитывается</td></tr>`;
      const dcls = b.diff === null ? '' : b.diff === 0 ? 'pos' : 'neg';
      return `<tr><td>${C.ACC_LABEL[acc]}</td><td class="n">${M(b.open)}</td><td class="n">${M(b.sales + b.income)}</td><td class="n">${M(b.out)}</td><td class="n"><b>${M(b.calc)}</b></td><td class="n">${b.fact === null ? '—' : M(b.fact)}</td><td class="n ${dcls}">${b.diff === null ? '—' : b.diff === 0 ? 'сходится' : C.signed(b.diff)}</td></tr>`;
    }).join('');
    return `<div class="tbl-wrap"><table><thead><tr><th>Счёт</th><th class="n">Начало</th><th class="n">Приход</th><th class="n">Расход</th><th class="n">Расчёт</th><th class="n">Факт</th><th class="n">Разница</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">Приход: продажи, поступления, перемещения на счёт. Расход: расходы, закупки, личные операции, зарплата, возвраты, комиссия Kaspi, перемещения со счёта.</p>`;
  }

  function sellersBlock(d, t, open) {
    if (!(d.sellers || []).length) return '<p class="note bad">Продавец смены не указан.</p>';
    return d.sellers.map((s) => {
      const st = t.sellers[s.name] || { revenue: 0, receipts: 0 };
      const paid = s.paid
        ? `<span class="badge ok">выплачено ${M(s.paidAmount === undefined ? s.salary : s.paidAmount)} · ${C.ACC_LABEL[s.paidFrom] || ''}</span>`
        : '<span class="badge warn">начислено, не выплачено</span>';
      return `<div class="seller-row"><div><b>${esc(s.name)}</b> <span class="small muted">${esc(s.start || '?')}–${esc(s.end || '…')}</span>
          <div class="small">зарплата ${M(s.salary)} ${paid}</div>
          <div class="small muted">продаж ${st.receipts}, выручка ${M(st.revenue)}</div></div>
        ${open ? `<button class="btn sm" data-act="paySeller" data-id="${s.id}">${s.paid ? 'Выплата' : 'Выплатить'}</button>` : ''}</div>`;
    }).join('');
  }

  function viewDay() {
    const d = S.day;
    const t = C.dayTotals(d);
    const open = d.status === 'open';
    const op = d.opening || {};
    const sales = [...(d.sales || [])].reverse();
    const ops = [...(d.ops || [])].reverse();
    return `
      <section class="card">
        <div class="row between"><h2>Смена ${C.dmy(d.date)}</h2>${open ? '<span class="badge ok">открыта</span>' : `<span class="badge">закрыта${d.closing && d.closing.closedWithGaps ? ' с пропусками' : ''}</span>`}</div>
        <p class="small muted">Начало ${esc(op.time || '')}. Начальные остатки: наличные ${M(op.cash)}, Kaspi Pay ${M(op.kaspi)}, переводы ${op.transferTracked === false ? 'не учитываются' : M(op.transfer)}${op.note ? `. ${esc(op.note)}` : ''}</p>
        ${open ? '<button class="btn ghost sm" data-act="editOpening">Изменить начальные остатки</button>' : ''}
        <h3 style="margin-top:14px">Продавцы</h3>
        ${sellersBlock(d, t, open)}
        ${open ? '<button class="btn ghost sm" data-act="editSellers" style="margin-top:6px">Продавцы и зарплаты</button>' : ''}
      </section>
      <div class="kpis">
        ${kpi('Выручка', M(t.revenue), 'hl')}
        ${kpi('Kaspi Pay', M(t.pay.kaspi))}
        ${kpi('Переводы', M(t.pay.transfer))}
        ${kpi('Наличные', M(t.pay.cash))}
        ${kpi('Себестоимость', M(t.cogs))}
        ${kpi('Валовая прибыль', M(t.gross), 'hl')}
        ${kpi('Чеков / позиций', `${t.receipts} / ${t.positions}`)}
        ${kpi('Средний чек', M(t.avgCheck))}
      </div>
      ${open ? '<div class="actions"><button class="btn primary big" data-act="newSale">+ Продажа</button><button class="btn big" data-act="newOp">+ Расход или операция</button></div>' : ''}
      <section class="card"><h3>Продажи (${sales.length})</h3><div class="list">${sales.length ? sales.map((s) => saleHtml(s, open)).join('') : '<p class="empty">Продаж пока нет.</p>'}</div></section>
      <section class="card"><h3>Расходы и операции (${ops.length})</h3><div class="list">${ops.length ? ops.map((o) => opHtml(o, open)).join('') : '<p class="empty">Операций нет.</p>'}</div>
        ${t.purchases ? `<p class="hint">Закупки товара ${M(t.purchases)} уменьшают деньги, но не входят в себестоимость продаж.</p>` : ''}</section>
      <section class="card"><h3>Остатки денег</h3>${balancesTable(t)}</section>
      ${open ? closeCta(t) : closedBlock(d)}`;
  }

  function closeCta(t) {
    return `<section class="card"><h3>Закрытие смены</h3>
      ${t.missing.length ? `<div class="note warn small">Для закрытия понадобится: ${t.missing.map(esc).join(', ')}.</div>` : '<div class="note ok small">Все данные для закрытия заполнены.</div>'}
      <button class="btn gold big" data-act="openClosing">Закрыть смену</button>
      <div class="row wrap" style="margin-top:10px"><button class="btn sm ghost" data-act="showDayReport">Предварительный отчёт</button></div>
    </section>`;
  }

  function closedBlock(d) {
    const text = C.dailyReportText(d);
    return `<section class="card"><h3>Отчёт за день</h3>
      <div class="row wrap" style="margin-bottom:10px">
        <button class="btn sm primary" data-act="copyDay">Скопировать отчёт</button>
        <a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">Отправить в WhatsApp</a>
        ${d.closing && d.closing.photo ? '<button class="btn sm" data-act="viewPhoto">Фото сверки</button>' : ''}
      </div>
      <div class="report">${esc(text)}</div>
      <div style="margin-top:12px"><button class="btn sm danger" data-act="reopen">Открыть смену для исправления</button></div>
    </section>`;
  }

  /* ----- Продажа ----- */

  const volsFor = (type) => {
    const st = S.settings;
    const keys = type === 'perfume' ? [...Object.keys(st.concentration || {}), ...Object.keys(st.perfumeBottles || {})] : Object.keys(st.oilBottles || {});
    return [...new Set(keys.map(Number))].filter((n) => n > 0).sort((a, b) => a - b);
  };

  function newItem(type) {
    return { id: uid(), type, name: '', volume: '', conc: '', concManual: false, oilPrice: '', bottleCost: '', basePrice: S.settings.basePrice, unitCost: '', qty: 1, gift: false, fullPrice: '', price: '', src: 'manual', saveRef: true };
  }

  function applyVolumeDefaults(it) {
    const st = S.settings;
    if (it.type === 'perfume') {
      if (!it.concManual) it.conc = val(C.tableValue(st.concentration, it.volume));
      it.bottleCost = val(C.tableValue(st.perfumeBottles, it.volume));
    } else if (it.type === 'oil') {
      it.bottleCost = val(C.tableValue(st.oilBottles, it.volume));
    }
  }

  function lookup(it) {
    if (it.type === 'other') {
      const g = C.findGood(S.settings, it.name);
      if (g) {
        it.src = 'ref';
        it.unitCost = g.cost;
      } else if (it.src !== 'manual') {
        it.src = 'manual';
        it.unitCost = '';
      }
    } else {
      const o = C.findOil(S.settings, it.name);
      if (o) {
        it.src = 'ref';
        it.oilPrice = o.price;
      } else if (it.src !== 'manual') {
        it.src = 'manual';
        it.oilPrice = '';
      }
    }
  }

  function dynHtml(it) {
    if (it.type === 'other') {
      const g = C.findGood(S.settings, it.name);
      const ro = it.src === 'ref' || it.src === 'snap';
      return `<label>Закупка за 1 шт., ₸<input data-f="unitCost" inputmode="decimal" value="${esc(fmtNum(it.unitCost))}" ${ro ? 'readonly' : ''}></label>
        <div class="hint">${it.src === 'ref' ? `из справочника${g && g.updated ? `, обновлено ${C.dmy(g.updated)}` : ''}` : it.src === 'snap' ? 'стоимость на момент продажи' : C.blank(it.name) ? 'Выберите товар' : 'Товара нет в справочнике. Укажите закупочную стоимость.'}</div>
        ${it.src === 'manual' && !C.blank(it.name) ? `<label class="check"><input type="checkbox" data-f="saveRef" ${it.saveRef ? 'checked' : ''}> Добавить в справочник</label>` : ''}`;
    }
    const o = C.findOil(S.settings, it.name);
    const ro = it.src === 'ref' || it.src === 'snap';
    return `<label>Закупка масла за 1 мл, ₸<input data-f="oilPrice" inputmode="decimal" value="${esc(fmtNum(it.oilPrice))}" ${ro ? 'readonly' : ''} class="${!ro && !C.blank(it.name) && !(C.num(it.oilPrice) > 0) ? 'req' : ''}"></label>
      <div class="hint ${it.src === 'manual' && !C.blank(it.name) ? 'bad' : ''}">${it.src === 'ref' ? `из справочника${o && o.updated ? `, обновлено ${C.dmy(o.updated)}` : ''}` : it.src === 'snap' ? 'цена на момент продажи' : C.blank(it.name) ? 'Выберите аромат из списка' : 'Аромата нет в справочнике. Укажите закупочную цену за 1 мл.'}</div>
      ${it.src === 'manual' && !C.blank(it.name) ? `<label class="check"><input type="checkbox" data-f="saveRef" ${it.saveRef ? 'checked' : ''}> Добавить в справочник</label>` : ''}`;
  }

  function calcHtml(it) {
    const miss = C.itemMissing(it);
    const c = C.itemCalc(it);
    if (miss.length) return `<span class="hint bad">Не заполнено: ${esc(miss.join(', '))}</span>`;
    let parts;
    if (it.type === 'perfume') {
      parts = `масло ${C.fmt(c.oilMl)} мл × ${M(it.oilPrice)} = ${M(c.oilMl * C.num(it.oilPrice))} · основа ${C.fmt(c.baseMl)} мл × ${M(it.basePrice)} = ${M(c.baseMl * C.num(it.basePrice))} · флакон ${M(it.bottleCost)}`;
    } else if (it.type === 'oil') {
      parts = `масло ${C.fmt(c.oilMl)} мл × ${M(it.oilPrice)} = ${M(c.oilMl * C.num(it.oilPrice))} · флакон ${M(it.bottleCost)}`;
    } else {
      parts = `${c.qty} шт. × ${M(it.unitCost)}`;
    }
    return `${parts}<br>Себестоимость <b>${M(c.cost)}</b> · ${it.gift ? 'подарок, выручки нет' : `прибыль <b>${M(c.profit)}</b>${c.discount ? ` · скидка ${M(c.discount)}` : ''}`}`;
  }

  function itemHtml(it, i, count) {
    const vols = it.type === 'other' ? [] : volsFor(it.type);
    const volStr = C.blank(it.volume) ? '' : String(C.num(it.volume));
    const isStd = vols.map(String).includes(volStr);
    const custom = !C.blank(it.volume) && !isStd;
    const seg = ['perfume', 'oil', 'other'].map((t) => `<button type="button" data-type="${t}" class="${it.type === t ? 'on' : ''}">${C.TYPE_LABEL[t]}</button>`).join('');
    let mid = '';
    if (it.type !== 'other') {
      mid = `<label>Объём, мл<select data-f="volSel">
          <option value="" ${C.blank(it.volume) ? 'selected' : ''}>выберите</option>
          ${vols.map((v) => `<option value="${v}" ${String(v) === volStr ? 'selected' : ''}>${String(v).replace('.', ',')} мл</option>`).join('')}
          <option value="custom" ${custom || it.volCustom ? 'selected' : ''}>другой объём</option>
        </select></label>
        ${custom || it.volCustom ? `<label>Объём вручную, мл<input data-f="volume" inputmode="decimal" value="${esc(volStr)}"></label>` : ''}`;
    } else {
      mid = `<label>Количество<input data-f="qty" inputmode="numeric" value="${esc(it.qty)}"></label>`;
    }
    const perfumeFields = it.type === 'perfume'
      ? `<label>Концентрация масла, %<input data-f="conc" inputmode="decimal" value="${esc(fmtNum(it.conc))}"><div class="hint">основа ${C.blank(it.conc) ? '—' : C.r2(100 - C.num(it.conc))}%</div></label>`
      : '';
    const bottle = it.type !== 'other' ? `<label>Флакон, ₸<input data-f="bottleCost" inputmode="decimal" value="${esc(fmtNum(it.bottleCost))}" class="${C.blank(it.bottleCost) && !C.blank(it.volume) ? 'req' : ''}">${C.blank(it.bottleCost) && !C.blank(it.volume) ? '<div class="hint bad">нет в таблице флаконов</div>' : ''}</label>` : '';
    return `<div class="item" data-i="${i}">
      <div class="row between"><div class="seg">${seg}</div>${count > 1 ? `<button type="button" class="btn sm danger" data-rm="${i}">Убрать</button>` : ''}</div>
      <div class="grid2">
        <label>${it.type === 'other' ? 'Товар (фиксатор, пустой флакон…)' : 'Аромат'}<input data-f="name" list="${it.type === 'other' ? 'goodsList' : 'oilList'}" value="${esc(it.name)}" autocomplete="off"></label>
        ${mid}
      </div>
      <div class="grid3">${perfumeFields}${bottle}<div class="dyn">${dynHtml(it)}</div></div>
      <label class="check"><input type="checkbox" data-f="gift" ${it.gift ? 'checked' : ''}> Подарок по акции (выручки нет, себестоимость учитывается)</label>
      ${it.gift ? '' : `<div class="grid2">
        <label>Цена до скидки, ₸<input data-f="fullPrice" inputmode="decimal" value="${esc(fmtNum(it.fullPrice))}" placeholder="если была скидка"></label>
        <label>Цена продажи по факту, ₸<input data-f="price" inputmode="decimal" value="${esc(fmtNum(it.price))}" placeholder="итог со скидкой"></label>
      </div>`}
      <div class="calcbox" data-calc>${calcHtml(it)}</div>
    </div>`;
  }

  function openSale(existing) {
    const day = S.day;
    const names = (day.sellers || []).map((s) => s.name);
    const lastSeller = LS.get('am_last_seller');
    const draft = existing
      ? clone(existing)
      : {
          id: uid(),
          time: nowTime(),
          seller: names.length === 1 ? names[0] : names.includes(lastSeller) ? lastSeller : '',
          promo: '',
          note: '',
          pay: { kaspi: '', transfer: '', cash: '' },
          items: [newItem('perfume')],
        };
    if (existing) {
      for (const it of draft.items) {
        it.src = 'snap';
        it.saveRef = false;
        it.concManual = true;
        for (const k of ['fullPrice', 'price', 'conc', 'oilPrice', 'bottleCost', 'unitCost', 'volume']) if (it[k] === undefined) it[k] = '';
        if (it.basePrice === undefined || it.basePrice === '') it.basePrice = S.settings.basePrice;
      }
      for (const p of C.PAY) if (!draft.pay[p]) draft.pay[p] = '';
    }
    const sellerOpts = [...new Set([...names, ...(draft.seller && !names.includes(draft.seller) ? [draft.seller] : [])])]
      .map((n) => `<option value="${esc(n)}" ${n === draft.seller ? 'selected' : ''}>${esc(n)}</option>`).join('');
    const body = modal(existing ? 'Изменить продажу' : 'Новая продажа', `<form id="saleForm" autocomplete="off">
        <div class="grid3">
          <label>Продавец<select name="seller"><option value="" ${draft.seller ? '' : 'selected'}>${C.NO_SELLER}</option>${sellerOpts}</select></label>
          <label>Время<input name="time" type="time" value="${esc(draft.time)}"></label>
          <label>Акция<input name="promo" value="${esc(draft.promo)}" placeholder="например 2+1"></label>
        </div>
        <div id="items"></div>
        <div class="row wrap">
          <button type="button" class="btn sm" data-add="perfume">+ Духи</button>
          <button type="button" class="btn sm" data-add="oil">+ Масло</button>
          <button type="button" class="btn sm" data-add="other">+ Товар</button>
          <button type="button" class="btn sm gold" data-add="gift">+ Подарок 2+1</button>
        </div>
        <h3 style="margin-top:18px">Оплата</h3>
        <div class="row wrap" style="margin-bottom:6px">
          <button type="button" class="btn sm" data-payall="kaspi">Всё Kaspi Pay</button>
          <button type="button" class="btn sm" data-payall="transfer">Всё переводом</button>
          <button type="button" class="btn sm" data-payall="cash">Всё наличными</button>
        </div>
        <div class="grid3">
          <label>Kaspi Pay (терминал), ₸<input data-pay="kaspi" inputmode="decimal" value="${esc(fmtNum(draft.pay.kaspi))}"></label>
          <label>Перевод, ₸<input data-pay="transfer" inputmode="decimal" value="${esc(fmtNum(draft.pay.transfer))}"></label>
          <label>Наличные, ₸<input data-pay="cash" inputmode="decimal" value="${esc(fmtNum(draft.pay.cash))}"></label>
        </div>
        <div id="payInfo"></div>
        <label>Комментарий<input name="note" value="${esc(draft.note)}" placeholder="необязательно"></label>
        <div id="saleTotals"></div>
        <div id="saleErr"></div>
        <div class="sheet-f"><button type="button" class="btn" data-act="closeModal">Отмена</button><button class="btn primary">Сохранить продажу</button></div>
      </form>`, true);
    const form = $('#saleForm', body);
    const itemsBox = $('#items', form);

    const renderItems = () => {
      itemsBox.innerHTML = draft.items.map((it, i) => itemHtml(it, i, draft.items.length)).join('');
      updateTotals();
    };
    const updateItem = (i) => {
      const box = $(`.item[data-i="${i}"]`, itemsBox);
      if (box) $('[data-calc]', box).innerHTML = calcHtml(draft.items[i]);
    };
    const updateTotals = () => {
      const c = C.saleCalc(draft);
      const left = C.r2(c.revenue - c.paySum);
      $('#payInfo', form).innerHTML = c.payOk
        ? (c.revenue > 0 ? `<div class="note ok small">Оплата распределена: ${c.method}</div>` : '')
        : `<div class="note ${left > 0 ? 'warn' : 'bad'} small">${left > 0 ? `Осталось распределить ${M(left)}` : `Оплата больше суммы на ${M(-left)}`}</div>`;
      $('#saleTotals', form).innerHTML = `<div class="totals">${kpi('Выручка', M(c.revenue))}${kpi('Себестоимость', M(c.cost))}${kpi('Прибыль', M(c.profit), 'hl')}</div>
        ${c.gifts ? `<p class="hint">В т.ч. подарки: ${c.gifts} шт., себестоимость ${M(c.giftCost)}</p>` : ''}`;
    };
    renderItems();

    form.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.type) {
        const i = Number(b.closest('.item').dataset.i);
        if (draft.items[i].type === b.dataset.type) return;
        const gift = draft.items[i].gift;
        draft.items[i] = Object.assign(newItem(b.dataset.type), { gift });
        renderItems();
      } else if (b.dataset.rm !== undefined) {
        draft.items.splice(Number(b.dataset.rm), 1);
        renderItems();
      } else if (b.dataset.add) {
        const t = b.dataset.add;
        const it = newItem(t === 'gift' ? 'perfume' : t);
        if (t === 'gift') {
          it.gift = true;
          const promo = $('[name=promo]', form);
          if (!promo.value) promo.value = '2+1';
        }
        draft.items.push(it);
        renderItems();
        const last = $$('.item', itemsBox).pop();
        if (last) {
          last.scrollIntoView({ block: 'center', behavior: 'smooth' });
          $('[data-f=name]', last).focus({ preventScroll: true });
        }
      } else if (b.dataset.payall) {
        const c = C.saleCalc(draft);
        for (const p of C.PAY) draft.pay[p] = p === b.dataset.payall ? c.revenue : '';
        $$('[data-pay]', form).forEach((inp) => (inp.value = fmtNum(draft.pay[inp.dataset.pay])));
        updateTotals();
      }
    });

    const onField = (e) => {
      const el = e.target;
      if (el.dataset.pay) {
        draft.pay[el.dataset.pay] = el.value;
        return updateTotals();
      }
      const box = el.closest('.item');
      if (!box || !el.dataset.f) return;
      const i = Number(box.dataset.i);
      const it = draft.items[i];
      const f = el.dataset.f;
      if (f === 'volSel') {
        if (e.type !== 'change') return;
        if (el.value === 'custom') {
          it.volCustom = true;
          it.volume = '';
        } else {
          it.volCustom = false;
          it.volume = el.value;
        }
        it.concManual = false;
        applyVolumeDefaults(it);
        renderItems();
        return;
      }
      if (f === 'gift') {
        it.gift = el.checked;
        renderItems();
        return;
      }
      if (f === 'saveRef') {
        it.saveRef = el.checked;
        return;
      }
      it[f] = el.value;
      if (f === 'conc') it.concManual = true;
      if (f === 'volume' && e.type === 'change') {
        applyVolumeDefaults(it);
        renderItems();
        return;
      }
      if (f === 'name') {
        const before = it.src;
        lookup(it);
        const dyn = $('.dyn', box);
        if (dyn && (before !== it.src || it.src === 'ref' || e.type === 'change')) dyn.innerHTML = dynHtml(it);
      }
      updateItem(i);
      updateTotals();
    };
    form.addEventListener('input', onField);
    form.addEventListener('change', (e) => {
      if (e.target.dataset.f === 'volSel' || e.target.dataset.f === 'name' || e.target.dataset.f === 'volume') onField(e);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      draft.seller = fd.get('seller');
      draft.time = fd.get('time');
      draft.promo = String(fd.get('promo') || '').trim();
      draft.note = String(fd.get('note') || '').trim();
      const errs = [];
      draft.items.forEach((it, i) => {
        const m = C.itemMissing(it);
        if (m.length) errs.push(`Позиция ${i + 1}${it.name ? ` (${it.name})` : ''}: ${m.join(', ')}`);
      });
      const c = C.saleCalc(draft);
      if (!errs.length && !c.payOk) errs.push(`Распределите оплату: сумма продажи ${M(c.revenue)}, указано ${M(c.paySum)}`);
      if (draft.items.some((it) => it.gift) && !draft.promo) errs.push('Есть подарок: укажите акцию (например 2+1)');
      if (errs.length) {
        $('#saleErr', form).innerHTML = `<div class="note bad"><ul>${errs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
        $('#saleErr', form).scrollIntoView({ block: 'center' });
        return;
      }
      if (!draft.seller && !confirm('Продавец не указан. Сохранить с пометкой «Продавец не указан»?')) return;
      const btn = $('button.primary', form);
      btn.disabled = true;
      try {
        const newOils = draft.items.filter((it) => it.type !== 'other' && it.src === 'manual' && it.saveRef && !C.findOil(S.settings, it.name));
        const newGoods = draft.items.filter((it) => it.type === 'other' && it.src === 'manual' && it.saveRef && !C.findGood(S.settings, it.name));
        if (newOils.length || newGoods.length) {
          const d = today();
          await saveSettings((st) => {
            const seen = new Set();
            for (const it of newOils) {
              if (seen.has(C.norm(it.name))) continue;
              seen.add(C.norm(it.name));
              st.oils.push({ id: uid(), name: it.name.trim(), price: C.num(it.oilPrice), updated: d, history: [{ date: d, price: C.num(it.oilPrice) }] });
            }
            for (const it of newGoods) {
              if (seen.has(`g:${C.norm(it.name)}`)) continue;
              seen.add(`g:${C.norm(it.name)}`);
              st.goods.push({ id: uid(), name: it.name.trim(), cost: C.num(it.unitCost), updated: d, history: [{ date: d, cost: C.num(it.unitCost) }] });
            }
          });
        }
        await act({ type: 'upsertSale', sale: draft });
        if (draft.seller) LS.set('am_last_seller', draft.seller);
        closeModal();
        render();
        toast(existing ? 'Продажа изменена' : `Продажа ${M(c.revenue)} сохранена`);
      } catch (err) {
        btn.disabled = false;
        fail(err);
      }
    });
  }

  /* ----- Операции ----- */

  function openOp(existing) {
    const d = existing
      ? clone(existing)
      : { id: uid(), time: nowTime(), kind: 'business', category: C.OP_KINDS.business.cats[0], amount: '', account: 'cash', to: 'kaspi', note: '', unclear: false };
    const accOpts = (sel) => C.ACCOUNTS.map((a) => `<option value="${a}" ${a === sel ? 'selected' : ''}>${C.ACC_LABEL[a]}</option>`).join('');
    const HINT = {
      business: 'Уменьшает результат магазина и остаток выбранного счёта.',
      purchase: 'Закупка уменьшает деньги, но не входит в себестоимость. Себестоимость считается при продаже.',
      personal: 'Личное владельца: не влияет на прибыль магазина, но уменьшает остаток счёта.',
      transfer: 'Внутреннее перемещение, не расход. Уменьшает один счёт и увеличивает другой.',
      income: 'Поступление денег не от продаж: увеличивает остаток счёта.',
      refund: 'Возврат покупателю: уменьшает результат и остаток счёта.',
    };
    const draw = () => {
      const k = C.OP_KINDS[d.kind];
      return `<form id="opForm" autocomplete="off">
        <div class="seg wrap">${Object.entries(C.OP_KINDS).map(([key, v]) => `<button type="button" data-kind="${key}" class="${key === d.kind ? 'on' : ''}">${v.label}</button>`).join('')}</div>
        <p class="hint">${HINT[d.kind]}</p>
        <div class="grid2">
          <label>Категория<select name="category">${k.cats.map((c) => `<option ${c === d.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
          <label>Сумма, ₸<input name="amount" inputmode="decimal" value="${esc(fmtNum(d.amount))}" required></label>
        </div>
        <div class="grid2">
          <label>${d.kind === 'income' ? 'На какой счёт' : d.kind === 'transfer' ? 'Откуда' : 'С какого счёта'}<select name="account">${accOpts(d.account)}</select></label>
          ${d.kind === 'transfer' ? `<label>Куда<select name="to">${accOpts(d.to)}</select></label>` : `<label>Время<input name="time" type="time" value="${esc(d.time)}"></label>`}
        </div>
        ${d.kind === 'transfer' ? `<label style="max-width:200px">Время<input name="time" type="time" value="${esc(d.time)}"></label>` : ''}
        <label>Назначение, комментарий<input name="note" value="${esc(d.note)}" placeholder="на что именно"></label>
        <label class="check"><input type="checkbox" name="unclear" ${d.unclear ? 'checked' : ''}> Назначение не уточнено (попадёт в контроль)</label>
        <div id="opErr"></div>
        <div class="sheet-f"><button type="button" class="btn" data-act="closeModal">Отмена</button><button class="btn primary">Сохранить</button></div>
      </form>`;
    };
    const body = modal(existing ? 'Изменить операцию' : 'Новая операция', draw());
    const readForm = () => {
      const f = $('#opForm', body);
      if (!f) return;
      const fd = new FormData(f);
      d.category = fd.get('category');
      d.amount = fd.get('amount');
      d.account = fd.get('account');
      if (fd.get('to')) d.to = fd.get('to');
      d.time = fd.get('time') || d.time;
      d.note = fd.get('note');
      d.unclear = !!fd.get('unclear');
    };
    const presetTransfer = () => {
      if (d.kind !== 'transfer') return;
      if (d.category === 'Снятие с Kaspi в кассу') Object.assign(d, { account: 'kaspi', to: 'cash' });
      if (d.category === 'Внесение наличных на Kaspi') Object.assign(d, { account: 'cash', to: 'kaspi' });
    };
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-kind]');
      if (!b) return;
      readForm();
      d.kind = b.dataset.kind;
      d.category = C.OP_KINDS[d.kind].cats[0];
      if (d.kind === 'personal' || d.kind === 'transfer') d.account = 'kaspi';
      presetTransfer();
      body.innerHTML = draw();
    });
    body.addEventListener('change', (e) => {
      if (e.target.name === 'category' && d.kind === 'transfer') {
        readForm();
        presetTransfer();
        body.innerHTML = draw();
      }
    });
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      readForm();
      if (!(C.num(d.amount) > 0)) {
        $('#opErr', body).innerHTML = '<div class="note bad">Укажите сумму</div>';
        return;
      }
      try {
        await act({ type: 'upsertOp', op: d });
        closeModal();
        render();
        toast('Операция сохранена');
      } catch (err) {
        fail(err);
      }
    });
  }

  /* ----- Продавцы, остатки ----- */

  function openSellers() {
    const list = clone(S.day.sellers || []);
    const row = (s) => `<div class="item seller-ed" data-id="${esc(s.id || uid())}">
        <div class="grid2">
          <label>Имя<input name="name" list="sellerNames" value="${esc(s.name)}"></label>
          <label>Зарплата за смену, ₸<input name="salary" inputmode="decimal" value="${esc(fmtNum(s.salary))}"></label>
        </div>
        <div class="grid3">
          <label>Начало<input name="start" type="time" value="${esc(s.start || '')}"></label>
          <label>Конец<input name="end" type="time" value="${esc(s.end || '')}"></label>
          <div style="align-self:end"><button type="button" class="btn sm danger" data-rm>Убрать</button></div>
        </div>
        ${s.paid ? `<div class="hint">Зарплата выплачена ${M(s.paidAmount)}. Изменить выплату можно кнопкой «Выплата».</div>` : ''}
      </div>`;
    const body = modal('Продавцы и зарплаты', `<form id="selForm"><div id="selRows">${list.map(row).join('')}</div>
      <button type="button" class="btn sm" data-add>+ Продавец</button>
      <p class="hint">Зарплата записывается отдельно по каждому продавцу. Пока не нажата «Выплатить», она считается начисленной, но не выплаченной.</p>
      <div id="selErr"></div>
      <div class="sheet-f"><button type="button" class="btn" data-act="closeModal">Отмена</button><button class="btn primary">Сохранить</button></div></form>`);
    body.addEventListener('click', (e) => {
      if (e.target.closest('[data-add]')) $('#selRows', body).insertAdjacentHTML('beforeend', row({ start: nowTime() }));
      const rm = e.target.closest('[data-rm]');
      if (rm) {
        const box = rm.closest('.seller-ed');
        const old = list.find((s) => s.id === box.dataset.id);
        const st = old && C.dayTotals(S.day).sellers[old.name];
        if (st && st.receipts && !confirm(`У продавца ${old.name} есть продажи (${st.receipts}). Убрать из смены? Продажи останутся с его именем.`)) return;
        box.remove();
      }
    });
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rows = $$('.seller-ed', body).map((box) => {
        const old = list.find((s) => s.id === box.dataset.id) || {};
        return { ...old, id: box.dataset.id, name: $('[name=name]', box).value.trim(), salary: $('[name=salary]', box).value.trim(), start: $('[name=start]', box).value, end: $('[name=end]', box).value };
      });
      const errs = [];
      for (const r of rows) {
        if (!r.name) errs.push('Укажите имя продавца');
        if (C.blank(r.salary)) errs.push(`Укажите зарплату: ${r.name || 'продавец'}`);
      }
      if (errs.length) {
        $('#selErr', body).innerHTML = `<div class="note bad">${errs.map(esc).join('<br>')}</div>`;
        return;
      }
      try {
        await act({ type: 'setSellers', sellers: rows });
        closeModal();
        render();
        toast('Продавцы сохранены');
      } catch (err) {
        fail(err);
      }
    });
  }

  function openPay(id) {
    const list = clone(S.day.sellers || []);
    const s = list.find((x) => x.id === id);
    if (!s) return;
    const body = modal(`Зарплата: ${s.name}`, `<form id="payForm">
      <p>Начислено за смену: <b>${M(s.salary)}</b></p>
      <div class="grid3">
        <label>Выплачено, ₸<input name="amount" inputmode="decimal" value="${esc(fmtNum(s.paid ? s.paidAmount : s.salary))}"></label>
        <label>Откуда<select name="from">${C.ACCOUNTS.map((a) => `<option value="${a}" ${a === (s.paidFrom || 'cash') ? 'selected' : ''}>${C.ACC_LABEL[a]}</option>`).join('')}</select></label>
        <label>Время<input name="time" type="time" value="${esc(s.paidAt || nowTime())}"></label>
      </div>
      <p class="hint">Выплата уменьшит остаток выбранного счёта.</p>
      <div class="sheet-f">
        ${s.paid ? '<button type="button" class="btn danger" data-unpay>Отменить выплату</button>' : '<button type="button" class="btn" data-act="closeModal">Отмена</button>'}
        <button class="btn primary">Записать выплату</button>
      </div></form>`);
    const save = async (paid, fd) => {
      Object.assign(s, paid ? { paid: true, paidAmount: fd.get('amount'), paidFrom: fd.get('from'), paidAt: fd.get('time') } : { paid: false, paidAmount: undefined, paidFrom: undefined, paidAt: undefined });
      try {
        await act({ type: 'setSellers', sellers: list });
        closeModal();
        render();
        toast(paid ? 'Выплата записана' : 'Выплата отменена');
      } catch (err) {
        fail(err);
      }
    };
    body.addEventListener('click', (e) => {
      if (e.target.closest('[data-unpay]') && confirm('Отменить запись о выплате?')) save(false);
    });
    body.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (!(C.num(fd.get('amount')) > 0)) return toast('Укажите сумму выплаты', true);
      save(true, fd);
    });
  }

  function openOpening() {
    const o = S.day.opening || {};
    const body = modal('Начальные остатки', `<form id="opnForm">
      <div class="note warn small">Начальные остатки влияют на расчёт кассы. Меняйте только если при открытии была ошибка. Изменение попадёт в журнал.</div>
      <label style="max-width:200px">Время начала<input name="time" type="time" value="${esc(o.time || '')}"></label>
      <div class="grid3">
        <label>Наличные, ₸<input name="cash" inputmode="decimal" value="${esc(fmtNum(o.cash))}"></label>
        <label>Kaspi Pay, ₸<input name="kaspi" inputmode="decimal" value="${esc(fmtNum(o.kaspi))}"></label>
        <label>Счёт переводов, ₸<input name="transfer" inputmode="decimal" value="${esc(fmtNum(o.transfer))}"></label>
      </div>
      <label class="check"><input type="checkbox" name="transferTracked" ${o.transferTracked === false ? '' : 'checked'}> Учитывать счёт переводов отдельно</label>
      <label>Комментарий<input name="note" value="${esc(o.note || '')}"></label>
      <div class="sheet-f"><button type="button" class="btn" data-act="closeModal">Отмена</button><button class="btn primary">Сохранить</button></div></form>`);
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (C.blank(fd.get('cash')) || C.blank(fd.get('kaspi'))) return toast('Заполните наличные и Kaspi Pay', true);
      try {
        await act({ type: 'setOpening', opening: { time: fd.get('time'), cash: fd.get('cash'), kaspi: fd.get('kaspi'), transfer: fd.get('transfer'), transferTracked: !!fd.get('transferTracked'), note: fd.get('note') } });
        closeModal();
        render();
      } catch (err) {
        fail(err);
      }
    });
  }

  /* ----- Закрытие смены ----- */

  async function compressImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('Не удалось прочитать фото'));
        im.src = url;
      });
      const max = 1600;
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k);
      cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      let q = 0.8;
      let out = cv.toDataURL('image/jpeg', q);
      while (out.length > 900000 && q > 0.35) {
        q -= 0.1;
        out = cv.toDataURL('image/jpeg', q);
      }
      return out;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function openClosing() {
    const day = S.day;
    const cl = day.closing || {};
    const t0 = C.dayTotals(day);
    const tracked = t0.transferTracked;
    const f = (name, label, hint) => `<label>${label}<input name="${name}" inputmode="decimal" value="${esc(fmtNum(cl[name]))}"></label><div class="hint" data-h="${name}">${hint || ''}</div>`;
    const sumOps = (kind) => (day.ops || []).filter((o) => o.kind === kind);
    const opsList = (kind, empty) => {
      const l = sumOps(kind);
      return l.length ? `<ul class="small">${l.map((o) => `<li>${esc(o.category)}: ${M(o.amount)} (${C.ACC_LABEL[o.account]})${o.note ? `, ${esc(o.note)}` : ''}</li>`).join('')}</ul>` : `<p class="small muted">${empty}</p>`;
    };
    const body = modal(`Закрытие смены ${C.dmy(day.date)}`, `<form id="closeForm" autocomplete="off">
      <ol class="steps">
        <li><b>Фото сверки с терминала</b>
          <div id="photoBox">${cl.photo ? '<p class="small">Фото приложено. <button type="button" class="link" data-act="viewPhoto">Посмотреть</button> · <button type="button" class="link" data-delphoto>Удалить</button></p>' : '<p class="small muted">Фото не приложено.</p>'}</div>
          <input type="file" accept="image/*" id="photoIn">
        </li>
        <li>${f('kaspiTerminal', 'Сумма продаж Kaspi Pay по терминалу, ₸')}</li>
        <li>${f('transfersReported', 'Сумма переводов за смену, ₸')}</li>
        <li>${f('cashSalesReported', 'Сумма продаж наличными, ₸')}</li>
        <li>${f('cashActual', 'Наличные в кассе по факту пересчёта, ₸')}</li>
        <li>${f('commission', 'Комиссия терминала за день, ₸', 'Фактическая сумма из Kaspi, без примерного процента.')}</li>
        <li>${f('kaspiActual', 'Остаток Kaspi Pay по факту, ₸')}</li>
        ${tracked ? `<li>${f('transferActual', 'Остаток счёта переводов по факту, ₸')}</li>` : ''}
        <li><b>Расходы бизнеса и закупки за смену</b>${opsList('business', 'Расходов бизнеса нет.')}${opsList('purchase', 'Закупок нет.')}</li>
        <li><b>Личные снятия и расходы</b>${opsList('personal', 'Личных операций нет.')}</li>
        <li><b>Зарплата</b><ul class="small">${(day.sellers || []).map((s) => `<li>${esc(s.name)}: ${M(s.salary)} · ${s.paid ? `выплачено ${M(s.paidAmount)} (${C.ACC_LABEL[s.paidFrom]})` : '<b>не выплачено</b>'}</li>`).join('') || '<li>Продавцы не указаны</li>'}</ul></li>
        <li><b>Продавцы смены:</b> ${(day.sellers || []).map((s) => esc(s.name)).join(', ') || '<span class="badge bad">не указаны</span>'}</li>
      </ol>
      <p class="hint">Если какой-то расход, снятие или выплата не внесены: «Сохранить черновик», добавьте операцию на экране смены и вернитесь к закрытию.</p>
      <div class="grid2"><label>Время закрытия<input name="time" type="time" value="${esc(cl.time || nowTime())}"></label><label>Комментарий<input name="note" value="${esc(cl.note || '')}"></label></div>
      <h3>Сверка</h3>
      <div id="closeLive"></div>
      <div id="closeErr"></div>
      <div class="sheet-f"><button type="button" class="btn" data-draft>Сохранить черновик</button><button class="btn gold">Закрыть смену</button></div>
    </form>`, true);
    const form = $('#closeForm', body);
    const FIELDS = ['kaspiTerminal', 'transfersReported', 'cashSalesReported', 'cashActual', 'commission', 'kaspiActual', 'transferActual'];
    const readVals = () => {
      const fd = new FormData(form);
      const v = {};
      for (const k of FIELDS) if (fd.has(k)) v[k] = String(fd.get(k)).trim();
      v.time = fd.get('time');
      v.note = fd.get('note');
      return v;
    };
    const live = () => {
      const v = readVals();
      const tmp = clone(S.day);
      tmp.closing = { ...(tmp.closing || {}), ...v };
      const t = C.dayTotals(tmp);
      const cmp = (c) => (!c ? '' : c.diff === 0 ? '<span class="badge ok">сходится</span>' : `<span class="badge bad">разница ${C.signed(c.diff)}</span>`);
      const setH = (name, html) => {
        const el = $(`[data-h="${name}"]`, form);
        if (el) el.innerHTML = html;
      };
      setH('kaspiTerminal', `Внесено продаж Kaspi Pay: ${M(t.pay.kaspi)} ${cmp(t.check.terminal)}`);
      setH('transfersReported', `Внесено продаж переводом: ${M(t.pay.transfer)} ${cmp(t.check.transfers)}`);
      setH('cashSalesReported', `Внесено продаж наличными: ${M(t.pay.cash)} ${cmp(t.check.cashSales)}`);
      const bal = (acc) => {
        const b = t.balances[acc];
        return `Расчёт: ${M(b.calc)} ${b.diff === null ? '' : b.diff === 0 ? '<span class="badge ok">сходится</span>' : `<span class="badge bad">разница ${C.signed(b.diff)}</span>`}`;
      };
      setH('cashActual', bal('cash'));
      setH('kaspiActual', `${bal('kaspi')}<br>с учётом комиссии ${t.commission === null ? '(комиссия не указана)' : M(t.commission)}`);
      setH('transferActual', bal('transfer'));
      $('#closeLive', form).innerHTML = balancesTable(t) + (t.missing.length ? `<div class="note warn small">Не заполнено: ${t.missing.map(esc).join(', ')}</div>` : '<div class="note ok small">Все поля закрытия заполнены.</div>');
    };
    live();
    form.addEventListener('input', live);

    const saveDraft = async () => {
      const v = readVals();
      await act({ type: 'setClosing', closing: v });
    };

    $('#photoIn', form).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $('#photoBox', form).innerHTML = '<p class="small muted">Загрузка фото…</p>';
      try {
        const dataUrl = await compressImage(file);
        const r = await api('PUT', `/api/photo/${S.date}`, { dataUrl });
        S.day = r.value;
        S.index[S.date] = C.daySummary(r.value);
        $('#photoBox', form).innerHTML = `<img class="photo-prev" src="${dataUrl}" alt="Сверка с терминала"><p class="small">Фото приложено. <button type="button" class="link" data-delphoto>Удалить</button></p>`;
        live();
      } catch (err) {
        $('#photoBox', form).innerHTML = '<p class="small muted">Фото не загружено.</p>';
        fail(err);
      }
    });
    form.addEventListener('click', async (e) => {
      if (e.target.closest('[data-delphoto]')) {
        if (!confirm('Удалить фото сверки?')) return;
        try {
          const r = await api('DELETE', `/api/photo/${S.date}`);
          S.day = r.value;
          $('#photoBox', form).innerHTML = '<p class="small muted">Фото не приложено.</p>';
          live();
        } catch (err) {
          fail(err);
        }
      }
      if (e.target.closest('[data-draft]')) {
        try {
          await saveDraft();
          closeModal();
          render();
          toast('Черновик закрытия сохранён');
        } catch (err) {
          fail(err);
        }
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = readVals();
      try {
        await act({ type: 'setClosing', closing: v });
        // Время окончания работы продавцов, если не указано
        if ((S.day.sellers || []).some((s) => !s.end)) {
          await act({ type: 'setSellers', sellers: S.day.sellers.map((s) => ({ ...s, end: s.end || v.time })) });
        }
        const missing = C.closingMissing(S.day);
        let withGaps = false;
        if (missing.length) {
          if (!confirm(`Не заполнено:\n• ${missing.join('\n• ')}\n\nЗакрыть смену с незаполненными полями? Это будет отмечено в отчёте.`)) {
            $('#closeErr', form).innerHTML = `<div class="note warn">Смена не закрыта. Заполните: ${missing.map(esc).join(', ')}</div>`;
            return;
          }
          withGaps = true;
        }
        await act({ type: 'close', time: v.time, withGaps });
        closeModal();
        render();
        toast('Смена закрыта');
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      } catch (err) {
        fail(err);
      }
    });
  }

  async function viewPhoto(date = S.date) {
    try {
      const r = await api('GET', `/api/photo/${date}`);
      if (!r.dataUrl) return toast('Фото не найдено', true);
      modal(`Сверка терминала ${C.dmy(date)}`, `<img src="${r.dataUrl}" alt="Фото сверки" style="width:100%;border-radius:10px">`, true);
    } catch (err) {
      fail(err);
    }
  }

  /* ----- Отчёты ----- */

  function presetRange(p) {
    const t = today();
    const [y, m] = t.split('-').map(Number);
    const d = new Date();
    const dow = (d.getDay() + 6) % 7;
    if (p === 'week') return [addDays(t, -dow), t];
    if (p === '7') return [addDays(t, -6), t];
    if (p === '30') return [addDays(t, -29), t];
    if (p === 'prevMonth') {
      const pm = new Date(y, m - 2, 1);
      const last = new Date(y, m - 1, 0);
      return [`${pm.getFullYear()}-${pad(pm.getMonth() + 1)}-01`, `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`];
    }
    return [`${y}-${pad(m)}-01`, t];
  }

  function viewReports() {
    const R = S.rep;
    if (!R.date) R.date = S.date;
    if (!R.from) [R.from, R.to] = presetRange(R.preset);
    const days = Object.values(S.index).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 14);
    const presets = [['week', 'Эта неделя'], ['month', 'Этот месяц'], ['prevMonth', 'Прошлый месяц'], ['7', '7 дней'], ['30', '30 дней']];
    return `<div class="seg" style="margin-bottom:12px"><button data-act="repMode" data-mode="day" class="${R.mode === 'day' ? 'on' : ''}">Отчёт за день</button><button data-act="repMode" data-mode="range" class="${R.mode === 'range' ? 'on' : ''}">Неделя, месяц, период</button></div>
      ${R.mode === 'day'
        ? `<section class="card"><div class="row wrap"><label>Дата<input type="date" id="repDate" value="${R.date}"></label></div>
            ${days.length ? `<div class="row wrap small" style="margin-top:10px">${days.map((d) => `<button class="btn sm ${d.date === R.date ? 'primary' : ''}" data-act="repDay" data-date="${d.date}">${C.dmy(d.date).slice(0, 5)} · ${M(d.revenue)}${d.status !== 'closed' ? ' ●' : ''}</button>`).join('')}</div><p class="hint">● смена не закрыта</p>` : ''}
          </section>`
        : `<section class="card"><div class="row wrap">${presets.map(([k, l]) => `<button class="btn sm ${R.preset === k ? 'primary' : ''}" data-act="repPreset" data-p="${k}">${l}</button>`).join('')}</div>
            <div class="grid3"><label>С<input type="date" id="repFrom" value="${R.from}"></label><label>По<input type="date" id="repTo" value="${R.to}"></label><div style="align-self:end"><button class="btn primary" data-act="repRange">Показать</button></div></div>
          </section>`}
      <div id="repOut"><div class="loading">Загрузка отчёта…</div></div>`;
  }

  async function loadReport() {
    const R = S.rep;
    const out = () => $('#repOut');
    try {
      if (R.mode === 'day') {
        let day = R.date === S.date ? S.day : (await api('GET', `/api/day/${R.date}`)).value;
        if (!out()) return;
        if (!day) {
          out().innerHTML = `<section class="card"><p class="empty">Смены за ${C.dmy(R.date)} нет.</p></section>`;
          return;
        }
        out().innerHTML = dayReportHtml(day);
      } else {
        const days = await api('GET', `/api/range?from=${R.from}&to=${R.to}`);
        if (!out()) return;
        out().innerHTML = rangeReportHtml(days);
      }
    } catch (err) {
      if (out()) out().innerHTML = `<section class="card"><div class="note bad">${esc(err.message)}</div></section>`;
    }
  }

  function sellersTable(list, withDays) {
    if (!list.length) return '<p class="empty">Нет данных.</p>';
    return `<div class="tbl-wrap"><table><thead><tr><th>Продавец</th>${withDays ? '<th class="n">Дней</th>' : ''}<th class="n">Продаж</th><th class="n">Выручка</th><th class="n">Kaspi Pay</th><th class="n">Переводы</th><th class="n">Наличные</th><th class="n">Ср. чек</th><th class="n">Себест.</th><th class="n">Вал. прибыль</th><th class="n">Подарки</th><th class="n">Зарплата</th></tr></thead><tbody>
      ${list.map((s) => `<tr><td>${esc(s.name)}</td>${withDays ? `<td class="n">${s.days}</td>` : ''}<td class="n">${s.receipts}</td><td class="n"><b>${M(s.revenue)}</b></td><td class="n">${M(s.pay.kaspi)}</td><td class="n">${M(s.pay.transfer)}</td><td class="n">${M(s.pay.cash)}</td><td class="n">${M(s.avgCheck)}</td><td class="n">${M(s.cost)}</td><td class="n">${M(s.gross)}</td><td class="n">${s.gifts}</td><td class="n">${M(s.salary)}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function dayReportHtml(day) {
    const t = C.dayTotals(day);
    const text = C.dailyReportText(day);
    const lines = t.lines.map((ln) => `<tr><td>${esc(ln.time || '')}</td><td>${esc(ln.seller)}</td><td>${esc(C.itemTitle(ln.it))}${ln.it.gift ? ' <span class="badge gold">подарок</span>' : ''}</td><td class="n">${ln.it.type === 'other' ? '' : C.fmt(ln.c.oilMl)}</td><td class="n">${ln.it.type === 'perfume' ? C.fmt(ln.c.baseMl) : ''}</td><td class="n">${ln.c.discount ? M(ln.c.fullPrice) : ''}</td><td class="n">${ln.c.discount ? M(ln.c.discount) : ''}</td><td class="n">${M(ln.c.price)}</td><td>${esc(ln.method)}</td><td class="n">${M(ln.c.cost)}</td><td class="n">${M(ln.c.profit)}</td></tr>`).join('');
    const sellers = Object.values(t.sellers);
    return `<div class="kpis">
        ${kpi('Выручка', M(t.revenue), 'hl')}${kpi('Себестоимость', M(t.cogs))}${kpi('Валовая прибыль', M(t.gross))}${kpi('Результат после расходов', M(t.result), 'hl')}
      </div>
      <section class="card"><h3>Продавцы</h3>${sellersTable(sellers)}</section>
      <section class="card"><h3>Все позиции</h3>${lines ? `<div class="tbl-wrap"><table><thead><tr><th>Время</th><th>Продавец</th><th>Позиция</th><th class="n">Масло, мл</th><th class="n">Основа, мл</th><th class="n">До скидки</th><th class="n">Скидка</th><th class="n">Цена</th><th>Оплата</th><th class="n">Себест.</th><th class="n">Прибыль</th></tr></thead><tbody>${lines}</tbody></table></div>` : '<p class="empty">Продаж нет.</p>'}</section>
      <section class="card"><h3>Остатки</h3>${balancesTable(t)}</section>
      <section class="card"><h3>Текст отчёта</h3>
        <div class="row wrap" style="margin-bottom:10px"><button class="btn sm primary" data-act="copyReport">Скопировать</button><a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">WhatsApp</a>${day.closing && day.closing.photo ? `<button class="btn sm" data-act="viewPhoto" data-date="${day.date}">Фото сверки</button>` : ''}</div>
        <div class="report" id="reportText">${esc(text)}</div></section>`;
  }

  function rangeReportHtml(days) {
    if (!days.length) return '<section class="card"><p class="empty">За период смен нет.</p></section>';
    const R = C.rangeTotals(days);
    const text = C.rangeReportText(R);
    const pl = [
      ['Выручка', R.revenue],
      ['Себестоимость проданных товаров (с подарками)', -R.cogs],
      ['Валовая прибыль', R.gross, true],
      ['Зарплаты', -R.salaries],
      ['Комиссии Kaspi', -R.commission],
      ['Аренда и прочие расходы бизнеса', -R.business],
      ...(R.refunds ? [['Возвраты покупателям', -R.refunds]] : []),
      ['Чистый операционный результат', R.result, true],
    ];
    const tbl = (rows) => `<table><tbody>${rows.map(([l, v, b]) => `<tr class="${b ? 'total' : ''}"><td>${esc(l)}</td><td class="n">${M(v)}</td></tr>`).join('')}</tbody></table>`;
    const cats = (obj) => Object.entries(obj).map(([c, v]) => [c, v]);
    return `<div class="kpis">
        ${kpi('Выручка', M(R.revenue), 'hl')}${kpi('Валовая прибыль', M(R.gross))}${kpi('Чистый результат', M(R.result), 'hl')}${kpi('Средний чек', M(R.avgCheck))}
        ${kpi('Kaspi Pay', M(R.pay.kaspi))}${kpi('Переводы', M(R.pay.transfer))}${kpi('Наличные', M(R.pay.cash))}${kpi('Чеков / подарков', `${R.receipts} / ${R.gifts}`)}
      </div>
      <section class="card"><h3>Финансовый результат</h3>${tbl(pl)}
        ${R.commissionMissingDays ? `<div class="note warn small">Комиссия Kaspi не указана за ${R.commissionMissingDays} дн. Результат может быть завышен.</div>` : ''}
        ${R.salaryUnpaid ? `<p class="hint">Зарплата начислена, но не выплачена: ${M(R.salaryUnpaid)}</p>` : ''}</section>
      <section class="card"><h3>Деньги (это не прибыль)</h3>
        ${tbl([['Закупки товара', R.purchases, true], ...cats(R.purchaseCats)])}
        <div style="height:10px"></div>
        ${tbl([['Личные снятия и расходы владельца', R.personal, true], ...cats(R.personalCats)])}
        ${R.lastBalances ? `<h3 style="margin-top:16px">Остатки на ${C.dmy(R.lastDate)}</h3>${balancesTable({ balances: R.lastBalances })}` : ''}
      </section>
      <section class="card"><h3>Рейтинг продавцов</h3>${sellersTable(R.sellerRank, true)}</section>
      <section class="card"><h3>Самые продаваемые ароматы</h3>${R.topAromas.length ? `<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Аромат</th><th class="n">Продано</th><th class="n">Подарено</th><th class="n">Масла, мл</th><th class="n">Выручка</th><th class="n">Себест.</th></tr></thead><tbody>${R.topAromas.slice(0, 20).map((a, i) => `<tr><td>${i + 1}</td><td>${esc(a.name)}</td><td class="n">${a.sold}</td><td class="n">${a.gifts}</td><td class="n">${C.fmt(a.ml)}</td><td class="n">${M(a.revenue)}</td><td class="n">${M(a.cost)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Нет продаж ароматов.</p>'}</section>
      <section class="card"><h3>По дням</h3><div class="tbl-wrap"><table><thead><tr><th>Дата</th><th class="n">Чеков</th><th class="n">Выручка</th><th class="n">Вал. прибыль</th><th class="n">Результат</th><th>Статус</th></tr></thead><tbody>${R.perDay.map((d) => `<tr><td><button class="link" data-act="repDay" data-date="${d.date}">${C.dmy(d.date)}</button></td><td class="n">${d.receipts}</td><td class="n">${M(d.revenue)}</td><td class="n">${M(d.gross)}</td><td class="n">${M(d.result)}</td><td>${d.status === 'closed' ? 'закрыта' : '<span class="badge warn">открыта</span>'}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card"><h3>Расхождения</h3>${R.disc.length ? `<ul>${R.disc.map((d) => `<li>${C.dmy(d.date)} · ${esc(d.label)}: <b>${C.signed(d.diff)}</b> ${d.resolved ? '<span class="badge ok">выяснено</span>' : '<span class="badge bad">не выяснено</span>'}${d.comment ? ` · ${esc(d.comment)}` : ''}</li>`).join('')}</ul>` : '<p class="empty">Нет.</p>'}</section>
      <section class="card"><h3>Текст отчёта</h3><div class="row wrap" style="margin-bottom:10px"><button class="btn sm primary" data-act="copyReport">Скопировать</button></div><div class="report" id="reportText">${esc(text)}</div></section>`;
  }

  /* ----- Расхождения ----- */

  function viewDisc() {
    const all = [];
    for (const s of Object.values(S.index)) for (const d of s.disc || []) all.push({ date: s.date, ...d });
    all.sort((a, b) => (a.resolved === b.resolved ? (a.date < b.date ? 1 : -1) : a.resolved ? 1 : -1));
    const pastOpen = openPastDays();
    const gaps = Object.values(S.index).filter((s) => s.closedWithGaps).sort((a, b) => (a.date < b.date ? 1 : -1));
    return `<section class="card"><h2>Расхождения</h2>
        <p class="small muted">Разница между фактом и расчётом. Цифры не исправляются автоматически: выясните причину и отметьте результат.</p>
        <div class="list">${all.length ? all.map((d) => `<div class="li"><div class="row between"><b>${C.dmy(d.date)} · ${esc(d.label)}</b><b class="num ${d.diff < 0 ? 'neg' : ''}">${C.signed(d.diff)}</b></div>
          <div class="small muted">расчёт ${M(d.calc)} · факт ${M(d.fact)}</div>
          <div class="row between wrap" style="margin-top:6px">${d.resolved ? '<span class="badge ok">выяснено</span>' : '<span class="badge bad">не выяснено</span>'}${d.comment ? `<span class="small">${esc(d.comment)}</span>` : ''}<button class="btn sm" data-act="discNote" data-date="${d.date}" data-key="${d.key}">Комментарий</button></div></div>`).join('') : '<p class="empty">Расхождений нет.</p>'}</div>
      </section>
      <section class="card"><h3>Незакрытые смены</h3>${pastOpen.length ? pastOpen.map((d) => `<div class="seller-row"><span>${C.dmy(d.date)} · выручка ${M(d.revenue)}</span><button class="btn sm" data-act="goDate" data-date="${d.date}">Открыть</button></div>`).join('') : '<p class="empty">Нет.</p>'}</section>
      <section class="card"><h3>Закрыты с незаполненными полями</h3>${gaps.length ? gaps.map((d) => `<div class="seller-row"><span>${C.dmy(d.date)}</span><button class="btn sm" data-act="goDate" data-date="${d.date}">Посмотреть</button></div>`).join('') : '<p class="empty">Нет.</p>'}</section>`;
  }

  function openDiscNote(date, key) {
    const s = S.index[date];
    const d = s && (s.disc || []).find((x) => x.key === key);
    if (!d) return;
    const body = modal(`${C.dmy(date)} · ${d.label}`, `<form><p>Расчёт ${M(d.calc)}, факт ${M(d.fact)}, разница <b>${C.signed(d.diff)}</b></p>
      <label>Причина, что выяснили<textarea name="comment" rows="3">${esc(d.comment || '')}</textarea></label>
      <label class="check"><input type="checkbox" name="resolved" ${d.resolved ? 'checked' : ''}> Расхождение выяснено</label>
      <p class="hint">Отметка не меняет цифры. Если нашлась пропущенная операция, внесите её в смену.</p>
      <div class="sheet-f"><button type="button" class="btn" data-act="closeModal">Отмена</button><button class="btn primary">Сохранить</button></div></form>`);
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await act({ type: 'setDiscNote', key, comment: fd.get('comment'), resolved: !!fd.get('resolved') }, date);
        closeModal();
        render();
      } catch (err) {
        fail(err);
      }
    });
  }

  /* ----- Справочник ----- */

  function viewRef() {
    const st = S.settings;
    const q = C.norm(S.refSearch);
    const oils = (st.oils || []).filter((o) => !q || C.norm(o.name).includes(q)).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const tableRows = (tbl, unit) => Object.entries(tbl || {}).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `<tr><td>${String(k).replace('.', ',')} мл</td><td class="n">${unit === '%' ? `${v}%` : M(v)}</td></tr>`).join('');
    return `<section class="card">
        <div class="row between wrap"><h2>Ароматы (${(st.oils || []).length})</h2><div class="row wrap"><button class="btn sm primary" data-act="oilAdd">+ Аромат</button><button class="btn sm" data-act="oilImport">Импорт списком</button></div></div>
        <p class="small muted">Закупочная цена за 1 мл концентрированного масла. Изменение цены сохраняется с датой. Прошлые продажи не пересчитываются.</p>
        <input class="search" id="refSearch" placeholder="Поиск аромата" value="${esc(S.refSearch)}">
        ${oils.length ? `<div class="tbl-wrap"><table><thead><tr><th>Аромат</th><th class="n">Цена за 1 мл</th><th>Обновлено</th><th></th></tr></thead><tbody>${oils.map((o) => `<tr><td>${esc(o.name)}</td><td class="n">${M(o.price)}</td><td class="small muted">${o.updated ? C.dmy(o.updated) : ''}</td><td class="right"><button class="btn sm" data-act="oilEdit" data-id="${o.id}">Изменить</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="note warn">${(st.oils || []).length ? 'Ничего не найдено.' : 'Справочник пуст. Добавьте ароматы или вставьте весь список через «Импорт списком».'}</div>`}
      </section>
      <section class="card"><div class="row between wrap"><h2>Другие товары</h2><button class="btn sm primary" data-act="goodAdd">+ Товар</button></div>
        <p class="small muted">Фиксатор, пустые флаконы и прочее. Себестоимость = своя закупочная стоимость, без формулы духов.</p>
        ${(st.goods || []).length ? `<table><tbody>${st.goods.map((g) => `<tr><td>${esc(g.name)}</td><td class="n">${M(g.cost)}</td><td class="small muted">${g.updated ? C.dmy(g.updated) : ''}</td><td class="right"><button class="btn sm" data-act="goodEdit" data-id="${g.id}">Изменить</button></td></tr>`).join('')}</tbody></table>` : '<p class="empty">Пока нет.</p>'}
      </section>
      <section class="card"><div class="row between wrap"><h2>Продавцы</h2><button class="btn sm" data-act="sellersRef">Изменить</button></div>
        ${(st.sellers || []).length ? `<table><tbody>${st.sellers.map((s) => `<tr><td>${esc(s.name)}</td><td class="n">${M(s.salary)} за смену</td></tr>`).join('')}</tbody></table>` : '<p class="empty">Добавятся автоматически при открытии смены.</p>'}
      </section>
      <section class="card"><h2>Нормы и стоимость материалов</h2>
        <div class="row between"><h3>Основа и фиксатор</h3><button class="btn sm" data-act="basePrice">Изменить</button></div>
        <p><b>${M(st.basePrice)}</b> за 1 мл</p>
        <div class="grid3">
          <div><div class="row between"><h3>Концентрация духов</h3><button class="btn sm" data-act="tbl" data-t="concentration">Изменить</button></div><table><tbody>${tableRows(st.concentration, '%')}</tbody></table></div>
          <div><div class="row between"><h3>Флаконы духов</h3><button class="btn sm" data-act="tbl" data-t="perfumeBottles">Изменить</button></div><table><tbody>${tableRows(st.perfumeBottles)}</tbody></table></div>
          <div><div class="row between"><h3>Флаконы масла</h3><button class="btn sm" data-act="tbl" data-t="oilBottles">Изменить</button></div><table><tbody>${tableRows(st.oilBottles)}</tbody></table></div>
        </div>
        ${(st.changeLog || []).length ? `<h3>Журнал изменений</h3><ul class="small muted">${st.changeLog.slice(-10).reverse().map((c) => `<li>${C.dmy(c.date)}: ${esc(c.text)}</li>`).join('')}</ul>` : ''}
      </section>
      <section class="card"><h2>Данные</h2>
        <div class="row wrap"><button class="btn sm" data-act="export">Скачать резервную копию (JSON)</button>${S.health && S.health.auth ? '<button class="btn sm danger" data-act="logout">Выйти</button>' : ''}</div>
        <p class="hint">Хранилище: ${S.health ? esc(S.health.store) : '—'}. Резервную копию полезно скачивать раз в неделю.</p>
      </section>`;
  }

  function openOilEdit(id, isGood) {
    const listKey = isGood ? 'goods' : 'oils';
    const priceKey = isGood ? 'cost' : 'price';
    const cur = (S.settings[listKey] || []).find((o) => o.id === id);
    const body = modal(cur ? `Изменить: ${cur.name}` : isGood ? 'Новый товар' : 'Новый аромат', `<form autocomplete="off">
      <label>${isGood ? 'Название товара' : 'Название аромата'}<input name="name" value="${esc(cur ? cur.name : '')}" required></label>
      <label>${isGood ? 'Закупочная стоимость за 1 шт., ₸' : 'Закупочная цена за 1 мл масла, ₸'}<input name="price" inputmode="decimal" value="${esc(cur ? fmtNum(cur[priceKey]) : '')}" required></label>
      ${cur && (cur.history || []).length ? `<h3>История цены</h3><ul class="small muted">${cur.history.slice().reverse().map((h) => `<li>${C.dmy(h.date)}: ${M(h[priceKey])}</li>`).join('')}</ul>` : ''}
      <p class="hint">Новая цена применяется к новым продажам. Себестоимость прошлых продаж не меняется.</p>
      <div class="sheet-f">${cur ? '<button type="button" class="btn danger" data-del>Удалить</button>' : '<button type="button" class="btn" data-act="closeModal">Отмена</button>'}<button class="btn primary">Сохранить</button></div></form>`);
    body.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-del]')) return;
      if (!confirm(`Удалить «${cur.name}» из справочника? Прошлые продажи не изменятся.`)) return;
      try {
        await saveSettings((st) => {
          st[listKey] = st[listKey].filter((o) => o.id !== id);
        });
        closeModal();
        render();
      } catch (err) {
        fail(err);
      }
    });
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = String(fd.get('name')).trim();
      const price = C.num(fd.get('price'));
      if (!name || C.blank(fd.get('price')) || (!isGood && !(price > 0))) return toast('Укажите название и цену', true);
      const dupe = (S.settings[listKey] || []).find((o) => C.norm(o.name) === C.norm(name) && o.id !== id);
      if (dupe) return toast(`«${dupe.name}» уже есть в справочнике`, true);
      if (cur && cur[priceKey] !== price && !confirm(`Изменить цену «${name}» с ${M(cur[priceKey])} на ${M(price)}?`)) return;
      const d = today();
      try {
        await saveSettings((st) => {
          const list = st[listKey];
          const o = list.find((x) => x.id === id);
          if (o) {
            if (o[priceKey] !== price) {
              o.history = (o.history || []).concat({ date: d, [priceKey]: price });
              o.updated = d;
            }
            o[priceKey] = price;
            o.name = name;
          } else {
            list.push({ id: uid(), name, [priceKey]: price, updated: d, history: [{ date: d, [priceKey]: price }] });
          }
        });
        closeModal();
        render();
        toast('Справочник обновлён');
      } catch (err) {
        fail(err);
      }
    });
  }

  function openImport() {
    const body = modal('Импорт ароматов списком', `<form>
      <p class="small">Вставьте список: каждый аромат с новой строки, цена за 1 мл в конце строки.</p>
      <p class="small muted">Например: «Baccarat Rouge 540 — 120» или «Black Opium; 85».</p>
      <textarea name="text" rows="10" placeholder="Название — цена"></textarea>
      <div id="impPrev"></div>
      <div class="sheet-f"><button type="button" class="btn" data-prev>Проверить</button><button class="btn primary" disabled>Загрузить</button></div></form>`, true);
    const form = $('form', body);
    let parsed = null;
    const preview = () => {
      parsed = C.parsePriceList(form.text.value);
      const rows = parsed.rows.map((r) => {
        const ex = C.findOil(S.settings, r.name);
        const st = !ex ? '<span class="badge ok">новый</span>' : ex.price === r.price ? '<span class="badge">без изменений</span>' : `<span class="badge warn">цена ${M(ex.price)} → ${M(r.price)}</span>`;
        return `<tr><td>${esc(r.name)}</td><td class="n">${M(r.price)}</td><td>${st}</td></tr>`;
      }).join('');
      $('#impPrev', form).innerHTML = `${parsed.rows.length ? `<div class="tbl-wrap" style="max-height:300px;overflow:auto"><table><tbody>${rows}</tbody></table></div>` : ''}
        ${parsed.bad.length ? `<div class="note bad small">Не распознаны строки (${parsed.bad.length}):<ul>${parsed.bad.slice(0, 10).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
        <p class="small">Распознано: ${parsed.rows.length}</p>`;
      $('button.primary', form).disabled = !parsed.rows.length;
    };
    body.addEventListener('click', (e) => {
      if (e.target.closest('[data-prev]')) preview();
    });
    form.text.addEventListener('input', () => {
      $('button.primary', form).disabled = true;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      preview();
      if (!parsed.rows.length) return;
      const changed = parsed.rows.filter((r) => {
        const ex = C.findOil(S.settings, r.name);
        return ex && ex.price !== r.price;
      });
      if (changed.length && !confirm(`У ${changed.length} ароматов изменится цена. Подтверждаете?`)) return;
      const d = today();
      try {
        await saveSettings((st) => {
          for (const r of parsed.rows) {
            const ex = st.oils.find((o) => C.norm(o.name) === C.norm(r.name));
            if (ex) {
              if (ex.price !== r.price) {
                ex.history = (ex.history || []).concat({ date: d, price: r.price });
                ex.updated = d;
                ex.price = r.price;
              }
            } else {
              st.oils.push({ id: uid(), name: r.name, price: r.price, updated: d, history: [{ date: d, price: r.price }] });
            }
          }
        });
        closeModal();
        render();
        toast(`Загружено: ${parsed.rows.length}`);
      } catch (err) {
        fail(err);
      }
    });
  }

  const TBL_NAMES = { concentration: 'Концентрация масла в духах, %', perfumeBottles: 'Стоимость флаконов для духов, ₸', oilBottles: 'Стоимость флаконов для масла, ₸' };

  function openTable(key) {
    const tbl = S.settings[key] || {};
    const row = (k, v) => `<div class="grid3 trow"><label>Объём, мл<input name="k" inputmode="decimal" value="${esc(k)}"></label><label>${key === 'concentration' ? 'Масло, %' : 'Стоимость, ₸'}<input name="v" inputmode="decimal" value="${esc(v)}"></label><div style="align-self:end"><button type="button" class="btn sm danger" data-rm>Убрать</button></div></div>`;
    const body = modal(TBL_NAMES[key], `<form><div id="trows">${Object.entries(tbl).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => row(k, v)).join('')}</div>
      <button type="button" class="btn sm" data-add>+ Строка</button>
      <p class="hint">Изменения применяются к новым продажам. Прошлые продажи не пересчитываются.</p>
      <div class="sheet-f"><button type="button" class="btn" data-act="closeModal">Отмена</button><button class="btn primary">Сохранить</button></div></form>`);
    body.addEventListener('click', (e) => {
      if (e.target.closest('[data-add]')) $('#trows', body).insertAdjacentHTML('beforeend', row('', ''));
      const rm = e.target.closest('[data-rm]');
      if (rm) rm.closest('.trow').remove();
    });
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const next = {};
      for (const r of $$('.trow', body)) {
        const k = C.num($('[name=k]', r).value);
        const v = $('[name=v]', r).value;
        if (k > 0 && !C.blank(v)) next[String(k)] = C.num(v);
      }
      const diffs = [];
      const keys = new Set([...Object.keys(tbl), ...Object.keys(next)]);
      for (const k of keys) if (tbl[k] !== next[k]) diffs.push(`${k} мл: ${tbl[k] === undefined ? '—' : tbl[k]} → ${next[k] === undefined ? 'удалено' : next[k]}`);
      if (!diffs.length) return closeModal();
      if (!confirm(`Подтвердите изменения:\n${diffs.join('\n')}`)) return;
      try {
        await saveSettings((st) => {
          st[key] = next;
          st.changeLog = (st.changeLog || []).concat({ date: today(), text: `${TBL_NAMES[key]}: ${diffs.join('; ')}` });
        });
        closeModal();
        render();
        toast('Сохранено');
      } catch (err) {
        fail(err);
      }
    });
  }

  function openBasePrice() {
    const cur = S.settings.basePrice;
    const body = modal('Цена основы и фиксатора', `<form><label>Цена за 1 мл, ₸<input name="p" inputmode="decimal" value="${esc(cur)}"></label>
      <p class="hint">Используется для новых продаж духов. Прошлые продажи не пересчитываются.</p>
      <div class="sheet-f"><button type="button" class="btn" data-act="closeModal">Отмена</button><button class="btn primary">Сохранить</button></div></form>`);
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = C.num(new FormData(e.target).get('p'));
      if (!(p > 0)) return toast('Укажите цену', true);
      if (p === cur) return closeModal();
      if (!confirm(`Изменить цену основы с ${M(cur)} на ${M(p)} за 1 мл?`)) return;
      try {
        await saveSettings((st) => {
          st.basePrice = p;
          st.changeLog = (st.changeLog || []).concat({ date: today(), text: `Цена основы: ${cur} → ${p} ₸/мл` });
        });
        closeModal();
        render();
      } catch (err) {
        fail(err);
      }
    });
  }

  function openSellersRef() {
    const list = S.settings.sellers || [];
    const row = (s) => `<div class="grid3 srow"><label>Имя<input name="n" value="${esc(s.name)}"></label><label>Зарплата за смену, ₸<input name="s" inputmode="decimal" value="${esc(fmtNum(s.salary))}"></label><div style="align-self:end"><button type="button" class="btn sm danger" data-rm>Убрать</button></div></div>`;
    const body = modal('Продавцы', `<form><div id="srows">${list.map(row).join('')}</div><button type="button" class="btn sm" data-add>+ Продавец</button>
      <p class="hint">Это подсказки для открытия смены. Зарплата каждой смены всё равно подтверждается при открытии.</p>
      <div class="sheet-f"><button type="button" class="btn" data-act="closeModal">Отмена</button><button class="btn primary">Сохранить</button></div></form>`);
    body.addEventListener('click', (e) => {
      if (e.target.closest('[data-add]')) $('#srows', body).insertAdjacentHTML('beforeend', row({ name: '', salary: '' }));
      const rm = e.target.closest('[data-rm]');
      if (rm) rm.closest('.srow').remove();
    });
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const next = $$('.srow', body).map((r) => ({ name: $('[name=n]', r).value.trim(), salary: C.num($('[name=s]', r).value) })).filter((s) => s.name);
      try {
        await saveSettings((st) => {
          st.sellers = next;
        });
        closeModal();
        render();
      } catch (err) {
        fail(err);
      }
    });
  }

  async function exportData() {
    try {
      const data = await api('GET', '/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `al-musk-${today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (err) {
      fail(err);
    }
  }

  /* ---------- События ---------- */

  async function setDate(d) {
    if (!d) return;
    S.date = d;
    S.rep.date = d;
    try {
      await loadDay();
    } catch (err) {
      fail(err);
    }
    render();
    window.scrollTo({ top: 0 });
  }

  const ACTIONS = {
    closeModal,
    prevDay: () => setDate(addDays(S.date, -1)),
    nextDay: () => setDate(addDays(S.date, 1)),
    goToday: () => setDate(today()),
    goDate: (b) => {
      S.tab = 'shift';
      LS.set('am_tab', 'shift');
      closeModal();
      setDate(b.dataset.date);
    },
    addOpenSeller: () => $('#openSellers').insertAdjacentHTML('beforeend', sellerRowHtml({ start: nowTime() })),
    fillPrev: (b) => {
      const p = S.index[b.dataset.date];
      const f = $('#openForm');
      if (!p || !f) return;
      for (const acc of C.ACCOUNTS) {
        const c = p.closing[acc];
        if (c && c.tracked && c.fact !== null) f[acc].value = c.fact;
      }
      if (p.closing.transfer && !p.closing.transfer.tracked) f.transferTracked.checked = false;
      toast('Проверьте суммы и откройте смену');
    },
    newSale: () => openSale(),
    editSale: (b) => openSale(S.day.sales.find((s) => s.id === b.dataset.id)),
    delSale: async (b) => {
      const sale = S.day.sales.find((s) => s.id === b.dataset.id);
      const c = C.saleCalc(sale);
      const reason = prompt(`Удалить продажу ${sale.time || ''} на ${M(c.revenue)}?\nУкажите причину (запись сохранится в журнале):`);
      if (reason === null) return;
      if (!reason.trim()) return toast('Без причины удаление не выполняется', true);
      try {
        await act({ type: 'removeSale', id: sale.id, reason });
        render();
        toast('Продажа удалена');
      } catch (err) {
        fail(err);
      }
    },
    newOp: () => openOp(),
    editOp: (b) => openOp(S.day.ops.find((o) => o.id === b.dataset.id)),
    delOp: async (b) => {
      const op = S.day.ops.find((o) => o.id === b.dataset.id);
      const reason = prompt(`Удалить операцию «${op.category}» на ${M(op.amount)}?\nУкажите причину:`);
      if (reason === null) return;
      if (!reason.trim()) return toast('Без причины удаление не выполняется', true);
      try {
        await act({ type: 'removeOp', id: op.id, reason });
        render();
      } catch (err) {
        fail(err);
      }
    },
    editSellers: openSellers,
    paySeller: (b) => openPay(b.dataset.id),
    editOpening: openOpening,
    openClosing,
    showDayReport: () => {
      modal('Предварительный отчёт', `<div class="row wrap" style="margin-bottom:10px"><button class="btn sm primary" data-act="copyDay">Скопировать</button></div><div class="report">${esc(C.dailyReportText(S.day))}</div>`, true);
    },
    copyDay: () => copyText(C.dailyReportText(S.day)),
    copyReport: () => copyText($('#reportText').textContent),
    viewPhoto: (b) => viewPhoto(b.dataset.date || S.date),
    reopen: async () => {
      const reason = prompt('Открыть закрытую смену для исправления?\nУкажите причину (сохранится в журнале):');
      if (reason === null) return;
      if (!reason.trim()) return toast('Укажите причину', true);
      try {
        await act({ type: 'reopen', reason });
        render();
        toast('Смена открыта для исправления. Не забудьте закрыть её снова.');
      } catch (err) {
        fail(err);
      }
    },
    repMode: (b) => {
      S.rep.mode = b.dataset.mode;
      render();
    },
    repDay: (b) => {
      S.rep.mode = 'day';
      S.rep.date = b.dataset.date;
      S.tab = 'reports';
      render();
    },
    repPreset: (b) => {
      S.rep.preset = b.dataset.p;
      [S.rep.from, S.rep.to] = presetRange(b.dataset.p);
      render();
    },
    repRange: () => {
      S.rep.from = $('#repFrom').value;
      S.rep.to = $('#repTo').value;
      S.rep.preset = '';
      if (!S.rep.from || !S.rep.to || S.rep.from > S.rep.to) return toast('Проверьте период', true);
      render();
    },
    discNote: (b) => openDiscNote(b.dataset.date, b.dataset.key),
    oilAdd: () => openOilEdit(null, false),
    oilEdit: (b) => openOilEdit(b.dataset.id, false),
    oilImport: openImport,
    goodAdd: () => openOilEdit(null, true),
    goodEdit: (b) => openOilEdit(b.dataset.id, true),
    sellersRef: openSellersRef,
    tbl: (b) => openTable(b.dataset.t),
    basePrice: openBasePrice,
    export: exportData,
    logout: () => {
      LS.del('am_pin');
      S.pin = '';
      location.reload();
    },
  };

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      S.tab = tab.dataset.tab;
      LS.set('am_tab', S.tab);
      render();
      window.scrollTo({ top: 0 });
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b || !ACTIONS[b.dataset.act]) return;
    e.preventDefault();
    Promise.resolve(ACTIONS[b.dataset.act](b)).catch(fail);
  });
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'openForm') {
      e.preventDefault();
      const btn = $('button.primary', e.target);
      btn.disabled = true;
      submitOpen(e.target).catch(fail).finally(() => (btn.disabled = false));
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'dateInput') setDate(e.target.value);
    if (e.target.id === 'repDate') {
      S.rep.date = e.target.value;
      render();
    }
    // Подставляем зарплату продавца из справочника
    if (e.target.name === 'sname') {
      const s = (S.settings.sellers || []).find((x) => C.norm(x.name) === C.norm(e.target.value));
      const sal = e.target.closest('.seller-in') && $('[name=ssalary]', e.target.closest('.seller-in'));
      if (s && sal && C.blank(sal.value)) sal.value = s.salary;
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'refSearch') {
      S.refSearch = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const inp = $('#refSearch');
      inp.focus();
      inp.setSelectionRange(pos, pos);
    }
  });
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    S.pin = $('#pinInput').value.trim();
    try {
      await api('POST', '/api/login');
      LS.set('am_pin', S.pin);
      $('#login').hidden = true;
      $('#pinInput').value = '';
      await loadAll();
    } catch (err) {
      $('#loginErr').textContent = err.message;
    }
  });

  async function boot() {
    try {
      S.health = await api('GET', '/api/health');
      renderBanner();
      if (S.health.auth && !S.pin) return showLogin();
      await loadAll();
    } catch (err) {
      if (err.status === 401) return;
      $('#view').innerHTML = `<section class="card"><div class="note bad">${esc(err.message)}</div><button class="btn" onclick="location.reload()">Повторить</button></section>`;
    }
  }
  boot();
})();
