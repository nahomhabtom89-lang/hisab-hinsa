// ═══════════════════════════════════════════════════════════
// PATCH v57 — Sales Orders, Phase 1: Creation, Matching, Reservation
// ═══════════════════════════════════════════════════════════
// New "🧾 Sales Orders" page (retail mode). Two ways to start an order:
//   1. Upload the customer's Purchase Order (image/PDF) — reuses the
//      app's EXISTING document-AI pipeline (the same /api/ai
//      mode:'universalDocument' call behind Smart Document Import,
//      already deployed) to extract the customer name and line items.
//      No backend change, no new OCR.
//   2. Build one manually with the same line-item form OCR pre-fills.
// Either way, each line is matched against RETAIL_PRODUCTS with the
// app's existing posFindProduct() fuzzy matcher, pricing is pulled from
// the product's own sale_price (the master rate) rather than whatever
// price the PO document happened to state, and availability is checked
// live against a RESERVATION figure.
//
// DESIGN NOTE — reservation is computed, not stored:
// Rather than adding a persisted "reserved_qty" column to products
// (hh_products is a real fixed-column SQL table, not a JSON blob — a
// schema change there is a bigger, riskier move than this feature
// needs), reserved quantity is derived on demand by scanning all open
// (Confirmed/Partially_Fulfilled) Sales Orders for that product and
// summing quantity_reserved minus quantity_shipped. This can never drift
// out of sync with the orders themselves, the same reasoning already
// used for Delivery Note numbering (scanned, not counted). Physical
// product.qty is only ever touched by an actual stock movement (a real
// receipt or an actual shipment) — never by merely confirming an order.
// Verified with a standalone Node.js simulation before shipping,
// including the trickier cases: cancelling an order releases its
// reservation, editing an order excludes its own existing reservation
// from the availability check, and partially shipping an order frees
// the shipped portion (this last one sets up cleanly for v58, which will
// wire "Ship from this order" into the existing Delivery Note system for
// real fulfillment tracking — Partially_Fulfilled/Fulfilled will reflect
// what's actually been shipped, not just what was typed at order time).
//
// Also makes POS reservation-aware: adding to the cart is capped at
// availableQty (physical stock minus what's reserved by other open
// orders) so a cashier can't accidentally sell stock a Sales Order has
// already committed. Note: the base app's posAddToCart() had NO stock
// check at all before this (not even against raw qty) — this patch adds
// the first one, scoped to reservation-awareness.
//
// Output: a formal Sales Order document (its own print page, same
// technique as the Delivery Note print view) with Ordered / Reserved /
// Backordered columns, printable to PDF via the browser's own Print
// dialog, plus a Share button reusing the same rasterize + native share
// sheet / WhatsApp-link fallback pattern already built for Delivery
// Notes (a small self-contained copy here rather than reaching into
// another patch's closure — that exact mistake broke the DN Share button
// once already this session).
//
// SCOPE NOTES (read before extending):
//   - Retail only for now — construction's Invoice screen has no stock
//     concept to reserve against (see patch-v52's note on the same
//     issue). A construction "Sales Order" would need a different design
//     entirely if ever wanted.
//   - Editing an already-confirmed order's line quantities isn't
//     supported yet (only Cancel) — reopening committed reservations for
//     editing safely is more involved and is deferred rather than rushed.
//   - Tax is a single manual amount per order, not run through the app's
//     full per-item tax-tier engine — kept simple on purpose; flag if you
//     need it tier-aware later.
// ═══════════════════════════════════════════════════════════

(function () {
  function todayStr() { return (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function fmtMoney(n) { return (typeof fc === 'function') ? fc(n) : '$' + (parseFloat(n) || 0).toFixed(2); }

  function _dnResolveGlobalV57(name) {
    if (typeof window[name] !== 'undefined') return window[name];
    try { return eval(name); } catch (e) { return undefined; }
  }

  // ── Persistence: ride on the existing generic key-value save/load ────
  // hh_data is a true (company_id, data_key, data_value) store server-side
  // — any new key just works, confirmed by reading api/db.js directly
  // before building this. Pushing onto DB_KEYS makes DB.salesOrders save
  // and load automatically via the app's existing saveData()/loadDB().
  const _dbKeys = _dnResolveGlobalV57('DB_KEYS');
  if (Array.isArray(_dbKeys) && _dbKeys.indexOf('salesOrders') === -1) _dbKeys.push('salesOrders');
  function ensureSalesOrdersArray() { if (!Array.isArray(DB.salesOrders)) DB.salesOrders = []; }
  ensureSalesOrdersArray();

  // ── Numbering (scanned, same pattern as Delivery Notes) ──────────────
  function nextSONumberV57() {
    let max = 0;
    (DB.salesOrders || []).forEach(function (so) {
      const m = /^SO-(\d+)$/.exec(so.order_number || '');
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    });
    return 'SO-' + String(max + 1).padStart(4, '0');
  }

  // ── Reservation math (verified separately before this file was written) ──
  function reservedQtyForProductV57(productId, excludeOrderId) {
    let sum = 0;
    (DB.salesOrders || []).forEach(function (so) {
      if (so.id === excludeOrderId) return;
      if (so.status === 'Cancelled' || so.status === 'Fulfilled') return;
      (so.lines || []).forEach(function (l) {
        if (l.item_id !== productId) return;
        sum += Math.max(0, (l.quantity_reserved || 0) - (l.quantity_shipped || 0));
      });
    });
    return sum;
  }
  window.reservedQtyForProductV57 = reservedQtyForProductV57;

  function availableQtyV57(productId, excludeOrderId) {
    const product = (typeof RETAIL_PRODUCTS !== 'undefined' ? RETAIL_PRODUCTS : []).find(function (p) { return p.id === productId; });
    if (!product) return 0;
    return Math.max(0, (parseFloat(product.qty) || 0) - reservedQtyForProductV57(productId, excludeOrderId));
  }
  window.availableQtyV57 = availableQtyV57;

  function splitReservedBackorderedV57(productId, qtyOrdered, excludeOrderId) {
    const avail = availableQtyV57(productId, excludeOrderId);
    const reserved = Math.min(qtyOrdered, avail);
    return { reserved: reserved, backordered: Math.max(0, qtyOrdered - reserved) };
  }
  window.splitReservedBackorderedV57 = splitReservedBackorderedV57;

  // ── Make POS reservation-aware (it had no stock check at all before) ──
  const _origPosAddToCartV57 = window.posAddToCart;
  if (typeof _origPosAddToCartV57 === 'function') {
    window.posAddToCart = function (product, qty) {
      qty = qty || 1;
      if (product && product.id != null) {
        const avail = availableQtyV57(product.id, null);
        const cartRef = _dnResolveGlobalV57('POS_CART') || [];
        const existing = cartRef.find(function (i) { return i.id === product.id; });
        const alreadyInCart = existing ? existing.qty : 0;
        if (alreadyInCart + qty > avail) {
          const allowed = Math.max(0, avail - alreadyInCart);
          if (typeof showToast === 'function') {
            showToast(allowed > 0
              ? `⚠️ Only ${allowed} more available — rest reserved by Sales Orders`
              : `⚠️ None available — all ${product.qty} of "${product.name}" reserved by Sales Orders`);
          }
          if (allowed <= 0) return;
          qty = allowed;
        }
      }
      return _origPosAddToCartV57(product, qty);
    };
  }

  // ── Sidebar + pages ────────────────────────────────────────────────
  function injectSalesOrdersPagesV57() {
    if (document.getElementById('pg-salesorders')) return;
    const main = document.querySelector('.main'); if (!main) return;

    const listPage = document.createElement('div');
    listPage.className = 'page'; listPage.id = 'pg-salesorders';
    listPage.innerHTML = `<div class="ph"><h1>🧾 Sales Orders</h1></div>
      <div class="card" style="margin-bottom:12px">
        <button class="btn btn-gold" onclick="openNewSalesOrderFormV57()">+ New Sales Order</button>
      </div>
      <div class="card"><div id="so-list-v57"></div></div>`;
    main.appendChild(listPage);

    const formPage = document.createElement('div');
    formPage.className = 'page'; formPage.id = 'pg-so-new';
    formPage.innerHTML = `<div class="ph"><h1>🧾 New Sales Order</h1></div>
      <div class="card" style="margin-bottom:12px">
        <div class="card-hdr">📎 Upload Customer's Purchase Order (optional)</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:10px">Upload a photo or PDF of the customer's PO and it'll try to pull the customer name and items — you still review and edit everything below before confirming.</div>
        <div id="soUdocDropzone" onclick="document.getElementById('soUdocFile').click()" ondragover="event.preventDefault();this.style.borderColor='var(--gold2)'" ondragleave="this.style.borderColor='var(--border2)'" ondrop="handleSOPoDrop(event)" style="border:2px dashed var(--border2);border-radius:8px;padding:16px;text-align:center;cursor:pointer">
          <input type="file" id="soUdocFile" accept="image/*,.pdf" style="display:none" onchange="handleSOPoUploadV57(this.files[0])"/>
          <div style="font-size:20px;margin-bottom:4px">📄</div>
          <div style="font-size:12px;color:var(--text2)">Click or drag the PO here</div>
        </div>
        <div id="soUdocStatus" style="font-size:11px;color:var(--text3);margin-top:8px"></div>
      </div>
      <div class="card" style="margin-bottom:12px">
        <div class="fg"><label style="font-size:10px">Customer</label>
          <select id="soCustomer" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:9px 10px;font-size:13px;color:var(--text);outline:none"><option value="">— Select customer —</option></select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div class="fg" style="margin:0"><label style="font-size:10px">Order Date</label><input id="soOrderDate" type="date" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:9px 10px;font-size:13px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Customer's PO / Reference No. (optional)</label><input id="soRefNo" type="text" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:9px 10px;font-size:13px;color:var(--text);outline:none"/></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:12px">
        <div class="card-hdr">Line Items</div>
        <div id="so-lines-v57"></div>
        <button type="button" class="btn btn-outline" style="margin-top:4px" onclick="addSOLineV57()">+ Add Line</button>
      </div>
      <div class="card" style="margin-bottom:12px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div class="fg" style="margin:0"><label style="font-size:10px">Tax Amount (optional)</label><input id="soTaxAmt" type="number" min="0" step="0.01" value="0" oninput="recalcSOTotalsV57()" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:9px 10px;font-size:13px;color:var(--text);outline:none"/></div>
          <div></div>
        </div>
        <div id="so-totals-v57" style="margin-top:8px;font-size:13px"></div>
      </div>
      <div class="btn-row">
        <button class="btn btn-gold" onclick="confirmSalesOrderV57()">✅ Confirm Sales Order</button>
        <button class="btn btn-outline" onclick="nav('salesorders')">Cancel</button>
      </div>`;
    main.appendChild(formPage);

    const printPage = document.createElement('div');
    printPage.className = 'page'; printPage.id = 'pg-so-print-v57';
    printPage.innerHTML = `<div class="no-print" style="margin-bottom:14px;display:flex;gap:8px">
        <button class="btn btn-outline" onclick="nav('salesorders')">← Back</button>
        <button class="btn btn-gold" onclick="window.print()">🖨️ Print</button>
        <button class="btn btn-outline" id="so-share-btn-v57" onclick="shareSalesOrderV57(window._soCurrentPrintIdV57)">📤 Share</button>
      </div>
      <div id="so-print-content-v57" style="background:#fff;color:#111;padding:28px;max-width:760px;margin:0 auto;font-family:Arial,sans-serif;border-radius:4px"></div>`;
    main.appendChild(printPage);

    const style = document.createElement('style');
    style.textContent = `
      @media print{
        body.so-printing-v57 .page{display:none!important}
        body.so-printing-v57 #pg-so-print-v57{display:block!important}
      }
      #so-print-content-v57 table{width:100%;border-collapse:collapse;margin:14px 0;font-size:12px}
      #so-print-content-v57 th,#so-print-content-v57 td{border:1px solid #999;padding:6px 7px;text-align:left;color:#111!important}
    `;
    document.head.appendChild(style);
  }

  ['RETAIL_NAV', 'RETAIL_NAV_EN'].forEach(function (name) {
    const arr = _dnResolveGlobalV57(name);
    if (Array.isArray(arr) && !arr.some(function (s) { return s.section === '🧾 Orders'; })) {
      arr.push({ section: '🧾 Orders', items: [{ ico: '🧾', ti: 'Sales Orders', en: 'Sales Orders', page: 'salesorders' }] });
    }
  });

  // ── List page ─────────────────────────────────────────────────────
  const STATUS_TAG_V57 = { Confirmed: 't-blue', Partially_Fulfilled: 't-gold', Fulfilled: 't-green', Cancelled: 't-red' };
  function renderSalesOrdersListV57() {
    const el = document.getElementById('so-list-v57'); if (!el) return;
    const orders = (DB.salesOrders || []).slice().sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
    if (!orders.length) { el.innerHTML = '<div style="text-align:center;padding:22px;color:var(--text3)">No Sales Orders yet</div>'; return; }
    el.innerHTML = `<table><thead><tr><th>Order #</th><th>Date</th><th>Customer</th><th>Total</th><th>Status</th><th>Backorder?</th><th></th></tr></thead><tbody>${
      orders.map(function (so) {
        const hasBackorder = (so.lines || []).some(function (l) { return (l.quantity_backordered || 0) > 0; });
        return `<tr>
          <td style="font-family:'JetBrains Mono',monospace">${esc(so.order_number)}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${esc(so.order_date)}</td>
          <td>${esc(so.customerName) || '—'}</td>
          <td style="font-family:'JetBrains Mono',monospace">${fmtMoney(so.total_amount)}</td>
          <td><span class="tag ${STATUS_TAG_V57[so.status] || 't-blue'}" style="font-size:9px">${esc((so.status || '').replace(/_/g, ' '))}</span></td>
          <td>${hasBackorder ? '<span class="tag t-gold" style="font-size:9px">⚠️ Backordered</span>' : '—'}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-outline" style="padding:4px 9px;font-size:11px" onclick="printSalesOrderV57(${so.id})">🖨️</button>
            ${so.status !== 'Cancelled' && so.status !== 'Fulfilled' ? `<button class="btn btn-outline" style="padding:4px 9px;font-size:11px" onclick="cancelSalesOrderV57(${so.id})">✕ Cancel</button>` : ''}
          </td>
        </tr>`;
      }).join('')
    }</tbody></table>`;
  }
  window.renderSalesOrdersListV57 = renderSalesOrdersListV57;

  window.cancelSalesOrderV57 = function (orderId) {
    const so = (DB.salesOrders || []).find(function (o) { return o.id === orderId; });
    if (!so) return;
    if (!window.confirm('Cancel ' + so.order_number + '? Any reserved stock will be released back to available.')) return;
    so.status = 'Cancelled';
    if (typeof saveData === 'function') saveData();
    if (typeof showToast === 'function') showToast('✅ ' + so.order_number + ' cancelled — stock released');
    renderSalesOrdersListV57();
  };

  // ── New Sales Order form ─────────────────────────────────────────
  let _soLineSeq = 0;
  function productOptionsV57(selectedId) {
    const products = (typeof RETAIL_PRODUCTS !== 'undefined' ? RETAIL_PRODUCTS : []);
    return '<option value="">Type a description below instead...</option>' + products.map(function (p) {
      return `<option value="${p.id}" ${String(p.id) === String(selectedId) ? 'selected' : ''}>${esc(p.name)} — ${fmtMoney(p.sale_price)} (stock: ${p.qty} ${p.unit})</option>`;
    }).join('');
  }
  window.addSOLineV57 = function (prefill) {
    const wrap = document.getElementById('so-lines-v57'); if (!wrap) return;
    const rowId = 'sol-' + (_soLineSeq++);
    const row = document.createElement('div');
    row.className = 'so-line-row';
    row.dataset.rowId = rowId;
    row.style.cssText = 'border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:8px';
    const pre = prefill || {};
    row.innerHTML = `
      <div style="display:grid;grid-template-columns:1.6fr auto;gap:6px;margin-bottom:5px">
        <select class="so-line-product" onchange="onSOLineProductChangeV57('${rowId}')" style="background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 8px;font-size:11px;color:var(--text);outline:none">${productOptionsV57(pre.item_id)}</select>
        <button type="button" onclick="this.closest('.so-line-row').remove();recalcSOTotalsV57()" style="padding:7px 10px;background:transparent;border:1px solid rgba(192,48,42,.3);border-radius:5px;color:var(--red3);cursor:pointer;font-size:12px">✕</button>
      </div>
      <input class="so-line-desc" type="text" placeholder="Description (used if no product matched)" value="${esc(pre.description || '')}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 8px;font-size:11px;color:var(--text);outline:none;margin-bottom:5px"/>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
        <div class="fg" style="margin:0"><label style="font-size:9px">Qty Ordered</label><input class="so-line-qty" type="number" min="0" value="${pre.quantity_ordered || ''}" oninput="onSOLineQtyChangeV57('${rowId}')" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 8px;font-size:11px;color:var(--text);outline:none"/></div>
        <div class="fg" style="margin:0"><label style="font-size:9px">Unit Price</label><input class="so-line-price" type="number" min="0" step="0.01" value="${pre.unit_price || ''}" oninput="recalcSOTotalsV57()" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 8px;font-size:11px;color:var(--text);outline:none"/></div>
        <div class="fg" style="margin:0"><label style="font-size:9px">Unit</label><input class="so-line-unit" type="text" value="${esc(pre.unit || 'unit')}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 8px;font-size:11px;color:var(--text);outline:none"/></div>
      </div>
      <div class="so-line-avail" style="font-size:10px;color:var(--text3);margin-top:4px"></div>
    `;
    wrap.appendChild(row);
    onSOLineQtyChangeV57(rowId);
  };

  window.onSOLineProductChangeV57 = function (rowId) {
    const row = document.querySelector('.so-line-row[data-row-id="' + rowId + '"]'); if (!row) return;
    const sel = row.querySelector('.so-line-product');
    const productId = sel.value ? parseInt(sel.value, 10) : null;
    const product = productId ? (RETAIL_PRODUCTS || []).find(function (p) { return p.id === productId; }) : null;
    if (product) {
      row.querySelector('.so-line-desc').value = product.name;
      row.querySelector('.so-line-price').value = product.sale_price || 0;
      row.querySelector('.so-line-unit').value = product.unit || 'unit';
    }
    onSOLineQtyChangeV57(rowId);
  };

  window.onSOLineQtyChangeV57 = function (rowId) {
    const row = document.querySelector('.so-line-row[data-row-id="' + rowId + '"]'); if (!row) return;
    const sel = row.querySelector('.so-line-product');
    const productId = sel.value ? parseInt(sel.value, 10) : null;
    const qty = parseFloat(row.querySelector('.so-line-qty').value) || 0;
    const availEl = row.querySelector('.so-line-avail');
    if (productId) {
      const product = (RETAIL_PRODUCTS || []).find(function (p) { return p.id === productId; });
      const reserved = reservedQtyForProductV57(productId, null);
      const avail = availableQtyV57(productId, null);
      const split = splitReservedBackorderedV57(productId, qty, null);
      availEl.innerHTML = `In stock: ${product ? product.qty : 0} · Reserved elsewhere: ${reserved} · Available: ${avail}` +
        (split.backordered > 0 ? ` <span class="tag t-gold" style="font-size:9px">⚠️ ${split.backordered} will be Backordered</span>` : (qty > 0 ? ' <span class="tag t-green" style="font-size:9px">✅ Fully available</span>' : ''));
    } else {
      availEl.innerHTML = qty > 0 ? '<span style="color:var(--text3)">No matching product — this line has no stock to check.</span>' : '';
    }
    recalcSOTotalsV57();
  };

  window.recalcSOTotalsV57 = function () {
    const rows = document.querySelectorAll('#so-lines-v57 .so-line-row');
    let subtotal = 0;
    rows.forEach(function (row) {
      const qty = parseFloat(row.querySelector('.so-line-qty').value) || 0;
      const price = parseFloat(row.querySelector('.so-line-price').value) || 0;
      subtotal += qty * price;
    });
    const tax = parseFloat((document.getElementById('soTaxAmt') || {}).value) || 0;
    const el = document.getElementById('so-totals-v57');
    if (el) el.innerHTML = `<div style="display:flex;justify-content:space-between"><span>Subtotal</span><span>${fmtMoney(subtotal)}</span></div><div style="display:flex;justify-content:space-between"><span>Tax</span><span>${fmtMoney(tax)}</span></div><div style="display:flex;justify-content:space-between;font-weight:700;border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><span>Total</span><span>${fmtMoney(subtotal + tax)}</span></div>`;
    return { subtotal: subtotal, tax: tax, total: subtotal + tax };
  };

  window.openNewSalesOrderFormV57 = function () {
    injectSalesOrdersPagesV57();
    const custSel = document.getElementById('soCustomer');
    if (custSel) custSel.innerHTML = '<option value="">— Select customer —</option>' + (CUSTOMERS || []).map(function (c) { return `<option value="${c.id}">${esc(c.name)}</option>`; }).join('');
    const dateEl = document.getElementById('soOrderDate'); if (dateEl) dateEl.value = todayStr();
    const refEl = document.getElementById('soRefNo'); if (refEl) refEl.value = '';
    const linesEl = document.getElementById('so-lines-v57'); if (linesEl) linesEl.innerHTML = '';
    const taxEl = document.getElementById('soTaxAmt'); if (taxEl) taxEl.value = 0;
    const statusEl = document.getElementById('soUdocStatus'); if (statusEl) statusEl.textContent = '';
    window._soLastOcrSource = null;
    addSOLineV57();
    recalcSOTotalsV57();
    nav('so-new');
  };

  // ── OCR PO upload (reuses the app's existing document-AI pipeline) ──
  window.handleSOPoDrop = function (ev) {
    ev.preventDefault();
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) handleSOPoUploadV57(f);
  };

  window.handleSOPoUploadV57 = async function (file) {
    if (!file) return;
    const statusEl = document.getElementById('soUdocStatus');
    const setStatus = function (msg, isErr) { if (statusEl) { statusEl.textContent = msg; statusEl.style.color = isErr ? 'var(--red3)' : 'var(--text3)'; } };
    try {
      setStatus('⏳ Reading document...');
      let text = '';
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) text = await extractTextFromPDF(file, setStatus);
      else if (file.type.startsWith('image/')) text = await extractTextFromImage(file, setStatus);
      else { setStatus('⚠️ Unsupported file type — use an image or PDF', true); return; }
      text = (text || '').trim();
      if (!text) { setStatus('⚠️ No text found in that document', true); return; }
      setStatus('🧠 Extracting customer and items...');
      const docContext = {
        chartOfAccounts: (typeof CHART_OF_ACCOUNTS !== 'undefined' ? CHART_OF_ACCOUNTS.map(function (a) { return { name: a.name, account_type: a.account_type }; }) : []),
        isVatRegistered: !!(typeof TAX_SETTINGS !== 'undefined' && TAX_SETTINGS.is_vat_registered),
        baseCurrency: 'USD',
        customers: (CUSTOMERS || []).map(function (c) { return { name: c.name }; }),
        suppliers: (typeof SUPPLIERS !== 'undefined' ? SUPPLIERS.map(function (s) { return { name: s.name }; }) : [])
      };
      const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text, mode: 'universalDocument', docContext: docContext }) });
      const data = await res.json();
      const parsed = (typeof safeParseReceiptJson === 'function') ? safeParseReceiptJson(data.result || '') : null;
      if (!parsed) { setStatus('⚠️ Could not analyze that document — add items manually below instead.', true); return; }
      window._soLastOcrSource = true;
      applyOcrResultToSOFormV57(parsed);
      setStatus('✅ Pulled ' + ((parsed.line_items || []).length) + ' item(s) — review below before confirming.');
    } catch (err) {
      setStatus('❌ ' + err.message, true);
    } finally {
      const f = document.getElementById('soUdocFile'); if (f) f.value = '';
    }
  };

  function applyOcrResultToSOFormV57(parsed) {
    // Customer: try to match an existing one by name; otherwise leave the
    // dropdown on "select" and let the user pick/add one — never invent a
    // new customer record silently.
    if (parsed.party_name && typeof findCustomerByName === 'function') {
      const match = findCustomerByName(parsed.party_name);
      const custSel = document.getElementById('soCustomer');
      if (match && custSel) custSel.value = match.id;
    }
    if (parsed.document_number) {
      const refEl = document.getElementById('soRefNo'); if (refEl) refEl.value = parsed.document_number;
    }
    const linesEl = document.getElementById('so-lines-v57'); if (linesEl) linesEl.innerHTML = '';
    const items = parsed.line_items || [];
    if (!items.length) { addSOLineV57(); return; }
    items.forEach(function (it) {
      const match = (typeof posFindProduct === 'function') ? posFindProduct(it.description, true) : null;
      addSOLineV57({
        item_id: match ? match.id : null,
        description: match ? match.name : (it.description || ''),
        unit_price: match ? match.sale_price : (it.unit_price || 0), // master rate wins when matched, per the ask
        unit: match ? match.unit : 'unit',
        quantity_ordered: it.quantity || 0
      });
    });
  }

  // ── Confirm & save ────────────────────────────────────────────────
  window.confirmSalesOrderV57 = function () {
    const custSel = document.getElementById('soCustomer');
    const custId = custSel ? custSel.value : '';
    const customer = custId ? (CUSTOMERS || []).find(function (c) { return String(c.id) === String(custId); }) : null;
    if (!customer) { if (typeof showToast === 'function') showToast('⚠️ Select a customer'); return; }

    const rows = document.querySelectorAll('#so-lines-v57 .so-line-row');
    let lines = [];
    rows.forEach(function (row) {
      const sel = row.querySelector('.so-line-product');
      const productId = sel.value ? parseInt(sel.value, 10) : null;
      const description = row.querySelector('.so-line-desc').value.trim();
      const unit = row.querySelector('.so-line-unit').value.trim() || 'unit';
      const qty = parseFloat(row.querySelector('.so-line-qty').value) || 0;
      const price = parseFloat(row.querySelector('.so-line-price').value) || 0;
      if (!description || qty <= 0) return;
      const split = productId ? splitReservedBackorderedV57(productId, qty, null) : { reserved: 0, backordered: qty };
      lines.push({
        item_id: productId, description: description, sku: productId ? ((RETAIL_PRODUCTS || []).find(function (p) { return p.id === productId; }) || {}).sku || '' : '',
        unit: unit, quantity_ordered: qty, quantity_reserved: split.reserved, quantity_backordered: split.backordered,
        quantity_shipped: 0, unit_price: price, subtotal: qty * price
      });
    });
    if (!lines.length) { if (typeof showToast === 'function') showToast('⚠️ Add at least one line item'); return; }

    const totals = recalcSOTotalsV57();
    const so = {
      id: DB.nextId++,
      order_number: nextSONumberV57(),
      order_date: (document.getElementById('soOrderDate') || {}).value || todayStr(),
      customerId: customer.id, customerName: customer.name,
      status: 'Confirmed',
      currency: (typeof CUR !== 'undefined' ? CUR : 'USD'),
      subtotal: totals.subtotal, tax_amount: totals.tax, total_amount: totals.total,
      source: window._soLastOcrSource ? 'ocr_po' : 'manual',
      sourceDocNumber: (document.getElementById('soRefNo') || {}).value || '',
      lines: lines,
      createdAt: todayStr()
    };
    ensureSalesOrdersArray();
    DB.salesOrders.push(so);
    if (typeof saveData === 'function') saveData();
    const hasBackorder = lines.some(function (l) { return l.quantity_backordered > 0; });
    if (typeof showToast === 'function') showToast('✅ ' + so.order_number + ' confirmed' + (hasBackorder ? ' — some items backordered' : ''));
    printSalesOrderV57(so.id);
  };

  // ── Formal document + share (self-contained, see file header) ───────
  window.printSalesOrderV57 = function (orderId) {
    const so = (DB.salesOrders || []).find(function (o) { return o.id === orderId; });
    if (!so) { if (typeof showToast === 'function') showToast('⚠️ Sales Order not found'); return; }
    injectSalesOrdersPagesV57();
    window._soCurrentPrintIdV57 = orderId;
    const content = document.getElementById('so-print-content-v57'); if (!content) return;
    const linesHtml = (so.lines || []).map(function (l) {
      const backorderTag = l.quantity_backordered > 0 ? ' <span style="color:#b45309;font-weight:700">(⚠️ ' + l.quantity_backordered + ' backordered)</span>' : '';
      return `<tr><td>${esc(l.description)}${backorderTag}</td><td>${esc(l.sku) || '—'}</td><td style="text-align:center">${l.quantity_ordered}</td><td style="text-align:center">${l.quantity_reserved}</td><td style="text-align:center">${l.quantity_backordered}</td><td style="text-align:right">${fmtMoney(l.unit_price)}</td><td style="text-align:right">${fmtMoney(l.subtotal)}</td></tr>`;
    }).join('');
    const anyBackorder = (so.lines || []).some(function (l) { return l.quantity_backordered > 0; });
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #333;padding-bottom:12px;margin-bottom:14px">
        <div style="font-size:20px;font-weight:700">${esc((typeof BIZ_NAME !== 'undefined' && BIZ_NAME) || 'Company')}</div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:700;letter-spacing:1px">SALES ORDER</div>
          <div style="font-size:12px">No: <b>${esc(so.order_number)}</b></div>
          <div style="font-size:12px">Date: ${esc(so.order_date)}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:20px;font-size:13px;margin-bottom:14px">
        <div><b>Customer:</b> ${esc(so.customerName)}</div>
        <div><b>Status:</b> ${esc((so.status || '').replace(/_/g, ' '))}</div>
        ${so.sourceDocNumber ? `<div><b>Customer PO #:</b> ${esc(so.sourceDocNumber)}</div>` : ''}
      </div>
      <table><thead><tr><th>Description</th><th>SKU</th><th>Ordered</th><th>Reserved</th><th>Backordered</th><th>Unit Price</th><th>Line Total</th></tr></thead><tbody>${linesHtml}</tbody></table>
      <div style="text-align:right;font-size:13px;margin-top:10px">
        <div>Subtotal: ${fmtMoney(so.subtotal)}</div>
        <div>Tax: ${fmtMoney(so.tax_amount)}</div>
        <div style="font-weight:700;font-size:15px">Total: ${fmtMoney(so.total_amount)}</div>
      </div>
      ${anyBackorder ? '<div style="margin-top:14px;padding:8px 10px;background:#fef3c7;border:1px solid #f59e0b;border-radius:4px;font-size:12px">⚠️ Some items on this order are backordered and will be delivered separately once available.</div>' : ''}
    `;
    document.body.classList.add('so-printing-v57');
    nav('so-print-v57');
  };

  function ensureHtml2CanvasV57() {
    if (window.html2canvas) return Promise.resolve();
    if (window._soHtml2CanvasLoadingV57) return window._soHtml2CanvasLoadingV57;
    window._soHtml2CanvasLoadingV57 = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload = function () { resolve(); }; s.onerror = function () { reject(new Error('html2canvas failed to load')); };
      document.head.appendChild(s);
    });
    return window._soHtml2CanvasLoadingV57;
  }
  window.shareSalesOrderV57 = async function (orderId) {
    const so = (DB.salesOrders || []).find(function (o) { return o.id === orderId; });
    if (!so) return;
    const itemLines = (so.lines || []).map(function (l) { return '• ' + l.description + ' — ' + l.quantity_ordered + (l.quantity_backordered ? ' (' + l.quantity_backordered + ' backordered)' : ''); }).join('\n');
    const summaryText = '🧾 Sales Order ' + so.order_number + '\nCustomer: ' + so.customerName + '\nDate: ' + so.order_date + '\n\nItems:\n' + itemLines + '\n\nTotal: ' + fmtMoney(so.total_amount) + '\nStatus: ' + so.status;
    let file = null;
    try {
      await ensureHtml2CanvasV57();
      const node = document.getElementById('so-print-content-v57');
      if (node && window.html2canvas) {
        const canvas = await window.html2canvas(node, { backgroundColor: '#ffffff', scale: 2 });
        const blob = await new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
        if (blob) file = new File([blob], so.order_number + '.png', { type: 'image/png' });
      }
    } catch (e) { console.warn('SO share rasterize failed, falling back to text', e); }
    if (navigator.share) {
      try {
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ title: 'Sales Order ' + so.order_number, text: summaryText, files: [file] });
        else await navigator.share({ title: 'Sales Order ' + so.order_number, text: summaryText });
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    window.open('https://wa.me/?text=' + encodeURIComponent(summaryText), '_blank');
  };

  // ── Hook up nav() ─────────────────────────────────────────────────
  // Same ordering fix as v53 (see its file for the full explanation):
  // injectSalesOrdersPagesV57() must run BEFORE awaiting the original
  // nav chain, or base nav() won't find #pg-salesorders yet on the very
  // first visit and will show a blank page.
  const _origNavV57 = window.nav;
  if (typeof _origNavV57 === 'function') {
    window.nav = async function (page, el) {
      injectSalesOrdersPagesV57();
      const result = await _origNavV57(page, el);
      if (page === 'salesorders') renderSalesOrdersListV57();
      if (page !== 'so-print-v57') document.body.classList.remove('so-printing-v57');
      return result;
    };
  }

  console.log('✅ patch-v57.js loaded — Sales Orders (creation, OCR-PO matching, reservation, document)');
})();
