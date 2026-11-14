/*
 * Al Musk: дашборд руководителя. Графики рисуются в SVG и HTML без библиотек,
 * по реальной ширине экрана. Все цифры берутся из calc.js, как в отчётах.
 */
(function () {
  'use strict';
  const C = window.Calc;
  const M = C.money;
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pad = (n) => String(n).padStart(2, '0');
  const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  function compact(n) {
    const a = Math.abs(n);
    if (a >= 1e6) return `${(n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн`;
    if (a >= 1e3) return `${Math.round(n / 1e3).toLocaleString('ru-RU')} тыс`;
    return String(Math.round(n));
  }
  function niceStep(range, ticks) {
    const raw = range / ticks;
    const p = 10 ** Math.floor(Math.log10(raw || 1));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  function scaleY(min, max) {
    if (max <= min) max = min + 1;
    const step = niceStep(max - min, 4);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
    return { lo, hi, ticks };
  }
  /** Левый отступ под самую длинную подпись шкалы. */
  const padLeft = (sc) => 12 + Math.max(...sc.ticks.map((t) => compact(t).length)) * 6.6;

  /** Подписи оси X без наложений: шаг по ширине, последняя прижата к краю. */
  function xLabels(items, x, W, pl, pr, H) {
    const n = items.length;
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - pl) / 52))));
    let out = '';
    let lastShown = -Infinity;
    items.forEach((it, i) => {
      const isLast = i === n - 1;
      if (i % every !== 0 && !(isLast && i - lastShown >= every * 0.75)) return;
      if (isLast && i - lastShown < every * 0.75) return;
      lastShown = i;
      const half = String(it.label).length * 3.4;
      const cx = x(i);
      const anchor = cx + half > W - 2 ? 'end' : cx - half < pl ? 'start' : 'middle';
      const px = anchor === 'end' ? W - 2 : anchor === 'start' ? Math.max(pl, cx - half) : cx;
      out += `<text x="${px}" y="${H - 6}" text-anchor="${anchor}" class="tick">${esc(it.label)}</text>`;
    });
    return out;
  }

  function datesBetween(from, to) {
    const out = [];
    const [y, m, d] = from.split('-').map(Number);
    for (let dt = new Date(y, m - 1, d); ; dt.setDate(dt.getDate() + 1)) {
      const iso = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
      if (iso > to) break;
      out.push(iso);
      if (out.length > 400) break;
    }
    return out;
  }
  const dm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  const wdOf = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return (new Date(y, m - 1, d).getDay() + 6) % 7;
  };

  /* ---------- Данные ---------- */

  function aggregate(days, from, to) {
    const R = C.rangeTotals(days);
    const byDate = {};
    for (const d of days) byDate[d.date] = d;
    const hours = Array.from({ length: 24 }, (_, h) => ({ h, revenue: 0, receipts: 0 }));
    const week = WD.map((l) => ({ l, revenue: 0, days: 0 }));
    const volumes = {};
    const perDay = datesBetween(from, to).map((date) => {
      const d = byDate[date];
      if (!d) return { date, none: true, revenue: 0, gross: 0, receipts: 0 };
      const t = C.dayTotals(d);
      for (const sale of d.sales || []) {
        const h = parseInt(String(sale.time || '').slice(0, 2), 10);
        if (h >= 0 && h < 24) {
          hours[h].revenue += C.saleCalc(sale).revenue;
          hours[h].receipts += 1;
        }
      }
      for (const ln of t.lines) {
        if (ln.it.gift) continue;
        const key = ln.it.type === 'other' ? 'Товары' : `${ln.it.type === 'oil' ? 'Масло' : 'Духи'} ${C.fmt(C.num(ln.it.volume))} мл`;
        const v = (volumes[key] = volumes[key] || { name: key, count: 0, revenue: 0 });
        v.count += ln.c.qty;
        v.revenue += ln.c.price;
      }
      const w = week[wdOf(date)];
      w.revenue += t.revenue;
      w.days += 1;
      const bal = (acc) => (t.balances[acc].fact === null ? t.balances[acc].calc : t.balances[acc].fact);
      return { date, revenue: t.revenue, gross: t.gross, result: t.result, receipts: t.receipts, cash: bal('cash'), kaspi: bal('kaspi') };
    });
    return {
      R,
      perDay,
      hours,
      week: week.map((w) => ({ ...w, avg: w.days ? w.revenue / w.days : 0 })),
      volumes: Object.values(volumes).sort((a, b) => b.count - a.count),
    };
  }

  /* ---------- Графики ---------- */

  const legendHtml = (items) => `<div class="dlegend">${items.map((i) => `<span><i class="sw ${i.line ? 'ln' : ''}" style="--c:var(${i.color})"></i>${esc(i.label)}</span>`).join('')}</div>`;

  /** Столбцы по оси X (дни, часы, дни недели) + необязательная линия на той же шкале ₸. */
  function columns(el, items, opts = {}) {
    const W = Math.max(260, el.clientWidth);
    const H = opts.height || 200;
    const pr = 6;
    const pt = 10;
    const pb = 22;
    const vals = items.flatMap((i) => [i.a || 0, ...(opts.line ? [i.b || 0] : [])]);
    const sc = scaleY(Math.min(0, ...vals), Math.max(0, ...vals));
    const pl = padLeft(sc);
    const y = (v) => pt + (H - pt - pb) * (1 - (v - sc.lo) / (sc.hi - sc.lo));
    const n = items.length;
    const band = (W - pl - pr) / n;
    const bw = Math.max(2, Math.min(28, band - 2));
    const x = (i) => pl + band * i + band / 2;
    let svg = '';
    for (const t of sc.ticks) {
      svg += `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? 'axis0' : 'grid'}"/>`;
      svg += `<text x="${pl - 6}" y="${y(t) + 4}" text-anchor="end" class="tick">${compact(t)}</text>`;
    }
    svg += xLabels(items, x, W, pl, pr, H);
    items.forEach((it, i) => {
      if (it.a) {
        const top = y(Math.max(it.a, 0));
        const base = y(Math.min(it.a, 0));
        const h = Math.max(1, base - top);
        const r = Math.min(4, bw / 2, h);
        const x0 = x(i) - bw / 2;
        // скругление только у конца столбца
        svg += it.a >= 0
          ? `<path class="bar" d="M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${base} Z"/>`
          : `<path class="bar" d="M${x0},${top} V${base - r} Q${x0},${base} ${x0 + r},${base} H${x0 + bw - r} Q${x0 + bw},${base} ${x0 + bw},${base - r} V${top} Z"/>`;
      }
    });
    if (opts.line) {
      const pts = items.map((it, i) => (it.none ? null : [x(i), y(it.b || 0)]));
      let d = '';
      let pen = false;
      for (const p of pts) {
        if (!p) {
          pen = false;
          continue;
        }
        d += `${pen ? 'L' : 'M'}${p[0]},${p[1]} `;
        pen = true;
      }
      svg += `<path class="ln2" d="${d}"/>`;
      if (band >= 14) for (const p of pts) if (p) svg += `<circle class="dot2" cx="${p[0]}" cy="${p[1]}" r="4"/>`;
    }
    items.forEach((it, i) => {
      svg += `<rect class="hit" x="${pl + band * i}" y="${pt}" width="${band}" height="${H - pt - pb}" data-tip="${esc(it.tip)}"/>`;
    });
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(opts.aria || '')}">${svg}</svg>`;
  }

  /** Линии нескольких рядов на одной шкале ₸ (остатки). */
  function lines(el, items, series) {
    const W = Math.max(260, el.clientWidth);
    const H = 180;
    const pr = 6;
    const pt = 10;
    const pb = 22;
    const pts = items.filter((i) => !i.none);
    if (!pts.length) {
      el.innerHTML = '<p class="empty">Нет данных.</p>';
      return;
    }
    const vals = pts.flatMap((i) => series.map((s) => i[s.key]));
    const sc = scaleY(Math.min(0, ...vals), Math.max(...vals));
    const pl = padLeft(sc);
    const n = items.length;
    const band = (W - pl - pr) / n;
    const x = (i) => pl + band * i + band / 2;
    const y = (v) => pt + (H - pt - pb) * (1 - (v - sc.lo) / (sc.hi - sc.lo));
    let svg = '';
    for (const t of sc.ticks) {
      svg += `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? 'axis0' : 'grid'}"/>`;
      svg += `<text x="${pl - 6}" y="${y(t) + 4}" text-anchor="end" class="tick">${compact(t)}</text>`;
    }
    svg += xLabels(items, x, W, pl, pr, H);
    for (const s of series) {
      let d = '';
      let pen = false;
      items.forEach((it, i) => {
        if (it.none) {
          pen = false;
          return;
        }
        d += `${pen ? 'L' : 'M'}${x(i)},${y(it[s.key])} `;
        pen = true;
      });
      svg += `<path class="ln" style="stroke:var(${s.color})" d="${d}"/>`;
      if (band >= 14) items.forEach((it, i) => { if (!it.none) svg += `<circle class="dot" style="fill:var(${s.color})" cx="${x(i)}" cy="${y(it[s.key])}" r="4"/>`; });
    }
    items.forEach((it, i) => {
      if (it.none) return;
      const tip = `${C.dmy(it.date)}\n${series.map((s) => `${s.label}: ${M(it[s.key])}`).join('\n')}`;
      svg += `<rect class="hit" x="${pl + band * i}" y="${pt}" width="${band}" height="${H - pt - pb}" data-tip="${esc(tip)}"/>`;
    });
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Остатки денег по дням">${svg}</svg>`;
  }

  /** Горизонтальные полосы с подписями: продавцы, ароматы, объёмы, структура денег. */
  function hbars(list, { max, color = '--s1' } = {}) {
    if (!list.length) return '<p class="empty">Нет данных.</p>';
    const top = max || Math.max(...list.map((r) => Math.abs(r.value)), 1);
    return `<div class="hbars">${list.map((r) => `<div class="hb" data-tip="${esc(r.tip || '')}">
        <div class="hb-l">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</div>
        <div class="hb-t"><div class="hb-f" style="width:${Math.max(1, (Math.abs(r.value) / top) * 100)}%;background:var(${r.color || color})"></div></div>
        <div class="hb-v">${esc(r.text)}</div></div>`).join('')}</div>`;
  }

  /** Доли способов оплаты: одна полоса из сегментов с зазором 2px. */
  function shareBar(parts) {
    const total = parts.reduce((a, p) => a + p.value, 0);
    if (!total) return '<p class="empty">Продаж нет.</p>';
    return `<div class="share">${parts.filter((p) => p.value > 0).map((p) => `<div class="seg" style="flex:${p.value};background:var(${p.color})" data-tip="${esc(`${p.label}: ${M(p.value)} (${Math.round((p.value / total) * 100)}%)`)}"></div>`).join('')}</div>
      <div class="share-l">${parts.map((p) => `<div><i class="sw" style="--c:var(${p.color})"></i>${esc(p.label)} <b>${M(p.value)}</b> <span class="muted">${Math.round((p.value / total) * 100)}%</span></div>`).join('')}</div>`;
  }

  /* ---------- Плитки ---------- */

  function tile(label, cur, prev, fmt, { goodUp = true, hl = false, note = '' } = {}) {
    let delta = '';
    if (prev !== null && prev !== undefined && isFinite(prev)) {
      if (prev === 0) delta = cur === 0 ? '<span class="dl">без изменений</span>' : '<span class="dl">в прошлом периоде 0</span>';
      else {
        const pct = ((cur - prev) / Math.abs(prev)) * 100;
        const up = pct >= 0;
        const good = up === goodUp;
        delta = Math.abs(pct) < 0.5 ? '<span class="dl">≈ как раньше</span>' : `<span class="dl ${good ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(pct).toLocaleString('ru-RU', { maximumFractionDigits: 0 })}%</span>`;
      }
    }
    return `<div class="kpi ${hl ? 'hl' : ''}"><div class="l">${esc(label)}</div><div class="v">${fmt(cur)}</div>${delta}${note ? `<div class="dl">${note}</div>` : ''}</div>`;
  }

  /* ---------- Сборка ---------- */

  let mounted = null;

  function mount(root, { days, prev, from, to }) {
    const A = aggregate(days, from, to);
    const P = prev ? C.rangeTotals(prev) : null;
    const R = A.R;
    const pct = (n) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}%`;
    const margin = R.revenue ? (R.gross / R.revenue) * 100 : 0;
    const pMargin = P && P.revenue ? (P.gross / P.revenue) * 100 : null;
    const shiftDays = A.perDay.filter((d) => !d.none).length;
    const best = A.perDay.filter((d) => !d.none).sort((a, b) => b.revenue - a.revenue)[0];
    const peakHour = A.hours.reduce((m, h) => (h.revenue > m.revenue ? h : m), A.hours[0]);
    const bestWd = A.week.reduce((m, w) => (w.avg > m.avg ? w : m), A.week[0]);

    const breakdown = [
      { label: 'Выручка', value: R.revenue, text: M(R.revenue), color: '--s1' },
      { label: 'Себестоимость', value: R.cogs, text: `−${M(R.cogs)}`, color: '--neutral', sub: R.giftCost ? `в т.ч. подарки ${M(R.giftCost)}` : '' },
      { label: 'Зарплаты', value: R.salaries, text: `−${M(R.salaries)}`, color: '--neutral' },
      { label: 'Комиссии Kaspi', value: R.commission, text: `−${M(R.commission)}`, color: '--neutral' },
      { label: 'Аренда и расходы', value: R.business, text: `−${M(R.business)}`, color: '--neutral' },
      ...(R.refunds ? [{ label: 'Возвраты', value: R.refunds, text: `−${M(R.refunds)}`, color: '--neutral' }] : []),
      { label: 'Чистый результат', value: R.result, text: M(R.result), color: '--s1' },
    ];

    root.innerHTML = `
      ${R.pendingCost ? `<div class="note bad small">Позиций без себестоимости: ${R.pendingCost}. Прибыль на графиках завышена.</div>` : ''}
      <div class="kpis">
        ${tile('Выручка', R.revenue, P && P.revenue, M, { hl: true })}
        ${tile('Валовая прибыль', R.gross, P && P.gross, M)}
        ${tile('Чистый результат', R.result, P && P.result, M, { hl: true })}
        ${tile('Маржа', margin, pMargin, pct)}
        ${tile('Чеков', R.receipts, P && P.receipts, (n) => n.toLocaleString('ru-RU'))}
        ${tile('Средний чек', R.avgCheck, P && P.avgCheck, M)}
        ${tile('Подарков', R.gifts, P && P.gifts, (n) => n.toLocaleString('ru-RU'), { goodUp: false })}
        ${tile('Скидки', R.discount, P && P.discount, M, { goodUp: false })}
      </div>
      <p class="hint" style="margin-top:-6px">Стрелки: сравнение с прошлым периодом такой же длины.</p>

      <section class="card"><h3>Выручка и валовая прибыль по дням</h3>
        ${legendHtml([{ label: 'Выручка', color: '--s1' }, { label: 'Валовая прибыль', color: '--s2', line: true }])}
        <div class="chart" data-c="days"></div>
        <p class="small muted">Смен: ${shiftDays}${best ? ` · лучший день ${C.dmy(best.date)}: ${M(best.revenue)}` : ''}</p>
        <details><summary class="small">Таблица по дням</summary><div class="tbl-wrap"><table><thead><tr><th>Дата</th><th class="n">Чеков</th><th class="n">Выручка</th><th class="n">Вал. прибыль</th><th class="n">Результат</th></tr></thead><tbody>
          ${A.perDay.filter((d) => !d.none).map((d) => `<tr><td>${C.dmy(d.date)}</td><td class="n">${d.receipts}</td><td class="n">${M(d.revenue)}</td><td class="n">${M(d.gross)}</td><td class="n">${M(d.result)}</td></tr>`).join('')}
        </tbody></table></div></details>
      </section>

      <div class="dgrid">
        <section class="card"><h3>Как платят</h3>${shareBar([
          { label: 'Kaspi Pay', value: R.pay.kaspi, color: '--s1' },
          { label: 'Переводы', value: R.pay.transfer, color: '--s2' },
          { label: 'Наличные', value: R.pay.cash, color: '--s3' },
        ])}</section>
        <section class="card"><h3>Куда уходит выручка</h3>${hbars(breakdown, { max: Math.max(R.revenue, Math.abs(R.result), 1) })}</section>
      </div>

      <div class="dgrid">
        <section class="card"><h3>Продажи по часам</h3><div class="chart" data-c="hours"></div>
          <p class="small muted">${peakHour.revenue ? `Пик: ${pad(peakHour.h)}:00–${pad(peakHour.h + 1)}:00, ${M(peakHour.revenue)}` : 'Нет данных о времени продаж.'}</p></section>
        <section class="card"><h3>Средняя выручка по дням недели</h3><div class="chart" data-c="week"></div>
          <p class="small muted">${bestWd.avg ? `Сильнее всего: ${bestWd.l}, в среднем ${M(bestWd.avg)}` : ''}</p></section>
      </div>

      <div class="dgrid">
        <section class="card"><h3>Продавцы</h3>${hbars(R.sellerRank.map((s) => ({
          label: s.name,
          sub: `${s.receipts} чек. · ср. чек ${M(s.avgCheck)}`,
          value: s.revenue,
          text: M(s.revenue),
          tip: `${s.name}\nВыручка ${M(s.revenue)}\nВаловая прибыль ${M(s.gross)}\nЧеков ${s.receipts}, средний ${M(s.avgCheck)}\nЗарплата ${M(s.salary)}`,
        })))}</section>
        <section class="card"><h3>Топ-10 ароматов</h3>${hbars(R.topAromas.slice(0, 10).map((a) => ({
          label: a.name,
          sub: `${M(a.revenue)}${a.gifts ? ` · подарено ${a.gifts}` : ''}`,
          value: a.sold,
          text: `${a.sold} шт.`,
          tip: `${a.name}\nПродано ${a.sold} шт. на ${M(a.revenue)}\nМасла ${C.fmt(a.ml)} мл`,
        })))}</section>
      </div>

      <div class="dgrid">
        <section class="card"><h3>Что берут: объёмы</h3>${hbars(A.volumes.slice(0, 8).map((v) => ({
          label: v.name,
          value: v.count,
          text: `${v.count} шт.`,
          sub: M(v.revenue),
          tip: `${v.name}: ${v.count} шт., ${M(v.revenue)}`,
        })))}</section>
        <section class="card"><h3>Остатки денег на конец дня</h3>
          ${legendHtml([{ label: 'Наличная касса', color: '--s1', line: true }, { label: 'Kaspi Pay', color: '--s2', line: true }])}
          <div class="chart" data-c="bal"></div>
          <p class="small muted">Факт пересчёта, а если его нет, расчётный остаток.</p></section>
      </div>`;

    mounted = { root, A };
    draw();
    wireTips(root);
  }

  function draw() {
    if (!mounted || !document.body.contains(mounted.root)) return;
    const { root, A } = mounted;
    const c = (k) => root.querySelector(`[data-c="${k}"]`);
    columns(c('days'), A.perDay.map((d) => ({
      label: dm(d.date),
      a: d.revenue,
      b: d.gross,
      none: d.none,
      tip: d.none ? `${C.dmy(d.date)}\nСмены не было` : `${C.dmy(d.date)}\nВыручка ${M(d.revenue)}\nВаловая прибыль ${M(d.gross)}\nЧеков ${d.receipts}`,
    })), { line: true, aria: 'Выручка и валовая прибыль по дням' });
    const hs = A.hours.filter((h) => h.receipts);
    const hFrom = hs.length ? Math.min(...hs.map((h) => h.h)) : 10;
    const hTo = hs.length ? Math.max(...hs.map((h) => h.h)) : 21;
    columns(c('hours'), A.hours.slice(Math.min(hFrom, 10), Math.max(hTo, 21) + 1).map((h) => ({
      label: pad(h.h),
      a: h.revenue,
      tip: `${pad(h.h)}:00–${pad(h.h + 1)}:00\n${M(h.revenue)}, чеков ${h.receipts}`,
    })), { height: 170, aria: 'Продажи по часам' });
    columns(c('week'), A.week.map((w) => ({
      label: w.l,
      a: Math.round(w.avg),
      tip: `${w.l}: в среднем ${M(w.avg)}\nсмен ${w.days}`,
    })), { height: 170, aria: 'Средняя выручка по дням недели' });
    lines(c('bal'), A.perDay.map((d) => ({ ...d, label: dm(d.date) })), [
      { key: 'cash', label: 'Наличная касса', color: '--s1' },
      { key: 'kaspi', label: 'Kaspi Pay', color: '--s2' },
    ]);
  }

  function wireTips(root) {
    let tip = document.getElementById('dashTip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'dashTip';
      tip.className = 'dash-tip';
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    const show = (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t || !root.contains(t) || !t.dataset.tip) {
        tip.hidden = true;
        root.querySelectorAll('.hover').forEach((x) => x.classList.remove('hover'));
        return;
      }
      root.querySelectorAll('.hover').forEach((x) => x !== t && x.classList.remove('hover'));
      t.classList.add('hover');
      tip.textContent = t.dataset.tip;
      tip.hidden = false;
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      let x = e.clientX + 12;
      let y = e.clientY - h - 12;
      if (x + w > window.innerWidth - 8) x = e.clientX - w - 12;
      if (x < 8) x = 8;
      if (y < 8) y = e.clientY + 16;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    };
    root.addEventListener('pointermove', show);
    root.addEventListener('pointerdown', show);
    root.addEventListener('pointerleave', () => (tip.hidden = true));
    window.addEventListener('scroll', () => (tip.hidden = true), { passive: true });
  }

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(draw, 150);
  });

  window.Dash = { mount, aggregate };
})();
