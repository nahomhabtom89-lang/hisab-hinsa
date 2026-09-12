// ═══════════════════════════════════════════════════════════
// PATCH v55 — Delivery Note, Phase 4: Actual Drawn Signature Pad
// ═══════════════════════════════════════════════════════════
// v54 made "Delivered By" / "Received By" editable TEXT fields (typed
// name, styled in a cursive font). The user wants an actual pen-style
// signature — draw it with a mouse or finger, not type it. This patch
// fully redefines printDeliveryNoteV53() again (same reasoning as v54's
// header comment: this changes existing rendering, so it's a superset
// redefinition, not a wrap) to swap the signature area for a small
// <canvas> pad per side, plus keeps a separate "printed name" text field
// underneath (a signature alone with no name is hard to read back later
// — this matches how paper delivery notes are usually laid out too).
//
// How it works:
//   - Each canvas supports both mouse and touch drawing (works on a
//     phone/tablet screen, not just a mouse).
//   - On every stroke release, the canvas is saved as a PNG data URL
//     onto entry.deliveryNote.deliveredBySignatureImg /
//     receivedBySignatureImg and persisted via the existing saveData().
//   - Reopening a note redraws any previously-saved signature onto the
//     canvas, so it stays visually there and can still be cleared and
//     redrawn (a "Clear" button next to each pad).
//   - The printed-name fields reuse v54's persistDNSignatureV54() helper
//     and fall back to whatever was typed in v54 (deliveredBySignature /
//     receivedBySignature) if this is an older note, so nothing already
//     saved is lost — just presented as the printed-name line instead.
// ═══════════════════════════════════════════════════════════

(function () {
  function persistDNField(entryId, field, value) {
    const entry = (DB.entries || []).find(function (e) { return e.id === entryId; });
    if (!entry || !entry.deliveryNote) return;
    entry.deliveryNote[field] = value;
    if (typeof saveData === 'function') saveData();
  }
  window.persistDNSignatureV54 = persistDNField; // keep v54's helper name working for the name fields

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  // ── Signature pad ──────────────────────────────────────────────────
  window._dnSigPadsV55 = window._dnSigPadsV55 || {};

  function initSignaturePadV55(canvas, entryId, field, existingDataUrl) {
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
      persistDNField(entryId, field, canvas.toDataURL('image/png'));
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

    return {
      clear: function () { ctx.clearRect(0, 0, canvas.width, canvas.height); persistDNField(entryId, field, ''); }
    };
  }

  window.clearDNSignatureV55 = function (role, entryId) {
    const key = role + '-' + entryId;
    const pad = window._dnSigPadsV55[key];
    if (pad) pad.clear();
  };

  function signatureBlockHtml(role, entryId, label, canvasIdSuffix, printedNameVal) {
    const canvasId = 'dn-sig-canvas-' + canvasIdSuffix + '-' + entryId;
    return `<div class="dn-sig-block">
      <canvas id="${canvasId}" width="300" height="90" style="width:100%;max-width:300px;height:90px;border-bottom:1px solid #333;background:#fff;touch-action:none;cursor:crosshair;display:block"></canvas>
      <div class="no-print" style="text-align:right;margin-top:2px">
        <button type="button" onclick="clearDNSignatureV55('${role}',${entryId})" style="font-size:10px;padding:2px 9px;border:1px solid #999;background:#fff;color:#333;border-radius:3px;cursor:pointer">Clear</button>
      </div>
      <input type="text" value="${esc(printedNameVal)}" placeholder="Printed name"
        oninput="persistDNSignatureV54(${entryId},'${role === 'delivered' ? 'deliveredByName' : 'receivedByName'}',this.value)"
        style="width:100%;border:none;border-bottom:1px dotted #999;background:transparent;font-family:inherit;font-size:11px;padding:3px 2px;outline:none;margin-top:2px"/>
      <div style="font-size:11px;color:#555;margin-top:2px">${label}</div>
    </div>`;
  }

  // ── Full redefinition (same header/table logic as v54, new sig area) ──
  window.printDeliveryNoteV53 = function (entryId) {
    const entry = (DB.entries || []).find(function (e) { return e.id === entryId; });
    if (!entry || !entry.deliveryNote) { if (typeof showToast === 'function') showToast('⚠️ Delivery note not found'); return; }
    const dn = entry.deliveryNote;
    if (typeof injectDNPagesV53 === 'function') injectDNPagesV53();
    if (typeof injectShareButtonV54 === 'function') injectShareButtonV54();
    window._dnCurrentEntryIdV54 = entryId;

    const content = document.getElementById('dn-print-content-v53');
    if (!content) return;

    const STATUS_LABEL = { full: '✅ Fully Delivered', partial: '📦 Partial', pending: '🕓 Pending' };
    const linesHtml = (dn.lines || []).map(function (l) {
      return `<tr><td>${esc(l.description)}</td><td>${esc(l.sku) || '—'}</td><td>${esc(l.unit) || ''}</td><td style="text-align:center">${l.qtyOrdered}</td><td style="text-align:center">${l.qtyDelivered}</td></tr>`;
    }).join('');

    // Fall back to whatever v54 had already saved as typed "signature" text
    const deliveredNameVal = dn.deliveredByName != null ? dn.deliveredByName : (dn.deliveredBySignature || dn.driverName || '');
    const receivedNameVal = dn.receivedByName != null ? dn.receivedByName : (dn.receivedBySignature || '');
    const receivedDateVal = dn.receivedDate || '';

    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #333;padding-bottom:12px;margin-bottom:14px">
        <div><div style="font-size:20px;font-weight:700">${esc((typeof BIZ_NAME !== 'undefined' && BIZ_NAME) || 'Company')}</div></div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:700;letter-spacing:1px">DELIVERY NOTE</div>
          <div style="font-size:12px">No: <b>${esc(dn.dnNumber)}</b></div>
          <div style="font-size:12px">Date: ${esc(dn.deliveryDate)}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:20px;font-size:13px;margin-bottom:10px">
        <div><b>Reference:</b> ${esc(entry.desc)}</div>
        <div><b>Status:</b> ${STATUS_LABEL[dn.status] || esc(dn.status)}</div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:20px;font-size:13px;margin-bottom:14px">
        <div style="flex:1"><b>Customer:</b><br/>${esc(dn.customerName) || '—'}</div>
        <div style="flex:1"><b>Ship To:</b><br/>${esc(dn.shipTo || '—').replace(/\n/g, '<br/>')}</div>
      </div>
      <table><thead><tr><th>Description</th><th>SKU / Part No.</th><th>Unit</th><th>Qty Ordered</th><th>Qty Delivered</th></tr></thead><tbody>${linesHtml}</tbody></table>
      <div style="display:flex;justify-content:space-between;gap:20px;font-size:12px;margin-top:14px">
        <div><b>Driver / Carrier:</b> ${esc(dn.driverName) || '—'}${dn.carrier ? (' (' + esc(dn.carrier) + ')') : ''}</div>
        <div><b>Vehicle No:</b> ${esc(dn.vehicleNo) || '—'}</div>
        <div><b># Packages:</b> ${esc(dn.numPackages) || '—'}</div>
      </div>
      ${dn.instructions ? `<div style="font-size:12px;margin-top:8px"><b>Instructions:</b> ${esc(dn.instructions)}</div>` : ''}
      <div class="dn-sig-row" style="margin-top:40px">
        ${signatureBlockHtml('delivered', entryId, 'Delivered By (Signature)', 'delivered', deliveredNameVal)}
        ${signatureBlockHtml('received', entryId, 'Received By (Signature)', 'received', receivedNameVal)}
      </div>
      <div style="text-align:right;font-size:11px;margin-top:6px">
        Date received: <input type="date" value="${esc(receivedDateVal)}" onchange="persistDNSignatureV54(${entryId},'receivedDate',this.value)"
          style="border:none;border-bottom:1px dotted #999;background:transparent;font-family:inherit;font-size:11px;outline:none"/>
      </div>
    `;

    // Canvases only exist now that innerHTML has been set — wire them up.
    const deliveredCanvas = document.getElementById('dn-sig-canvas-delivered-' + entryId);
    const receivedCanvas = document.getElementById('dn-sig-canvas-received-' + entryId);
    if (deliveredCanvas) window._dnSigPadsV55['delivered-' + entryId] = initSignaturePadV55(deliveredCanvas, entryId, 'deliveredBySignatureImg', dn.deliveredBySignatureImg);
    if (receivedCanvas) window._dnSigPadsV55['received-' + entryId] = initSignaturePadV55(receivedCanvas, entryId, 'receivedBySignatureImg', dn.receivedBySignatureImg);

    document.body.classList.add('dn-printing-v53');
    nav('dn-print-v53');
  };

  console.log('✅ patch-v55.js loaded — Delivery Note drawn signature pad (mouse/touch)');
})();
