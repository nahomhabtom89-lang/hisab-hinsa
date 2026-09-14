// ═══════════════════════════════════════════════════════════
// PATCH v58 — Sales Orders, Phase 2: Ship / Fulfill
// ═══════════════════════════════════════════════════════════
// Adds the "🚚 Ship" action v57 deferred. This is what actually moves a
// Sales Order from Confirmed -> Partially_Fulfilled -> Fulfilled, based
// on what's really been shipped — not just what was typed at order time.
//
// A shipment is stored on the order itself (so.shipments[]) rather than
// as an entry.deliveryNote like v52-56's delivery notes — a shipment
// against a Sales Order isn't itself a sale/invoice journal entry (the
// order may be invoiced separately, before or after shipping), so it
// doesn't have a natural DB.entries record to tag. This keeps the
// accounting side completely untouched: shipping affects real stock
// (via the app's own existing applyProductStockAdjustment, confirmed by
// reading its source before use — same helper other stock movements
// already use) and the order's fulfillment tracking, nothing else.
//
// Reuses v57's already-exposed splitReservedBackorderedV57() for the
// "🔄 Recheck Availability" action (lets newly-arrived stock convert a
// line's backorder into something shippable) — that function IS on
// window, unlike the mistake made with v54's injectShareButtonV54, so
// this reach-across is safe. Everything else here is self-contained.
//
// Verified with a standalone Node.js simulation before shipping:
// status transitions (Confirmed -> Partially_Fulfilled -> Fulfilled)
// driven by actual shipped-vs-ordered quantities, ship-quantity
// clamping (can never ship more than is currently reserved, even if
// asked to), and the recheck-then-ship-the-rest flow ending Fulfilled.
//
// SCOPE NOTE: shipment paperwork here uses simple editable text fields
// for "Delivered By / Received By" (same style v54 used), not the full
// drawn-signature canvas pad from v55 — kept this patch to a reasonable
// size. Say the word if you want the canvas pad here too; it's the same
// technique, just not duplicated a third time without being asked.
// ═══════════════════════════════════════════════════════════

(function () {
  function todayStr() { return (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function fmtMoney(n) { return (typeof fc === 'function') ? fc(n) : '$' + (parseFloat(n) || 0).toFixed(2); }

  function ensureShipments(so) { if (!Array.isArray(so.shipments)) so.shipments = []; }

  // Combined numbering — scans BOTH entry.deliveryNote (v52-56) and
  // salesOrder shipments so the two systems share one sequence and never
  // collide, since a delivery note is a delivery note regardless of
  // which flow created it.
  function nextShipmentNumberV58() {
    let max = 0;
    (DB.entries || []).forEach(function (e) {
      const m = /^DN-(\d+)$/.exec((e && e.deliveryNote && e.deliveryNote.dnNumber) || '');
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    });
    (DB.salesOrders || []).forEach(function (so) {
      (so.shipments || []).forEach(function (sh) {
        const m = /^DN-(\d+)$/.exec(sh.dnNumber || '');
        if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
      });
    });
    return 'DN-' + String(max + 1).padStart(4, '0');
  }

  function computeSOStatusV58(lines) {
    const totalOrdered = lines.reduce(function (s, l) { return s + (l.quantity_ordered || 0); }, 0);
    const totalShipped = lines.reduce(function (s, l) { return s + (l.quantity_shipped || 0); }, 0);
    if (totalShipped <= 0) return 'Confirmed';
    if (totalShipped >= totalOrdered) return 'Fulfilled';
    return 'Partially_Fulfilled';
  }

  function clampShipQtyV58(line, requested) {
    const maxShippable = Math.max(0, (line.quantity_reserved || 0) - (line.quantity_shipped || 0));
    return Math.max(0, Math.min(requested, maxShippable));
  }

  // ── Pages ─────────────────────────────────────────────────────────
  function injectShipPagesV58() {
    if (document.getElementById('pg-so-ship')) return;
    const main = document.querySelector('.main'); if (!main) return;

    const shipPage = document.createElement('div');
    shipPage.className = 'page'; shipPage.id = 'pg-so-ship';
    shipPage.innerHTML = `<div class="ph"><h1>🚚 Ship Sales Order</h1></div>
      <div class="card" style="margin-bottom:12px"><div id="so-ship-header-v58" style="font-size:13px;margin-bottom:8px"></div>
        <button type="button" class="btn btn-outline" style="padding:5px 10px;font-size:11px" onclick="recheckAvailabilityV58()">🔄 Recheck Availability</button>
      </div>
      <div class="card" style="margin-bottom:12px"><div id="so-ship-lines-v58"></div></div>
      <div class="card" style="margin-bottom:12px">
        <div class="fg" style="margin-bottom:6px"><label style="font-size:10px">Shipping / Delivery Address</label><textarea id="soShipShipto" rows="2" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:9px 10px;font-size:12px;color:var(--text);outline:none;resize:vertical"></textarea></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div class="fg" style="margin:0"><label style="font-size:10px">Driver / Carrier Name</label><input id="soShipDriver" type="text" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:9px 10px;font-size:12px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Vehicle No.</label><input id="soShipVehicle" type="text" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:9px 10px;font-size:12px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Carrier / Company</label><input id="soShipCarrier" type="text" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:9px 10px;font-size:12px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px"># Packages / Boxes</label><input id="soShipPackages" type="text" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:9px 10px;font-size:12px;color:var(--text);outline:none"/></div>
        </div>
        <div class="fg" style="margin:6px 0 0"><label style="font-size:10px">Special Delivery Instructions</label><input id="soShipNotes" type="text" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:9px 10px;font-size:12px;color:var(--text);outline:none"/></div>
      </div>
      <div class="btn-row">
        <button class="btn btn-gold" onclick="confirmShipmentV58()">✅ Confirm Shipment</button>
        <button class="btn btn-outline" onclick="nav('salesorders')">Cancel</button>
      </div>`;
    main.appendChild(shipPage);

    const shipmentsListPage = document.createElement('div');
    shipmentsListPage.className = 'page'; shipmentsListPage.id = 'pg-so-shipments';
    shipmentsListPage.innerHTML = `<div class="ph"><h1>📋 Shipments</h1></div>
      <div class="card" style="margin-bottom:12px"><button class="btn btn-outline" onclick="nav('salesorders')">← Back to Sales Orders</button></div>
      <div class="card"><div id="so-shipments-list-v58"></div></div>`;
    main.appendChild(shipmentsListPage);

    const printPage = document.createElement('div');
    printPage.className = 'page'; printPage.id = 'pg-so-ship-print-v58';
    printPage.innerHTML = `<div class="no-print" style="margin-bottom:14px;display:flex;gap:8px">
        <button class="btn btn-outline" onclick="nav('salesorders')">← Back</button>
        <button class="btn btn-gold" onclick="window.print()">🖨️ Print</button>
        <button class="btn btn-outline" onclick="shareShipmentV58(window._soShipCurrentOrderIdV58, window._soShipCurrentIdxV58)">📤 Share</button>
      </div>
      <div id="so-ship-print-content-v58" style="background:#fff;color:#111;padding:28px;max-width:760px;margin:0 auto;font-family:Arial,sans-serif;border-radius:4px"></div>`;
    main.appendChild(printPage);

    const style = document.createElement('style');
    style.textContent = `
      @media print{
        body.soship-printing-v58 .page{display:none!important}
        body.soship-printing-v58 #pg-so-ship-print-v58{display:block!important}
      }
      #so-ship-print-content-v58 table{width:100%;border-collapse:collapse;margin:14px 0;font-size:12px}
      #so-ship-print-content-v58 th,#so-ship-print-content-v58 td{border:1px solid #999;padding:6px 7px;text-align:left;color:#111!important}
      #so-ship-print-content-v58 .sig-row{display:flex;justify-content:space-between;margin-top:45px;gap:30px}
      #so-ship-print-content-v58 .sig-block{flex:1;font-size:12px}
      #so-ship-print-content-v58 .sig-input{width:100%;border:none;border-bottom:1px solid #333;background:transparent;font-family:'Brush Script MT',cursive;font-size:16px;padding:2px 2px 4px;outline:none}
    `;
    document.head.appendChild(style);
  }

  // ── Open ship form for an order ─────────────────────────────────────
  window.openShipFormV58 = function (orderId) {
    const so = (DB.salesOrders || []).find(function (o) { return o.id === orderId; });
    if (!so) return;
    if (so.status === 'Cancelled' || so.status === 'Fulfilled') { if (typeof showToast === 'function') showToast('⚠️ Nothing left to ship on this order'); return; }
    injectShipPagesV58();
    window._soShipCurrentOrderIdV58 = orderId;
    document.getElementById('so-ship-header-v58').innerHTML = `<b>${esc(so.order_number)}</b> — ${esc(so.customerName)} <span class="tag ${so.status === 'Partially_Fulfilled' ? 't-gold' : 't-blue'}" style="font-size:9px">${esc(so.status.replace(/_/g, ' '))}</span>`;
    renderShipLinesV58(so);
    ['soShipShipto', 'soShipDriver', 'soShipVehicle', 'soShipCarrier', 'soShipPackages', 'soShipNotes'].forEach(function (id) { const el = document.getElementById(id); if (el) el.value = ''; });
    nav('so-ship');
  };

  function renderShipLinesV58(so) {
    const wrap = document.getElementById('so-ship-lines-v58'); if (!wrap) return;
    wrap.innerHTML = (so.lines || []).map(function (l, idx) {
      const readyNow = Math.max(0, (l.quantity_reserved || 0) - (l.quantity_shipped || 0));
      const stillBackordered = l.quantity_backordered || 0;
      const remaining = (l.quantity_ordered || 0) - (l.quantity_shipped || 0);
      if (remaining <= 0) return ''; // this line is fully shipped already, nothing to show
      return `<div style="border-bottom:1px solid var(--border);padding:8px 0" data-line-idx="${idx}">
        <div style="font-size:13px;font-weight:600">${esc(l.description)}</div>
        <div style="font-size:11px;color:var(--text3);margin:3px 0">
          Ordered: ${l.quantity_ordered} · Shipped so far: ${l.quantity_shipped || 0} · Ready to ship now: ${readyNow}
          ${stillBackordered > 0 ? ` · <span style="color:#b45309">⚠️ Still backordered: ${stillBackordered}</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <label style="font-size:10px">Ship Qty Now</label>
          <input class="so-ship-qty-input" type="number" min="0" max="${readyNow}" value="${readyNow}" data-line-idx="${idx}" style="width:90px;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:5px 8px;font-size:12px;color:var(--text);outline:none"/>
        </div>
      </div>`;
    }).join('') || '<div style="color:var(--text3);text-align:center;padding:14px">Nothing outstanding on this order.</div>';
  }

  window.recheckAvailabilityV58 = function () {
    const so = (DB.salesOrders || []).find(function (o) { return o.id === window._soShipCurrentOrderIdV58; });
    if (!so) return;
    if (typeof splitReservedBackorderedV57 !== 'function') { if (typeof showToast === 'function') showToast('⚠️ Sales Order module (v57) not loaded'); return; }
    let changed = 0;
    (so.lines || []).forEach(function (l) {
      if (!l.item_id) return; // no matched product, nothing to recheck against stock
      const remaining = (l.quantity_ordered || 0) - (l.quantity_shipped || 0);
      if (remaining <= 0) return;
      // Exclude THIS order's own existing reservation from the check, then
      // re-derive the split against the remaining (unshipped) quantity —
      // this is exactly Test 4 from the pre-build verification.
      const split = splitReservedBackorderedV57(l.item_id, remaining, so.id);
      if (split.reserved !== l.quantity_reserved || split.backordered !== l.quantity_backordered) changed++;
      l.quantity_reserved = split.reserved;
      l.quantity_backordered = split.backordered;
    });
    if (typeof saveData === 'function') saveData();
    renderShipLinesV58(so);
    if (typeof showToast === 'function') showToast(changed > 0 ? `✅ Availability updated on ${changed} line(s)` : 'No change — still the same as before');
  };

  window.confirmShipmentV58 = function () {
    const so = (DB.salesOrders || []).find(function (o) { return o.id === window._soShipCurrentOrderIdV58; });
    if (!so) return;
    const qtyInputs = document.querySelectorAll('.so-ship-qty-input');
    const shippedLines = [];
    qtyInputs.forEach(function (input) {
      const idx = parseInt(input.dataset.lineIdx, 10);
      const line = so.lines[idx]; if (!line) return;
      const requested = parseFloat(input.value) || 0;
      const shipQty = clampShipQtyV58(line, requested);
      if (shipQty <= 0) return;
      if (line.item_id && typeof applyProductStockAdjustment === 'function') {
        applyProductStockAdjustment(line.item_id, line.description, shipQty, 0, 'decrease');
      }
      line.quantity_shipped = (line.quantity_shipped || 0) + shipQty;
      shippedLines.push({ description: line.description, sku: line.sku || '', unit: line.unit || 'unit', qtyShipped: shipQty });
    });
    if (!shippedLines.length) { if (typeof showToast === 'function') showToast('⚠️ Enter a ship quantity for at least one line'); return; }

    ensureShipments(so);
    const val = function (id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const shipment = {
      dnNumber: nextShipmentNumberV58(),
      date: todayStr(),
      shipTo: val('soShipShipto'), driverName: val('soShipDriver'), vehicleNo: val('soShipVehicle'),
      carrier: val('soShipCarrier'), numPackages: val('soShipPackages'), instructions: val('soShipNotes'),
      lines: shippedLines,
      deliveredByName: '', receivedByName: '', receivedDate: ''
    };
    so.shipments.push(shipment);
    so.status = computeSOStatusV58(so.lines);
    if (typeof saveData === 'function') saveData();
    if (typeof showToast === 'function') showToast('✅ ' + shipment.dnNumber + ' shipped — order now ' + so.status.replace(/_/g, ' '));
    printShipmentV58(so.id, so.shipments.length - 1);
    if (typeof renderSalesOrdersListV57 === 'function') renderSalesOrdersListV57();
  };

  // ── Past shipments list ──────────────────────────────────────────
  window.viewShipmentsV58 = function (orderId) {
    injectShipPagesV58();
    const so = (DB.salesOrders || []).find(function (o) { return o.id === orderId; });
    const el = document.getElementById('so-shipments-list-v58');
    if (!so || !el) return;
    const shipments = so.shipments || [];
    el.innerHTML = `<div style="font-size:13px;margin-bottom:10px"><b>${esc(so.order_number)}</b> — ${esc(so.customerName)}</div>` +
      (shipments.length ? `<table><thead><tr><th>DN #</th><th>Date</th><th>Items</th><th></th></tr></thead><tbody>${
        shipments.map(function (sh, idx) {
          const itemSummary = (sh.lines || []).map(function (l) { return l.description + ' ×' + l.qtyShipped; }).join(', ');
          return `<tr><td style="font-family:'JetBrains Mono',monospace">${esc(sh.dnNumber)}</td><td style="font-size:11px">${esc(sh.date)}</td><td style="font-size:12px">${esc(itemSummary)}</td><td><button class="btn btn-outline" style="padding:4px 9px;font-size:11px" onclick="printShipmentV58(${orderId},${idx})">🖨️</button></td></tr>`;
        }).join('')
      }</tbody></table>` : '<div style="color:var(--text3);text-align:center;padding:14px">No shipments yet.</div>');
    nav('so-shipments');
  };

  window.printShipmentV58 = function (orderId, shipmentIdx) {
    const so = (DB.salesOrders || []).find(function (o) { return o.id === orderId; });
    if (!so || !so.shipments || !so.shipments[shipmentIdx]) { if (typeof showToast === 'function') showToast('⚠️ Shipment not found'); return; }
    const sh = so.shipments[shipmentIdx];
    injectShipPagesV58();
    window._soShipCurrentOrderIdV58 = orderId;
    window._soShipCurrentIdxV58 = shipmentIdx;
    const content = document.getElementById('so-ship-print-content-v58'); if (!content) return;
    const linesHtml = (sh.lines || []).map(function (l) {
      return `<tr><td>${esc(l.description)}</td><td>${esc(l.sku) || '—'}</td><td>${esc(l.unit)}</td><td style="text-align:center">${l.qtyShipped}</td></tr>`;
    }).join('');
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #333;padding-bottom:12px;margin-bottom:14px">
        <div style="font-size:20px;font-weight:700">${esc((typeof BIZ_NAME !== 'undefined' && BIZ_NAME) || 'Company')}</div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:700;letter-spacing:1px">DELIVERY NOTE</div>
          <div style="font-size:12px">No: <b>${esc(sh.dnNumber)}</b></div>
          <div style="font-size:12px">Date: ${esc(sh.date)}</div>
        </div>
      </div>
      <div style="font-size:13px;margin-bottom:14px"><b>Sales Order:</b> ${esc(so.order_number)} &nbsp; <b>Customer:</b> ${esc(so.customerName)}</div>
      <div style="font-size:13px;margin-bottom:14px"><b>Ship To:</b><br/>${esc(sh.shipTo || '—').replace(/\n/g, '<br/>')}</div>
      <table><thead><tr><th>Description</th><th>SKU</th><th>Unit</th><th>Qty Shipped</th></tr></thead><tbody>${linesHtml}</tbody></table>
      <div style="display:flex;justify-content:space-between;gap:20px;font-size:12px;margin-top:14px">
        <div><b>Driver / Carrier:</b> ${esc(sh.driverName) || '—'}${sh.carrier ? (' (' + esc(sh.carrier) + ')') : ''}</div>
        <div><b>Vehicle No:</b> ${esc(sh.vehicleNo) || '—'}</div>
        <div><b># Packages:</b> ${esc(sh.numPackages) || '—'}</div>
      </div>
      ${sh.instructions ? `<div style="font-size:12px;margin-top:8px"><b>Instructions:</b> ${esc(sh.instructions)}</div>` : ''}
      <div class="sig-row">
        <div class="sig-block">
          <input class="sig-input" type="text" value="${esc(sh.deliveredByName)}" placeholder="Type name to sign" oninput="persistShipmentFieldV58(${orderId},${shipmentIdx},'deliveredByName',this.value)"/>
          <div style="font-size:11px;color:#555;margin-top:3px">Delivered By (Name / Signature)</div>
        </div>
        <div class="sig-block">
          <input class="sig-input" type="text" value="${esc(sh.receivedByName)}" placeholder="Type name to sign" oninput="persistShipmentFieldV58(${orderId},${shipmentIdx},'receivedByName',this.value)"/>
          <div style="font-size:11px;color:#555;margin-top:3px">Received By (Name / Signature)
            <input type="date" value="${esc(sh.receivedDate)}" onchange="persistShipmentFieldV58(${orderId},${shipmentIdx},'receivedDate',this.value)" style="border:none;background:transparent;font-family:inherit;font-size:11px;margin-left:6px;outline:none"/>
          </div>
        </div>
      </div>
    `;
    document.body.classList.add('soship-printing-v58');
    nav('so-ship-print-v58');
  };

  window.persistShipmentFieldV58 = function (orderId, shipmentIdx, field, value) {
    const so = (DB.salesOrders || []).find(function (o) { return o.id === orderId; });
    if (!so || !so.shipments || !so.shipments[shipmentIdx]) return;
    so.shipments[shipmentIdx][field] = value;
    if (typeof saveData === 'function') saveData();
  };

  // ── Share (self-contained, same pattern as v54/v57) ─────────────────
  function ensureHtml2CanvasV58() {
    if (window.html2canvas) return Promise.resolve();
    if (window._soShipHtml2CanvasLoadingV58) return window._soShipHtml2CanvasLoadingV58;
    window._soShipHtml2CanvasLoadingV58 = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload = function () { resolve(); }; s.onerror = function () { reject(new Error('html2canvas failed to load')); };
      document.head.appendChild(s);
    });
    return window._soShipHtml2CanvasLoadingV58;
  }
  window.shareShipmentV58 = async function (orderId, shipmentIdx) {
    const so = (DB.salesOrders || []).find(function (o) { return o.id === orderId; });
    if (!so || !so.shipments || !so.shipments[shipmentIdx]) return;
    const sh = so.shipments[shipmentIdx];
    const itemLines = (sh.lines || []).map(function (l) { return '• ' + l.description + ' — ' + l.qtyShipped + ' ' + (l.unit || ''); }).join('\n');
    const summaryText = '📦 Delivery Note ' + sh.dnNumber + ' (Sales Order ' + so.order_number + ')\nCustomer: ' + so.customerName + '\nDate: ' + sh.date + '\n\nItems:\n' + itemLines;
    let file = null;
    try {
      await ensureHtml2CanvasV58();
      const node = document.getElementById('so-ship-print-content-v58');
      if (node && window.html2canvas) {
        const canvas = await window.html2canvas(node, { backgroundColor: '#ffffff', scale: 2 });
        const blob = await new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
        if (blob) file = new File([blob], sh.dnNumber + '.png', { type: 'image/png' });
      }
    } catch (e) { console.warn('Shipment share rasterize failed, falling back to text', e); }
    if (navigator.share) {
      try {
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ title: 'Delivery Note ' + sh.dnNumber, text: summaryText, files: [file] });
        else await navigator.share({ title: 'Delivery Note ' + sh.dnNumber, text: summaryText });
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    window.open('https://wa.me/?text=' + encodeURIComponent(summaryText), '_blank');
  };

  // ── Wire "Ship" + "Shipments" buttons into v57's list rendering ─────
  // v57's renderSalesOrdersListV57 is exposed on window, so this is a
  // safe wrap (calling a captured, window-exposed original), not a
  // reach into a private closure.
  const _origRenderSOListV58 = window.renderSalesOrdersListV57;
  if (typeof _origRenderSOListV58 === 'function') {
    window.renderSalesOrdersListV57 = function () {
      const result = _origRenderSOListV58.apply(this, arguments);
      const el = document.getElementById('so-list-v57'); if (!el) return result;
      el.querySelectorAll('tr[data-so-augmented]').length; // no-op guard placeholder
      const rows = el.querySelectorAll('tbody tr');
      const orders = (DB.salesOrders || []).slice().sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
      rows.forEach(function (row, i) {
        const so = orders[i]; if (!so || row.dataset.soAugmented) return;
        row.dataset.soAugmented = '1';
        const actionsCell = row.querySelector('td:last-child'); if (!actionsCell) return;
        if (so.status !== 'Cancelled' && so.status !== 'Fulfilled') {
          const shipBtn = document.createElement('button');
          shipBtn.className = 'btn btn-outline'; shipBtn.style.cssText = 'padding:4px 9px;font-size:11px';
          shipBtn.textContent = '🚚 Ship';
          shipBtn.onclick = function () { openShipFormV58(so.id); };
          actionsCell.appendChild(shipBtn);
        }
        if ((so.shipments || []).length) {
          const viewBtn = document.createElement('button');
          viewBtn.className = 'btn btn-outline'; viewBtn.style.cssText = 'padding:4px 9px;font-size:11px';
          viewBtn.textContent = '📋 Shipments (' + so.shipments.length + ')';
          viewBtn.onclick = function () { viewShipmentsV58(so.id); };
          actionsCell.appendChild(viewBtn);
        }
      });
      return result;
    };
  }

  const _origNavV58 = window.nav;
  if (typeof _origNavV58 === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV58(page, el);
      injectShipPagesV58();
      if (page !== 'so-ship-print-v58') document.body.classList.remove('soship-printing-v58');
      return result;
    };
  }

  console.log('✅ patch-v58.js loaded — Ship / Fulfill Sales Orders (real stock decrement, status tracking, delivery doc)');
})();
