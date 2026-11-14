/*
 * Al Musk: склад. Приход после закупа, автоматическое списание по продажам,
 * ревизия и выгрузка в Excel. Использует общие функции приложения из window.AM.
 */
(function () {
  'use strict';
  const C = window.Calc;
  const M = C.money;
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const AM = () => window.AM;

  const St = { doc: null, cons: null, rev: 0, tab: 'oil', q: '', all: false, revDraft: {} };
  const TABS = [['oil', 'Масла'], ['bottle', 'Флаконы и основа'], ['good', 'Товары']];
  const inTab = (it, tab) => (tab === 'oil' ? it.kind === 'oil' : tab === 'bottle' ? it.kind === 'bottle' || it.kind === 'base' : it.kind === 'good');
  const qty = (it, q = it.qty) => `${C.fmt(q)} ${it.unit}`;

  async function load() {
    const r = await AM().api('GET', '/api/stock');
    St.doc = r.value;
    St.cons = r.cons;
    St.rev = r.rev;
    return r;
  }
  const state = (asOf) => C.stockState(St.doc, St.cons, AM().S.settings, AM().today(), asOf);

  /* ---------- Экран склада ---------- */

  function view() {
    return '<div id="skOut"><div class="loading">Считаю остатки…</div></div>';
  }

  async function mount() {
    try {
      await load();
      draw();
    } catch (err) {
      const out = $('#skOut');
      if (out) out.innerHTML = `<section class="card"><div class="note bad">${esc(err.message)}</div></section>`;
    }
  }

  function rowHtml(it) {
    const flag = it.negative ? '<span class="badge bad">минус</span>' : it.low ? '<span class="badge warn">мало</span>' : '';
    const left = it.daysLeft === null ? '—' : it.daysLeft > 365 ? '> года' : `${it.daysLeft} дн.`;
    return `<tr><td>${esc(it.name)} ${flag}${it.revDate ? `<div class="small muted">ревизия ${C.dmy(it.revDate)}</div>` : ''}</td>
      <td class="n"><b>${qty(it)}</b></td><td class="n hide-sm">${it.cons30 ? qty(it, it.cons30) : '—'}</td><td class="n">${left}</td><td class="n hide-sm">${it.value === null ? '—' : M(it.value)}</td></tr>`;
  }

  function draw() {
    const out = $('#skOut');
    if (!out || !St.doc) return;
    const list = state();
    const tracked = list.filter((i) => i.tracked);
    const value = tracked.reduce((a, i) => a + (i.value || 0), 0);
    const low = tracked.filter((i) => i.low && !i.negative);
    const neg = tracked.filter((i) => i.negative);
    const q = C.norm(St.q);
    let rows = list.filter((i) => inTab(i, St.tab) && (!q || C.norm(i.name).includes(q)));
    const hiddenUntracked = rows.filter((i) => !i.tracked).length;
    if (!St.all && !q) rows = rows.filter((i) => i.tracked || i.kind !== 'oil');
    rows.sort((a, b) => (b.negative - a.negative) || (b.low - a.low) || ((a.daysLeft === null ? 1e9 : a.daysLeft) - (b.daysLeft === null ? 1e9 : b.daysLeft)) || a.name.localeCompare(b.name, 'ru'));
    const hist = [
      ...Object.values((St.doc.receipts || []).reduce((g, r) => {
        const b = (g[r.batch] = g[r.batch] || { type: 'receipt', batch: r.batch, date: r.date, at: r.at, lines: [], sum: 0, note: r.note });
        b.lines.push(r);
        b.sum += C.num(r.sum);
        return g;
      }, {})),
      ...(St.doc.revisions || []).map((r) => ({ type: 'revision', ...r })),
    ].sort((a, b) => ((a.at || a.date) < (b.at || b.date) ? 1 : -1)).slice(0, 15);
    const k = (l, v, cls = '') => `<div class="kpi ${cls}"><div class="l">${esc(l)}</div><div class="v">${v}</div></div>`;
    out.innerHTML = `<div class="row between wrap" style="margin-bottom:10px"><h2 style="margin:0">Склад</h2>
        <div class="row wrap"><button class="btn sm primary" data-sk="receipt">+ Приход (закуп)</button><button class="btn sm" data-sk="revision">Ревизия</button><button class="btn sm" data-sk="xlsStock">Excel остатки</button></div></div>
      <div class="kpis">${k('Стоимость остатков', M(value), 'hl')}${k('Позиций в учёте', tracked.length)}${k('Заканчивается', low.length)}${k('Ушло в минус', neg.length)}</div>
      ${!tracked.length ? `<div class="note info"><b>Как начать.</b> 1) Проведите ревизию: пересчитайте масла, основу и флаконы, чтобы задать стартовые остатки. 2) После каждого закупа вносите приход. Продажи списываются сами: масло и основа в мл, флаконы и товары в штуках.</div>` : ''}
      ${neg.length ? `<div class="note bad small">В минусе: ${neg.slice(0, 8).map((i) => `${esc(i.name)} (${qty(i)})`).join(', ')}. Продали больше, чем было по учёту: внесите пропущенный приход или проведите ревизию.</div>` : ''}
      <section class="card">
        <div class="seg" style="margin-bottom:10px">${TABS.map(([t, l]) => `<button data-sk="tab" data-t="${t}" class="${St.tab === t ? 'on' : ''}">${l}</button>`).join('')}</div>
        <input class="search" id="skSearch" placeholder="Поиск" value="${esc(St.q)}">
        ${St.tab === 'oil' && hiddenUntracked && !q ? `<label class="check"><input type="checkbox" id="skAll" ${St.all ? 'checked' : ''}> Показать все ароматы справочника (${hiddenUntracked} без движения)</label>` : ''}
        ${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Позиция</th><th class="n">Остаток</th><th class="n hide-sm">Расход 30 дн.</th><th class="n">Хватит</th><th class="n hide-sm">Стоимость</th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table></div>` : '<p class="empty">Нет позиций. Внесите приход или проведите ревизию.</p>'}
        <p class="hint">Остаток = последняя ревизия + приходы после неё − продажи после неё (подарки тоже списываются). «Хватит» считается по среднему расходу за 30 дней.</p>
      </section>
      <section class="card"><h3>История склада</h3>${hist.length ? `<div class="list">${hist.map((h) => h.type === 'receipt'
        ? `<div class="li"><div class="row between wrap"><b>${C.dmy(h.date)} · приход</b><span class="num">${M(h.sum)}</span></div>
            <div class="small muted">${h.lines.map((l) => `${esc(l.name)}: ${C.fmt(l.qty)} ${l.kind === 'oil' || l.kind === 'base' ? 'мл' : 'шт'}`).join(', ')}${h.note ? ` · ${esc(h.note)}` : ''}</div>
            <div class="row" style="margin-top:6px"><button class="btn sm danger" data-sk="delReceipt" data-id="${h.batch}">Удалить</button></div></div>`
        : `<div class="li"><div class="row between wrap"><b>${C.dmy(h.date)} · ревизия</b><span class="small">${h.items.length} поз.</span></div>
            <div class="small muted">Расхождение: ${M(revDiffValue(h))}${h.note ? ` · ${esc(h.note)}` : ''}</div>
            <div class="row wrap" style="margin-top:6px"><button class="btn sm" data-sk="xlsRev" data-id="${h.id}">Excel</button><button class="btn sm danger" data-sk="delRevision" data-id="${h.id}">Удалить</button></div></div>`).join('')}</div>` : '<p class="empty">Пока пусто.</p>'}</section>`;
  }

  const revDiffValue = (rv) => C.r2(rv.items.reduce((a, r) => a + (C.num(r.counted) - C.num(r.expected)) * (r.unitCost === null || r.unitCost === undefined ? 0 : C.num(r.unitCost)), 0));

  /* ---------- Приход ---------- */

  const LINE_KINDS = [['oil', 'Масло, мл'], ['base', 'Основа, мл'], ['bottle:perfume', 'Флакон для духов, шт'], ['bottle:oil', 'Флакон для масла, шт'], ['good', 'Товар, шт']];

  function refPrice(l) {
    const st = AM().S.settings;
    if (l.kind === 'oil') {
      const o = C.findOil(st, l.name);
      return o && C.hasPrice(o) ? C.num(o.price) : null;
    }
    if (l.kind === 'base') return C.num(st.basePrice);
    if (l.kind === 'bottle') {
      const v = C.tableValue(l.bottleType === 'oil' ? st.oilBottles : st.perfumeBottles, l.volume);
      return v === null ? null : C.num(v);
    }
    const g = C.findGood(st, l.name);
    return g ? C.num(g.cost) : null;
  }

  function openReceipt() {
    const A = AM();
    const st = A.S.settings;
    const lines = [{ kind: 'oil', name: '', qty: '', sum: '', volume: '', bottleType: 'perfume', update: true }];
    const vols = (t) => Object.keys(t === 'oil' ? st.oilBottles : st.perfumeBottles).map(Number).sort((a, b) => a - b);
    const lineHtml = (l, i) => {
      const kv = l.kind === 'bottle' ? `bottle:${l.bottleType}` : l.kind;
      const unit = l.kind === 'oil' || l.kind === 'base' ? 'мл' : 'шт';
      const up = C.num(l.qty) > 0 && C.num(l.sum) > 0 ? C.num(l.sum) / C.num(l.qty) : null;
      const ref = refPrice(l);
      const differs = up !== null && (ref === null || Math.abs(C.r2(up) - ref) >= 0.01);
      const newOil = l.kind === 'oil' && !C.blank(l.name) && !C.findOil(st, l.name);
      const newGood = l.kind === 'good' && !C.blank(l.name) && !C.findGood(st, l.name);
      return `<div class="item" data-i="${i}">
        <div class="row between"><select data-f="kindSel" style="max-width:240px">${LINE_KINDS.map(([v, lab]) => `<option value="${v}" ${v === kv ? 'selected' : ''}>${lab}</option>`).join('')}</select>${lines.length > 1 ? `<button type="button" class="btn sm danger" data-rm="${i}">Убрать</button>` : ''}</div>
        <div class="grid3">
          ${l.kind === 'oil' || l.kind === 'good' ? `<label>${l.kind === 'oil' ? 'Аромат' : 'Товар'}<input data-f="name" list="${l.kind === 'oil' ? 'oilList' : 'goodsList'}" value="${esc(l.name)}" autocomplete="off"></label>` : ''}
          ${l.kind === 'bottle' ? `<label>Объём флакона<select data-f="volume"><option value="">выберите</option>${vols(l.bottleType).map((v) => `<option value="${v}" ${C.num(l.volume) === v ? 'selected' : ''}>${C.fmt(v)} мл</option>`).join('')}</select></label>` : ''}
          <label>Количество, ${unit}<input data-f="qty" inputmode="decimal" value="${esc(l.qty)}"></label>
          <label>Заплатили, ₸<input data-f="sum" inputmode="decimal" value="${esc(l.sum)}"></label>
        </div>
        <div class="hint" data-info>${up === null ? 'Цена за единицу посчитается сама.' : `= ${M(up)} за ${unit}${ref !== null ? ` · в справочнике ${M(ref)}` : ''}`}${newOil ? ' · аромата нет в справочнике' : ''}${newGood ? ' · товара нет в справочнике' : ''}</div>
        ${differs || newOil || newGood ? `<label class="check"><input type="checkbox" data-f="update" ${l.update ? 'checked' : ''}> ${newOil || newGood ? 'Добавить в справочник с этой ценой' : 'Обновить цену в справочнике (новые продажи будут считаться по ней)'}</label>` : ''}
      </div>`;
    };
    const body = A.modal('Приход на склад', `<form id="rcForm" autocomplete="off">
      <div class="grid2"><label>Дата закупа<input type="date" name="date" value="${A.today()}"></label>
        <label>Оплата<select name="payFrom"><option value="">не записывать в операции</option>${C.ACCOUNTS.map((a) => `<option value="${a}">${C.ACC_LABEL[a]}</option>`).join('')}</select></label></div>
      <p class="hint">Если выбрать счёт оплаты, в смену этой даты добавится расход «Закупка товара». Смена должна быть открыта.</p>
      <div id="rcLines"></div>
      <button type="button" class="btn sm" data-add>+ Ещё позиция</button>
      <label>Комментарий<input name="note" placeholder="поставщик, накладная"></label>
      <div id="rcTotal"></div><div id="rcErr"></div>
      <div class="sheet-f"><button type="button" class="btn" data-act="closeModal">Отмена</button><button class="btn primary">Внести приход</button></div></form>`, true);
    const form = $('#rcForm', body);
    const box = $('#rcLines', form);
    const total = () => {
      const s = lines.reduce((a, l) => a + C.num(l.sum), 0);
      $('#rcTotal', form).innerHTML = s ? `<p><b>Итого закуп: ${M(s)}</b></p>` : '';
    };
    const renderLines = () => {
      box.innerHTML = lines.map(lineHtml).join('');
      total();
    };
    renderLines();
    form.addEventListener('click', (e) => {
      if (e.target.closest('[data-add]')) {
        const last = lines[lines.length - 1];
        lines.push({ kind: last ? last.kind : 'oil', bottleType: last ? last.bottleType : 'perfume', name: '', qty: '', sum: '', volume: '', update: true });
        renderLines();
      }
      const rm = e.target.closest('[data-rm]');
      if (rm) {
        lines.splice(Number(rm.dataset.rm), 1);
        renderLines();
      }
    });
    form.addEventListener('input', (e) => {
      const it = e.target.closest('.item');
      const f = e.target.dataset.f;
      if (!it || !f || f === 'kindSel' || f === 'volume') return;
      const l = lines[Number(it.dataset.i)];
      l[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (f !== 'update') {
        // перерисовываем только подсказку и галочку, чтобы не сбить ввод
        const tmp = document.createElement('div');
        tmp.innerHTML = lineHtml(l, Number(it.dataset.i));
        const fresh = tmp.firstElementChild;
        $('[data-info]', it).innerHTML = $('[data-info]', fresh).innerHTML;
        const oldChk = $('label.check', it);
        const newChk = $('label.check', fresh);
        if (oldChk && !newChk) oldChk.remove();
        else if (!oldChk && newChk) it.appendChild(newChk);
        else if (oldChk && newChk) oldChk.lastChild.textContent = newChk.lastChild.textContent;
        total();
      }
    });
    form.addEventListener('change', (e) => {
      const it = e.target.closest('.item');
      const f = e.target.dataset.f;
      if (!it || (f !== 'kindSel' && f !== 'volume')) return;
      const l = lines[Number(it.dataset.i)];
      if (f === 'kindSel') {
        const [kind, bt] = e.target.value.split(':');
        Object.assign(l, { kind, bottleType: bt || 'perfume', name: '', volume: '' });
      } else l.volume = e.target.value;
      renderLines();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const date = fd.get('date');
      const errs = [];
      lines.forEach((l, i) => {
        if ((l.kind === 'oil' || l.kind === 'good') && C.blank(l.name)) errs.push(`Позиция ${i + 1}: укажите название`);
        if (l.kind === 'bottle' && !(C.num(l.volume) > 0)) errs.push(`Позиция ${i + 1}: выберите объём флакона`);
        if (!(C.num(l.qty) > 0)) errs.push(`Позиция ${i + 1}: укажите количество`);
        if (C.blank(l.sum)) errs.push(`Позиция ${i + 1}: укажите, сколько заплатили (0, если бесплатно)`);
      });
      if (!date) errs.push('Укажите дату');
      if (errs.length) {
        $('#rcErr', form).innerHTML = `<div class="note bad"><ul>${errs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
        return;
      }
      // Обновление цен справочника: только отмеченные позиции
      const upd = lines.filter((l) => l.update && C.num(l.sum) > 0 && C.num(l.qty) > 0 && (refPrice(l) === null || Math.abs(C.r2(C.num(l.sum) / C.num(l.qty)) - refPrice(l)) >= 0.01));
      if (upd.length) {
        const msg = upd.map((l) => `${l.kind === 'base' ? 'Основа' : l.kind === 'bottle' ? C.bottleName(`${l.bottleType}:${C.num(l.volume)}`) : l.name}: ${refPrice(l) === null ? 'новая' : M(refPrice(l))} → ${M(C.r2(C.num(l.sum) / C.num(l.qty)))}`).join('\n');
        if (!confirm(`Обновить цены в справочнике?\n${msg}\n\nПрошлые продажи не пересчитываются.`)) return;
      }
      const btn = $('button.primary', form);
      btn.disabled = true;
      try {
        if (upd.length) {
          const d = A.today();
          await A.saveSettings((s) => {
            for (const l of upd) {
              const p = C.r2(C.num(l.sum) / C.num(l.qty));
              if (l.kind === 'oil') {
                const o = s.oils.find((x) => C.norm(x.name) === C.norm(l.name));
                if (o) {
                  o.price = p;
                  o.updated = d;
                  o.history = (o.history || []).concat({ date: d, price: p });
                } else s.oils.push({ id: A.uid(), name: l.name.trim(), price: p, updated: d, history: [{ date: d, price: p }] });
              } else if (l.kind === 'good') {
                const g = s.goods.find((x) => C.norm(x.name) === C.norm(l.name));
                if (g) {
                  g.cost = p;
                  g.updated = d;
                  g.history = (g.history || []).concat({ date: d, cost: p });
                } else s.goods.push({ id: A.uid(), name: l.name.trim(), cost: p, updated: d, history: [{ date: d, cost: p }] });
              } else if (l.kind === 'base') {
                s.changeLog = (s.changeLog || []).concat({ date: d, text: `Цена основы по закупу: ${s.basePrice} → ${p} ₸/мл` });
                s.basePrice = p;
              } else {
                const t = l.bottleType === 'oil' ? 'oilBottles' : 'perfumeBottles';
                const v = String(C.num(l.volume));
                s.changeLog = (s.changeLog || []).concat({ date: d, text: `${C.bottleName(`${l.bottleType}:${v}`)} по закупу: ${s[t][v] === undefined ? '—' : s[t][v]} → ${p} ₸` });
                s[t][v] = p;
              }
            }
          });
        }
        const r = await A.api('POST', '/api/stock', { type: 'receipt', date, payFrom: fd.get('payFrom') || '', note: fd.get('note'), lines: lines.map((l) => ({ kind: l.kind, name: l.name, volume: l.volume, bottleType: l.bottleType, qty: l.qty, sum: l.sum })) });
        St.doc = r.value;
        St.rev = r.rev;
        if (fd.get('payFrom') && date === A.S.date) await A.loadDay();
        A.closeModal();
        A.render();
        A.toast(`Приход внесён${r.payNote ? `. ${r.payNote}` : ''}`, r.payNote && r.payNote.includes('не открыта'));
      } catch (err) {
        btn.disabled = false;
        A.fail(err);
      }
    });
  }

  /* ---------- Ревизия ---------- */

  function openRevision() {
    const A = AM();
    const R = { date: A.today(), tab: 'oil', q: '', all: false, note: '' };
    St.revDraft = {};
    const body = A.modal('Ревизия склада', `<form id="rvForm" autocomplete="off">
      <div class="grid2"><label>Дата ревизии<input type="date" name="date" value="${R.date}"></label><label>Комментарий<input name="note" placeholder="кто считал"></label></div>
      <p class="hint">Остатки фиксируются на конец выбранного дня. Если считаете утром до открытия смены, выберите вчерашнюю дату. Можно внести только часть позиций: остальные не изменятся.</p>
      <div class="seg" style="margin:6px 0 10px">${TABS.map(([t, l]) => `<button type="button" data-rt="${t}" class="${t === R.tab ? 'on' : ''}">${l}</button>`).join('')}</div>
      <input class="search" id="rvSearch" placeholder="Поиск">
      <label class="check"><input type="checkbox" id="rvAll"> Показать все позиции справочника</label>
      <div id="rvRows"></div>
      <div id="rvSum"></div>
      <div class="sheet-f"><button type="button" class="btn" data-act="closeModal">Отмена</button><button class="btn primary">Сохранить ревизию</button></div></form>`, true);
    const form = $('#rvForm', body);
    let list = state(R.date);
    const byId = () => Object.fromEntries(list.map((i) => [i.id, i]));
    const summary = () => {
      const m = byId();
      let n = 0;
      let minus = 0;
      let plus = 0;
      for (const [id, v] of Object.entries(St.revDraft)) {
        if (C.blank(v) || !m[id]) continue;
        n += 1;
        const d = (C.num(v) - m[id].qty) * (m[id].unitCost || 0);
        if (d < 0) minus += d;
        else plus += d;
      }
      $('#rvSum', form).innerHTML = n ? `<div class="note info small">Внесено позиций: ${n}. Недостача: ${M(minus)}. Излишек: ${M(plus)}.</div>` : '';
    };
    const rows = () => {
      const q = C.norm(R.q);
      let rs = list.filter((i) => inTab(i, R.tab) && (!q || C.norm(i.name).includes(q)));
      if (!R.all && !q && R.tab === 'oil') rs = rs.filter((i) => i.tracked || !C.blank(St.revDraft[i.id]));
      rs.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      $('#rvRows', form).innerHTML = rs.length
        ? `<div class="tbl-wrap"><table><thead><tr><th>Позиция</th><th class="n">По учёту</th><th class="n">Факт</th><th class="n">Разница</th></tr></thead><tbody>${rs.map((i) => {
          const v = St.revDraft[i.id];
          const d = C.blank(v) ? null : C.r2(C.num(v) - i.qty);
          return `<tr><td>${esc(i.name)}</td><td class="n">${qty(i)}</td><td class="n" style="width:110px"><input data-id="${esc(i.id)}" inputmode="decimal" value="${esc(v || '')}" placeholder="${i.unit}" style="padding:6px 8px;text-align:right"></td><td class="n" data-d="${esc(i.id)}">${d === null ? '' : d === 0 ? 'сходится' : `${d > 0 ? '+' : ''}${C.fmt(d)}`}</td></tr>`;
        }).join('')}</tbody></table></div>`
        : `<p class="empty">${R.tab === 'oil' && !R.all ? 'Нет ароматов в учёте. Отметьте «Показать все позиции» или найдите аромат поиском.' : 'Ничего не найдено.'}</p>`;
      summary();
    };
    rows();
    form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rt]');
      if (!b) return;
      R.tab = b.dataset.rt;
      $$('[data-rt]', form).forEach((x) => x.classList.toggle('on', x === b));
      rows();
    });
    form.addEventListener('input', (e) => {
      if (e.target.id === 'rvSearch') {
        R.q = e.target.value;
        rows();
      } else if (e.target.dataset.id) {
        const id = e.target.dataset.id;
        St.revDraft[id] = e.target.value;
        const it = byId()[id];
        const cell = $(`[data-d="${CSS.escape(id)}"]`, form);
        if (cell && it) {
          const d = C.blank(e.target.value) ? null : C.r2(C.num(e.target.value) - it.qty);
          cell.textContent = d === null ? '' : d === 0 ? 'сходится' : `${d > 0 ? '+' : ''}${C.fmt(d)}`;
        }
        summary();
      }
    });
    form.addEventListener('change', (e) => {
      if (e.target.id === 'rvAll') {
        R.all = e.target.checked;
        rows();
      } else if (e.target.name === 'date') {
        R.date = e.target.value;
        list = state(R.date);
        rows();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const m = byId();
      const items = Object.entries(St.revDraft).filter(([id, v]) => !C.blank(v) && m[id]).map(([id, v]) => {
        const i = m[id];
        return { kind: i.kind, key: i.key, name: i.name, expected: i.qty, counted: C.num(v), unitCost: i.unitCost };
      });
      if (!items.length) return A.toast('Внесите фактическое количество хотя бы по одной позиции', true);
      if (!confirm(`Сохранить ревизию на ${C.dmy(fd.get('date'))} по ${items.length} позициям? Остатки этих позиций станут равны факту.`)) return;
      try {
        const r = await A.api('POST', '/api/stock', { type: 'revision', date: fd.get('date'), note: fd.get('note'), items });
        St.doc = r.value;
        St.rev = r.rev;
        const saved = r.value.revisions[r.value.revisions.length - 1];
        A.closeModal();
        A.render();
        A.toast('Ревизия сохранена');
        if (confirm('Скачать ревизию в Excel?')) exportRevision(saved);
      } catch (err) {
        A.fail(err);
      }
    });
  }

  /* ---------- Excel ---------- */

  const unitOf = (kind) => (kind === 'oil' || kind === 'base' ? 'мл' : 'шт');
  const KIND_LABEL = { oil: 'Масло', base: 'Основа', bottle: 'Флакон', good: 'Товар' };

  function stockRows(list) {
    const rows = [['Вид', 'Позиция', 'Ед.', 'Остаток', 'Цена за ед., ₸', 'Стоимость, ₸', 'Расход за 30 дн.', 'Хватит, дн.', 'Последняя ревизия', 'Статус']];
    for (const i of list.filter((x) => x.tracked).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'ru'))) {
      rows.push([KIND_LABEL[i.kind], i.name, i.unit, i.qty, i.unitCost, i.value, i.cons30, i.daysLeft, i.revDate ? C.dmy(i.revDate) : '', i.negative ? 'минус' : i.low ? 'мало' : '']);
    }
    rows.push([{ v: 'Итого', bold: true }, '', '', '', '', { v: C.r2(list.reduce((a, i) => a + (i.tracked ? i.value || 0 : 0), 0)), bold: true }]);
    return rows;
  }

  async function exportStock() {
    if (!St.doc) await load();
    window.XLSX_LITE.download(`al-musk-sklad-${AM().today()}.xlsx`, [{ name: 'Остатки', rows: stockRows(state()) }]);
  }

  function exportRevision(rv) {
    const rows = [['Вид', 'Позиция', 'Ед.', 'По учёту', 'Факт', 'Разница', 'Цена за ед., ₸', 'Сумма разницы, ₸']];
    let total = 0;
    for (const r of rv.items) {
      const diff = C.r2(C.num(r.counted) - C.num(r.expected));
      const val = r.unitCost === null || r.unitCost === undefined ? null : C.r2(diff * C.num(r.unitCost));
      total += val || 0;
      rows.push([KIND_LABEL[r.kind], r.name, unitOf(r.kind), C.num(r.expected), C.num(r.counted), diff, r.unitCost, val]);
    }
    rows.push([{ v: 'Итого расхождение', bold: true }, '', '', '', '', '', '', { v: C.r2(total), bold: true }]);
    window.XLSX_LITE.download(`al-musk-reviziya-${rv.date}.xlsx`, [
      { name: `Ревизия ${C.dmy(rv.date)}`, rows },
      { name: 'Сведения', rows: [['Поле', 'Значение'], ['Дата ревизии', C.dmy(rv.date)], ['Позиций', rv.items.length], ['Комментарий', rv.note || ''], ['Остатки на', 'конец дня ревизии']] },
    ]);
  }

  /** Полный отчёт за период: сводка, дни, продажи, продавцы, ароматы, операции, склад. */
  async function exportRange(days, from, to) {
    const A = AM();
    const st = A.S.settings;
    const R = C.rangeTotals(days);
    const be = C.breakeven(days, st, from, to, A.today());
    const sum = [
      ['Показатель', 'Сумма, ₸'],
      ['Период', `${C.dmy(from)} – ${C.dmy(to)}`],
      ['Смен', days.length],
      ['Выручка', R.revenue],
      ['Kaspi Pay', R.pay.kaspi],
      ['Переводы', R.pay.transfer],
      ['Наличные', R.pay.cash],
      ['Себестоимость (с подарками)', -R.cogs],
      [{ v: 'Валовая прибыль', bold: true }, { v: R.gross, bold: true }],
      ['Зарплаты', -R.salaries],
      ['Комиссии Kaspi', -R.commission],
      ['Аренда и прочие расходы (оплачено)', -R.business],
      ['Возвраты', -R.refunds],
      [{ v: 'Чистый операционный результат', bold: true }, { v: R.result, bold: true }],
    ];
    if (be.monthly) {
      sum.push(['Постоянные расходы в месяц', be.monthly], ['Постоянные расходы за период (начислено)', -be.fixedAccrued], [{ v: 'Итог с учётом аренды', bold: true }, { v: be.net, bold: true }]);
      if (be.needPerShift !== null) sum.push(['Безубыточная выручка за смену', be.needPerShift], ['Средняя выручка за смену', be.avgRevenue]);
    }
    sum.push(['Закупки товара (деньги, не себестоимость)', R.purchases], ['Личные снятия и расходы владельца', R.personal], ['Чеков', R.receipts], ['Средний чек', R.avgCheck], ['Подарков', R.gifts], ['Скидки', R.discount]);
    const perDay = [['Дата', 'Статус', 'Чеков', 'Выручка', 'Kaspi Pay', 'Переводы', 'Наличные', 'Себестоимость', 'Валовая прибыль', 'Зарплата', 'Комиссия', 'Расходы', 'Результат', 'Аренда на день', 'Итог с арендой', 'Касса факт', 'Расхождение кассы']];
    const sales = [['Дата', 'Время', 'Продавец', 'Вид', 'Позиция', 'Объём, мл', 'Концентрация, %', 'Масло, мл', 'Основа, мл', 'Подарок', 'Акция', 'Цена до скидки', 'Скидка', 'Цена продажи', 'Оплата', 'Себестоимость', 'Прибыль']];
    const ops = [['Дата', 'Время', 'Вид', 'Категория', 'Счёт', 'Куда', 'Сумма', 'Комментарий', 'Не уточнено']];
    for (const d of [...days].sort((a, b) => (a.date < b.date ? -1 : 1))) {
      const t = C.dayTotals(d);
      const n = C.dayNet(d, st, t);
      perDay.push([C.dmy(d.date), d.status === 'closed' ? 'закрыта' : 'открыта', t.receipts, t.revenue, t.pay.kaspi, t.pay.transfer, t.pay.cash, t.cogs, t.gross, t.salaries, t.commission, t.business, t.result, n.fixedDaily, n.net, t.balances.cash.fact, t.balances.cash.diff]);
      for (const ln of t.lines) {
        sales.push([C.dmy(d.date), ln.time, ln.seller, C.TYPE_LABEL[ln.it.type], ln.it.name, ln.it.type === 'other' ? null : C.num(ln.it.volume), ln.it.type === 'perfume' ? C.num(ln.it.conc) : null, ln.it.type === 'other' ? null : ln.c.oilMl, ln.it.type === 'perfume' ? ln.c.baseMl : null, ln.it.gift ? 'да' : '', ln.promo, ln.c.discount ? ln.c.fullPrice : null, ln.c.discount || null, ln.c.price, ln.method, ln.it.costPending ? 'нет цены' : ln.c.cost, ln.it.costPending ? null : ln.c.profit]);
      }
      for (const o of d.ops || []) ops.push([C.dmy(d.date), o.time, (C.OP_KINDS[o.kind] || {}).label || o.kind, o.category, C.ACC_LABEL[o.account], o.to ? C.ACC_LABEL[o.to] : '', C.num(o.amount), o.note, o.unclear ? 'да' : '']);
    }
    const sellers = [['Продавец', 'Дней', 'Чеков', 'Выручка', 'Kaspi Pay', 'Переводы', 'Наличные', 'Средний чек', 'Себестоимость', 'Валовая прибыль', 'Подарки', 'Зарплата']];
    for (const s of R.sellerRank) sellers.push([s.name, s.days, s.receipts, s.revenue, s.pay.kaspi, s.pay.transfer, s.pay.cash, s.avgCheck, s.cost, s.gross, s.gifts, s.salary]);
    const aromas = [['Аромат', 'Продано', 'Подарено', 'Масла, мл', 'Выручка', 'Себестоимость', 'Прибыль']];
    for (const a of R.topAromas) aromas.push([a.name, a.sold, a.gifts, a.ml, a.revenue, a.cost, C.r2(a.revenue - a.cost)]);
    const sheets = [
      { name: 'Сводка', rows: sum },
      { name: 'По дням', rows: perDay },
      { name: 'Продажи', rows: sales },
      { name: 'Продавцы', rows: sellers },
      { name: 'Ароматы', rows: aromas },
      { name: 'Расходы и операции', rows: ops },
    ];
    try {
      if (!St.doc) await load();
      sheets.push({ name: 'Склад', rows: stockRows(state()) });
    } catch (e) {
      /* склад не обязателен для отчёта */
    }
    window.XLSX_LITE.download(`al-musk-otchet-${from}_${to}.xlsx`, sheets);
  }

  /* ---------- События ---------- */

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sk]');
    if (!b) return;
    e.preventDefault();
    const A = AM();
    try {
      switch (b.dataset.sk) {
        case 'tab':
          St.tab = b.dataset.t;
          St.q = '';
          draw();
          break;
        case 'receipt':
          openReceipt();
          break;
        case 'revision':
          openRevision();
          break;
        case 'xlsStock':
          await exportStock();
          break;
        case 'xlsRev':
          exportRevision(St.doc.revisions.find((r) => r.id === b.dataset.id));
          break;
        case 'delReceipt':
          if (!confirm('Удалить этот приход? Остатки уменьшатся. Расход в операциях смены, если он был записан, удалите отдельно.')) return;
          Object.assign(St, await A.api('POST', '/api/stock', { type: 'removeReceipt', batch: b.dataset.id }));
          St.doc = St.value;
          draw();
          break;
        case 'delRevision':
          if (!confirm('Удалить ревизию? Остатки снова будут считаться по учёту.')) return;
          Object.assign(St, await A.api('POST', '/api/stock', { type: 'removeRevision', id: b.dataset.id }));
          St.doc = St.value;
          draw();
          break;
        default:
      }
    } catch (err) {
      A.fail(err);
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'skSearch') {
      St.q = e.target.value;
      const pos = e.target.selectionStart;
      draw();
      const inp = $('#skSearch');
      inp.focus();
      inp.setSelectionRange(pos, pos);
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'skAll') {
      St.all = e.target.checked;
      draw();
    }
  });

  window.Sklad = { view, mount, load, state: () => (St.doc ? state() : null), ensure: async () => { if (!St.doc) await load(); return state(); }, exportRange, exportStock };
})();
