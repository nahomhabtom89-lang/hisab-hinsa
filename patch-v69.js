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
      <div style="display:flex;justify-content:space-between;gap:30px;margin-top:50px;font-size:12px">
        <div style="flex:1"><div style="border-top:1px solid #333;margin-top:40px;padding-top:4px">Authorized By (Us)</div></div>
        <div style="flex:1"><div style="border-top:1px solid #333;margin-top:40px;padding-top:4px">Acknowledged By (Supplier)</div></div>
      </div>
    `;
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
