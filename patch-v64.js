// ═══════════════════════════════════════════════════════════
// PATCH v64 — Purchase Returns, rebuilt as a real two-stage process
// ═══════════════════════════════════════════════════════════
// Purchase Returns now has its own page ("↩️ Purchase Returns" in the
// sidebar) and is a genuine two-stage business process, not a single
// button:
//
//   STAGE 1 — Return Request (a Debit Note draft). Store/inventory finds
//   a problem (damaged, wrong item/colour/spec, quantity discrepancy,
//   quality issue, pricing error, excess stock) against a purchase.
//   You document it — reason, item lines, optional reference to the
//   original bill — print it or send it to the supplier via WhatsApp.
//   Status goes draft → sent. NOTHING TOUCHES THE JOURNAL AT THIS STAGE.
//   Per an explicit decision, stock quantity ALSO stays on-hand at this
//   stage — items are only visually flagged "🔒 On Hold (pending return)"
//   via the derived heldQtyForProductV64() helper (window-exposed for any
//   future page to consume; not wired into Products/POS this round, to
//   keep this patch's blast radius contained).
//
//   STAGE 2 — Supplier Agrees → Confirm. Only now does a real journal
//   entry post (type 'Purchase Return', numbered PR-xxxx, exactly like
//   the old single-step flow used to). You choose how it's settled:
//     - Reduce the original invoice   (only if it still has an open
//       balance — if it's since been fully paid, this option is hidden
//       and you're told to use one of the other two instead)
//     - Cash refund                   (any cash/mobile/bank/foreign acct)
//     - Supplier credit                (they owe YOU — see below)
//   Only at THIS point does stock actually decrease, using the exact
//   same traced-FIFO-layer-first / fallback-to-FIFO-or-WAC costing chain
//   the original v63 Purchase Return used (duplicated locally here —
//   v63's version was never window-exposed, so per Lesson 3 this can't
//   reach into it; it's small enough that a local copy is the right,
//   low-risk move rather than coupling the two files together).
//
// SUPPLIER CREDIT — the "stays with the supplier, deduct from a future
// purchase" case: posts to a per-supplier GL account, "Supplier Credit
// Receivable (SupplierName)", and the available balance is DERIVED by
// scanning that account's own debit/credit lines across DB.entries —
// same pattern as v27's getForeignAccountBalance(), not a separately
// tracked/duplicated number that could drift. Applying it against a
// future bill (manual, by design — build automatic later if wanted)
// reuses the EXACT SAME returnAdjustments[] extension point that
// getCurrentBookedAmount() (window-exposed by v63) already reads from —
// no core function needed to change again, which is exactly the "find
// the one function everything already reads from" pattern this app has
// used since Session 2.
//
// VERIFIED before shipping: a standalone Node simulation of every new
// posting path (credit-settled return, applying that credit against a
// LATER, different, FX-denominated bill, and a refund with a traced/
// untraced split) — every entry balances (debits === credits), the
// credit-issuing return does NOT touch the original invoice's balance,
// applying the credit later reduces the target invoice's open balance
// by exactly the applied amount, and the derived credit balance nets to
// exactly zero once fully applied.
//
// TRACEABILITY: every request keeps its link back to the original bill
// (refEntryId, when matched) all the way through — the request itself,
// the printed Debit Note, and the confirmed journal entry's own desc all
// reference it, and a return with no matching bill on file is still
// fully supported (the "returns without the original invoice" case) —
// it just can't use "Reduce the invoice" as its settlement, since there's
// no invoice to reduce.
// ═══════════════════════════════════════════════════════════

(function () {
  function todayStr() { return (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function fmtMoney(n) { return (typeof fc === 'function') ? fc(n) : '$' + (parseFloat(n) || 0).toFixed(2); }
  function _resolveGlobalV64(name) {
    if (typeof window[name] !== 'undefined') return window[name];
    try { return eval(name); } catch (e) { return undefined; }
  }

  const PR_REASONS_V64 = [
    'Damaged / Defective', 'Wrong Item Delivered', 'Wrong Colour / Spec', 'Quantity Discrepancy (Over/Short)',
    'Quality Not as Agreed', 'Pricing / Invoicing Error', 'Excess Stock / Change of Need', 'Other'
  ];
  const PRR_STATUS_LABEL_V64 = { draft: '📝 Draft', sent: '📤 Sent to Supplier', confirmed: '✅ Confirmed', cancelled: '❌ Cancelled' };
  const PRR_STATUS_TAG_V64 = { draft: 't-blue', sent: 't-gold', confirmed: 't-green', cancelled: 't-red' };

  // DB_KEYS.push — generic key-value store, no backend change (same
  // pattern v57 used for DB.salesOrders).
  const _dbKeys = _resolveGlobalV64('DB_KEYS');
  if (Array.isArray(_dbKeys) && _dbKeys.indexOf('purchaseReturnRequests') === -1) _dbKeys.push('purchaseReturnRequests');
  function ensureRequestsArray() { if (!Array.isArray(DB.purchaseReturnRequests)) DB.purchaseReturnRequests = []; }

  function nextDrNumberV64() {
    ensureRequestsArray();
    let max = 0;
    DB.purchaseReturnRequests.forEach(function (r) {
      const m = /^DR-(\d+)$/.exec(r.drNumber || '');
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    });
    return 'DR-' + String(max + 1).padStart(4, '0');
  }
  function nextPrNumberV64() {
    let max = 0;
    (DB.entries || []).forEach(function (e) {
      if (!e.returnNumber || e.returnNumber.indexOf('PR-') !== 0) return;
      const m = /^PR-(\d+)$/.exec(e.returnNumber);
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    });
    return 'PR-' + String(max + 1).padStart(4, '0');
  }

  // ── Held/on-hold quantity — DERIVED, never a stored product field.
  // Sums qty across every draft/sent request's lines for this product.
  // Window-exposed so a future patch (Products/POS pages) can show it
  // without needing to touch this file. ─────────────────────────────
  window.heldQtyForProductV64 = function (productId) {
    ensureRequestsArray();
    let held = 0;
    DB.purchaseReturnRequests.forEach(function (r) {
      if (r.status !== 'draft' && r.status !== 'sent') return;
      (r.lines || []).forEach(function (l) { if (l.productId === productId) held += (parseFloat(l.qty) || 0); });
    });
    return +held.toFixed(4);
  };

  // ── Costing/depletion for a CONFIRMED return — local copy of v63's
  // logic (that version was never window-exposed, so per Lesson 3 this
  // can't be reached from here; duplicating this small function is the
  // safe move rather than coupling the two files). Only ever called at
  // Stage 2 confirm time now — never at request time. ─────────────────
  function costAndDepleteForPurchaseReturnV64(product, qty, originalEntryId) {
    const method = _resolveGlobalV64('INV_COSTING_METHOD');
    if (method === 'FIFO' && Array.isArray(product.layers)) {
      const layer = product.layers.find(function (l) { return l.invoiceId === originalEntryId; });
      if (layer) {
        const takeFromLayer = Math.min(qty, parseFloat(layer.qty) || 0);
        let cost = takeFromLayer * (parseFloat(layer.unitCost) || 0);
        layer.qty = +(((parseFloat(layer.qty) || 0) - takeFromLayer).toFixed(6));
        const shortfall = +(qty - takeFromLayer).toFixed(6);
        if (shortfall > 0.0001) {
          cost += (typeof computeFifoCost === 'function') ? computeFifoCost(product.id, shortfall) : shortfall * (parseFloat(product.cost_price) || 0);
          if (typeof depleteFifoLayers === 'function') depleteFifoLayers(product.id, shortfall);
        }
        product.layers = (product.layers || []).filter(function (l) { return (parseFloat(l.qty) || 0) > 0.0001; });
        return +cost.toFixed(2);
      }
      const cost = (typeof computeFifoCost === 'function') ? computeFifoCost(product.id, qty) : qty * (parseFloat(product.cost_price) || 0);
      if (typeof depleteFifoLayers === 'function') depleteFifoLayers(product.id, qty);
      return +cost.toFixed(2);
    }
    return +(qty * (parseFloat(product.cost_price) || 0)).toFixed(2);
  }

  // Guarded — getCurrentBookedAmount is exposed by patch-v63.js, which
  // must load before this file, but this stays defensive rather than
  // assuming a bare unguarded global reference.
  function bookedAmountV64(entry) {
    const fn = _resolveGlobalV64('getCurrentBookedAmount');
    return (typeof fn === 'function') ? fn(entry) : 0;
  }

  async function persistProductV64(product) {
    try {
      await dbApi({
        action: 'saveProduct', companyId: SESSION.companyId, id: product.id, name: product.name, sku: product.sku,
        barcode: product.barcode, category: product.category, sale_price: product.sale_price, cost_price: product.cost_price,
        qty: product.qty, min_qty: product.min_qty, unit: product.unit, tax_tier_id: product.tax_tier_id,
        price_inclusive: product.price_inclusive, layers: product.layers
      });
    } catch (e) { console.error('persistProductV64', e); }
  }

  // Every AP bill for a supplier, open or not — needed so a return can
  // reference an ALREADY-SETTLED bill too (the "returns after payment"
  // case). getOpenAPInvoices() only returns open ones, so this is a
  // small local superset, not a replacement.
  function allSupplierBillsV64(supplierId) {
    return (DB.entries || [])
      .filter(function (e) { return e.party && e.party.type === 'supplier' && String(e.party.id) === String(supplierId) && (e.credits || []).some(function (l) { return l.acct === 'Accounts Payable'; }); })
      .map(function (e) {
        const booked = bookedAmountV64(e);
        const settled = (typeof getSettledAmountForInvoice === 'function') ? getSettledAmountForInvoice(e.id) : 0;
        return { id: e.id, date: e.date, desc: e.desc, booked: booked, remaining: +(booked - settled).toFixed(2), fx: e.fx || null };
      })
      .sort(function (a, b) { return b.date.localeCompare(a.date); });
  }

  // ═══════════════════════════════════════════════════════════
  // STAGE 1 — Return Request (Debit Note draft). NO accounting impact.
  // ═══════════════════════════════════════════════════════════
  let _prLineSeq = 0;
  function productPickerOptionsV64() {
    return '<option value="">— type description instead (non-catalog item) —</option>' + (RETAIL_PRODUCTS || []).map(function (p) {
      return `<option value="${p.id}" data-cost="${p.cost_price || 0}" data-name="${esc(p.name)}" data-sku="${esc(p.sku || '')}">${esc(p.name)}</option>`;
    }).join('');
  }
  // A row's dropdown is only built once, at the moment "+ Add Item" is
  // clicked. If that happens BEFORE a new product's stock receipt has
  // finished posting (and reloaded RETAIL_PRODUCTS from the server),
  // that row's <select> is a snapshot from before the product existed —
  // it never updates on its own. Fix: refresh every currently-open row's
  // options (preserving whatever's selected) any time the app's own
  // product list reloads — same pattern as the base app's own
  // refreshUdocProductDropdowns()/refreshManualIntakeProductDropdowns().
  function refreshPR64ProductDropdowns() {
    document.querySelectorAll('.pr64-line-product').forEach(function (sel) {
      const prev = sel.value;
      sel.innerHTML = productPickerOptionsV64();
      if (prev && (RETAIL_PRODUCTS || []).some(function (p) { return String(p.id) === String(prev); })) sel.value = prev;
    });
  }
  const _origLoadRetailProductsV64 = window.loadRetailProducts;
  if (typeof _origLoadRetailProductsV64 === 'function') {
    window.loadRetailProducts = async function () {
      const result = await _origLoadRetailProductsV64.apply(this, arguments);
      refreshPR64ProductDropdowns();
      return result;
    };
  }
  window.addPRLineV64 = function () {
    const wrap = document.getElementById('pr64-lines'); if (!wrap) return;
    const rowId = 'prline64-' + (++_prLineSeq);
    const row = document.createElement('div');
    row.className = 'pr64-line-row'; row.id = rowId;
    row.style.cssText = 'display:grid;grid-template-columns:1.3fr 1fr 70px 90px 26px;gap:6px;margin-bottom:6px;align-items:center';
    row.innerHTML = `
      <select class="pr64-line-product" onchange="onPR64LineProductChange('${rowId}')" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none">${productPickerOptionsV64()}</select>
      <input class="pr64-line-desc" type="text" placeholder="Description" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <input class="pr64-line-qty" type="number" min="0" step="0.01" placeholder="Qty" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <input class="pr64-line-price" type="number" min="0" step="0.01" placeholder="Unit Price" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <button type="button" class="btn btn-danger" style="padding:4px 6px;font-size:11px" onclick="document.getElementById('${rowId}').remove()">✕</button>
    `;
    wrap.appendChild(row);
  };
  window.onPR64LineProductChange = function (rowId) {
    const row = document.getElementById(rowId); if (!row) return;
    const sel = row.querySelector('.pr64-line-product');
    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value) return;
    const descEl = row.querySelector('.pr64-line-desc');
    const priceEl = row.querySelector('.pr64-line-price');
    if (descEl && !descEl.value) descEl.value = opt.dataset.name || '';
    if (priceEl && !priceEl.value) priceEl.value = opt.dataset.cost || '';
  };

  window.onPRSupplierChangeV64 = function () {
    const supSel = document.getElementById('pr64-supplier');
    const refSel = document.getElementById('pr64-ref-bill');
    if (!supSel || !refSel) return;
    const bills = supSel.value ? allSupplierBillsV64(supSel.value) : [];
    refSel.innerHTML = '<option value="">— no matching invoice / not sure —</option>' + bills.map(function (b) {
      const status = b.remaining > 0.01 ? ('open, ' + fmtMoney(b.remaining) + ' remaining') : 'fully settled';
      return `<option value="${b.id}">#${b.id} · ${esc(b.desc)} · ${status}</option>`;
    }).join('');
  };

  function readPRLinesV64() {
    const rows = document.querySelectorAll('#pr64-lines .pr64-line-row');
    const lines = [];
    rows.forEach(function (row) {
      const sel = row.querySelector('.pr64-line-product');
      const productId = sel && sel.value ? parseInt(sel.value, 10) : null;
      const description = (row.querySelector('.pr64-line-desc') || {}).value || '';
      const qty = parseFloat((row.querySelector('.pr64-line-qty') || {}).value) || 0;
      const unitPrice = parseFloat((row.querySelector('.pr64-line-price') || {}).value) || 0;
      if (qty <= 0 || unitPrice < 0 || (!productId && !description.trim())) return;
      const product = productId ? (RETAIL_PRODUCTS || []).find(function (p) { return p.id === productId; }) : null;
      lines.push({ productId: productId, description: product ? product.name : description.trim(), sku: product ? (product.sku || '') : '', qty: qty, unitPrice: unitPrice, total: +(qty * unitPrice).toFixed(2) });
    });
    return lines;
  }

  window.createPurchaseReturnRequestV64 = async function () {
    const st = document.getElementById('pr64-st');
    const supSel = document.getElementById('pr64-supplier');
    const supplierId = supSel ? supSel.value : '';
    if (!supplierId) { if (st) st.innerHTML = '<span style="color:var(--red3)">Select a supplier</span>'; return; }
    const supplier = (typeof SUPPLIERS !== 'undefined' ? SUPPLIERS : []).find(function (s) { return String(s.id) === String(supplierId); });

    const lines = readPRLinesV64();
    if (!lines.length) { if (st) st.innerHTML = '<span style="color:var(--red3)">Add at least one item (qty and unit price required)</span>'; return; }

    const refSel = document.getElementById('pr64-ref-bill');
    const refEntryId = refSel && refSel.value ? parseInt(refSel.value, 10) : null;
    const refEntry = refEntryId ? DB.entries.find(function (e) { return e.id === refEntryId; }) : null;

    const reasonSel = document.getElementById('pr64-reason');
    const reason = reasonSel ? reasonSel.value : PR_REASONS_V64[0];
    const notesEl = document.getElementById('pr64-notes');
    const reasonNotes = notesEl ? notesEl.value.trim() : '';
    const freightEl = document.querySelector('input[name="pr64-freight"]:checked');
    const freightBorneBy = freightEl ? freightEl.value : 'us';

    const amount = +lines.reduce(function (s, l) { return s + l.total; }, 0).toFixed(2);

    const request = {
      id: DB.nextId++, drNumber: nextDrNumberV64(), date: todayStr(),
      supplierId: supplierId, supplierName: supplier ? supplier.name : '',
      refEntryId: refEntryId, refDesc: refEntry ? refEntry.desc : '',
      reason: reason, reasonNotes: reasonNotes, freightBorneBy: freightBorneBy,
      lines: lines, amount: amount,
      status: 'draft', sentDate: null, confirmedDate: null,
      settlement: null, returnEntryId: null, creditNoteRef: ''
    };
    ensureRequestsArray();
    DB.purchaseReturnRequests.push(request);
    await saveData();
    renderAll();
    if (typeof showToast === 'function') showToast('✅ ' + request.drNumber + ' created (draft) — ' + fmtMoney(amount) + '. Print or send it, then confirm once the supplier agrees.');
    resetPRRequestFormV64();
    renderPRRequestsListV64();
    renderSupplierCreditBalancesV64();
  };

  function resetPRRequestFormV64() {
    const supSel = document.getElementById('pr64-supplier'); if (supSel) supSel.value = '';
    const refSel = document.getElementById('pr64-ref-bill'); if (refSel) refSel.innerHTML = '<option value="">— no matching invoice / not sure —</option>';
    const notesEl = document.getElementById('pr64-notes'); if (notesEl) notesEl.value = '';
    const linesEl = document.getElementById('pr64-lines'); if (linesEl) linesEl.innerHTML = '';
    const st = document.getElementById('pr64-st'); if (st) st.innerHTML = '';
  }

  window.markReturnRequestSentV64 = async function (id) {
    ensureRequestsArray();
    const r = DB.purchaseReturnRequests.find(function (x) { return x.id === id; });
    if (!r || r.status !== 'draft') return;
    r.status = 'sent'; r.sentDate = todayStr();
    await saveData();
    if (typeof showToast === 'function') showToast('📤 ' + r.drNumber + ' marked as sent to ' + r.supplierName);
    renderPRRequestsListV64();
  };

  window.cancelReturnRequestV64 = async function (id) {
    ensureRequestsArray();
    const r = DB.purchaseReturnRequests.find(function (x) { return x.id === id; });
    if (!r || r.status === 'confirmed' || r.status === 'cancelled') return;
    if (!confirm('Cancel ' + r.drNumber + '? This cannot be undone.')) return;
    r.status = 'cancelled';
    await saveData();
    if (typeof showToast === 'function') showToast('❌ ' + r.drNumber + ' cancelled');
    renderPRRequestsListV64();
  };

  // ═══════════════════════════════════════════════════════════
  // STAGE 2 — Supplier Agreed → Confirm. THIS is where the journal
  // entry, and only now the stock decrease, actually happen.
  // ═══════════════════════════════════════════════════════════
  window.togglePRConfirmPanelV64 = function (id) {
    const panel = document.getElementById('pr64-confirm-' + id);
    if (!panel) return;
    const opening = panel.style.display === 'none';
    document.querySelectorAll('.pr64-confirm-panel').forEach(function (p) { p.style.display = 'none'; });
    if (opening) { panel.style.display = 'block'; onPRConfirmSettlementChangeV64(id); }
  };

  window.onPRConfirmSettlementChangeV64 = function (id) {
    const method = (document.querySelector('input[name="pr64-settle-' + id + '"]:checked') || {}).value;
    const fxWrap = document.getElementById('pr64-fx-wrap-' + id);
    const refundWrap = document.getElementById('pr64-refund-wrap-' + id);
    const isFxReduce = method === 'reduceInvoice' && fxWrap && fxWrap.querySelector('input');
    if (fxWrap) fxWrap.style.display = (method === 'reduceInvoice') ? 'block' : 'none';
    if (refundWrap) refundWrap.style.display = (method === 'refund') ? 'block' : 'none';
    const amtWrap = document.getElementById('pr64-amt-wrap-' + id);
    if (amtWrap) amtWrap.style.display = isFxReduce ? 'none' : 'block';
    if (method === 'refund') {
      const sel = document.getElementById('pr64-refund-acct-' + id);
      if (sel && typeof appendForeignAccountOptions === 'function') appendForeignAccountOptions('pr64-refund-acct-' + id);
    }
  };

  function confirmPanelHtml(r) {
    const bills = r.supplierId ? allSupplierBillsV64(r.supplierId) : [];
    const refBill = r.refEntryId ? bills.find(function (b) { return b.id === r.refEntryId; }) : null;
    const canReduceInvoice = !!(refBill && refBill.remaining > 0.01);
    const isFxBill = !!(refBill && refBill.fx);
    return `<div class="pr64-confirm-panel" id="pr64-confirm-${r.id}" style="display:none;background:var(--bg3);border-radius:8px;padding:12px;margin-top:6px">
      <div style="font-size:12px;font-weight:600;margin-bottom:8px">Supplier agreed — how is this settled?</div>
      <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:6px;${canReduceInvoice ? '' : 'opacity:0.45'}">
          <input type="radio" name="pr64-settle-${r.id}" value="reduceInvoice" onchange="onPRConfirmSettlementChangeV64(${r.id})" ${canReduceInvoice ? '' : 'disabled'} ${canReduceInvoice ? 'checked' : ''}/>
          Reduce the original invoice ${refBill ? ('(#' + refBill.id + ', ' + (canReduceInvoice ? (fmtMoney(refBill.remaining) + ' open') : 'already fully settled — use refund or credit instead') + ')') : '(no matching invoice on this request)'}
        </label>
        <label style="display:flex;align-items:center;gap:6px">
          <input type="radio" name="pr64-settle-${r.id}" value="refund" onchange="onPRConfirmSettlementChangeV64(${r.id})" ${canReduceInvoice ? '' : 'checked'}/>
          Cash refund from supplier
        </label>
        <label style="display:flex;align-items:center;gap:6px">
          <input type="radio" name="pr64-settle-${r.id}" value="credit" onchange="onPRConfirmSettlementChangeV64(${r.id})"/>
          Stays as credit with supplier (apply to a future purchase)
        </label>
      </div>
      <div id="pr64-fx-wrap-${r.id}" style="display:none;margin-bottom:8px">
        ${isFxBill ? `<label style="font-size:10px">Return amount in the invoice's currency (${esc(refBill.fx.currency)}) — original booking rate (${refBill.fx.rate}) is used automatically</label>
          <input id="pr64-fx-amt-${r.id}" type="number" min="0" step="0.01" value="${+(r.amount / (refBill && refBill.fx ? refBill.fx.rate : 1)).toFixed(2)}" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"/>` : ''}
      </div>
      <div id="pr64-refund-wrap-${r.id}" style="display:none;margin-bottom:8px">
        <label style="font-size:10px">Refund into</label>
        <select id="pr64-refund-acct-${r.id}" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none">
          <option value="cash">Cash</option><option value="mobile">Mobile Money</option><option value="bank">Bank Account</option>
        </select>
      </div>
      <div class="fg" id="pr64-amt-wrap-${r.id}" style="margin-bottom:8px"><label style="font-size:10px">Amount</label>
        <input id="pr64-amt-${r.id}" type="number" min="0" step="0.01" value="${r.amount}" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:13px;color:var(--text);outline:none"/>
      </div>
      <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Supplier's Credit Note # (optional)</label>
        <input id="pr64-creditnote-${r.id}" type="text" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"/>
      </div>
      <div><button class="btn btn-gold" onclick="submitConfirmReturnV64(${r.id})">✔️ Confirm — Post Journal Entry</button></div>
      <div id="pr64-confirm-st-${r.id}" style="margin-top:6px;font-size:11px"></div>
    </div>`;
  }

  window.submitConfirmReturnV64 = async function (id) {
    ensureRequestsArray();
    const r = DB.purchaseReturnRequests.find(function (x) { return x.id === id; });
    const stEl = document.getElementById('pr64-confirm-st-' + id);
    if (!r || (r.status !== 'draft' && r.status !== 'sent')) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Request not found or already handled</span>'; return; }

    const method = (document.querySelector('input[name="pr64-settle-' + id + '"]:checked') || {}).value;
    if (!method) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Choose a settlement</span>'; return; }

    const bills = r.supplierId ? allSupplierBillsV64(r.supplierId) : [];
    const refBill = r.refEntryId ? bills.find(function (b) { return b.id === r.refEntryId; }) : null;
    const refEntry = r.refEntryId ? DB.entries.find(function (e) { return e.id === r.refEntryId; }) : null;

    let returnBase, foreignAmt = null, foreignCurrency = null;
    if (method === 'reduceInvoice') {
      if (!refBill || refBill.remaining <= 0.01) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">That invoice no longer has an open balance — use a refund or supplier credit instead</span>'; return; }
      if (refBill.fx) {
        const fxAmtEl = document.getElementById('pr64-fx-amt-' + id);
        const fxAmt = fxAmtEl ? parseFloat(fxAmtEl.value) || 0 : 0;
        if (fxAmt <= 0) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Enter the return amount in the invoice\'s currency</span>'; return; }
        returnBase = +(fxAmt * refBill.fx.rate).toFixed(2);
        foreignAmt = fxAmt; foreignCurrency = refBill.fx.currency;
      } else {
        const amtEl = document.getElementById('pr64-amt-' + id);
        returnBase = amtEl ? parseFloat(amtEl.value) || 0 : 0;
      }
      if (returnBase > refBill.remaining + 0.01) { if (stEl) stEl.innerHTML = `<span style="color:var(--red3)">Amount (${fmtMoney(returnBase)}) is more than what's still open on that invoice (${fmtMoney(refBill.remaining)})</span>`; return; }
    } else {
      const amtEl = document.getElementById('pr64-amt-' + id);
      returnBase = amtEl ? parseFloat(amtEl.value) || 0 : 0;
    }
    if (!returnBase || returnBase <= 0) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Enter an amount greater than zero</span>'; return; }

    // NOW — and only now — stock actually depletes, using the request's
    // own captured lines (no re-entry needed).
    const creditsByAcct = {};
    let totalTracedValue = 0;
    for (const l of (r.lines || [])) {
      if (!l.productId) continue;
      const product = (RETAIL_PRODUCTS || []).find(function (p) { return p.id === l.productId; });
      if (!product) continue;
      const cost = costAndDepleteForPurchaseReturnV64(product, l.qty, r.refEntryId);
      const acct = 'Inventory (' + product.name + ')';
      creditsByAcct[acct] = +((creditsByAcct[acct] || 0) + cost).toFixed(2);
      totalTracedValue = +(totalTracedValue + cost).toFixed(2);
      await persistProductV64(product);
    }
    const untracedRemainder = +(returnBase - totalTracedValue).toFixed(2);
    const credits = [];
    Object.keys(creditsByAcct).forEach(function (acct) { if (creditsByAcct[acct] > 0.001) credits.push({ acct: acct, amt: creditsByAcct[acct], atype: 'asset' }); });
    if (Math.abs(untracedRemainder) > 0.001) credits.push({ acct: 'Purchase Returns', amt: untracedRemainder, atype: 'income' });

    let debitLine;
    if (method === 'reduceInvoice') {
      debitLine = { acct: 'Accounts Payable', amt: returnBase, atype: 'liability' };
    } else if (method === 'refund') {
      const acctSel = document.getElementById('pr64-refund-acct-' + id);
      const acctVal = acctSel ? acctSel.value : 'cash';
      if (acctVal.indexOf('foreign:') === 0) {
        const acctId = acctVal.split(':')[1];
        const foreignAcct = (typeof FOREIGN_ACCOUNTS !== 'undefined' ? FOREIGN_ACCOUNTS : []).find(function (a) { return String(a.id) === String(acctId); });
        if (!foreignAcct) { if (stEl) stEl.innerHTML = '<span style="color:var(--red3)">Selected account not found</span>'; return; }
        const rate = (typeof fxCrossRate === 'function') ? fxCrossRate(foreignAcct.currency) : null;
        if (!rate) { if (stEl) stEl.innerHTML = `<span style="color:var(--red3)">No known rate for ${foreignAcct.currency} today</span>`; return; }
        debitLine = { acct: foreignAccountGLName(foreignAcct), amt: returnBase, atype: 'asset', foreignAmt: +(returnBase / rate).toFixed(4), currency: foreignAcct.currency };
      } else {
        const payAcctMap = { cash: 'Cash', mobile: 'Mobile Money', bank: 'Bank Account' };
        debitLine = { acct: payAcctMap[acctVal] || 'Cash', amt: returnBase, atype: 'asset' };
      }
    } else { // credit
      debitLine = { acct: 'Supplier Credit Receivable (' + r.supplierName + ')', amt: returnBase, atype: 'asset' };
    }

    const returnNumber = nextPrNumberV64();
    const creditNoteEl = document.getElementById('pr64-creditnote-' + id);
    const creditNoteRef = creditNoteEl ? creditNoteEl.value.trim() : '';
    const settleLabel = { reduceInvoice: 'reduced invoice', refund: 'cash refund', credit: 'supplier credit' }[method];

    const returnEntry = {
      id: DB.nextId++, date: todayStr(),
      desc: 'Purchase Return (' + returnNumber + ', ' + r.drNumber + ') — ' + r.supplierName + (refEntry ? (' — ref: ' + refEntry.desc) : '') + ' — settled: ' + settleLabel,
      type: 'Purchase Return', amount: returnBase, returnNumber: returnNumber, returnOf: method === 'reduceInvoice' ? r.refEntryId : null,
      debits: [debitLine], credits: credits,
      party: { type: 'supplier', id: r.supplierId, name: r.supplierName },
      drNumber: r.drNumber, settlementMethod: method, creditNoteRef: creditNoteRef
    };
    if (foreignAmt != null) returnEntry.fx = { currency: foreignCurrency, rate: refBill.fx.rate, originalAmount: foreignAmt };
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
    renderPRRequestsListV64();
    renderSupplierCreditBalancesV64();
  };

  // ═══════════════════════════════════════════════════════════
  // SUPPLIER CREDIT — derived balance + manual "apply to a bill"
  // ═══════════════════════════════════════════════════════════
  function suppliersWithCreditV64() {
    const names = {};
    (DB.entries || []).forEach(function (e) {
      (e.debits || []).forEach(function (l) { const m = /^Supplier Credit Receivable \((.+)\)$/.exec(l.acct); if (m) names[m[1]] = true; });
      (e.credits || []).forEach(function (l) { const m = /^Supplier Credit Receivable \((.+)\)$/.exec(l.acct); if (m) names[m[1]] = true; });
    });
    return Object.keys(names);
  }
  window.getSupplierCreditBalanceV64 = function (supplierName) {
    const glName = 'Supplier Credit Receivable (' + supplierName + ')';
    let bal = 0;
    (DB.entries || []).forEach(function (e) {
      (e.debits || []).forEach(function (l) { if (l.acct === glName) bal += (+l.amt || 0); });
      (e.credits || []).forEach(function (l) { if (l.acct === glName) bal -= (+l.amt || 0); });
    });
    return +bal.toFixed(2);
  };

  function renderSupplierCreditBalancesV64() {
    const el = document.getElementById('pr64-credit-list'); if (!el) return;
    const names = suppliersWithCreditV64().filter(function (n) { return window.getSupplierCreditBalanceV64(n) > 0.01; });
    if (!names.length) { el.innerHTML = '<div style="text-align:center;padding:14px;color:var(--text3)">No outstanding supplier credit</div>'; return; }
    el.innerHTML = names.map(function (name) {
      const bal = window.getSupplierCreditBalanceV64(name);
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border2)">
        <div><b>${esc(name)}</b><div style="font-size:10px;color:var(--text3)">available credit</div></div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-family:'JetBrains Mono',monospace;color:var(--green3)">${fmtMoney(bal)}</span>
          <button class="btn btn-outline" style="padding:4px 10px;font-size:11px" onclick="openApplyCreditV64('${esc(name)}')">Apply to a bill</button>
          <button class="btn btn-outline" style="padding:4px 10px;font-size:11px" onclick="openCashOutCreditV64('${esc(name)}')">💵 Cash it out</button>
        </div>
      </div>`;
    }).join('');
  }

  window.openApplyCreditV64 = function (supplierName) {
    const supplier = (typeof SUPPLIERS !== 'undefined' ? SUPPLIERS : []).find(function (s) { return s.name === supplierName; });
    const wrap = document.getElementById('pr64-apply-credit-wrap'); if (!wrap) return;
    wrap.style.display = 'block';
    wrap.dataset.supplierId = supplier ? supplier.id : '';
    wrap.dataset.supplierName = supplierName;
    const bal = window.getSupplierCreditBalanceV64(supplierName);
    document.getElementById('pr64-apply-credit-hdr').textContent = 'Apply ' + supplierName + "'s credit (" + fmtMoney(bal) + ' available)';
    const billSel = document.getElementById('pr64-apply-credit-bill');
    const bills = supplier ? allSupplierBillsV64(supplier.id).filter(function (b) { return b.remaining > 0.01; }) : [];
    billSel.innerHTML = '<option value="">— select open bill —</option>' + bills.map(function (b) {
      return `<option value="${b.id}">#${b.id} · ${esc(b.desc)} · ${fmtMoney(b.remaining)} open</option>`;
    }).join('');
    document.getElementById('pr64-apply-credit-amt').value = '';
    document.getElementById('pr64-apply-credit-st').innerHTML = '';
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  window.applySupplierCreditV64 = async function () {
    const wrap = document.getElementById('pr64-apply-credit-wrap');
    const st = document.getElementById('pr64-apply-credit-st');
    const supplierId = wrap.dataset.supplierId, supplierName = wrap.dataset.supplierName;
    const billSel = document.getElementById('pr64-apply-credit-bill');
    const billId = billSel && billSel.value ? parseInt(billSel.value, 10) : null;
    if (!billId) { st.innerHTML = '<span style="color:var(--red3)">Select a bill</span>'; return; }
    const amtEl = document.getElementById('pr64-apply-credit-amt');
    const amt = amtEl ? parseFloat(amtEl.value) || 0 : 0;
    if (amt <= 0) { st.innerHTML = '<span style="color:var(--red3)">Enter an amount</span>'; return; }
    const available = window.getSupplierCreditBalanceV64(supplierName);
    if (amt > available + 0.01) { st.innerHTML = `<span style="color:var(--red3)">Only ${fmtMoney(available)} credit is available</span>`; return; }
    const bill = DB.entries.find(function (e) { return e.id === billId; });
    if (!bill) { st.innerHTML = '<span style="color:var(--red3)">Bill not found</span>'; return; }
    const remaining = +(bookedAmountV64(bill) - ((typeof getSettledAmountForInvoice === 'function') ? getSettledAmountForInvoice(bill.id) : 0)).toFixed(2);
    if (amt > remaining + 0.01) { st.innerHTML = `<span style="color:var(--red3)">That bill only has ${fmtMoney(remaining)} still open</span>`; return; }

    const applyEntry = {
      id: DB.nextId++, date: todayStr(),
      desc: 'Supplier Credit Applied — ' + supplierName + ' — to ' + bill.desc,
      type: 'Supplier Credit Application', amount: amt,
      debits: [{ acct: 'Accounts Payable', amt: amt, atype: 'liability' }],
      credits: [{ acct: 'Supplier Credit Receivable (' + supplierName + ')', amt: amt, atype: 'asset' }],
      party: { type: 'supplier', id: supplierId, name: supplierName }
    };
    DB.entries.push(applyEntry);
    bill.returnAdjustments = bill.returnAdjustments || [];
    bill.returnAdjustments.push({ amount: -amt, returnEntryId: applyEntry.id, date: todayStr(), foreignAmount: null });

    await saveData();
    renderAll();
    if (typeof showToast === 'function') showToast('✅ ' + fmtMoney(amt) + ' of ' + supplierName + "'s credit applied to " + bill.desc);
    wrap.style.display = 'none';
    renderSupplierCreditBalancesV64();
  };

  // ── Cash It Out — for exactly the case where you don't have (or don't
  // want to wait for) a new bill from that supplier to apply the credit
  // against: e.g. you buy on cash from them, so there's no AP bill to
  // reduce. This converts some/all of the standing credit into real cash
  // in hand — Dr the chosen cash/bank/foreign account, Cr the same
  // "Supplier Credit Receivable" account the original return credited,
  // so the derived balance (window.getSupplierCreditBalanceV64) drops by
  // exactly the amount cashed out. Structurally identical to a normal
  // refund-settled return, just not tied to a specific return event. ──
  window.openCashOutCreditV64 = function (supplierName) {
    const wrap = document.getElementById('pr64-cashout-wrap'); if (!wrap) return;
    wrap.style.display = 'block';
    wrap.dataset.supplierName = supplierName;
    const bal = window.getSupplierCreditBalanceV64(supplierName);
    document.getElementById('pr64-cashout-hdr').textContent = 'Cash out ' + supplierName + "'s credit (" + fmtMoney(bal) + ' available)';
    const acctSel = document.getElementById('pr64-cashout-acct');
    acctSel.innerHTML = '<option value="cash">Cash</option><option value="mobile">Mobile Money</option><option value="bank">Bank Account</option>';
    if (typeof appendForeignAccountOptions === 'function') appendForeignAccountOptions('pr64-cashout-acct');
    document.getElementById('pr64-cashout-amt').value = bal;
    document.getElementById('pr64-cashout-st').innerHTML = '';
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  window.cashOutSupplierCreditV64 = async function () {
    const wrap = document.getElementById('pr64-cashout-wrap');
    const st = document.getElementById('pr64-cashout-st');
    const supplierName = wrap.dataset.supplierName;
    const amtEl = document.getElementById('pr64-cashout-amt');
    const amt = amtEl ? parseFloat(amtEl.value) || 0 : 0;
    if (amt <= 0) { st.innerHTML = '<span style="color:var(--red3)">Enter an amount</span>'; return; }
    const available = window.getSupplierCreditBalanceV64(supplierName);
    if (amt > available + 0.01) { st.innerHTML = `<span style="color:var(--red3)">Only ${fmtMoney(available)} credit is available</span>`; return; }

    const acctSel = document.getElementById('pr64-cashout-acct');
    const acctVal = acctSel ? acctSel.value : 'cash';
    let debitLine;
    if (acctVal.indexOf('foreign:') === 0) {
      const acctId = acctVal.split(':')[1];
      const foreignAcct = (typeof FOREIGN_ACCOUNTS !== 'undefined' ? FOREIGN_ACCOUNTS : []).find(function (a) { return String(a.id) === String(acctId); });
      if (!foreignAcct) { st.innerHTML = '<span style="color:var(--red3)">Selected account not found</span>'; return; }
      const rate = (typeof fxCrossRate === 'function') ? fxCrossRate(foreignAcct.currency) : null;
      if (!rate) { st.innerHTML = `<span style="color:var(--red3)">No known rate for ${foreignAcct.currency} today</span>`; return; }
      debitLine = { acct: foreignAccountGLName(foreignAcct), amt: amt, atype: 'asset', foreignAmt: +(amt / rate).toFixed(4), currency: foreignAcct.currency };
    } else {
      const payAcctMap = { cash: 'Cash', mobile: 'Mobile Money', bank: 'Bank Account' };
      debitLine = { acct: payAcctMap[acctVal] || 'Cash', amt: amt, atype: 'asset' };
    }

    const cashoutEntry = {
      id: DB.nextId++, date: todayStr(),
      desc: 'Supplier Credit Cashed Out — ' + supplierName,
      type: 'Supplier Credit Cashout', amount: amt,
      debits: [debitLine],
      credits: [{ acct: 'Supplier Credit Receivable (' + supplierName + ')', amt: amt, atype: 'asset' }],
      party: { type: 'supplier', id: wrap.dataset.supplierId || '', name: supplierName }
    };
    DB.entries.push(cashoutEntry);

    await saveData();
    renderAll();
    if (typeof showToast === 'function') showToast('✅ ' + fmtMoney(amt) + ' of ' + supplierName + "'s credit cashed out");
    wrap.style.display = 'none';
    renderSupplierCreditBalancesV64();
  };

  // ═══════════════════════════════════════════════════════════
  // LIST + PAGE + PRINT + SHARE
  // ═══════════════════════════════════════════════════════════
  function renderPRRequestsListV64() {
    const el = document.getElementById('pr64-list'); if (!el) return;
    ensureRequestsArray();
    const rows = DB.purchaseReturnRequests.slice().sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
    if (!rows.length) { el.innerHTML = '<div style="text-align:center;padding:18px;color:var(--text3)">No return requests yet — create one above when inventory finds a problem with a delivery</div>'; return; }
    el.innerHTML = rows.map(function (r) {
      const heldNote = (r.status === 'draft' || r.status === 'sent') && (r.lines || []).some(function (l) { return l.productId; })
        ? '<div style="font-size:10px;color:var(--orange3);margin-top:2px">🔒 On hold (pending return) — stock still on hand until confirmed</div>' : '';
      const actions = [];
      actions.push(`<button class="btn btn-outline" style="padding:4px 9px;font-size:11px" onclick="printDebitNoteV64(${r.id})">🖨️ Print</button>`);
      if (r.status === 'draft' || r.status === 'sent') actions.push(`<button class="btn btn-outline" style="padding:4px 9px;font-size:11px" onclick="shareDebitNoteV64(${r.id})">📲 Share</button>`);
      if (r.status === 'draft') actions.push(`<button class="btn btn-outline" style="padding:4px 9px;font-size:11px" onclick="markReturnRequestSentV64(${r.id})">✅ Mark Sent</button>`);
      if (r.status === 'draft' || r.status === 'sent') {
        actions.push(`<button class="btn btn-gold" style="padding:4px 9px;font-size:11px" onclick="togglePRConfirmPanelV64(${r.id})">✔️ Supplier Agreed</button>`);
        actions.push(`<button class="btn btn-danger" style="padding:4px 9px;font-size:11px" onclick="cancelReturnRequestV64(${r.id})">✕ Cancel</button>`);
      }
      if (r.status === 'confirmed') actions.push(`<span style="font-size:10px;color:var(--text3)">${esc((r.settlement && r.settlement.method) || '')}${r.creditNoteRef ? (' · CN# ' + esc(r.creditNoteRef)) : ''}</span>`);
      return `<div style="padding:10px 0;border-bottom:1px solid var(--border2)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
          <div>
            <span style="font-family:'JetBrains Mono',monospace;font-weight:600">${esc(r.drNumber)}</span>
            <span class="tag ${PRR_STATUS_TAG_V64[r.status] || 't-blue'}" style="font-size:9px;margin-left:6px">${PRR_STATUS_LABEL_V64[r.status] || r.status}</span>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">${esc(r.date)} · ${esc(r.supplierName)} · ${esc(r.reason)}${r.refDesc ? (' · ref: ' + esc(r.refDesc)) : ' · no matching invoice on file'}</div>
            ${heldNote}
          </div>
          <div style="text-align:right">
            <div style="font-family:'JetBrains Mono',monospace;font-weight:600">${fmtMoney(r.amount)}</div>
            <div style="display:flex;gap:5px;margin-top:4px;flex-wrap:wrap;justify-content:flex-end">${actions.join('')}</div>
          </div>
        </div>
        ${(r.status === 'draft' || r.status === 'sent') ? confirmPanelHtml(r) : ''}
      </div>`;
    }).join('');
  }

  function populatePRDropdownsV64() {
    const supSel = document.getElementById('pr64-supplier');
    if (supSel) supSel.innerHTML = '<option value="">— select supplier —</option>' + (typeof SUPPLIERS !== 'undefined' ? SUPPLIERS : []).map(function (s) { return `<option value="${s.id}">${esc(s.name)}</option>`; }).join('');
    const reasonSel = document.getElementById('pr64-reason');
    if (reasonSel && !reasonSel.options.length) reasonSel.innerHTML = PR_REASONS_V64.map(function (r) { return `<option value="${esc(r)}">${esc(r)}</option>`; }).join('');
  }

  function injectPurchaseReturnsPagesV64() {
    if (document.getElementById('pg-purchreturns')) return;
    const main = document.querySelector('.main'); if (!main) return;

    const page = document.createElement('div');
    page.className = 'page'; page.id = 'pg-purchreturns';
    page.innerHTML = `<div class="ph"><h1>↩️ Purchase Returns</h1><p>Create a Return Request (Debit Note) when inventory finds a problem — nothing posts to the books until you confirm the supplier agreed.</p></div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-hdr">🆕 New Return Request</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <div class="fg" style="margin:0"><label style="font-size:10px">Supplier</label>
            <select id="pr64-supplier" onchange="onPRSupplierChangeV64()" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text);outline:none">
              <option value="">— select supplier —</option>
            </select>
          </div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Reference Bill (optional — leave blank if not sure/not on file)</label>
            <select id="pr64-ref-bill" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text);outline:none">
              <option value="">— no matching invoice / not sure —</option>
            </select>
          </div>
        </div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Items being returned:</div>
        <div id="pr64-lines"></div>
        <button type="button" class="btn btn-outline" style="padding:5px 10px;font-size:11px;margin-bottom:10px" onclick="addPRLineV64()">+ Add Item</button>
        <div style="margin-bottom:8px">
          <div class="fg" style="margin:0"><label style="font-size:10px">Reason</label>
            <select id="pr64-reason" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text);outline:none"></select>
          </div>
        </div>
        <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Notes (inspection detail, batch/lot, photos reference, etc.)</label>
          <textarea id="pr64-notes" rows="2" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text);outline:none;resize:vertical"></textarea>
        </div>
        <div style="font-size:11px;margin-bottom:6px">Who bears return freight?
          <label style="margin-left:10px"><input type="radio" name="pr64-freight" value="us" checked/> Us</label>
          <label style="margin-left:10px"><input type="radio" name="pr64-freight" value="supplier"/> Supplier</label>
        </div>
        <div><button class="btn btn-gold" onclick="createPurchaseReturnRequestV64()">✅ Create Return Request</button></div>
        <div id="pr64-st" style="margin-top:8px;font-size:12px"></div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-hdr">💳 Supplier Credit Balances</div>
        <div id="pr64-credit-list"></div>
        <div id="pr64-apply-credit-wrap" style="display:none;margin-top:10px;padding:10px;background:var(--bg3);border-radius:8px">
          <div id="pr64-apply-credit-hdr" style="font-size:12px;font-weight:600;margin-bottom:8px"></div>
          <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Open Bill</label>
            <select id="pr64-apply-credit-bill" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"></select>
          </div>
          <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Amount to Apply</label>
            <input id="pr64-apply-credit-amt" type="number" min="0" step="0.01" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"/>
          </div>
          <div><button class="btn btn-gold" onclick="applySupplierCreditV64()">✔️ Apply Credit</button></div>
          <div id="pr64-apply-credit-st" style="margin-top:6px;font-size:11px"></div>
        </div>
        <div id="pr64-cashout-wrap" style="display:none;margin-top:10px;padding:10px;background:var(--bg3);border-radius:8px">
          <div id="pr64-cashout-hdr" style="font-size:12px;font-weight:600;margin-bottom:8px"></div>
          <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Into</label>
            <select id="pr64-cashout-acct" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"></select>
          </div>
          <div class="fg" style="margin-bottom:8px"><label style="font-size:10px">Amount</label>
            <input id="pr64-cashout-amt" type="number" min="0" step="0.01" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:7px 9px;font-size:12px;color:var(--text);outline:none"/>
          </div>
          <div><button class="btn btn-gold" onclick="cashOutSupplierCreditV64()">✔️ Cash It Out</button></div>
          <div id="pr64-cashout-st" style="margin-top:6px;font-size:11px"></div>
        </div>
      </div>

      <div class="card"><div class="card-hdr">Return Requests</div><div id="pr64-list"></div></div>
    `;
    main.appendChild(page);

    const printPage = document.createElement('div');
    printPage.className = 'page'; printPage.id = 'pg-pr-print-v64';
    printPage.innerHTML = `<div class="no-print" style="margin-bottom:14px;display:flex;gap:8px">
        <button class="btn btn-outline" onclick="nav('purchreturns')">← Back</button>
        <button class="btn btn-gold" onclick="window.print()">🖨️ Print</button>
      </div>
      <div id="pr-print-content-v64" style="background:#fff;color:#111;padding:28px;max-width:760px;margin:0 auto;font-family:Arial,sans-serif;border-radius:4px"></div>`;
    main.appendChild(printPage);
  }

  const _prPrintStyleV64 = document.createElement('style');
  _prPrintStyleV64.textContent = `
    @media print{
      body.pr-printing-v64 .page{display:none!important}
      body.pr-printing-v64 #pg-pr-print-v64{display:block!important}
    }
    #pr-print-content-v64 table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px}
    #pr-print-content-v64 th,#pr-print-content-v64 td{border:1px solid #999;padding:6px 8px;text-align:left}
    #pr-print-content-v64 td, #pr-print-content-v64 th { color:#111 !important; }
    #pr-print-content-v64 th { background:#eee; font-weight:700; }
  `;
  document.head.appendChild(_prPrintStyleV64);

  window.printDebitNoteV64 = function (requestId) {
    ensureRequestsArray();
    const r = DB.purchaseReturnRequests.find(function (x) { return x.id === requestId; });
    if (!r) { if (typeof showToast === 'function') showToast('⚠️ Return request not found'); return; }
    injectPurchaseReturnsPagesV64();
    const content = document.getElementById('pr-print-content-v64');
    if (!content) return;
    const linesHtml = (r.lines || []).map(function (l) {
      return `<tr><td>${esc(l.description)}</td><td>${esc(l.sku) || '—'}</td><td style="text-align:center">${l.qty}</td><td style="text-align:right">${fmtMoney(l.unitPrice)}</td><td style="text-align:right">${fmtMoney(l.total)}</td></tr>`;
    }).join('');
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #333;padding-bottom:12px;margin-bottom:14px">
        <div><div style="font-size:20px;font-weight:700">${esc((typeof BIZ_NAME !== 'undefined' && BIZ_NAME) || 'Company')}</div></div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:700;letter-spacing:1px">DEBIT NOTE</div>
          <div style="font-size:12px">No: <b>${esc(r.drNumber)}</b></div>
          <div style="font-size:12px">Date: ${esc(r.date)}</div>
          <div style="font-size:12px">Status: ${esc(PRR_STATUS_LABEL_V64[r.status] || r.status)}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:20px;font-size:13px;margin-bottom:10px">
        <div><b>Supplier:</b> ${esc(r.supplierName)}</div>
        <div><b>Reference:</b> ${esc(r.refDesc) || 'no matching invoice on file'}</div>
      </div>
      <div style="font-size:13px;margin-bottom:10px"><b>Reason:</b> ${esc(r.reason)}${r.reasonNotes ? (' — ' + esc(r.reasonNotes)) : ''}</div>
      <table><thead><tr><th>Description</th><th>SKU</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead><tbody>${linesHtml}</tbody>
        <tfoot><tr><td colspan="4" style="text-align:right;font-weight:700">Total</td><td style="text-align:right;font-weight:700">${fmtMoney(r.amount)}</td></tr></tfoot></table>
      <div style="font-size:12px;margin-top:10px"><b>Return freight borne by:</b> ${r.freightBorneBy === 'supplier' ? 'Supplier' : 'Us'}</div>
      <div style="display:flex;justify-content:space-between;gap:30px;margin-top:50px;font-size:12px">
        <div style="flex:1"><div style="border-top:1px solid #333;margin-top:40px;padding-top:4px">Authorized Signature (Us)</div></div>
        <div style="flex:1"><div style="border-top:1px solid #333;margin-top:40px;padding-top:4px">Acknowledged By (Supplier)</div></div>
      </div>
    `;
    document.body.classList.add('pr-printing-v64');
    nav('pr-print-v64');
  };

  window.shareDebitNoteV64 = function (requestId) {
    ensureRequestsArray();
    const r = DB.purchaseReturnRequests.find(function (x) { return x.id === requestId; });
    if (!r) { if (typeof showToast === 'function') showToast('⚠️ Return request not found'); return; }
    const itemLines = (r.lines || []).map(function (l) { return '• ' + l.description + (l.sku ? ' (' + l.sku + ')' : '') + ' — qty ' + l.qty + ' @ ' + fmtMoney(l.unitPrice); }).join('\n');
    const summaryText = '📋 Debit Note ' + r.drNumber + '\n' +
      'Date: ' + r.date + '\n' +
      'Supplier: ' + r.supplierName + '\n' +
      'Reference: ' + (r.refDesc || 'no matching invoice on file') + '\n' +
      'Reason: ' + r.reason + (r.reasonNotes ? (' — ' + r.reasonNotes) : '') + '\n\n' +
      'Items:\n' + itemLines + '\n\n' +
      'Total: ' + fmtMoney(r.amount) + '\n' +
      'Return freight borne by: ' + (r.freightBorneBy === 'supplier' ? 'Supplier' : 'Us') + '\n\n' +
      'Please confirm you accept this return so we can proceed.';
    window.open('https://wa.me/?text=' + encodeURIComponent(summaryText), '_blank');
  };

  // ── Suppliers page — surface the same credit balance there too, not
  // just buried inside Purchase Returns. renderSupplierList() is a plain
  // top-level declaration in index.html itself (not inside any IIFE), so
  // reassigning window.renderSupplierList is safe (Lesson 2) — this is a
  // superset redefinition adding one column + a jump link, everything
  // else byte-for-byte the same as the original. ─────────────────────
  window.renderSupplierList = function () {
    const el = document.getElementById('supplierList'); if (!el) return;
    if (!SUPPLIERS.length) { el.innerHTML = '<div style="text-align:center;padding:14px;color:var(--text3)">No suppliers yet</div>'; return; }
    const bal = getPartyBalances('supplier');
    el.innerHTML = `<table><thead><tr><th>Name</th><th>Contact</th><th>AP Balance</th><th>💳 Credit</th><th></th></tr></thead><tbody>${
      SUPPLIERS.map(function (s) {
        const credit = window.getSupplierCreditBalanceV64(s.name);
        const creditCell = credit > 0.01
          ? `<span style="font-family:'JetBrains Mono',monospace;color:var(--green3)">${fmtMoney(credit)}</span> <button class="btn btn-outline" style="font-size:9px;padding:2px 6px" onclick="jumpToSupplierCreditV64('${esc(s.name)}')">use</button>`
          : `<span style="color:var(--text3)">—</span>`;
        return `<tr><td style="font-weight:500">${esc(s.name)}</td><td style="color:var(--text3);font-size:11px">${esc(s.contact) || '—'}</td><td style="font-family:'JetBrains Mono',monospace;color:${(bal[s.id] || 0) > 0 ? 'var(--orange3)' : 'var(--text3)'}">${fmtMoney(bal[s.id] || 0)}</td><td>${creditCell}</td><td style="white-space:nowrap"><button class="btn btn-outline" style="font-size:10px;padding:3px 7px;margin-right:4px" onclick="togglePartyLedger('supplier',${s.id})">📒 Ledger</button><button class="btn btn-danger" style="font-size:10px;padding:3px 7px" onclick="deleteSupplier(${s.id})">✕</button></td></tr>`;
      }).join('')
    }</tbody></table>`;
  };

  window.jumpToSupplierCreditV64 = async function (supplierName) {
    await nav('purchreturns');
    const el = document.getElementById('pr64-credit-list');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // ── Sidebar (both modes, both languages) ──────────────────────────
  ['RETAIL_NAV', 'RETAIL_NAV_EN', 'CONSTRUCTION_NAV', 'CONSTRUCTION_NAV_EN'].forEach(function (name) {
    const arr = _resolveGlobalV64(name);
    if (Array.isArray(arr) && !arr.some(function (s) { return s.section === '↩️ Purchase Returns'; })) {
      arr.push({ section: '↩️ Purchase Returns', items: [{ ico: '↩️', ti: 'Purchase Returns', en: 'Purchase Returns', page: 'purchreturns' }] });
    }
  });

  // ── nav() — inject BEFORE awaiting (Lesson 4) ──────────────────────
  const _origNavV64 = window.nav;
  if (typeof _origNavV64 === 'function') {
    window.nav = async function (page, el) {
      injectPurchaseReturnsPagesV64();
      const result = await _origNavV64(page, el);
      if (page !== 'pr-print-v64') document.body.classList.remove('pr-printing-v64');
      if (page === 'purchreturns') { populatePRDropdownsV64(); renderPRRequestsListV64(); renderSupplierCreditBalancesV64(); }
      return result;
    };
  }

  console.log('✅ patch-v64.js loaded — Purchase Returns: Debit Note request → supplier agreement → confirmed return (own page), plus supplier credit tracking');
})();
