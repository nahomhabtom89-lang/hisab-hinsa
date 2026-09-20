// ═══════════════════════════════════════════════════════════
// PATCH v63 — Sales Returns, rebuilt to match Purchase Returns exactly
// ═══════════════════════════════════════════════════════════
// RE-SHIP NOTE: this file previously held a single-step Sales Return
// form (record it, it posts immediately). Per request, Sales Returns now
// gets everything Purchase Returns (patch-v64.js) has, mirrored onto the
// customer/AR side:
//
//   STAGE 1 — Return Request (a Credit Note draft). A customer wants to
//   return something — document it (reason, item lines, optional
//   reference to the original invoice), print it or send it via
//   WhatsApp. Status goes draft → sent. NOTHING TOUCHES THE JOURNAL YET,
//   and stock stays exactly as-is (items just show a "🔒 Pending Return"
//   note, informational only — mirrors Purchase Returns' own decision).
//
//   STAGE 2 — Customer Agreed → Confirm. Only now does the journal entry
//   post (type 'Sales Return', numbered SR-xxxx) and stock actually goes
//   back on hand. Settlement choices:
//     - Reduce the original invoice   (only if it still has an open AR
//       balance)
//     - Cash refund to the customer   (any cash/mobile/bank/foreign acct)
//     - Store credit for the customer (WE owe THEM — see below)
//
// MIRRORED, NOT COPIED, WHERE THE DIRECTION FLIPS:
//   - Purchase Returns' "Supplier Credit Receivable" is an ASSET (the
//     supplier owes us). Its sales-side mirror, "Customer Store Credit",
//     is a LIABILITY (we owe the customer) — opposite sign, correctly
//     reflected in every posting below.
//   - A Purchase Return refund RECEIVES cash — paying MORE than the
//     original booked value is a GAIN. A Sales Return refund PAYS cash
//     OUT to the customer — paying MORE than the original booked value
//     is a LOSS. This is not a guess: it's the exact same sign
//     convention this app already uses for Pay Supplier (patch-v36,
//     paying out — loss when paying more) vs Receive Payment
//     (patch-v25, receiving in — gain when receiving more). Verified
//     with a standalone Node simulation (both directions, plus store
//     credit issuance + later application to a different AR invoice)
//     before shipping any of this.
//
// A REAL LIMITATION, stated plainly rather than glossed over: the base
// app only attaches party:{type:'customer',...} to a POS sale when it's
// a CREDIT sale — a cash sale (even to a regular, named customer) never
// gets a customer tagged on its journal entry at all, and POS pricing is
// already base-currency by design, so there's no equivalent of Purchase
// Returns' "untagged foreign cash purchase" gap to fix here. Practically:
// a return against a walk-in cash sale won't find a Reference Invoice to
// match at all — "no matching invoice / not sure" (already supported) is
// the honest, correct path for those, same as returns without an
// invoice on the purchase side.
//
// getCurrentBookedAmount(entry) is UNCHANGED and stays here, exposed
// exactly as before — every open AP/AR balance, discount check, and FX-
// on-payment calc across the whole app already reads from it, including
// patch-v64.js's Purchase Returns, which calls this exact function.
// ═══════════════════════════════════════════════════════════

(function () {
  function todayStr() { return (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function fmtMoney(n) { return (typeof fc === 'function') ? fc(n) : '$' + (parseFloat(n) || 0).toFixed(2); }
  function _resolveGlobalV63(name) {
    if (typeof window[name] !== 'undefined') return window[name];
    try { return eval(name); } catch (e) { return undefined; }
  }

  // ── The core integration point — UNCHANGED from before. Every open
  // AP/AR balance, discount eligibility check, and FX-on-payment calc
  // reads from this. A return (sales OR purchase) just adds to
  // entry.returnAdjustments[], and this is the one place that gets added
  // into the number everything else already uses. patch-v64.js's
  // Purchase Returns reuse this directly (it's window-exposed). ──
  window.getCurrentBookedAmount = function (entry) {
    const line = (entry.credits || []).find(function (l) { return l.acct === 'Accounts Payable'; })
      || (entry.debits || []).find(function (l) { return l.acct === 'Accounts Receivable'; });
    if (!line) return 0;
    const fxAdjTotal = (entry.fxAdjustments || []).reduce(function (s, a) { return s + (+a.amount || 0); }, 0);
    const returnAdjTotal = (entry.returnAdjustments || []).reduce(function (s, a) { return s + (+a.amount || 0); }, 0);
    return +(line.amt + fxAdjTotal + returnAdjTotal).toFixed(2);
  };
  function bookedAmountV63(entry) {
    const fn = _resolveGlobalV63('getCurrentBookedAmount');
    return (typeof fn === 'function') ? fn(entry) : 0;
  }

  const SR_REASONS_V63 = [
    'Damaged / Defective', 'Wrong Item Delivered', 'Wrong Colour / Spec', 'Quantity Discrepancy (Over/Short)',
    'Not as Described', 'Customer Changed Mind', 'Pricing / Invoicing Error', 'Other'
  ];
  const SRR_STATUS_LABEL_V63 = { draft: '📝 Draft', sent: '📤 Sent to Customer', confirmed: '✅ Confirmed', cancelled: '❌ Cancelled' };
  const SRR_STATUS_TAG_V63 = { draft: 't-blue', sent: 't-gold', confirmed: 't-green', cancelled: 't-red' };

  const _dbKeys = _resolveGlobalV63('DB_KEYS');
  if (Array.isArray(_dbKeys) && _dbKeys.indexOf('salesReturnRequests') === -1) _dbKeys.push('salesReturnRequests');
  function ensureSRRequestsArray() { if (!Array.isArray(DB.salesReturnRequests)) DB.salesReturnRequests = []; }

  function nextCrNumberV63() {
    ensureSRRequestsArray();
    let max = 0;
    DB.salesReturnRequests.forEach(function (r) {
      const m = /^CR-(\d+)$/.exec(r.crNumber || '');
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    });
    return 'CR-' + String(max + 1).padStart(4, '0');
  }
  function nextSrNumberV63() {
    let max = 0;
    (DB.entries || []).forEach(function (e) {
      if (!e.returnNumber || e.returnNumber.indexOf('SR-') !== 0) return;
      const m = /^SR-(\d+)$/.exec(e.returnNumber);
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    });
    return 'SR-' + String(max + 1).padStart(4, '0');
  }

  // Informational only (mirrors Purchase Returns' own scope decision) —
  // not wired into Products/POS this round.
  window.pendingReturnQtyForProductV63 = function (productId) {
    ensureSRRequestsArray();
    let pending = 0;
    DB.salesReturnRequests.forEach(function (r) {
      if (r.status !== 'draft' && r.status !== 'sent') return;
      (r.lines || []).forEach(function (l) { if (l.productId === productId) pending += (parseFloat(l.qty) || 0); });
    });
    return +pending.toFixed(4);
  };

  // Reads FX info off an entry regardless of shape — a credit sale
  // carries it at the top level (entry.fx), a foreign-account instant
  // sale (patch-v31) carries it on the debit line instead. Identical
  // helper to patch-v64.js's entryForeignInfoV64, duplicated locally
  // rather than reached into (that one isn't window-exposed, and this
  // is small enough that duplicating it is the safe move).
  function entryForeignInfoV63(entry) {
    if (!entry) return null;
    if (entry.fx && entry.fx.currency && entry.fx.rate) return { currency: entry.fx.currency, rate: entry.fx.rate };
    const lines = (entry.debits || []).concat(entry.credits || []);
    const line = lines.find(function (l) { return l.foreignAmt && l.currency && Math.abs(l.foreignAmt) > 0.0001; });
    if (line) return { currency: line.currency, rate: +(line.amt / line.foreignAmt).toFixed(6) };
    return null;
  }

  // Every sales entry for a customer — credit (AR) or cash. In practice
  // this mostly finds credit sales, since a cash POS sale never gets
  // party:{type:'customer',...} attached at all in the base app (see the
  // note at the top of this file) — a stated, honest limitation, not
  // something this function can work around.
  function allCustomerInvoicesV63(customerId) {
    return (DB.entries || [])
      .filter(function (e) {
        if (!e.party || e.party.type !== 'customer' || String(e.party.id) !== String(customerId)) return false;
        return (e.debits || []).some(function (l) { return l.acct === 'Accounts Receivable'; }) || e.type === 'POS Sale' || e.type === 'Invoice';
      })
      .map(function (e) {
        const booked = bookedAmountV63(e);
        const settled = (typeof getSettledAmountForInvoice === 'function') ? getSettledAmountForInvoice(e.id) : 0;
        const isAR = (e.debits || []).some(function (l) { return l.acct === 'Accounts Receivable'; });
        return { id: e.id, date: e.date, desc: e.desc, booked: booked, remaining: +(booked - settled).toFixed(2), fx: entryForeignInfoV63(e), isAR: isAR };
      })
      .sort(function (a, b) { return b.date.localeCompare(a.date); });
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

  // ═══════════════════════════════════════════════════════════
  // STAGE 1 — Return Request (Credit Note draft). NO accounting impact.
  // ═══════════════════════════════════════════════════════════
  let _srLineSeq = 0;
  function productPickerOptionsV63() {
    return '<option value="">— type description instead (non-catalog item) —</option>' + (RETAIL_PRODUCTS || []).map(function (p) {
      return `<option value="${p.id}" data-cost="${p.cost_price || 0}" data-price="${p.sale_price || 0}" data-name="${esc(p.name)}" data-sku="${esc(p.sku || '')}">${esc(p.name)}</option>`;
    }).join('');
  }
  function refreshSR63ProductDropdowns() {
    document.querySelectorAll('.sr63-line-product').forEach(function (sel) {
      const prev = sel.value;
      sel.innerHTML = productPickerOptionsV63();
      if (prev && (RETAIL_PRODUCTS || []).some(function (p) { return String(p.id) === String(prev); })) sel.value = prev;
    });
  }
  const _origLoadRetailProductsV63 = window.loadRetailProducts;
  if (typeof _origLoadRetailProductsV63 === 'function') {
    window.loadRetailProducts = async function () {
      const result = await _origLoadRetailProductsV63.apply(this, arguments);
      refreshSR63ProductDropdowns();
      return result;
    };
  }

  window.addSRLineV63 = function () {
    const wrap = document.getElementById('sr63-lines'); if (!wrap) return;
    const rowId = 'srline63-' + (++_srLineSeq);
    const row = document.createElement('div');
    row.className = 'sr63-line-row'; row.id = rowId;
    row.style.cssText = 'display:grid;grid-template-columns:1.3fr 1fr 70px 90px 26px;gap:6px;margin-bottom:6px;align-items:center';
    row.innerHTML = `
      <select class="sr63-line-product" onchange="onSR63LineProductChange('${rowId}')" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none">${productPickerOptionsV63()}</select>
      <input class="sr63-line-desc" type="text" placeholder="Description" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <input class="sr63-line-qty" type="number" min="0" step="0.01" placeholder="Qty" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <input class="sr63-line-price" type="number" min="0" step="0.01" placeholder="Unit Price" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <button type="button" class="btn btn-danger" style="padding:4px 6px;font-size:11px" onclick="document.getElementById('${rowId}').remove()">✕</button>
    `;
    wrap.appendChild(row);
  };
  window.onSR63LineProductChange = function (rowId) {
    const row = document.getElementById(rowId); if (!row) return;
    const sel = row.querySelector('.sr63-line-product');
    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value) return;
    const descEl = row.querySelector('.sr63-line-desc');
    const priceEl = row.querySelector('.sr63-line-price');
    if (descEl && !descEl.value) descEl.value = opt.dataset.name || '';
    if (priceEl && !priceEl.value) priceEl.value = opt.dataset.price || '';
  };

  window.onSRCustomerChangeV63 = function () {
    const custSel = document.getElementById('sr63-customer');
    const refSel = document.getElementById('sr63-ref-invoice');
    if (!custSel || !refSel) return;
    const invoices = custSel.value ? allCustomerInvoicesV63(custSel.value) : [];
    refSel.innerHTML = '<option value="">— no matching invoice / not sure —</option>' + invoices.map(function (inv) {
      const status = inv.remaining > 0.01 ? ('open, ' + fmtMoney(inv.remaining) + ' remaining') : (inv.isAR ? 'fully settled' : 'cash sale' + (inv.fx ? (' (' + inv.fx.currency + ')') : ''));
      return `<option value="${inv.id}">#${inv.id} · ${esc(inv.desc)} · ${status}</option>`;
    }).join('');
  };

  function readSRLinesV63() {
    const rows = document.querySelectorAll('#sr63-lines .sr63-line-row');
    const lines = [];
    rows.forEach(function (row) {
      const sel = row.querySelector('.sr63-line-product');
      const productId = sel && sel.value ? parseInt(sel.value, 10) : null;
      const description = (row.querySelector('.sr63-line-desc') || {}).value || '';
      const qty = parseFloat((row.querySelector('.sr63-line-qty') || {}).value) || 0;
      const unitPrice = parseFloat((row.querySelector('.sr63-line-price') || {}).value) || 0;
      if (qty <= 0 || unitPrice < 0 || (!productId && !description.trim())) return;
      const product = productId ? (RETAIL_PRODUCTS || []).find(function (p) { return p.id === productId; }) : null;
      lines.push({ productId: productId, description: product ? product.name : description.trim(), sku: product ? (product.sku || '') : '', qty: qty, unitPrice: unitPrice, total: +(qty * unitPrice).toFixed(2) });
    });
    return lines;
  }

  window.createSalesReturnRequestV63 = async function () {
    const st = document.getElementById('sr63-st');
    const custSel = document.getElementById('sr63-customer');
    const customerId = custSel ? custSel.value : '';
    if (!customerId) { if (st) st.innerHTML = '<span style="color:var(--red3)">Select a customer</span>'; return; }
    const customer = (typeof CUSTOMERS !== 'undefined' ? CUSTOMERS : []).find(function (c) { return String(c.id) === String(customerId); });

    const lines = readSRLinesV63();
    if (!lines.length) { if (st) st.innerHTML = '<span style="color:var(--red3)">Add at least one item (qty and unit price required)</span>'; return; }

    const refSel = document.getElementById('sr63-ref-invoice');
    const refEntryId = refSel && refSel.value ? parseInt(refSel.value, 10) : null;
    const refEntry = refEntryId ? DB.entries.find(function (e) { return e.id === refEntryId; }) : null;

    const reasonSel = document.getElementById('sr63-reason');
    const reason = reasonSel ? reasonSel.value : SR_REASONS_V63[0];
    const notesEl = document.getElementById('sr63-notes');
    const reasonNotes = notesEl ? notesEl.value.trim() : '';
    const freightEl = document.querySelector('input[name="sr63-freight"]:checked');
    const freightBorneBy = freightEl ? freightEl.value : 'us';

    const amount = +lines.reduce(function (s, l) { return s + l.total; }, 0).toFixed(2);

    const request = {
      id: DB.nextId++, crNumber: nextCrNumberV63(), date: todayStr(),
      customerId: customerId, customerName: customer ? customer.name : '',
      refEntryId: refEntryId, refDesc: refEntry ? refEntry.desc : '',
      reason: reason, reasonNotes: reasonNotes, freightBorneBy: freightBorneBy,
      lines: lines, amount: amount,
      status: 'draft', sentDate: null, confirmedDate: null,
      settlement: null, returnEntryId: null, creditNoteRef: ''
    };
    ensureSRRequestsArray();
    DB.salesReturnRequests.push(request);
    await saveData();
    renderAll();
    if (typeof showToast === 'function') showToast('✅ ' + request.crNumber + ' created (draft) — ' + fmtMoney(amount) + '. Print or send it, then confirm once the customer agrees.');
    resetSRRequestFormV63();
    renderSRRequestsListV63();
    renderCustomerCreditBalancesV63();
  };

  function resetSRRequestFormV63() {
    const custSel = document.getElementById('sr63-customer'); if (custSel) custSel.value = '';
    const refSel = document.getElementById('sr63-ref-invoice'); if (refSel) refSel.innerHTML = '<option value="">— no matching invoice / not sure —</option>';
    const notesEl = document.getElementById('sr63-notes'); if (notesEl) notesEl.value = '';
    const linesEl = document.getElementById('sr63-lines'); if (linesEl) linesEl.innerHTML = '';
    const st = document.getElementById('sr63-st'); if (st) st.innerHTML = '';
  }

  window.markSRRequestSentV63 = async function (id) {
    ensureSRRequestsArray();
    const r = DB.salesReturnRequests.find(function (x) { return x.id === id; });
    if (!r || r.status !== 'draft') return;
    r.status = 'sent'; r.sentDate = todayStr();
    await saveData();
    if (typeof showToast === 'function') showToast('📤 ' + r.crNumber + ' marked as sent to ' + r.customerName);
    renderSRRequestsListV63();
  };
  window.cancelSRRequestV63 = async function (id) {
    ensureSRRequestsArray();
    const r = DB.salesReturnRequests.find(function (x) { return x.id === id; });
    if (!r || r.status === 'confirmed' || r.status === 'cancelled') return;
    if (!confirm('Cancel ' + r.crNumber + '? This cannot be undone.')) return;
    r.status = 'cancelled';
    await saveData();
    if (typeof showToast === 'function') showToast('❌ ' + r.crNumber + ' cancelled');
    renderSRRequestsListV63();
  };

  // ═══════════════════════════════════════════════════════════
  // STAGE 2 — Customer Agreed → Confirm.
  // ═══════════════════════════════════════════════════════════
  window.toggleSRConfirmPanelV63 = function (id) {
    const panel = document.getElementById('sr63-confirm-' + id);
    if (!panel) return;
    const opening = panel.style.display === 'none';
    document.querySelectorAll('.sr63-confirm-panel').forEach(function (p) { p.style.display = 'none'; });
    if (opening) { panel.style.display = 'block'; onSRConfirmSettlementChangeV63(id); }
  };

  window.onSRConfirmSettlementChangeV63 = function (id) {
    const method = (document.querySelector('input[name="sr63-settle-' + id + '"]:checked') || {}).value;
    const panel = document.getElementById('sr63-confirm-' + id);
    const isFxBillStatic = !!(panel && panel.dataset.isFxBill === '1');
    const manualCb = document.getElementById('sr63-manual-fx-' + id);
    const manualChecked = !!(manualCb && manualCb.checked);
    const manualFieldsWrap = document.getElementById('sr63-manual-fx-fields-' + id);
    if (manualFieldsWrap) manualFieldsWrap.style.display = manualChecked ? 'grid' : 'none';

    const fxWrap = document.getElementById('sr63-fx-wrap-' + id);
    const refundWrap = document.getElementById('sr63-refund-wrap-' + id);
    const isFxDriven = (isFxBillStatic || manualChecked) && (method === 'reduceInvoice' || method === 'refund');
    if (fxWrap) fxWrap.style.display = isFxDriven ? 'block' : 'none';
    if (refundWrap) refundWrap.style.display = (method === 'refund') ? 'block' : 'none';
    const rateWrap = document.getElementById('sr63-fx-rate-wrap-' + id);
    if (rateWrap) rateWrap.style.display = (isFxDriven && method === 'refund') ? 'block' : 'none';
    const amtWrap = document.getElementById('sr63-amt-wrap-' + id);
    if (amtWrap) amtWrap.style.display = isFxDriven ? 'none' : 'block';
    if (method === 'refund') {
      const sel = document.getElementById('sr63-refund-acct-' + id);
      if (sel && typeof appendForeignAccountOptions === 'function') appendForeignAccountOptions('sr63-refund-acct-' + id);
    }
  };

  function readManualFxV63(id) {
    const cb = document.getElementById('sr63-manual-fx-' + id);
    if (!cb || !cb.checked) return null;
    const curEl = document.getElementById('sr63-manual-fx-currency-' + id);
    const rateEl = document.getElementById('sr63-manual-fx-origrate-' + id);
    const currency = curEl ? curEl.value.trim().toUpperCase() : '';
    const rate = rateEl ? parseFloat(rateEl.value) || 0 : 0;
    if (!currency || !rate) return null;
    return { currency: currency, rate: rate };
  }

  function confirmPanelHtmlV63(r) {
    const invoices = r.customerId ? allCustomerInvoicesV63(r.customerId) : [];
    const refInv = r.refEntryId ? invoices.find(function (b) { return b.id === r.refEntryId; }) : null;
    const canReduceInvoice = !!(refInv && refInv.remaining > 0.01);
    const isFxBill = !!(refInv && refInv.fx);
    const liveRate = (isFxBill && typeof fxCrossRate === 'function') ? fxCrossRate(refInv.fx.currency) : null;
    const baseCcy = esc((typeof BASE_CURRENCY !== 'undefined' && BASE_CURRENCY) || '');
    return `<div class="sr63-confirm-panel" id="sr63-confirm-${r.id}" data-is-fx-bill="${isFxBill ? '1' : '0'}" style="display:none;background:var(--bg3);border-radius:8px;padding:12px;margin-top:6px">
      <div style="font-size:12px;font-weight:600;margin-bottom:8px">Customer agreed — how is this settled?</div>
      <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:6px;${canReduceInvoice ? '' : 'opacity:0.45'}">
          <input type="radio" name="sr63-settle-${r.id}" value="reduceInvoice" onchange="onSRConfirmSettlementChangeV63(${r.id})" ${canReduceInvoice ? '' : 'disabled'} ${canReduceInvoice ? 'checked' : ''}/>
          Reduce the original invoice ${refInv ? ('(#' + refInv.id + ', ' + (canReduceInvoice ? (fmtMoney(refInv.remaining) + ' open') : 'already fully settled — use refund or store credit instead') + ')') : '(no matching invoice on this request)'}
        </label>
        <label style="display:flex;align-items:center;gap:6px">
          <input type="radio" name="sr63-settle-${r.id}" value="refund" onchange="onSRConfirmSettlementChangeV63(${r.id})" ${canReduceInvoice ? '' : 'checked'}/>
          Cash refund to the customer
        </label>
        <label style="display:flex;align-items:center;gap:6px">
          <input type="radio" name="sr63-settle-${r.id}" value="credit" onchange="onSRConfirmSettlementChangeV63(${r.id})"/>
          Store credit for the customer (apply to a future purchase)
        </label>
      </div>
      ${(refInv && !isFxBill) ? `<div style="margin-bottom:8px;font-size:11px">
        <label style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="sr63-manual-fx-${r.id}" onchange="onSRConfirmSettlementChangeV63(${r.id})"/>
          This sale was actually foreign-currency (its rate wasn't recorded at the time) — enter it manually
        </label>
        <div id="sr63-manual-fx-fields-${r.id}" style="display:none;grid-template-columns:110px 1fr;gap:8px;margin-top:6px">
          <input id="sr63-manual-fx-currency-${r.id}" type="text" placeholder="e.g. USD" maxlength="6" style="background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none;text-transform:uppercase"/>
          <input id="sr63-manual-fx-origrate-${r.id}" type="number" min="0" step="0.0001" placeholder="Original rate at sale time" style="background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"/>
        </div>
      </div>` : ''}
      <div id="sr63-fx-wrap-${r.id}" style="display:none;margin-bottom:8px">
        <label style="font-size:10px" id="sr63-fx-amt-label-${r.id}">Return amount in the sale's currency${isFxBill ? (' (' + esc(refInv.fx.currency) + ') — original rate was ' + refInv.fx.rate) : ''}</label>
        <input id="sr63-fx-amt-${r.id}" type="number" min="0" step="0.01" value="${isFxBill ? (+(r.amount / refInv.fx.rate).toFixed(2)) : ''}" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"/>
        <div id="sr63-fx-rate-wrap-${r.id}" style="display:none;margin-top:8px">
          <label style="font-size:10px">Today's settlement rate${isFxBill ? (' (1 ' + esc(refInv.fx.currency) + ' = ? ' + baseCcy + ')') : ''} — the rate has likely moved since the original sale; this decides the FX gain/loss on the refund</label>
          <input id="sr63-fx-settle-rate-${r.id}" type="number" min="0" step="0.0001" value="${isFxBill ? (liveRate ? liveRate : refInv.fx.rate) : ''}" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"/>
        </div>
      </div>
      <div id="sr63-refund-wrap-${r.id}" style="display:none;margin-bottom:8px">
        <label style="font-size:10px">Refund from${isFxBill ? (' (pick Cash/Mobile/Bank, or a ' + esc(refInv.fx.currency) + ' account)') : ''}</label>
        <select id="sr63-refund-acct-${r.id}" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none">
          <option value="cash">Cash</option><option value="mobile">Mobile Money</option><option value="bank">Bank Account</option>
        </select>
      </div>
      <div class="fg" id="sr63-amt-wrap-${r.id}" style="margin-bottom:8px"><label style="font-size:10px">Amount</label>
        <input id="sr63-amt-${r.id}" type="number" min="0" step="0.01" value="${r.amount}" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:13px;color:var(--text);outline:none"/>
      </div>
      <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Credit Note # given to customer (optional)</label>
        <input id="sr63-creditnote-${r.id}" type="text" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"/>
      </div>
      <div><button class="btn btn-gold" onclick="submitConfirmSRV63(${r.id})">✔️ Confirm — Post Journal Entry</button></div>
      <div id="sr63-confirm-st-${r.id}" style="margin-top:6px;font-size:11px"></div>
    </div>`;
  }

  window.submitConfirmSRV63 = async function (id) {
    ensureSRRequestsArray();
    const r = DB.salesReturnRequests.find(function (x) { return x.id === id; });
    const stEl = document.getElementById('sr63-confirm-st-' + id);
    if (!r || (r.status !== 'draft' && r.status !== 'sent')) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Request not found or already handled</span>'; return; }

    const method = (document.querySelector('input[name="sr63-settle-' + id + '"]:checked') || {}).value;
    if (!method) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Choose a settlement</span>'; return; }

    const invoices = r.customerId ? allCustomerInvoicesV63(r.customerId) : [];
    const refInv = r.refEntryId ? invoices.find(function (b) { return b.id === r.refEntryId; }) : null;
    const refEntry = r.refEntryId ? DB.entries.find(function (e) { return e.id === r.refEntryId; }) : null;

    const manualFxCb = document.getElementById('sr63-manual-fx-' + id);
    if (manualFxCb && manualFxCb.checked && !readManualFxV63(id)) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Enter both the currency and the original rate, or uncheck the manual override</span>'; return; }
    const effectiveFx = (refInv && refInv.fx) ? refInv.fx : readManualFxV63(id);

    let returnBase, foreignAmt = null, foreignCurrency = null;
    let refundActualAmt = null; // only set for a refund referencing a foreign sale — overrides the credit side
    let fxGainLoss = null;      // {type:'gain'|'loss', amt}
    if (method === 'reduceInvoice') {
      if (!refInv || refInv.remaining <= 0.01) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">That invoice no longer has an open balance — use a refund or store credit instead</span>'; return; }
      if (effectiveFx) {
        const fxAmtEl = document.getElementById('sr63-fx-amt-' + id);
        const fxAmt = fxAmtEl ? parseFloat(fxAmtEl.value) || 0 : 0;
        if (fxAmt <= 0) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Enter the return amount in the invoice\'s currency</span>'; return; }
        returnBase = +(fxAmt * effectiveFx.rate).toFixed(2);
        foreignAmt = fxAmt; foreignCurrency = effectiveFx.currency;
      } else {
        const amtEl = document.getElementById('sr63-amt-' + id);
        returnBase = amtEl ? parseFloat(amtEl.value) || 0 : 0;
      }
      if (returnBase > refInv.remaining + 0.01) { if (stEl) stEl.innerHTML = `<span style="color:var(--red3)">Amount (${fmtMoney(returnBase)}) is more than what's still open on that invoice (${fmtMoney(refInv.remaining)})</span>`; return; }
    } else if (method === 'refund' && effectiveFx) {
      // Mirrors patch-v64.js's Purchase Return refund branch exactly,
      // EXCEPT the FX gain/loss sign is flipped: this is money going OUT
      // to the customer (paying more than booked = LOSS), the same
      // convention this app's own Pay Supplier (v36) already uses for
      // money going out — not the "receiving" convention Purchase
      // Returns' refund uses, which is the opposite direction.
      const fxAmtEl = document.getElementById('sr63-fx-amt-' + id);
      const fxAmt = fxAmtEl ? parseFloat(fxAmtEl.value) || 0 : 0;
      if (fxAmt <= 0) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Enter the return amount in the sale\'s currency</span>'; return; }
      const rateEl = document.getElementById('sr63-fx-settle-rate-' + id);
      const settleRate = rateEl ? parseFloat(rateEl.value) || 0 : 0;
      if (!settleRate) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Enter today\'s settlement rate</span>'; return; }
      returnBase = +(fxAmt * effectiveFx.rate).toFixed(2);        // off the books at the ORIGINAL rate
      refundActualAmt = +(fxAmt * settleRate).toFixed(2);         // actually paid out today, at TODAY's rate
      foreignAmt = fxAmt; foreignCurrency = effectiveFx.currency;
      const net = +(refundActualAmt - returnBase).toFixed(2);
      if (Math.abs(net) > 0.01) fxGainLoss = { type: net > 0 ? 'loss' : 'gain', amt: Math.abs(net) }; // flipped vs Purchase Returns
    } else {
      const amtEl = document.getElementById('sr63-amt-' + id);
      returnBase = amtEl ? parseFloat(amtEl.value) || 0 : 0;
    }
    if (!returnBase || returnBase <= 0) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Enter an amount greater than zero</span>'; return; }

    // NOW — and only now — stock actually goes back on hand, using the
    // request's own captured lines.
    const debitsByAcct = {}; // Inventory lines put back — a DEBIT this time (opposite of Purchase Returns)
    let totalRestockValue = 0;
    for (const l of (r.lines || [])) {
      if (!l.productId) continue;
      const product = (RETAIL_PRODUCTS || []).find(function (p) { return p.id === l.productId; });
      if (!product) continue;
      const cost = restockForSalesReturnV63(product, l.qty);
      const acct = 'Inventory (' + product.name + ')';
      debitsByAcct[acct] = +((debitsByAcct[acct] || 0) + cost).toFixed(2);
      totalRestockValue = +(totalRestockValue + cost).toFixed(2);
      await persistProductV63(product);
    }

    let creditLine;
    if (method === 'reduceInvoice') {
      creditLine = { acct: 'Accounts Receivable', amt: returnBase, atype: 'asset' };
    } else if (method === 'refund') {
      const acctSel = document.getElementById('sr63-refund-acct-' + id);
      const acctVal = acctSel ? acctSel.value : 'cash';
      const creditAmt = refundActualAmt != null ? refundActualAmt : returnBase;
      if (acctVal.indexOf('foreign:') === 0) {
        const acctId = acctVal.split(':')[1];
        const foreignAcct = (typeof FOREIGN_ACCOUNTS !== 'undefined' ? FOREIGN_ACCOUNTS : []).find(function (a) { return String(a.id) === String(acctId); });
        if (!foreignAcct) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Selected account not found</span>'; return; }
        if (foreignCurrency && foreignAcct.currency !== foreignCurrency) { if (stEl) stEl.innerHTML = `<span style="color:var(--red3)">This return is in ${foreignCurrency} — pick Cash/Mobile/Bank or a ${foreignCurrency} account, not ${foreignAcct.currency}</span>`; return; }
        let creditForeignAmt;
        if (foreignAmt != null) {
          creditForeignAmt = foreignAmt;
        } else {
          const rate = (typeof fxCrossRate === 'function') ? fxCrossRate(foreignAcct.currency) : null;
          if (!rate) { if (stEl) stEl.innerHTML = `<span style="color:var(--red3)">No known rate for ${foreignAcct.currency} today</span>`; return; }
          creditForeignAmt = +(creditAmt / rate).toFixed(4);
        }
        creditLine = { acct: foreignAccountGLName(foreignAcct), amt: creditAmt, atype: 'asset', foreignAmt: creditForeignAmt, currency: foreignAcct.currency };
      } else {
        const payAcctMap = { cash: 'Cash', mobile: 'Mobile Money', bank: 'Bank Account' };
        creditLine = { acct: payAcctMap[acctVal] || 'Cash', amt: creditAmt, atype: 'asset' };
      }
    } else { // store credit — a LIABILITY (we owe the customer), opposite of Purchase Returns' Supplier Credit Receivable
      creditLine = { acct: 'Customer Store Credit (' + r.customerName + ')', amt: returnBase, atype: 'liability' };
    }

    const debits = [{ acct: 'Sales Returns & Allowances', amt: returnBase, atype: 'expense' }];
    Object.keys(debitsByAcct).forEach(function (acct) { if (debitsByAcct[acct] > 0.001) debits.push({ acct: acct, atype: 'asset', amt: debitsByAcct[acct] }); });
    if (fxGainLoss && fxGainLoss.type === 'loss') debits.push({ acct: 'Realized FX Loss', amt: fxGainLoss.amt, atype: 'expense' });
    const credits = [creditLine];
    if (totalRestockValue > 0.001) credits.push({ acct: 'Cost of Goods Sold', amt: totalRestockValue, atype: 'expense' });
    if (fxGainLoss && fxGainLoss.type === 'gain') credits.push({ acct: 'Realized FX Gain', amt: fxGainLoss.amt, atype: 'income' });

    const returnNumber = nextSrNumberV63();
    const creditNoteEl = document.getElementById('sr63-creditnote-' + id);
    const creditNoteRef = creditNoteEl ? creditNoteEl.value.trim() : '';
    const settleLabel = { reduceInvoice: 'reduced invoice', refund: 'cash refund', credit: 'store credit' }[method];

    const returnEntry = {
      id: DB.nextId++, date: todayStr(),
      desc: 'Sales Return (' + returnNumber + ', ' + r.crNumber + ') — ' + r.customerName + (refEntry ? (' — ref: ' + refEntry.desc) : '') + ' — settled: ' + settleLabel + (fxGainLoss ? (' — Realized FX ' + (fxGainLoss.type === 'gain' ? 'Gain' : 'Loss') + ' ' + fmtMoney(fxGainLoss.amt)) : ''),
      type: 'Sales Return', amount: returnBase, returnNumber: returnNumber, returnOf: method === 'reduceInvoice' ? r.refEntryId : null,
      debits: debits, credits: credits,
      party: { type: 'customer', id: r.customerId, name: r.customerName },
      crNumber: r.crNumber, settlementMethod: method, creditNoteRef: creditNoteRef
    };
    if (foreignAmt != null) returnEntry.fx = { currency: foreignCurrency, rate: effectiveFx.rate, originalAmount: foreignAmt };
    DB.entries.push(returnEntry);

    if (method === 'reduceInvoice' && refEntry) {
      refEntry.returnAdjustments = refEntry.returnAdjustments || [];
      refEntry.returnAdjustments.push({ amount: -returnBase, returnEntryId: returnEntry.id, date: todayStr(), foreignAmount: foreignAmt != null ? -foreignAmt : null });
    }

    r.status = 'confirmed'; r.confirmedDate = todayStr(); r.returnEntryId = returnEntry.id; r.creditNoteRef = creditNoteRef;
    r.settlement = { method: method, amount: returnBase };

    await saveData();
    renderAll();
    if (typeof showToast === 'function') showToast('✅ ' + returnNumber + ' posted — ' + fmtMoney(returnBase) + ' (' + settleLabel + ')');
    renderSRRequestsListV63();
    renderCustomerCreditBalancesV63();
  };

  // ═══════════════════════════════════════════════════════════
  // CUSTOMER STORE CREDIT — derived balance + manual "apply to a bill"
  // + "cash it out" (mirrors patch-v64.js's Supplier Credit exactly,
  // just as a liability instead of an asset).
  // ═══════════════════════════════════════════════════════════
  function customersWithCreditV63() {
    const names = {};
    (DB.entries || []).forEach(function (e) {
      (e.debits || []).forEach(function (l) { const m = /^Customer Store Credit \((.+)\)$/.exec(l.acct); if (m) names[m[1]] = true; });
      (e.credits || []).forEach(function (l) { const m = /^Customer Store Credit \((.+)\)$/.exec(l.acct); if (m) names[m[1]] = true; });
    });
    return Object.keys(names);
  }
  window.getCustomerCreditBalanceV63 = function (customerName) {
    const glName = 'Customer Store Credit (' + customerName + ')';
    let bal = 0;
    (DB.entries || []).forEach(function (e) {
      (e.debits || []).forEach(function (l) { if (l.acct === glName) bal -= (+l.amt || 0); });
      (e.credits || []).forEach(function (l) { if (l.acct === glName) bal += (+l.amt || 0); });
    });
    return +bal.toFixed(2);
  };

  function renderCustomerCreditBalancesV63() {
    const el = document.getElementById('sr63-credit-list'); if (!el) return;
    const names = customersWithCreditV63().filter(function (n) { return window.getCustomerCreditBalanceV63(n) > 0.01; });
    if (!names.length) { el.innerHTML = '<div style="text-align:center;padding:14px;color:var(--text3)">No outstanding store credit</div>'; return; }
    el.innerHTML = names.map(function (name) {
      const bal = window.getCustomerCreditBalanceV63(name);
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border2)">
        <div><b>${esc(name)}</b><div style="font-size:10px;color:var(--text3)">store credit owed to them</div></div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-family:'JetBrains Mono',monospace;color:var(--gold3)">${fmtMoney(bal)}</span>
          <button class="btn btn-outline" style="padding:4px 10px;font-size:11px" onclick="openApplyCustomerCreditV63('${esc(name)}')">Apply to a bill</button>
          <button class="btn btn-outline" style="padding:4px 10px;font-size:11px" onclick="openCashOutCustomerCreditV63('${esc(name)}')">💵 Pay it out</button>
        </div>
      </div>`;
    }).join('');
  }

  window.openApplyCustomerCreditV63 = function (customerName) {
    const customer = (typeof CUSTOMERS !== 'undefined' ? CUSTOMERS : []).find(function (c) { return c.name === customerName; });
    const wrap = document.getElementById('sr63-apply-credit-wrap'); if (!wrap) return;
    wrap.style.display = 'block';
    wrap.dataset.customerId = customer ? customer.id : '';
    wrap.dataset.customerName = customerName;
    const bal = window.getCustomerCreditBalanceV63(customerName);
    document.getElementById('sr63-apply-credit-hdr').textContent = 'Apply ' + customerName + "'s store credit (" + fmtMoney(bal) + ' available)';
    const invSel = document.getElementById('sr63-apply-credit-invoice');
    const invoices = customer ? allCustomerInvoicesV63(customer.id).filter(function (b) { return b.remaining > 0.01; }) : [];
    invSel.innerHTML = '<option value="">— select open invoice —</option>' + invoices.map(function (b) {
      return `<option value="${b.id}">#${b.id} · ${esc(b.desc)} · ${fmtMoney(b.remaining)} open</option>`;
    }).join('');
    document.getElementById('sr63-apply-credit-amt').value = '';
    document.getElementById('sr63-apply-credit-st').innerHTML = '';
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  window.applyCustomerCreditV63 = async function () {
    const wrap = document.getElementById('sr63-apply-credit-wrap');
    const st = document.getElementById('sr63-apply-credit-st');
    const customerId = wrap.dataset.customerId, customerName = wrap.dataset.customerName;
    const invSel = document.getElementById('sr63-apply-credit-invoice');
    const invId = invSel && invSel.value ? parseInt(invSel.value, 10) : null;
    if (!invId) { st.innerHTML = '<span style="color:var(--red3)">Select an invoice</span>'; return; }
    const amtEl = document.getElementById('sr63-apply-credit-amt');
    const amt = amtEl ? parseFloat(amtEl.value) || 0 : 0;
    if (amt <= 0) { st.innerHTML = '<span style="color:var(--red3)">Enter an amount</span>'; return; }
    const available = window.getCustomerCreditBalanceV63(customerName);
    if (amt > available + 0.01) { st.innerHTML = `<span style="color:var(--red3)">Only ${fmtMoney(available)} credit is available</span>`; return; }
    const inv = DB.entries.find(function (e) { return e.id === invId; });
    if (!inv) { st.innerHTML = '<span style="color:var(--red3)">Invoice not found</span>'; return; }
    const remaining = +(bookedAmountV63(inv) - ((typeof getSettledAmountForInvoice === 'function') ? getSettledAmountForInvoice(inv.id) : 0)).toFixed(2);
    if (amt > remaining + 0.01) { st.innerHTML = `<span style="color:var(--red3)">That invoice only has ${fmtMoney(remaining)} still open</span>`; return; }

    const applyEntry = {
      id: DB.nextId++, date: todayStr(),
      desc: 'Customer Store Credit Applied — ' + customerName + ' — to ' + inv.desc,
      type: 'Customer Credit Application', amount: amt,
      debits: [{ acct: 'Customer Store Credit (' + customerName + ')', amt: amt, atype: 'liability' }],
      credits: [{ acct: 'Accounts Receivable', amt: amt, atype: 'asset' }],
      party: { type: 'customer', id: customerId, name: customerName }
    };
    DB.entries.push(applyEntry);
    inv.returnAdjustments = inv.returnAdjustments || [];
    inv.returnAdjustments.push({ amount: -amt, returnEntryId: applyEntry.id, date: todayStr(), foreignAmount: null });

    await saveData();
    renderAll();
    if (typeof showToast === 'function') showToast('✅ ' + fmtMoney(amt) + ' of ' + customerName + "'s store credit applied to " + inv.desc);
    wrap.style.display = 'none';
    renderCustomerCreditBalancesV63();
  };

  window.openCashOutCustomerCreditV63 = function (customerName) {
    const wrap = document.getElementById('sr63-cashout-wrap'); if (!wrap) return;
    wrap.style.display = 'block';
    wrap.dataset.customerName = customerName;
    const bal = window.getCustomerCreditBalanceV63(customerName);
    document.getElementById('sr63-cashout-hdr').textContent = 'Pay out ' + customerName + "'s store credit (" + fmtMoney(bal) + ' available)';
    const acctSel = document.getElementById('sr63-cashout-acct');
    acctSel.innerHTML = '<option value="cash">Cash</option><option value="mobile">Mobile Money</option><option value="bank">Bank Account</option>';
    if (typeof appendForeignAccountOptions === 'function') appendForeignAccountOptions('sr63-cashout-acct');
    document.getElementById('sr63-cashout-amt').value = bal;
    document.getElementById('sr63-cashout-st').innerHTML = '';
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  window.cashOutCustomerCreditV63 = async function () {
    const wrap = document.getElementById('sr63-cashout-wrap');
    const st = document.getElementById('sr63-cashout-st');
    const customerName = wrap.dataset.customerName;
    const amtEl = document.getElementById('sr63-cashout-amt');
    const amt = amtEl ? parseFloat(amtEl.value) || 0 : 0;
    if (amt <= 0) { st.innerHTML = '<span style="color:var(--red3)">Enter an amount</span>'; return; }
    const available = window.getCustomerCreditBalanceV63(customerName);
    if (amt > available + 0.01) { st.innerHTML = `<span style="color:var(--red3)">Only ${fmtMoney(available)} credit is available</span>`; return; }

    const acctSel = document.getElementById('sr63-cashout-acct');
    const acctVal = acctSel ? acctSel.value : 'cash';
    let creditLine;
    if (acctVal.indexOf('foreign:') === 0) {
      const acctId = acctVal.split(':')[1];
      const foreignAcct = (typeof FOREIGN_ACCOUNTS !== 'undefined' ? FOREIGN_ACCOUNTS : []).find(function (a) { return String(a.id) === String(acctId); });
      if (!foreignAcct) { st.innerHTML = '<span style="color:var(--red3)">Selected account not found</span>'; return; }
      const rate = (typeof fxCrossRate === 'function') ? fxCrossRate(foreignAcct.currency) : null;
      if (!rate) { st.innerHTML = `<span style="color:var(--red3)">No known rate for ${foreignAcct.currency} today</span>`; return; }
      creditLine = { acct: foreignAccountGLName(foreignAcct), amt: amt, atype: 'asset', foreignAmt: +(amt / rate).toFixed(4), currency: foreignAcct.currency };
    } else {
      const payAcctMap = { cash: 'Cash', mobile: 'Mobile Money', bank: 'Bank Account' };
      creditLine = { acct: payAcctMap[acctVal] || 'Cash', amt: amt, atype: 'asset' };
    }

    const cashoutEntry = {
      id: DB.nextId++, date: todayStr(),
      desc: 'Customer Store Credit Paid Out — ' + customerName,
      type: 'Customer Credit Cashout', amount: amt,
      debits: [{ acct: 'Customer Store Credit (' + customerName + ')', amt: amt, atype: 'liability' }],
      credits: [creditLine],
      party: { type: 'customer', id: wrap.dataset.customerId || '', name: customerName }
    };
    DB.entries.push(cashoutEntry);

    await saveData();
    renderAll();
    if (typeof showToast === 'function') showToast('✅ ' + fmtMoney(amt) + ' of ' + customerName + "'s store credit paid out");
    wrap.style.display = 'none';
    renderCustomerCreditBalancesV63();
  };

  // ═══════════════════════════════════════════════════════════
  // LIST + PAGE + PRINT + SHARE
  // ═══════════════════════════════════════════════════════════
  function renderSRRequestsListV63() {
    const el = document.getElementById('sr63-list'); if (!el) return;
    ensureSRRequestsArray();
    const rows = DB.salesReturnRequests.slice().sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
    if (!rows.length) { el.innerHTML = '<div style="text-align:center;padding:18px;color:var(--text3)">No return requests yet — create one above when a customer wants to return something</div>'; return; }
    el.innerHTML = rows.map(function (r) {
      const pendingNote = (r.status === 'draft' || r.status === 'sent') && (r.lines || []).some(function (l) { return l.productId; })
        ? '<div style="font-size:10px;color:var(--orange3);margin-top:2px">🔒 Pending return — not yet back in stock</div>' : '';
      const actions = [];
      actions.push(`<button class="btn btn-outline" style="padding:4px 9px;font-size:11px" onclick="printCreditNoteV63(${r.id})">🖨️ Print</button>`);
      if (r.status === 'draft' || r.status === 'sent') actions.push(`<button class="btn btn-outline" style="padding:4px 9px;font-size:11px" onclick="shareCreditNoteV63(${r.id})">📲 Share</button>`);
      if (r.status === 'draft') actions.push(`<button class="btn btn-outline" style="padding:4px 9px;font-size:11px" onclick="markSRRequestSentV63(${r.id})">✅ Mark Sent</button>`);
      if (r.status === 'draft' || r.status === 'sent') {
        actions.push(`<button class="btn btn-gold" style="padding:4px 9px;font-size:11px" onclick="toggleSRConfirmPanelV63(${r.id})">✔️ Customer Agreed</button>`);
        actions.push(`<button class="btn btn-danger" style="padding:4px 9px;font-size:11px" onclick="cancelSRRequestV63(${r.id})">✕ Cancel</button>`);
      }
      if (r.status === 'confirmed') actions.push(`<span style="font-size:10px;color:var(--text3)">${esc((r.settlement && r.settlement.method) || '')}${r.creditNoteRef ? (' · CN# ' + esc(r.creditNoteRef)) : ''}</span>`);
      return `<div style="padding:10px 0;border-bottom:1px solid var(--border2)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
          <div>
            <span style="font-family:'JetBrains Mono',monospace;font-weight:600">${esc(r.crNumber)}</span>
            <span class="tag ${SRR_STATUS_TAG_V63[r.status] || 't-blue'}" style="font-size:9px;margin-left:6px">${SRR_STATUS_LABEL_V63[r.status] || r.status}</span>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">${esc(r.date)} · ${esc(r.customerName)} · ${esc(r.reason)}${r.refDesc ? (' · ref: ' + esc(r.refDesc)) : ' · no matching invoice on file'}</div>
            ${pendingNote}
          </div>
          <div style="text-align:right">
            <div style="font-family:'JetBrains Mono',monospace;font-weight:600">${fmtMoney(r.amount)}</div>
            <div style="display:flex;gap:5px;margin-top:4px;flex-wrap:wrap;justify-content:flex-end">${actions.join('')}</div>
          </div>
        </div>
        ${(r.status === 'draft' || r.status === 'sent') ? confirmPanelHtmlV63(r) : ''}
      </div>`;
    }).join('');
  }

  function populateSRDropdownsV63() {
    const custSel = document.getElementById('sr63-customer');
    if (custSel) custSel.innerHTML = '<option value="">— select customer —</option>' + (typeof CUSTOMERS !== 'undefined' ? CUSTOMERS : []).map(function (c) { return `<option value="${c.id}">${esc(c.name)}</option>`; }).join('');
    const reasonSel = document.getElementById('sr63-reason');
    if (reasonSel && !reasonSel.options.length) reasonSel.innerHTML = SR_REASONS_V63.map(function (r) { return `<option value="${esc(r)}">${esc(r)}</option>`; }).join('');
  }

  function injectSalesReturnsPagesV63() {
    if (document.getElementById('pg-returns')) return;
    const main = document.querySelector('.main'); if (!main) return;

    const page = document.createElement('div');
    page.className = 'page'; page.id = 'pg-returns';
    page.innerHTML = `<div class="ph"><h1>↩️ Sales Returns</h1><p>Create a Return Request (Credit Note) when a customer wants to return something — nothing posts to the books until you confirm the customer agreed.</p></div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-hdr">🆕 New Return Request</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <div class="fg" style="margin:0"><label style="font-size:10px">Customer</label>
            <select id="sr63-customer" onchange="onSRCustomerChangeV63()" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text);outline:none">
              <option value="">— select customer —</option>
            </select>
          </div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Reference Invoice (optional — leave blank if not sure/not on file)</label>
            <select id="sr63-ref-invoice" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text);outline:none">
              <option value="">— no matching invoice / not sure —</option>
            </select>
          </div>
        </div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Items being returned:</div>
        <div id="sr63-lines"></div>
        <button type="button" class="btn btn-outline" style="padding:5px 10px;font-size:11px;margin-bottom:10px" onclick="addSRLineV63()">+ Add Item</button>
        <div style="margin-bottom:8px">
          <div class="fg" style="margin:0"><label style="font-size:10px">Reason</label>
            <select id="sr63-reason" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text);outline:none"></select>
          </div>
        </div>
        <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Notes</label>
          <textarea id="sr63-notes" rows="2" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text);outline:none;resize:vertical"></textarea>
        </div>
        <div style="font-size:11px;margin-bottom:6px">Who bears return freight?
          <label style="margin-left:10px"><input type="radio" name="sr63-freight" value="us" checked/> Us</label>
          <label style="margin-left:10px"><input type="radio" name="sr63-freight" value="customer"/> Customer</label>
        </div>
        <div><button class="btn btn-gold" onclick="createSalesReturnRequestV63()">✅ Create Return Request</button></div>
        <div id="sr63-st" style="margin-top:8px;font-size:12px"></div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-hdr">💳 Customer Store Credit</div>
        <div id="sr63-credit-list"></div>
        <div id="sr63-apply-credit-wrap" style="display:none;margin-top:10px;padding:10px;background:var(--bg3);border-radius:8px">
          <div id="sr63-apply-credit-hdr" style="font-size:12px;font-weight:600;margin-bottom:8px"></div>
          <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Open Invoice</label>
            <select id="sr63-apply-credit-invoice" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"></select>
          </div>
          <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Amount to Apply</label>
            <input id="sr63-apply-credit-amt" type="number" min="0" step="0.01" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"/>
          </div>
          <div><button class="btn btn-gold" onclick="applyCustomerCreditV63()">✔️ Apply Credit</button></div>
          <div id="sr63-apply-credit-st" style="margin-top:6px;font-size:11px"></div>
        </div>
        <div id="sr63-cashout-wrap" style="display:none;margin-top:10px;padding:10px;background:var(--bg3);border-radius:8px">
          <div id="sr63-cashout-hdr" style="font-size:12px;font-weight:600;margin-bottom:8px"></div>
          <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Pay out from</label>
            <select id="sr63-cashout-acct" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"></select>
          </div>
          <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Amount</label>
            <input id="sr63-cashout-amt" type="number" min="0" step="0.01" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"/>
          </div>
          <div><button class="btn btn-gold" onclick="cashOutCustomerCreditV63()">✔️ Pay It Out</button></div>
          <div id="sr63-cashout-st" style="margin-top:6px;font-size:11px"></div>
        </div>
      </div>

      <div class="card"><div class="card-hdr">Return Requests</div><div id="sr63-list"></div></div>
    `;
    main.appendChild(page);

    const printPage = document.createElement('div');
    printPage.className = 'page'; printPage.id = 'pg-sr-print-v63';
    printPage.innerHTML = `<div class="no-print" style="margin-bottom:14px;display:flex;gap:8px">
        <button class="btn btn-outline" onclick="nav('returns')">← Back</button>
        <button class="btn btn-gold" onclick="window.print()">🖨️ Print</button>
      </div>
      <div id="sr-print-content-v63" style="background:#fff;color:#111;padding:28px;max-width:760px;margin:0 auto;font-family:Arial,sans-serif;border-radius:4px"></div>`;
    main.appendChild(printPage);
  }

  const _srPrintStyleV63 = document.createElement('style');
  _srPrintStyleV63.textContent = `
    @media print{
      body.sr-printing-v63 .page{display:none!important}
      body.sr-printing-v63 #pg-sr-print-v63{display:block!important}
    }
    #sr-print-content-v63 table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px}
    #sr-print-content-v63 th,#sr-print-content-v63 td{border:1px solid #999;padding:6px 8px;text-align:left}
    #sr-print-content-v63 td,#sr-print-content-v63 th{color:#111!important}
    #sr-print-content-v63 th{background:#eee;font-weight:700}
  `;
  document.head.appendChild(_srPrintStyleV63);

  window.printCreditNoteV63 = function (requestId) {
    ensureSRRequestsArray();
    const r = DB.salesReturnRequests.find(function (x) { return x.id === requestId; });
    if (!r) { if (typeof showToast === 'function') showToast('⚠️ Return request not found'); return; }
    injectSalesReturnsPagesV63();
    const content = document.getElementById('sr-print-content-v63');
    if (!content) return;
    const linesHtml = (r.lines || []).map(function (l) {
      return `<tr><td>${esc(l.description)}</td><td>${esc(l.sku) || '—'}</td><td style="text-align:center">${l.qty}</td><td style="text-align:right">${fmtMoney(l.unitPrice)}</td><td style="text-align:right">${fmtMoney(l.total)}</td></tr>`;
    }).join('');
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #333;padding-bottom:12px;margin-bottom:14px">
        <div><div style="font-size:20px;font-weight:700">${esc((typeof BIZ_NAME !== 'undefined' && BIZ_NAME) || 'Company')}</div></div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:700;letter-spacing:1px">CREDIT NOTE</div>
          <div style="font-size:12px">No: <b>${esc(r.crNumber)}</b></div>
          <div style="font-size:12px">Date: ${esc(r.date)}</div>
          <div style="font-size:12px">Status: ${esc(SRR_STATUS_LABEL_V63[r.status] || r.status)}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:20px;font-size:13px;margin-bottom:10px">
        <div><b>Customer:</b> ${esc(r.customerName)}</div>
        <div><b>Reference:</b> ${esc(r.refDesc) || 'no matching invoice on file'}</div>
      </div>
      <div style="font-size:13px;margin-bottom:10px"><b>Reason:</b> ${esc(r.reason)}${r.reasonNotes ? (' — ' + esc(r.reasonNotes)) : ''}</div>
      <table><thead><tr><th>Description</th><th>SKU</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead><tbody>${linesHtml}</tbody>
        <tfoot><tr><td colspan="4" style="text-align:right;font-weight:700">Total</td><td style="text-align:right;font-weight:700">${fmtMoney(r.amount)}</td></tr></tfoot></table>
      <div style="font-size:12px;margin-top:10px"><b>Return freight borne by:</b> ${r.freightBorneBy === 'customer' ? 'Customer' : 'Us'}</div>
      <div style="display:flex;justify-content:space-between;gap:30px;margin-top:50px;font-size:12px">
        <div style="flex:1"><div style="border-top:1px solid #333;margin-top:40px;padding-top:4px">Authorized Signature (Us)</div></div>
        <div style="flex:1"><div style="border-top:1px solid #333;margin-top:40px;padding-top:4px">Acknowledged By (Customer)</div></div>
      </div>
    `;
    document.body.classList.add('sr-printing-v63');
    nav('sr-print-v63');
  };

  window.shareCreditNoteV63 = function (requestId) {
    ensureSRRequestsArray();
    const r = DB.salesReturnRequests.find(function (x) { return x.id === requestId; });
    if (!r) { if (typeof showToast === 'function') showToast('⚠️ Return request not found'); return; }
    const itemLines = (r.lines || []).map(function (l) { return '• ' + l.description + (l.sku ? ' (' + l.sku + ')' : '') + ' — qty ' + l.qty + ' @ ' + fmtMoney(l.unitPrice); }).join('\n');
    const summaryText = '📋 Credit Note ' + r.crNumber + '\n' +
      'Date: ' + r.date + '\n' +
      'Customer: ' + r.customerName + '\n' +
      'Reference: ' + (r.refDesc || 'no matching invoice on file') + '\n' +
      'Reason: ' + r.reason + (r.reasonNotes ? (' — ' + r.reasonNotes) : '') + '\n\n' +
      'Items:\n' + itemLines + '\n\n' +
      'Total: ' + fmtMoney(r.amount) + '\n' +
      'Return freight borne by: ' + (r.freightBorneBy === 'customer' ? 'Customer' : 'Us') + '\n\n' +
      'Please confirm you agree to this return so we can proceed.';
    window.open('https://wa.me/?text=' + encodeURIComponent(summaryText), '_blank');
  };

  // ── Customers page — surface the same credit balance there too.
  // CORRECTED FROM AN EARLIER MISTAKE ON THE SUPPLIER SIDE: chain onto
  // whatever window.renderCustomerList currently is (patch-v25 already
  // wraps it to add a "💰 Receive" button) rather than replacing it
  // wholesale — that earlier version silently deleted v25's button. This
  // only adds a column via DOM insertion, nothing else. ──
  const _origRenderCustomerListV63 = window.renderCustomerList;
  if (typeof _origRenderCustomerListV63 === 'function') {
    window.renderCustomerList = function () {
      const result = _origRenderCustomerListV63.apply(this, arguments);
      const table = document.querySelector('#customerList table');
      if (!table) return result;
      const headRow = table.querySelector('thead tr');
      if (headRow && !headRow.querySelector('.sr63-credit-th')) {
        const th = document.createElement('th');
        th.className = 'sr63-credit-th';
        th.textContent = '💳 Store Credit';
        const lastTh = headRow.lastElementChild;
        if (lastTh) headRow.insertBefore(th, lastTh); else headRow.appendChild(th);
      }
      table.querySelectorAll('tbody tr').forEach(function (tr) {
        if (tr.querySelector('.sr63-credit-td')) return;
        const ledgerBtn = tr.querySelector('[onclick^="togglePartyLedger(\'customer\'"]');
        if (!ledgerBtn) return;
        const m = /togglePartyLedger\('customer',(\d+)\)/.exec(ledgerBtn.getAttribute('onclick') || '');
        if (!m) return;
        const customer = (typeof CUSTOMERS !== 'undefined' ? CUSTOMERS : []).find(function (c) { return String(c.id) === m[1]; });
        const credit = customer ? window.getCustomerCreditBalanceV63(customer.name) : 0;
        const td = document.createElement('td');
        td.className = 'sr63-credit-td';
        td.innerHTML = credit > 0.01
          ? `<span style="font-family:'JetBrains Mono',monospace;color:var(--gold3)">${fmtMoney(credit)}</span> <button class="btn btn-outline" style="font-size:9px;padding:2px 6px" onclick="jumpToCustomerCreditV63('${esc(customer.name)}')">use</button>`
          : `<span style="color:var(--text3)">—</span>`;
        const lastTd = tr.lastElementChild;
        if (lastTd) tr.insertBefore(td, lastTd); else tr.appendChild(td);
      });
      return result;
    };
  }
  window.jumpToCustomerCreditV63 = async function (customerName) {
    await nav('returns');
    const el = document.getElementById('sr63-credit-list');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

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
      injectSalesReturnsPagesV63();
      const result = await _origNavV63(page, el);
      if (page !== 'sr-print-v63') document.body.classList.remove('sr-printing-v63');
      if (page === 'returns') { populateSRDropdownsV63(); renderSRRequestsListV63(); renderCustomerCreditBalancesV63(); }
      return result;
    };
  }

  console.log('✅ patch-v63.js loaded (rebuilt) — Sales Returns now mirrors Purchase Returns: Credit Note request → customer agreement → confirmed return, plus customer store credit tracking');
})();
