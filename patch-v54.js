// ═══════════════════════════════════════════════════════════
// PATCH v54 — Delivery Note, Phase 3: SKU column, digital
// signatures, and Share (WhatsApp / native share sheet)
// ═══════════════════════════════════════════════════════════
// Builds on v52 (capture — now also captures item.sku) and v53 (list +
// print skeleton). This patch fully redefines printDeliveryNoteV53()
// (a superset redefinition, not a wrap, since it changes the existing
// print layout rather than adding independent behavior alongside it —
// same pattern this project already uses for functions like
// recordSupplierPayment).
//
// What's new on the print view:
//   - An extra SKU / Part No. column in the item table.
//   - "Delivered By" / "Received By" are now editable text fields (not
//     static blank lines) — type a name to sign, it's saved onto
//     entry.deliveryNote immediately (oninput -> saveData()), and it
//     stays editable if you reopen the note later. A cursive font gives
//     it a signature look without needing a drawing pad.
//   - A "📤 Share" button next to Print/Back. It rasterizes the note to
//     a PNG (via html2canvas, loaded on demand from cdnjs — nothing
//     added to index.html itself) and hands it to the device's native
//     share sheet (navigator.share), which is what actually lets you
//     pick WhatsApp, Instagram, Email, etc. — there's no single API that
//     targets one specific app. On desktop browsers that don't support
//     file sharing, it falls back to opening a WhatsApp Web chat with a
//     prefilled text summary of the note.
// ═══════════════════════════════════════════════════════════

(function () {
  function persistDNField(entryId, field, value) {
    const entry = (DB.entries || []).find(function (e) { return e.id === entryId; });
    if (!entry || !entry.deliveryNote) return;
    entry.deliveryNote[field] = value;
    if (typeof saveData === 'function') saveData();
  }
  window.persistDNSignatureV54 = persistDNField;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  function injectShareButtonV54() {
    const headerRow = document.querySelector('#pg-dn-print-v53 .no-print');
    if (!headerRow || document.getElementById('dn-share-btn-v54')) return;
    const btn = document.createElement('button');
    btn.id = 'dn-share-btn-v54';
    btn.className = 'btn btn-outline';
    btn.textContent = '📤 Share';
    btn.onclick = function () { if (window._dnCurrentEntryIdV54 != null) shareDeliveryNoteV54(window._dnCurrentEntryIdV54); };
    headerRow.appendChild(btn);
  }

  // ── Full redefinition — see file header for why this isn't a wrap ────
  window.printDeliveryNoteV53 = function (entryId) {
    const entry = (DB.entries || []).find(function (e) { return e.id === entryId; });
    if (!entry || !entry.deliveryNote) { if (typeof showToast === 'function') showToast('⚠️ Delivery note not found'); return; }
    const dn = entry.deliveryNote;
    if (typeof injectDNPagesV53 === 'function') injectDNPagesV53();
    injectShareButtonV54();
    window._dnCurrentEntryIdV54 = entryId;

    const content = document.getElementById('dn-print-content-v53');
    if (!content) return;

    const STATUS_LABEL = { full: '✅ Fully Delivered', partial: '📦 Partial', pending: '🕓 Pending' };
    const linesHtml = (dn.lines || []).map(function (l) {
      return `<tr><td>${esc(l.description)}</td><td>${esc(l.sku) || '—'}</td><td>${esc(l.unit) || ''}</td><td style="text-align:center">${l.qtyOrdered}</td><td style="text-align:center">${l.qtyDelivered}</td></tr>`;
    }).join('');

    const deliveredByVal = dn.deliveredBySignature != null ? dn.deliveredBySignature : (dn.driverName || '');
    const receivedByVal = dn.receivedBySignature || '';
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
      <div class="dn-sig-row">
        <div class="dn-sig-block">
          <input type="text" value="${esc(deliveredByVal)}" placeholder="Type name to sign"
            oninput="persistDNSignatureV54(${entryId},'deliveredBySignature',this.value)"
            style="width:100%;border:none;border-bottom:1px solid #333;background:transparent;font-family:'Brush Script MT',cursive;font-size:17px;padding:2px 2px 4px;outline:none"/>
          <div style="font-size:11px;color:#555;margin-top:3px">Delivered By (Name / Signature)</div>
        </div>
        <div class="dn-sig-block">
          <input type="text" value="${esc(receivedByVal)}" placeholder="Type name to sign"
            oninput="persistDNSignatureV54(${entryId},'receivedBySignature',this.value)"
            style="width:100%;border:none;border-bottom:1px solid #333;background:transparent;font-family:'Brush Script MT',cursive;font-size:17px;padding:2px 2px 4px;outline:none"/>
          <div style="font-size:11px;color:#555;margin-top:3px">Received By (Name / Signature)
            <input type="date" value="${esc(receivedDateVal)}" onchange="persistDNSignatureV54(${entryId},'receivedDate',this.value)"
              style="border:none;background:transparent;font-family:inherit;font-size:11px;margin-left:6px;outline:none"/>
          </div>
        </div>
      </div>
    `;
    document.body.classList.add('dn-printing-v53');
    nav('dn-print-v53');
  };

  // ── Share ──────────────────────────────────────────────────────────
  function ensureHtml2CanvasV54() {
    if (window.html2canvas) return Promise.resolve();
    if (window._dnHtml2CanvasLoadingV54) return window._dnHtml2CanvasLoadingV54;
    window._dnHtml2CanvasLoadingV54 = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('html2canvas failed to load')); };
      document.head.appendChild(s);
    });
    return window._dnHtml2CanvasLoadingV54;
  }

  window.shareDeliveryNoteV54 = async function (entryId) {
    const entry = (DB.entries || []).find(function (e) { return e.id === entryId; });
    if (!entry || !entry.deliveryNote) { if (typeof showToast === 'function') showToast('⚠️ Delivery note not found'); return; }
    const dn = entry.deliveryNote;
    const itemLines = (dn.lines || []).map(function (l) {
      return '• ' + l.description + (l.sku ? ' (' + l.sku + ')' : '') + ' — ' + l.qtyDelivered + '/' + l.qtyOrdered + ' ' + (l.unit || '');
    }).join('\n');
    const summaryText = '📦 Delivery Note ' + dn.dnNumber + '\n' +
      'Date: ' + (dn.deliveryDate || '') + '\n' +
      'Customer: ' + (dn.customerName || '—') + '\n' +
      'Ship To: ' + (dn.shipTo || '—') + '\n\n' +
      'Items:\n' + itemLines + '\n\n' +
      'Driver: ' + (dn.driverName || '—') + '   Vehicle: ' + (dn.vehicleNo || '—') + '\n' +
      'Status: ' + (dn.status || '');

    let file = null;
    try {
      await ensureHtml2CanvasV54();
      const node = document.getElementById('dn-print-content-v53');
      if (node && window.html2canvas) {
        const canvas = await window.html2canvas(node, { backgroundColor: '#ffffff', scale: 2 });
        const blob = await new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
        if (blob) file = new File([blob], dn.dnNumber + '.png', { type: 'image/png' });
      }
    } catch (e) {
      console.warn('Delivery Note share: image rasterize failed, falling back to text-only share', e);
    }

    if (navigator.share) {
      try {
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ title: 'Delivery Note ' + dn.dnNumber, text: summaryText, files: [file] });
        } else {
          await navigator.share({ title: 'Delivery Note ' + dn.dnNumber, text: summaryText });
        }
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // user cancelled the share sheet — not an error
        console.warn('Delivery Note share: navigator.share failed, falling back to WhatsApp link', e);
      }
    }
    // Fallback for browsers with no native share sheet (mainly desktop):
    // text-only, since a wa.me link can't carry an attached image.
    window.open('https://wa.me/?text=' + encodeURIComponent(summaryText), '_blank');
  };

  console.log('✅ patch-v54.js loaded — Delivery Note SKU column, editable digital signatures, Share');
})();
