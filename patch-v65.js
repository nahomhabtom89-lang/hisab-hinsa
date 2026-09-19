// ═══════════════════════════════════════════════════════════
// PATCH v65 — Sales Report: Organized Summary (Today/Week/Month/Custom
// + per-item totals), on top of the existing transaction list
// ═══════════════════════════════════════════════════════════
// The existing Sales Report (renderRetailSalesPage(), untouched by this
// patch) lists every sale one by one — kept exactly as it was, since
// that's still useful on its own. This adds a new card ABOVE it: pick a
// period (Today / This Week / This Month / a manual custom range), and
// see it organized — total sales + transaction count for that period,
// and a per-item breakdown (e.g. "apple — 1,847 sold, $36,940") instead
// of having to add it up by hand from the row-by-row list.
//
// Built as its own fetch + its own card, inserted via DOM insertion
// before the existing #retailSalesList card — renderRetailSalesPage()
// itself is never touched, so nothing about the existing list changes.
// Revenue per line item is unit sale_price × qty (the price the item was
// actually rung up at) — this is BEFORE any whole-cart discount, since
// POS discounts apply to the cart total rather than per line; stated
// plainly here rather than silently overstating per-item revenue
// precision, same spirit as this app's other documented simplifications.
// ═══════════════════════════════════════════════════════════

(function () {
  function todayStr() { return (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function fmtMoney(n) { return (typeof fc === 'function') ? fc(n) : '$' + (parseFloat(n) || 0).toFixed(2); }

  let _ss65Period = 'today'; // 'today' | 'week' | 'month' | 'custom' | 'all'
  let _ss65LastData = null; // { totalRevenue, count, rows, rangeLabel } — set on every render, read by Print/Word export

  function rangeLabelV65(period, range) {
    if (period === 'today') return 'Today (' + todayStr() + ')';
    if (period === 'week') return 'This Week (' + range.from + ' to ' + range.to + ')';
    if (period === 'month') return 'This Month (' + range.from + ' to ' + range.to + ')';
    if (period === 'custom') return 'Custom Range (' + range.from + ' to ' + range.to + ')';
    return 'All Time';
  }

  function mondayOfV65(d) {
    const day = d.getDay(); // 0=Sun..6=Sat
    const diff = (day === 0 ? 6 : day - 1);
    const m = new Date(d);
    m.setDate(d.getDate() - diff);
    return m;
  }
  function isoDateV65(d) { return d.toISOString().slice(0, 10); }

  function periodRangeV65(period) {
    const now = new Date();
    if (period === 'today') { const t = todayStr(); return { from: t, to: t }; }
    if (period === 'week') { return { from: isoDateV65(mondayOfV65(now)), to: todayStr() }; }
    if (period === 'month') { return { from: now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01', to: todayStr() }; }
    if (period === 'custom') {
      const fromEl = document.getElementById('ss65-from'), toEl = document.getElementById('ss65-to');
      const from = fromEl && fromEl.value ? fromEl.value : null;
      const to = toEl && toEl.value ? toEl.value : todayStr();
      return from ? { from: from, to: to } : null;
    }
    return null; // 'all' — no filtering
  }

  function saleDateV65(s) { return String(s.sale_date).split('T')[0]; }
  function saleItemsV65(s) { return Array.isArray(s.items) ? s.items : (JSON.parse(s.items || '[]')); }

  async function fetchSalesV65() {
    try {
      const r = await dbApi({ action: 'listPOSSales', companyId: SESSION.companyId, limit: 1000 });
      return r.sales || [];
    } catch (e) { console.error('fetchSalesV65', e); return []; }
  }

  window.setSalesSummaryPeriodV65 = function (period) {
    _ss65Period = period;
    const customWrap = document.getElementById('ss65-custom-wrap');
    if (customWrap) customWrap.style.display = (period === 'custom') ? 'flex' : 'none';
    document.querySelectorAll('.ss65-period-btn').forEach(function (b) {
      b.classList.toggle('btn-gold', b.dataset.period === period);
      b.classList.toggle('btn-outline', b.dataset.period !== period);
    });
    if (period !== 'custom') renderSalesSummaryV65();
  };
  window.applyCustomSalesRangeV65 = function () { renderSalesSummaryV65(); };

  async function renderSalesSummaryV65() {
    const statsEl = document.getElementById('ss65-stats');
    const itemsEl = document.getElementById('ss65-items');
    if (!statsEl || !itemsEl) return;
    statsEl.innerHTML = '<div style="text-align:center;padding:10px;color:var(--text3);font-size:11px">Loading…</div>';
    itemsEl.innerHTML = '';

    const allSales = await fetchSalesV65();
    const range = periodRangeV65(_ss65Period);
    const sales = range ? allSales.filter(function (s) { const d = saleDateV65(s); return d >= range.from && d <= range.to; }) : allSales;
    const label = rangeLabelV65(_ss65Period, range || { from: '', to: '' });

    if (!sales.length) {
      statsEl.innerHTML = `<div class="kgrid" style="grid-template-columns:repeat(2,1fr)"><div class="kpi"><div class="kpi-lbl">Total Sales</div><div class="kpi-val pos">${fmtMoney(0)}</div></div><div class="kpi"><div class="kpi-lbl">Transactions</div><div class="kpi-val">0</div></div></div>`;
      itemsEl.innerHTML = '<div style="text-align:center;padding:14px;color:var(--text3)">No sales in this period</div>';
      _ss65LastData = { totalRevenue: 0, count: 0, rows: [], rangeLabel: label };
      return;
    }

    const totalRevenue = sales.reduce(function (s, x) { return s + (parseFloat(x.total) || 0); }, 0);
    statsEl.innerHTML = `<div class="kgrid" style="grid-template-columns:repeat(2,1fr)"><div class="kpi"><div class="kpi-lbl">Total Sales</div><div class="kpi-val pos">${fmtMoney(totalRevenue)}</div></div><div class="kpi"><div class="kpi-lbl">Transactions</div><div class="kpi-val">${sales.length}</div></div></div>`;

    const byItem = {};
    sales.forEach(function (s) {
      let items;
      try { items = saleItemsV65(s); } catch (e) { items = []; }
      items.forEach(function (it) {
        const key = (it.id != null) ? ('id:' + it.id) : ('name:' + it.name);
        if (!byItem[key]) byItem[key] = { name: it.name || '(unnamed)', qty: 0, revenue: 0 };
        const qty = parseFloat(it.qty) || 0;
        const price = parseFloat(it.sale_price) || 0;
        byItem[key].qty += qty;
        byItem[key].revenue += qty * price;
      });
    });
    const rows = Object.keys(byItem).map(function (k) { return byItem[k]; }).sort(function (a, b) { return b.qty - a.qty; });
    _ss65LastData = { totalRevenue: totalRevenue, count: sales.length, rows: rows, rangeLabel: label };
    if (!rows.length) { itemsEl.innerHTML = '<div style="text-align:center;padding:14px;color:var(--text3)">No item detail on these sales</div>'; return; }

    itemsEl.innerHTML = `<table><thead><tr><th>Item</th><th style="text-align:right">Qty Sold</th><th style="text-align:right">Revenue</th></tr></thead><tbody>${
      rows.map(function (r) {
        return `<tr><td>${esc(r.name)}</td><td style="text-align:right;font-family:'JetBrains Mono',monospace">${r.qty}</td><td style="text-align:right;font-family:'JetBrains Mono',monospace;color:var(--gold3)">${fmtMoney(r.revenue)}</td></tr>`;
      }).join('')
    }</tbody></table>`;
  }

  function periodBtnV65(period, label) {
    return `<button type="button" class="ss65-period-btn btn ${period === _ss65Period ? 'btn-gold' : 'btn-outline'}" data-period="${period}" style="padding:6px 12px;font-size:11px" onclick="setSalesSummaryPeriodV65('${period}')">${label}</button>`;
  }

  function injectSalesSummaryCardV65() {
    if (document.getElementById('ss65-card')) return;
    const listEl = document.getElementById('retailSalesList');
    if (!listEl) return; // page not built yet this pass
    const listCard = listEl.closest('.card');
    if (!listCard || !listCard.parentNode) return;

    const card = document.createElement('div');
    card.className = 'card'; card.id = 'ss65-card';
    card.style.marginBottom = '14px';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div class="card-hdr" style="margin:0">📊 Organized Summary</div>
        <div style="display:flex;gap:6px">
          <button type="button" class="btn btn-outline" style="padding:5px 11px;font-size:11px" onclick="printSalesSummaryV65()">🖨️ Print / PDF</button>
          <button type="button" class="btn btn-outline" style="padding:5px 11px;font-size:11px" onclick="exportSalesSummaryWordV65()">📄 Export to Word</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
        ${periodBtnV65('today', 'Today')}
        ${periodBtnV65('week', 'This Week')}
        ${periodBtnV65('month', 'This Month')}
        ${periodBtnV65('all', 'All Time')}
        ${periodBtnV65('custom', 'Custom')}
      </div>
      <div id="ss65-custom-wrap" style="display:none;gap:8px;align-items:flex-end;margin-bottom:12px;flex-wrap:wrap">
        <div class="fg" style="margin:0"><label style="font-size:10px">From</label><input id="ss65-from" type="date" style="background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"/></div>
        <div class="fg" style="margin:0"><label style="font-size:10px">To</label><input id="ss65-to" type="date" style="background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"/></div>
        <button type="button" class="btn btn-gold" style="padding:7px 14px;font-size:11px" onclick="applyCustomSalesRangeV65()">Apply</button>
      </div>
      <div id="ss65-stats" style="margin-bottom:12px"></div>
      <div id="ss65-items"></div>
    `;
    listCard.parentNode.insertBefore(card, listCard);
  }

  // ═══════════════════════════════════════════════════════════
  // PRINT / PDF — a dedicated print page, same pattern as the Delivery
  // Note / Debit Note print pages elsewhere in this app: build a plain
  // white printable document, nav() to a page that shows ONLY that
  // document, then use the browser's own Print dialog — "Save as PDF"
  // there is how this becomes an actual PDF file, no extra library
  // needed. Table text color is forced to #111 up front this time
  // (a past patch had to fix this after the fact for Delivery Notes —
  // same underlying dark-theme-inherited-by-table-cells issue).
  // ═══════════════════════════════════════════════════════════
  function injectSalesSummaryPrintPageV65() {
    if (document.getElementById('pg-ss-print-v65')) return;
    const main = document.querySelector('.main'); if (!main) return;
    const page = document.createElement('div');
    page.className = 'page'; page.id = 'pg-ss-print-v65';
    page.innerHTML = `<div class="no-print" style="margin-bottom:14px;display:flex;gap:8px">
        <button class="btn btn-outline" onclick="nav('retailsales')">← Back</button>
        <button class="btn btn-gold" onclick="window.print()">🖨️ Print</button>
      </div>
      <div id="ss-print-content-v65" style="background:#fff;color:#111;padding:28px;max-width:760px;margin:0 auto;font-family:Arial,sans-serif;border-radius:4px"></div>`;
    main.appendChild(page);
  }
  const _ss65PrintStyle = document.createElement('style');
  _ss65PrintStyle.textContent = `
    @media print{
      body.ss-printing-v65 .page{display:none!important}
      body.ss-printing-v65 #pg-ss-print-v65{display:block!important}
    }
    #ss-print-content-v65 table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px}
    #ss-print-content-v65 th,#ss-print-content-v65 td{border:1px solid #999;padding:6px 8px;text-align:left}
    #ss-print-content-v65 td,#ss-print-content-v65 th{color:#111!important}
    #ss-print-content-v65 th{background:#eee;font-weight:700}
  `;
  document.head.appendChild(_ss65PrintStyle);

  function summaryDocHtmlV65() {
    const d = _ss65LastData || { totalRevenue: 0, count: 0, rows: [], rangeLabel: '' };
    const rowsHtml = d.rows.map(function (r) {
      return `<tr><td>${esc(r.name)}</td><td style="text-align:right">${r.qty}</td><td style="text-align:right">${fmtMoney(r.revenue)}</td></tr>`;
    }).join('');
    return {
      rowsHtml: rowsHtml,
      bizName: esc((typeof BIZ_NAME !== 'undefined' && BIZ_NAME) || 'Company'),
      rangeLabel: esc(d.rangeLabel),
      totalRevenue: fmtMoney(d.totalRevenue),
      count: d.count,
      generatedOn: todayStr()
    };
  }

  window.printSalesSummaryV65 = function () {
    if (!_ss65LastData) { if (typeof showToast === 'function') showToast('⚠️ Wait for the summary to finish loading first'); return; }
    injectSalesSummaryPrintPageV65();
    const content = document.getElementById('ss-print-content-v65');
    if (!content) return;
    const d = summaryDocHtmlV65();
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #333;padding-bottom:12px;margin-bottom:14px">
        <div style="font-size:20px;font-weight:700">${d.bizName}</div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:700;letter-spacing:1px">SALES SUMMARY</div>
          <div style="font-size:12px">${d.rangeLabel}</div>
          <div style="font-size:11px;color:#555">Generated ${d.generatedOn}</div>
        </div>
      </div>
      <div style="display:flex;gap:30px;font-size:13px;margin-bottom:14px">
        <div><b>Total Sales:</b> ${d.totalRevenue}</div>
        <div><b>Transactions:</b> ${d.count}</div>
      </div>
      <table><thead><tr><th>Item</th><th style="text-align:right">Qty Sold</th><th style="text-align:right">Revenue</th></tr></thead>
        <tbody>${d.rowsHtml || '<tr><td colspan="3" style="text-align:center;color:#777">No item detail</td></tr>'}</tbody></table>
    `;
    document.body.classList.add('ss-printing-v65');
    nav('ss-print-v65');
  };

  // ═══════════════════════════════════════════════════════════
  // EXPORT TO WORD — this is a vanilla-JS, no-framework, single-HTML-
  // file app, so there's no docx-generation library loaded anywhere in
  // it. The standard, low-risk way to hand someone a file Word will
  // open directly (no library, no backend change) is to save plain HTML
  // with a .doc extension and the application/msword MIME type — Word
  // recognizes and opens this natively. It won't carry Word's own
  // native formatting features, but headings, bold text and a real
  // table all come through correctly, which covers this report.
  // ═══════════════════════════════════════════════════════════
  window.exportSalesSummaryWordV65 = function () {
    if (!_ss65LastData) { if (typeof showToast === 'function') showToast('⚠️ Wait for the summary to finish loading first'); return; }
    const d = summaryDocHtmlV65();
    const html = `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>Sales Summary</title>
<style>
  body{font-family:Calibri,Arial,sans-serif;color:#111}
  h1{font-size:20pt;margin-bottom:2pt}
  .meta{font-size:11pt;color:#444;margin-bottom:14pt}
  table{border-collapse:collapse;width:100%;margin-top:10pt}
  th,td{border:1px solid #999;padding:6pt 8pt;font-size:11pt;text-align:left}
  th{background:#eee;font-weight:700}
  .stats{font-size:12pt;margin-bottom:10pt}
</style></head>
<body>
  <h1>${d.bizName} — Sales Summary</h1>
  <div class="meta">${d.rangeLabel} &nbsp;·&nbsp; Generated ${d.generatedOn}</div>
  <div class="stats"><b>Total Sales:</b> ${d.totalRevenue} &nbsp;&nbsp; <b>Transactions:</b> ${d.count}</div>
  <table><thead><tr><th>Item</th><th style="text-align:right">Qty Sold</th><th style="text-align:right">Revenue</th></tr></thead>
    <tbody>${d.rowsHtml || '<tr><td colspan="3" style="text-align:center;color:#777">No item detail</td></tr>'}</tbody></table>
</body></html>`;
    const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Sales-Summary-' + todayStr() + '.doc';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    if (typeof showToast === 'function') showToast('✅ Word file downloading');
  };

  // ── nav() — inject BEFORE awaiting (Lesson 4) ──────────────────────
  const _origNavV65 = window.nav;
  if (typeof _origNavV65 === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV65(page, el);
      if (page !== 'ss-print-v65') document.body.classList.remove('ss-printing-v65');
      if (page === 'retailsales') {
        injectSalesSummaryCardV65();
        renderSalesSummaryV65();
      }
      return result;
    };
  }

  console.log('✅ patch-v65.js loaded — Sales Report: organized Today/Week/Month/Custom summary with per-item totals, above the existing transaction list');
})();
