// ═══════════════════════════════════════════════════════════
// PATCH v53 — Delivery Note, Phase 2: List Page + Formal Print View
// ═══════════════════════════════════════════════════════════
// Builds on patch-v52 (which tags entry.deliveryNote onto POS Sales and
// construction Invoices when the toggle is checked). This patch adds:
//   1. A "📦 Delivery Notes" sidebar page listing every tagged entry
//      (both modes), each with a Print button.
//   2. A formal, print-ready Delivery Note layout — company header, DN
//      number, reference back to the originating sale/invoice, ship-to
//      address, an itemized Qty Ordered / Qty Delivered table, driver/
//      vehicle/packages/instructions, and blank "Delivered By" /
//      "Received By" signature lines for physical sign-off on delivery.
//      No pricing is shown — that's standard for a delivery/packing
//      note; the customer's copy of the Invoice/receipt already has it.
//
// PRINTING NOTE: the base app's existing @media print rule forces every
// .page element to display:block at once (so printing normally prints
// the whole app stacked, not just the current screen — a pre-existing
// quirk, not something this patch changes elsewhere). To get a clean,
// single-document printout here, this patch adds a body.dn-printing-v53
// class + its own @media print override, injected via a <style> tag
// appended after the page's original stylesheet — for equal-specificity
// !important rules, the later one in the cascade wins, so this override
// takes effect without touching the original CSS at all.
// ═══════════════════════════════════════════════════════════

(function () {
  function injectDNPagesV53() {
    if (document.getElementById('pg-deliverynotes')) return;
    const main = document.querySelector('.main'); if (!main) return;

    const listPage = document.createElement('div');
    listPage.className = 'page'; listPage.id = 'pg-deliverynotes';
    listPage.innerHTML = `<div class="ph"><h1>📦 Delivery Notes</h1></div>
      <div class="card"><div id="dn-list-v53"></div></div>`;
    main.appendChild(listPage);

    const printPage = document.createElement('div');
    printPage.className = 'page'; printPage.id = 'pg-dn-print-v53';
    printPage.innerHTML = `<div class="no-print" style="margin-bottom:14px;display:flex;gap:8px">
        <button class="btn btn-outline" onclick="nav('deliverynotes')">← Back</button>
        <button class="btn btn-gold" onclick="window.print()">🖨️ Print</button>
      </div>
      <div id="dn-print-content-v53" style="background:#fff;color:#111;padding:28px;max-width:760px;margin:0 auto;font-family:Arial,sans-serif;border-radius:4px"></div>`;
    main.appendChild(printPage);
  }

  const _dnPrintStyleV53 = document.createElement('style');
  _dnPrintStyleV53.textContent = `
    @media print{
      body.dn-printing-v53 .page{display:none!important}
      body.dn-printing-v53 #pg-dn-print-v53{display:block!important}
    }
    #dn-print-content-v53 table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px}
    #dn-print-content-v53 th,#dn-print-content-v53 td{border:1px solid #999;padding:6px 8px;text-align:left}
    #dn-print-content-v53 .dn-sig-row{display:flex;justify-content:space-between;margin-top:50px;gap:30px}
    #dn-print-content-v53 .dn-sig-block{flex:1;font-size:12px}
    #dn-print-content-v53 .dn-sig-line{border-top:1px solid #333;margin-top:40px;padding-top:4px}
  `;
  document.head.appendChild(_dnPrintStyleV53);

  function allDeliveryNoteEntriesV53() {
    return (DB.entries || []).filter(function (e) { return e && e.deliveryNote; }).sort(function (a, b) {
      const na = parseInt((a.deliveryNote.dnNumber || 'DN-0').split('-')[1], 10) || 0;
      const nb = parseInt((b.deliveryNote.dnNumber || 'DN-0').split('-')[1], 10) || 0;
      return nb - na;
    });
  }

  const DN_STATUS_LABEL_V53 = { full: '✅ Fully Delivered', partial: '📦 Partial', pending: '🕓 Pending' };
  const DN_STATUS_TAG_V53 = { full: 't-green', partial: 't-gold', pending: 't-orange' };

  function renderDeliveryNotesListV53() {
    const el = document.getElementById('dn-list-v53'); if (!el) return;
    const entries = allDeliveryNoteEntriesV53();
    if (!entries.length) { el.innerHTML = '<div style="text-align:center;padding:22px;color:var(--text3)">No delivery notes yet — check "Generate Delivery Note" on a Sale or Invoice to create one</div>'; return; }
    el.innerHTML = `<table><thead><tr><th>DN #</th><th>Date</th><th>Type</th><th>Customer</th><th>Status</th><th></th></tr></thead><tbody>${
      entries.map(function (e) {
        const dn = e.deliveryNote;
        const typeLabel = dn.refType === 'pos' ? '🛒 POS Sale' : '🧾 Invoice';
        const status = dn.status || 'full';
        return `<tr><td style="font-family:'JetBrains Mono',monospace">${dn.dnNumber}</td><td style="font-family:'JetBrains Mono',monospace;font-size:11px">${dn.deliveryDate || ''}</td><td>${typeLabel}</td><td>${dn.customerName || '—'}</td><td><span class="tag ${DN_STATUS_TAG_V53[status] || 't-blue'}" style="font-size:9px">${DN_STATUS_LABEL_V53[status] || status}</span></td><td><button class="btn btn-outline" style="padding:4px 10px;font-size:11px" onclick="printDeliveryNoteV53(${e.id})">🖨️ Print</button></td></tr>`;
      }).join('')
    }</tbody></table>`;
  }

  window.printDeliveryNoteV53 = function (entryId) {
    const entry = (DB.entries || []).find(function (e) { return e.id === entryId; });
    if (!entry || !entry.deliveryNote) { if (typeof showToast === 'function') showToast('⚠️ Delivery note not found'); return; }
    const dn = entry.deliveryNote;
    injectDNPagesV53();
    const content = document.getElementById('dn-print-content-v53');
    const linesHtml = (dn.lines || []).map(function (l) {
      return `<tr><td>${l.description}</td><td>${l.unit || ''}</td><td style="text-align:center">${l.qtyOrdered}</td><td style="text-align:center">${l.qtyDelivered}</td></tr>`;
    }).join('');
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #333;padding-bottom:12px;margin-bottom:14px">
        <div><div style="font-size:20px;font-weight:700">${(typeof BIZ_NAME !== 'undefined' && BIZ_NAME) || 'Company'}</div></div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:700;letter-spacing:1px">DELIVERY NOTE</div>
          <div style="font-size:12px">No: <b>${dn.dnNumber}</b></div>
          <div style="font-size:12px">Date: ${dn.deliveryDate || ''}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:20px;font-size:13px;margin-bottom:10px">
        <div><b>Reference:</b> ${entry.desc || ''}</div>
        <div><b>Status:</b> ${DN_STATUS_LABEL_V53[dn.status] || dn.status}</div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:20px;font-size:13px;margin-bottom:14px">
        <div style="flex:1"><b>Customer:</b><br/>${dn.customerName || '—'}</div>
        <div style="flex:1"><b>Ship To:</b><br/>${(dn.shipTo || '—').replace(/\n/g, '<br/>')}</div>
      </div>
      <table><thead><tr><th>Description</th><th>Unit</th><th>Qty Ordered</th><th>Qty Delivered</th></tr></thead><tbody>${linesHtml}</tbody></table>
      <div style="display:flex;justify-content:space-between;gap:20px;font-size:12px;margin-top:14px">
        <div><b>Driver / Carrier:</b> ${dn.driverName || '—'}${dn.carrier ? (' (' + dn.carrier + ')') : ''}</div>
        <div><b>Vehicle No:</b> ${dn.vehicleNo || '—'}</div>
        <div><b># Packages:</b> ${dn.numPackages || '—'}</div>
      </div>
      ${dn.instructions ? `<div style="font-size:12px;margin-top:8px"><b>Instructions:</b> ${dn.instructions}</div>` : ''}
      <div class="dn-sig-row">
        <div class="dn-sig-block"><div class="dn-sig-line">Delivered By (Name &amp; Signature)${dn.driverName ? ' — ' + dn.driverName : ''}</div></div>
        <div class="dn-sig-block"><div class="dn-sig-line">Received By (Name, Signature &amp; Date)</div></div>
      </div>
    `;
    document.body.classList.add('dn-printing-v53');
    nav('dn-print-v53');
  };

  // ── Sidebar entry (both modes) ────────────────────────────────────────
  if (typeof RETAIL_NAV !== 'undefined' && !RETAIL_NAV.some(function (s) { return s.section === '📦 Delivery'; })) {
    RETAIL_NAV.push({ section: '📦 Delivery', items: [{ ico: '📦', ti: 'Delivery Notes', en: 'Delivery', page: 'deliverynotes' }] });
  }
  if (typeof CONSTRUCTION_NAV !== 'undefined' && !CONSTRUCTION_NAV.some(function (s) { return s.section === '📦 Delivery'; })) {
    CONSTRUCTION_NAV.push({ section: '📦 Delivery', items: [{ ico: '📦', ti: 'Delivery Notes', en: 'Delivery', page: 'deliverynotes' }] });
  }

  // ── Hook everything up via nav() ──────────────────────────────────────
  const _origNavV53 = window.nav;
  if (typeof _origNavV53 === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV53(page, el);
      injectDNPagesV53();
      if (page === 'deliverynotes') renderDeliveryNotesListV53();
      if (page !== 'dn-print-v53') document.body.classList.remove('dn-printing-v53');
      return result;
    };
  }

  injectDNPagesV53();

  console.log('✅ patch-v53.js loaded — Delivery Notes list page + formal print view');
})();
