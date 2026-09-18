// ═══════════════════════════════════════════════════════════
// PATCH v63 — Sales Returns (re-shipped: now Sales-Return-only)
// ═══════════════════════════════════════════════════════════
// RE-SHIP NOTE: originally this file held BOTH Sales Returns and Purchase
// Returns on one shared page. Per a later request, the two were split:
// Purchase Returns moved entirely to patch-v64.js, which gives it its own
// page AND a proper two-stage workflow (Return Request/Debit Note → send
// to supplier → supplier agrees → THEN journal entries post). This file
// keeps only Sales Returns, which is unchanged in behavior from before —
// still a single-step "record it and it posts immediately" flow, since
// that wasn't asked to change.
//
// Nothing outside this file ever referenced the Purchase-Return-specific
// pieces that were removed (createPurchaseReturnV63, the ret-purch-* DOM
// ids, costAndDepleteForPurchaseReturnV63, onReturnSupplierChangeV63) —
// confirmed by grepping the whole repo before cutting them, so this is
// safe to re-ship as a straight replacement of the old file.
//
// getCurrentBookedAmount(entry) — the core integration point every open
// AP/AR balance, discount check, and FX-on-payment calc already reads
// from — STAYS here and stays exactly as before (it doesn't care whether
// the return that created a returnAdjustments[] entry was a sales or a
// purchase return). patch-v64.js reuses this exact function directly
// (it's window-exposed) rather than redefining it again.
//
// Verified end-to-end (Sales Return math unchanged from the original
// verification): EUR base / USD foreign, 2/10 n/30 terms, partial return
// then early payment — every number matched, including the discount/
// FX-loss split on a partially-returned foreign invoice. Always valued at
// the ORIGINAL booking rate (a return is a partial reversal, not a new
// transaction), never today's spot rate.
// ═══════════════════════════════════════════════════════════

(function () {
  function todayStr() { return (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function fmtMoney(n) { return (typeof fc === 'function') ? fc(n) : '$' + (parseFloat(n) || 0).toFixed(2); }
  function _resolveGlobalV63(name) {
    if (typeof window[name] !== 'undefined') return window[name];
    try { return eval(name); } catch (e) { return undefined; }
  }

  // ── The core integration point — every open AP/AR balance, discount
  // eligibility check, and FX-on-payment calc reads from this. A return
  // (sales OR purchase) just adds to entry.returnAdjustments[], and this
  // is the one place that gets added into the number everything else
  // already uses. patch-v64.js's Purchase Returns reuse this directly. ──
  window.getCurrentBookedAmount = function (entry) {
    const line = (entry.credits || []).find(function (l) { return l.acct === 'Accounts Payable'; })
      || (entry.debits || []).find(function (l) { return l.acct === 'Accounts Receivable'; });
    if (!line) return 0;
    const fxAdjTotal = (entry.fxAdjustments || []).reduce(function (s, a) { return s + (+a.amount || 0); }, 0);
    const returnAdjTotal = (entry.returnAdjustments || []).reduce(function (s, a) { return s + (+a.amount || 0); }, 0);
    return +(line.amt + fxAdjTotal + returnAdjTotal).toFixed(2);
  };

  function nextReturnNumberV63(prefix) {
    let max = 0;
    (DB.entries || []).forEach(function (e) {
      if (!e.returnNumber || e.returnNumber.indexOf(prefix + '-') !== 0) return;
      const m = /^([A-Z]+)-(\d+)$/.exec(e.returnNumber);
      if (m) { const n = parseInt(m[2], 10); if (n > max) max = n; }
    });
    return prefix + '-' + String(max + 1).padStart(4, '0');
  }

  async function persistProductV63(product) {
    try {
      await dbApi({
        action: 'saveProduct', companyId: SESSION.companyId, id: product.id, name: product.name, sku: product.sku,
        barcode: product.barcode, category: product.category, sale_price: product.sale_price, cost_price: product.cost_price,
        qty: product.qty, min_qty: product.min_qty, unit: product.unit, tax_tier_id: product.tax_tier_id,
        price_inclusive: product.price_inclusive, layers: product.layers
      });
    } catch (e) { console.error('persistProductV63', e); }
  }

  function restockForSalesReturnV63(product, qty) {
    const unitCost = parseFloat(product.cost_price) || 0;
    const method = _resolveGlobalV63('INV_COSTING_METHOD');
    if (method === 'FIFO') {
      product.layers = product.layers || [];
      product.layers.push({ qty: qty, unitCost: unitCost, date: todayStr() });
    }
    product.qty = +((parseFloat(product.qty) || 0) + qty).toFixed(6);
    return +(qty * unitCost).toFixed(2);
  }

  // ── Sales Return ──────────────────────────────────────────────────
  window.createSalesReturnV63 = async function () {
    const st = document.getElementById('ret-sales-st');
    const invSel = document.getElementById('ret-sales-invoice');
    const invoiceId = invSel ? parseInt(invSel.value, 10) : null;
    const amtEl = document.getElementById('ret-sales-amt');
    const amtEntered = amtEl ? parseFloat(amtEl.value) || 0 : 0;
    if (!invoiceId) { if (st) st.innerHTML = '<span style="color:var(--red3)">Select an invoice</span>'; return; }
    if (amtEntered <= 0) { if (st) st.innerHTML = '<span style="color:var(--red3)">Enter a return amount</span>'; return; }

    const custSel = document.getElementById('ret-sales-customer');
    const customerId = custSel ? custSel.value : null;
    const open = (typeof getOpenARInvoices === 'function') ? getOpenARInvoices(customerId) : [];
    const inv = open.find(function (x) { return x.id === invoiceId; });
    if (!inv) { if (st) st.innerHTML = '<span style="color:var(--red3)">That invoice is not currently open (already fully paid, or not found) — a return against a fully-settled invoice needs a cash refund instead, which isn\'t built yet.</span>'; return; }
    const originalEntry = DB.entries.find(function (e) { return e.id === invoiceId; });
    if (!originalEntry) { if (st) st.innerHTML = '<span style="color:var(--red3)">Original entry not found</span>'; return; }

    const isFx = !!inv.fx;
    const rate = isFx ? inv.fx.rate : 1; // ORIGINAL rate — a return is a partial reversal, never today's spot
    const remainingForeign = isFx ? +(inv.remaining / rate).toFixed(4) : inv.remaining;
    if (amtEntered > remainingForeign + 0.01) {
      if (st) st.innerHTML = `<span style="color:var(--red3)">Return amount (${fmtMoney(amtEntered)}) is more than what's still open on this invoice (${fmtMoney(remainingForeign)}).</span>`;
      return;
    }
    const returnBase = +(amtEntered * rate).toFixed(2);

    // Optional inventory lines
    const rows = document.querySelectorAll('#ret-sales-lines .ret-line-row');
    const inventoryDebitsByAcct = {};
    let totalCogsCredit = 0;
    rows.forEach(function (row) {
      const productId = parseInt((row.querySelector('.ret-line-product') || {}).value, 10);
      const qty = parseFloat((row.querySelector('.ret-line-qty') || {}).value) || 0;
      if (!productId || qty <= 0) return;
      const product = (RETAIL_PRODUCTS || []).find(function (p) { return p.id === productId; });
      if (!product) return;
      const cost = restockForSalesReturnV63(product, qty);
      const acct = 'Inventory (' + product.name + ')';
      inventoryDebitsByAcct[acct] = +((inventoryDebitsByAcct[acct] || 0) + cost).toFixed(2);
      totalCogsCredit = +(totalCogsCredit + cost).toFixed(2);
      persistProductV63(product);
    });

    const returnNumber = nextReturnNumberV63('SR');
    const debits = [{ acct: 'Sales Returns & Allowances', amt: returnBase, atype: 'expense' }];
    Object.keys(inventoryDebitsByAcct).forEach(function (acct) {
      if (inventoryDebitsByAcct[acct] > 0.001) debits.push({ acct: acct, amt: inventoryDebitsByAcct[acct], atype: 'asset' });
    });
    const credits = [{ acct: 'Accounts Receivable', amt: returnBase, atype: 'asset' }];
    if (totalCogsCredit > 0.001) credits.push({ acct: 'Cost of Goods Sold', amt: totalCogsCredit, atype: 'expense' });

    const returnEntry = {
      id: DB.nextId++, date: todayStr(),
      desc: 'Sales Return (' + returnNumber + ') — ' + (originalEntry.party ? originalEntry.party.name : '') + ' — ref: ' + originalEntry.desc,
      type: 'Sales Return', amount: returnBase, returnNumber: returnNumber, returnOf: invoiceId,
      debits: debits, credits: credits,
      party: originalEntry.party || null
    };
    if (isFx) returnEntry.fx = { currency: inv.fx.currency, rate: rate, originalAmount: amtEntered };
    DB.entries.push(returnEntry);

    originalEntry.returnAdjustments = originalEntry.returnAdjustments || [];
    originalEntry.returnAdjustments.push({ amount: -returnBase, returnEntryId: returnEntry.id, date: todayStr(), foreignAmount: isFx ? -amtEntered : null });

    await saveData();
    renderAll();
    if (typeof showToast === 'function') showToast('✅ ' + returnNumber + ' recorded — ' + fmtMoney(returnBase) + ' against ' + originalEntry.desc);
    resetSalesReturnFormV63();
    renderReturnsListV63();
  };

  // ── UI ────────────────────────────────────────────────────────────
  let _retLineSeq = 0;
  function productPickerOptionsV63() {
    return '<option value="">— select product (optional) —</option>' + (RETAIL_PRODUCTS || []).map(function (p) {
      return `<option value="${p.id}">${esc(p.name)}</option>`;
    }).join('');
  }
  function addReturnLineRowV63(containerId) {
    const wrap = document.getElementById(containerId); if (!wrap) return;
    const rowId = 'retline-' + (++_retLineSeq);
    const row = document.createElement('div');
    row.className = 'ret-line-row'; row.id = rowId;
    row.style.cssText = 'display:grid;grid-template-columns:1fr 90px 26px;gap:6px;margin-bottom:6px';
    row.innerHTML = `
      <select class="ret-line-product" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none">${productPickerOptionsV63()}</select>
      <input class="ret-line-qty" type="number" min="0" step="0.01" placeholder="Qty" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <button type="button" class="btn btn-danger" style="padding:4px 6px;font-size:11px" onclick="document.getElementById('${rowId}').remove()">✕</button>
    `;
    wrap.appendChild(row);
  }
  window.addSalesReturnLineV63 = function () { addReturnLineRowV63('ret-sales-lines'); };

  function invoiceDescForPickerV63(inv) {
    const remLabel = inv.fx ? (inv.fx.currency + ' ' + (+(inv.remaining / inv.fx.rate).toFixed(2))) : fmtMoney(inv.remaining);
    return '#' + inv.id + ' — ' + inv.desc + ' (open: ' + remLabel + ')';
  }
  window.onReturnCustomerChangeV63 = function () {
    const custSel = document.getElementById('ret-sales-customer');
    const invSel = document.getElementById('ret-sales-invoice');
    if (!custSel || !invSel) return;
    const open = (typeof getOpenARInvoices === 'function' && custSel.value) ? getOpenARInvoices(custSel.value) : [];
    invSel.innerHTML = '<option value="">— select open invoice —</option>' + open.map(function (inv) {
      return `<option value="${inv.id}">${esc(invoiceDescForPickerV63(inv))}</option>`;
    }).join('');
  };

  function resetSalesReturnFormV63() {
    const custSel = document.getElementById('ret-sales-customer'); if (custSel) custSel.value = '';
    const invSel = document.getElementById('ret-sales-invoice'); if (invSel) invSel.innerHTML = '<option value="">— select open invoice —</option>';
    const amtEl = document.getElementById('ret-sales-amt'); if (amtEl) amtEl.value = '';
    const linesEl = document.getElementById('ret-sales-lines'); if (linesEl) linesEl.innerHTML = '';
    const st = document.getElementById('ret-sales-st'); if (st) st.innerHTML = '';
  }

  function renderReturnsListV63() {
    const el = document.getElementById('ret-list-v63'); if (!el) return;
    const returns = (DB.entries || []).filter(function (e) { return e.type === 'Sales Return'; })
      .sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
    if (!returns.length) { el.innerHTML = '<div style="text-align:center;padding:18px;color:var(--text3)">No sales returns recorded yet</div>'; return; }
    el.innerHTML = `<table><thead><tr><th>#</th><th>Date</th><th>Customer</th><th>Amount</th><th>Reference</th></tr></thead><tbody>${
      returns.map(function (r) {
        return `<tr><td style="font-family:'JetBrains Mono',monospace">${esc(r.returnNumber)}</td><td style="font-size:11px">${esc(r.date)}</td><td>${esc(r.party ? r.party.name : '—')}</td><td>${fmtMoney(r.amount)}</td><td style="font-size:11px;color:var(--text3)">${esc(r.desc)}</td></tr>`;
      }).join('')
    }</tbody></table>`;
  }

  function injectReturnsPageV63() {
    if (document.getElementById('pg-returns')) return;
    const main = document.querySelector('.main'); if (!main) return;
    const page = document.createElement('div');
    page.className = 'page'; page.id = 'pg-returns';
    page.innerHTML = `<div class="ph"><h1>↩️ Sales Returns</h1><p>Purchase Returns now has its own page — see "↩️ Purchase Returns" in the sidebar, with the Debit Note request → supplier-agreement workflow.</p></div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-hdr">↩️ Sales Return</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <div class="fg" style="margin:0"><label style="font-size:10px">Customer</label>
            <select id="ret-sales-customer" onchange="onReturnCustomerChangeV63()" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text);outline:none">
              <option value="">— select customer —</option>
            </select>
          </div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Open Invoice</label>
            <select id="ret-sales-invoice" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text);outline:none">
              <option value="">— select open invoice —</option>
            </select>
          </div>
        </div>
        <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Return Amount (in the invoice's own currency — original booking rate is used automatically, not today's rate)</label>
          <input id="ret-sales-amt" type="number" min="0" step="0.01" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:13px;color:var(--text);outline:none"/>
        </div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Items being returned to stock (optional — leave blank for non-inventory/service invoices):</div>
        <div id="ret-sales-lines"></div>
        <button type="button" class="btn btn-outline" style="padding:5px 10px;font-size:11px;margin-bottom:10px" onclick="addSalesReturnLineV63()">+ Add Item</button>
        <div><button class="btn btn-gold" onclick="createSalesReturnV63()">✅ Record Sales Return</button></div>
        <div id="ret-sales-st" style="margin-top:8px;font-size:12px"></div>
      </div>

      <div class="card"><div class="card-hdr">History</div><div id="ret-list-v63"></div></div>
    `;
    main.appendChild(page);
  }

  function populatePartyDropdownsV63() {
    const custSel = document.getElementById('ret-sales-customer');
    if (custSel) custSel.innerHTML = '<option value="">— select customer —</option>' + (CUSTOMERS || []).map(function (c) { return `<option value="${c.id}">${esc(c.name)}</option>`; }).join('');
  }

  // ── Sidebar (both modes, both languages) ──────────────────────────
  ['RETAIL_NAV', 'RETAIL_NAV_EN', 'CONSTRUCTION_NAV', 'CONSTRUCTION_NAV_EN'].forEach(function (name) {
    const arr = _resolveGlobalV63(name);
    if (Array.isArray(arr) && !arr.some(function (s) { return s.section === '↩️ Sales Returns' || s.section === '↩️ Returns'; })) {
      arr.push({ section: '↩️ Sales Returns', items: [{ ico: '↩️', ti: 'Sales Returns', en: 'Sales Returns', page: 'returns' }] });
    }
  });

  // ── nav() — inject BEFORE awaiting, per the lesson learned fixing
  // v53/v57/v58's blank-page-on-first-visit bug ─────────────────────
  const _origNavV63 = window.nav;
  if (typeof _origNavV63 === 'function') {
    window.nav = async function (page, el) {
      injectReturnsPageV63();
      const result = await _origNavV63(page, el);
      if (page === 'returns') { populatePartyDropdownsV63(); renderReturnsListV63(); }
      return result;
    };
  }

  console.log('✅ patch-v63.js loaded (re-shipped) — Sales Returns only; Purchase Returns moved to patch-v64.js');
})();
