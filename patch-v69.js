// ═══════════════════════════════════════════════════════════
// PATCH v69 — Purchase Orders: Print / Share document
// ═══════════════════════════════════════════════════════════
// The Purchase Order creation flow itself (submitPurchaseOrder,
// renderPOLines, the whole "pending → partially received → completed"
// lifecycle) is UNTOUCHED — this only adds a formal printable PO
// document + WhatsApp share, same pattern as the Delivery Note.
//
// renderPOList() is a plain top-level function in index.html itself
// (not inside any IIFE, and nothing else wraps it — confirmed by
// grepping the whole repo first), so wrapping it here is safe. It's
// wrapped, not replaced: the original still runs exactly as before,
// this only adds a "PO #" column and a Print/Share column onto the
// table it built, via DOM insertion — the same safe pattern already
// used to add columns to the Suppliers and Customers pages, after an
// earlier mistake here full-replaced one of those instead of chaining.
//
// Row → PO matched by array index against the bare PO_ORDERS global
// (a `let` at index.html's own top level — per Lesson 1, read as the
// bare identifier, never window.PO_ORDERS), which renderPOList() itself
// populates right before building the same rows in the same order.
// ═══════════════════════════════════════════════════════════

(function () {
  function todayStr() { return (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function fmtMoney(n) { return (typeof fc === 'function') ? fc(n) : '$' + (parseFloat(n) || 0).toFixed(2); }
  function poItemsV69(o) { return Array.isArray(o.items) ? o.items : (JSON.parse(o.items || '[]')); }

  // ── Add "PO #" + Print/Share columns via DOM insertion only ────────
  const _origRenderPOListV69 = window.renderPOList;
  if (typeof _origRenderPOListV69 === 'function') {
    window.renderPOList = async function () {
      const result = await _origRenderPOListV69.apply(this, arguments);
      const table = document.querySelector('#poList table');
      if (!table) return result;
      const headRow = table.querySelector('thead tr');
      if (headRow && !headRow.querySelector('.po69-num-th')) {
        const thNum = document.createElement('th');
        thNum.className = 'po69-num-th'; thNum.textContent = 'PO #';
        headRow.insertBefore(thNum, headRow.firstElementChild);
        const thAct = document.createElement('th');
        thAct.className = 'po69-actions-th'; thAct.textContent = '';
        headRow.appendChild(thAct);
      }
      const orders = (typeof PO_ORDERS !== 'undefined') ? PO_ORDERS : [];
      const rows = table.querySelectorAll('tbody tr');
      rows.forEach(function (tr, idx) {
        if (tr.querySelector('.po69-actions-td')) return; // already added this render pass
        const po = orders[idx];
        if (!po) return;
        const tdNum = document.createElement('td');
        tdNum.className = 'po69-num-td';
        tdNum.style.cssText = "font-family:'JetBrains Mono',monospace;font-size:11px";
        tdNum.textContent = '#' + po.id;
        tr.insertBefore(tdNum, tr.firstElementChild);
        const tdAct = document.createElement('td');
        tdAct.className = 'po69-actions-td';
        tdAct.style.whiteSpace = 'nowrap';
        tdAct.innerHTML = `<button class="btn btn-outline" style="padding:3px 8px;font-size:10px;margin-right:4px" onclick="printPurchaseOrderV69(${po.id})">🖨️ Print</button><button class="btn btn-outline" style="padding:3px 8px;font-size:10px" onclick="sharePurchaseOrderV69(${po.id})">📲 Share</button>`;
        tr.appendChild(tdAct);
      });
      return result;
    };
  }

  async function findPOV69(poId) {
    let orders = (typeof PO_ORDERS !== 'undefined') ? PO_ORDERS : [];
    let po = orders.find(function (o) { return o.id === poId; });
    if (po) return po;
    if (typeof loadPurchaseOrdersCache === 'function') await loadPurchaseOrdersCache();
    orders = (typeof PO_ORDERS !== 'undefined') ? PO_ORDERS : [];
    return orders.find(function (o) { return o.id === poId; }) || null;
  }

  // ═══════════════════════════════════════════════════════════
  // Print page — same dedicated-page pattern as the Delivery Note.
  // ═══════════════════════════════════════════════════════════
  function injectPOPrintPageV69() {
    if (document.getElementById('pg-po-print-v69')) return;
    const main = document.querySelector('.main'); if (!main) return;
    const page = document.createElement('div');
    page.className = 'page'; page.id = 'pg-po-print-v69';
    page.innerHTML = `<div class="no-print" style="margin-bottom:14px;display:flex;gap:8px">
        <button class="btn btn-outline" onclick="nav('purchaseorders')">← Back</button>
        <button class="btn btn-gold" onclick="window.print()">🖨️ Print</button>
      </div>
      <div id="po-print-content-v69" style="background:#fff;color:#111;padding:28px;max-width:760px;margin:0 auto;font-family:Arial,sans-serif;border-radius:4px"></div>`;
    main.appendChild(page);
  }
  const _poPrintStyleV69 = document.createElement('style');
  _poPrintStyleV69.textContent = `
    @media print{
      body.po-printing-v69 .page{display:none!important}
      body.po-printing-v69 #pg-po-print-v69{display:block!important}
    }
    #po-print-content-v69 table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px}
    #po-print-content-v69 th,#po-print-content-v69 td{border:1px solid #999;padding:6px 8px;text-align:left}
    #po-print-content-v69 td,#po-print-content-v69 th{color:#111!important}
    #po-print-content-v69 th{background:#eee;font-weight:700}
  `;
  document.head.appendChild(_poPrintStyleV69);

  // ── Signature storage — Purchase Orders live in their own SQL table
  // (hh_purchase_orders) with no signature column, and per instruction
  // the PO process/table itself isn't touched. So signatures are kept
  // separately, in the SAME generic key-value store the return requests
  // already use (DB.poSignaturesV69, keyed by PO id) — zero backend
  // change, and the PO record itself is never written to. Same drawable
  // canvas pattern as the Delivery Note (patch-v55) and the Debit/Credit
  // Notes (patch-v64/v63): mouse or touch, saved as a PNG on every
  // stroke release, redrawn on reopen, with a printed-name field
  // underneath. Duplicated locally rather than reused — those aren't
  // window-exposed beyond their own top-level helpers, and it's small
  // enough that a local copy is the safe move (Lesson 3). ──
  const _dbKeysV69 = (typeof DB_KEYS !== 'undefined') ? DB_KEYS : null;
  if (Array.isArray(_dbKeysV69) && _dbKeysV69.indexOf('poSignaturesV69') === -1) _dbKeysV69.push('poSignaturesV69');
  function ensurePOSigStoreV69() { if (!DB.poSignaturesV69 || typeof DB.poSignaturesV69 !== 'object') DB.poSignaturesV69 = {}; }
  function persistPOSignatureV69(poId, field, value) {
    ensurePOSigStoreV69();
    DB.poSignaturesV69[poId] = DB.poSignaturesV69[poId] || {};
    DB.poSignaturesV69[poId][field] = value;
    if (typeof saveData === 'function') saveData();
  }
  window.persistPOSignatureV69 = persistPOSignatureV69;

  window._poSigPadsV69 = window._poSigPadsV69 || {};
  function initSignaturePadV69(canvas, poId, field, existingDataUrl) {
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a1a1a';
    let drawing = false, lastX = 0, lastY = 0;
    function getPos(e) {
      const rect = canvas.getBoundingClientRect();
      const t = e.touches && e.touches[0];
      const clientX = t ? t.clientX : e.clientX, clientY = t ? t.clientY : e.clientY;
      return { x: (clientX - rect.left) * (canvas.width / rect.width), y: (clientY - rect.top) * (canvas.height / rect.height) };
    }
    function start(e) { drawing = true; const p = getPos(e); lastX = p.x; lastY = p.y; e.preventDefault(); }
    function move(e) {
      if (!drawing) return;
      const p = getPos(e);
      ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
      lastX = p.x; lastY = p.y;
      e.preventDefault();
    }
    function end() {
      if (!drawing) return;
      drawing = false;
      persistPOSignatureV69(poId, field, canvas.toDataURL('image/png'));
    }
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
    if (existingDataUrl) {
      const img = new Image();
      img.onload = function () { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); };
      img.src = existingDataUrl;
    }
    return { clear: function () { ctx.clearRect(0, 0, canvas.width, canvas.height); persistPOSignatureV69(poId, field, ''); } };
  }
  window.clearPOSignatureV69 = function (role, poId) {
    const pad = window._poSigPadsV69[role + '-' + poId];
    if (pad) pad.clear();
  };
  function poSignatureBlockHtmlV69(role, poId, label, printedNameVal, nameField) {
    const canvasId = 'po-sig-canvas-' + role + '-' + poId;
    return `<div style="flex:1">
      <canvas id="${canvasId}" width="300" height="90" style="width:100%;max-width:300px;height:90px;border-bottom:1px solid #333;background:#fff;touch-action:none;cursor:crosshair;display:block"></canvas>
      <div class="no-print" style="text-align:right;margin-top:2px">
        <button type="button" onclick="clearPOSignatureV69('${role}',${poId})" style="font-size:10px;padding:2px 9px;border:1px solid #999;background:#fff;color:#333;border-radius:3px;cursor:pointer">Clear</button>
      </div>
      <input type="text" value="${esc(printedNameVal)}" placeholder="Printed name"
        oninput="persistPOSignatureV69(${poId},'${nameField}',this.value)"
        style="width:100%;border:none;border-bottom:1px dotted #999;background:transparent;font-family:inherit;font-size:11px;padding:3px 2px;outline:none;margin-top:2px"/>
      <div style="font-size:11px;color:#555;margin-top:2px">${label}</div>
    </div>`;
  }

  window.printPurchaseOrderV69 = async function (poId) {
    const po = await findPOV69(poId);
    if (!po) { if (typeof showToast === 'function') showToast('⚠️ PO #' + poId + ' not found'); return; }
    injectPOPrintPageV69();
    const content = document.getElementById('po-print-content-v69');
    if (!content) return;
    const items = poItemsV69(po);
    const linesHtml = items.map(function (it) {
      return `<tr><td>${esc(it.name)}</td><td style="text-align:center">${it.qty}</td><td style="text-align:right">${fmtMoney(it.unitCost)}</td><td style="text-align:right">${fmtMoney(it.lineTotal)}</td></tr>`;
    }).join('');
    const status = po.status || 'pending';
    const statusLabel = (typeof PO_STATUS_LABEL !== 'undefined' && PO_STATUS_LABEL[status]) || status;
    const currencyNote = po.currency ? `<div style="font-size:11px;color:#555;margin-top:2px">Invoice currency: ${esc(po.currency)}${po.fx_rate ? (' @ rate ' + po.fx_rate) : ''}</div>` : '';
    ensurePOSigStoreV69();
    const sig = DB.poSignaturesV69[po.id] || {};
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #333;padding-bottom:12px;margin-bottom:14px">
        <div><div style="font-size:20px;font-weight:700">${esc((typeof BIZ_NAME !== 'undefined' && BIZ_NAME) || 'Company')}</div></div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:700;letter-spacing:1px">PURCHASE ORDER</div>
          <div style="font-size:12px">No: <b>#${po.id}</b></div>
          <div style="font-size:12px">Date: ${esc(String(po.po_date).split('T')[0])}</div>
          <div style="font-size:12px">Status: ${esc(statusLabel)}</div>
        </div>
      </div>
      <div style="font-size:13px;margin-bottom:4px"><b>Supplier:</b> ${esc(po.supplier)}</div>
      <div style="font-size:12px;margin-bottom:10px">Payment terms: ${esc(po.payment_method === 'cash' ? 'Cash' : 'Credit (Account)')}${currencyNote}</div>
      <table><thead><tr><th>Description</th><th>Qty</th><th>Unit Cost</th><th>Line Total</th></tr></thead><tbody>${linesHtml}</tbody>
        <tfoot><tr><td colspan="3" style="text-align:right;font-weight:700">Total</td><td style="text-align:right;font-weight:700">${fmtMoney(po.total)}</td></tr></tfoot></table>
      ${po.notes ? `<div style="font-size:12px;margin-top:10px"><b>Notes:</b> ${esc(po.notes)}</div>` : ''}
      <div class="po-sig-row" style="display:flex;justify-content:space-between;gap:30px;margin-top:40px">
        ${poSignatureBlockHtmlV69('us', po.id, 'Authorized By (Us)', sig.usSignatureName || '', 'usSignatureName')}
        ${poSignatureBlockHtmlV69('supplier', po.id, 'Acknowledged By (Supplier)', sig.supplierSignatureName || '', 'supplierSignatureName')}
      </div>
    `;
    const usCanvas = document.getElementById('po-sig-canvas-us-' + po.id);
    const supplierCanvas = document.getElementById('po-sig-canvas-supplier-' + po.id);
    if (usCanvas) window._poSigPadsV69['us-' + po.id] = initSignaturePadV69(usCanvas, po.id, 'usSignatureImg', sig.usSignatureImg);
    if (supplierCanvas) window._poSigPadsV69['supplier-' + po.id] = initSignaturePadV69(supplierCanvas, po.id, 'supplierSignatureImg', sig.supplierSignatureImg);
    document.body.classList.add('po-printing-v69');
    nav('po-print-v69');
  };

  window.sharePurchaseOrderV69 = async function (poId) {
    const po = await findPOV69(poId);
    if (!po) { if (typeof showToast === 'function') showToast('⚠️ PO #' + poId + ' not found'); return; }
    const items = poItemsV69(po);
    const itemLines = items.map(function (it) { return '• ' + it.name + ' — qty ' + it.qty + ' @ ' + fmtMoney(it.unitCost); }).join('\n');
    const summaryText = '📋 Purchase Order #' + po.id + '\n' +
      'Date: ' + String(po.po_date).split('T')[0] + '\n' +
      'Supplier: ' + po.supplier + '\n\n' +
      'Items:\n' + itemLines + '\n\n' +
      'Total: ' + fmtMoney(po.total) + '\n' +
      'Payment terms: ' + (po.payment_method === 'cash' ? 'Cash' : 'Credit (Account)') +
      (po.notes ? ('\nNotes: ' + po.notes) : '') + '\n\n' +
      'Please confirm you can fulfill this order.';
    window.open('https://wa.me/?text=' + encodeURIComponent(summaryText), '_blank');
  };

  // ── nav() — inject the print page BEFORE awaiting (Lesson 4), and
  // clear the printing body class when leaving it ───────────────────
  const _origNavV69 = window.nav;
  if (typeof _origNavV69 === 'function') {
    window.nav = async function (page, el) {
      injectPOPrintPageV69();
      const result = await _origNavV69(page, el);
      if (page !== 'po-print-v69') document.body.classList.remove('po-printing-v69');
      return result;
    };
  }

  console.log('✅ patch-v69.js loaded — Purchase Orders: Print/Share document added, creation flow untouched');
})();
