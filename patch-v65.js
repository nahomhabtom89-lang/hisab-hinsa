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

    if (!sales.length) {
      statsEl.innerHTML = `<div class="kgrid" style="grid-template-columns:repeat(2,1fr)"><div class="kpi"><div class="kpi-lbl">Total Sales</div><div class="kpi-val pos">${fmtMoney(0)}</div></div><div class="kpi"><div class="kpi-lbl">Transactions</div><div class="kpi-val">0</div></div></div>`;
      itemsEl.innerHTML = '<div style="text-align:center;padding:14px;color:var(--text3)">No sales in this period</div>';
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
      <div class="card-hdr">📊 Organized Summary</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
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

  // ── nav() — inject BEFORE awaiting (Lesson 4) ──────────────────────
  const _origNavV65 = window.nav;
  if (typeof _origNavV65 === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV65(page, el);
      if (page === 'retailsales') {
        injectSalesSummaryCardV65();
        renderSalesSummaryV65();
      }
      return result;
    };
  }

  console.log('✅ patch-v65.js loaded — Sales Report: organized Today/Week/Month/Custom summary with per-item totals, above the existing transaction list');
})();
