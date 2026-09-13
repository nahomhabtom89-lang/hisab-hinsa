// ═══════════════════════════════════════════════════════════
// PATCH v56 — Delivery Note, Phase 5: Retroactive Creation
// ═══════════════════════════════════════════════════════════
// Covers "I forgot to check the box at the time of sale." Adds a
// "+ Create for a Past Sale/Invoice" section at the top of the
// 📦 Delivery Notes page: pick any past POS Sale or Invoice that doesn't
// already have a delivery note, fill in the same shipping/driver/
// packages/instructions fields used at time-of-sale, list what was
// delivered, and tag it directly onto that entry — no lookback-search
// needed here since we already know exactly which entry to tag (unlike
// v52's tagLastEntryWithDeliveryNoteV52, which has to guess at
// creation time).
//
// SCOPE NOTE: for an old POS Sale, the original cart's line items are
// NOT recoverable from client-side data — DB.entries only stores the
// sale's total/desc/accounts, not its items; the item-level detail was
// sent to the backend's separate POS-sale-items log (dbApi
// action:'savePOSSale') and was never loaded back into the client. Pulling
// it back would mean adding a new backend read action — real scope
// creep for a "let me fix a forgotten note" feature. So retroactive
// notes use the same manual line-entry approach already used for
// construction Invoices in v52, for BOTH sale types. This is stated up
// front rather than silently guessing/fabricating item data.
//
// Self-contained on purpose: does not reach into v52/v53/v54/v55's
// private closures for anything (that exact mistake broke the Share
// button when v55 shipped) — only relies on things those patches
// explicitly exposed on window (DB, saveData, nav, showToast — all
// already global from index.html itself), plus its own local copies of
// the numbering/status logic.
// ═══════════════════════════════════════════════════════════

(function () {
  function todayStr() { return (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  function nextDNNumberV56() {
    let max = 0;
    (DB.entries || []).forEach(function (e) {
      const dn = e && e.deliveryNote;
      if (dn && dn.dnNumber) {
        const m = /^DN-(\d+)$/.exec(dn.dnNumber);
        if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
      }
    });
    return 'DN-' + String(max + 1).padStart(4, '0');
  }

  function computeDNStatusV56(lines) {
    if (!lines || !lines.length) return 'full';
    let totalDel = 0, anyShort = false;
    lines.forEach(function (l) {
      const ord = parseFloat(l.qtyOrdered) || 0, del = parseFloat(l.qtyDelivered) || 0;
      totalDel += del;
      if (del < ord) anyShort = true;
    });
    if (totalDel <= 0) return 'pending';
    if (anyShort) return 'partial';
    return 'full';
  }

  function eligiblePastEntriesV56() {
    return (DB.entries || []).filter(function (e) {
      return e && !e.deliveryNote && (e.type === 'POS Sale' || e.type === 'Invoice');
    }).sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
  }

  // ── Retro line-item builder (same look as v52's construction rows) ───
  let _dnRetroLineSeq = 0;
  window.addDNRetroLineV56 = function () {
    const wrap = document.getElementById('dn-retro-lines'); if (!wrap) return;
    const id = 'dnrl-' + (_dnRetroLineSeq++);
    const row = document.createElement('div');
    row.className = 'dn-retro-line-row';
    row.dataset.lineId = id;
    row.style.cssText = 'display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr auto;gap:6px;margin-bottom:5px;align-items:center';
    row.innerHTML = `
      <input class="dn-retro-line-desc" type="text" placeholder="Item description" style="background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <input class="dn-retro-line-sku" type="text" placeholder="SKU / part no." style="background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <input class="dn-retro-line-unit" type="text" placeholder="unit" style="background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <input class="dn-retro-line-qord" type="number" placeholder="Qty Ordered" min="0" style="background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <input class="dn-retro-line-qdel" type="number" placeholder="Qty Delivered" min="0" style="background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <button type="button" onclick="this.closest('.dn-retro-line-row').remove()" style="padding:6px 9px;background:transparent;border:1px solid rgba(192,48,42,.3);border-radius:5px;color:var(--red3);cursor:pointer;font-size:12px">✕</button>
    `;
    wrap.appendChild(row);
  };

  function resetRetroFormV56() {
    ['dn-retro-shipto', 'dn-retro-driver', 'dn-retro-vehicle', 'dn-retro-carrier', 'dn-retro-packages', 'dn-retro-notes'].forEach(function (id) { const el = document.getElementById(id); if (el) el.value = ''; });
    const dateEl = document.getElementById('dn-retro-date'); if (dateEl) dateEl.value = todayStr();
    const linesEl = document.getElementById('dn-retro-lines'); if (linesEl) linesEl.innerHTML = '';
    const sel = document.getElementById('dn-retro-entry-select'); if (sel) sel.value = '';
    const panel = document.getElementById('dn-retro-panel'); if (panel) panel.style.display = 'none';
  }

  window.createRetroactiveDeliveryNoteV56 = function () {
    const sel = document.getElementById('dn-retro-entry-select');
    const entryId = sel ? parseInt(sel.value, 10) : NaN;
    if (!entryId) { if (typeof showToast === 'function') showToast('⚠️ Pick which sale/invoice this delivery note is for'); return; }
    const entry = (DB.entries || []).find(function (e) { return e.id === entryId; });
    if (!entry) { if (typeof showToast === 'function') showToast('⚠️ That entry could not be found'); return; }
    if (entry.deliveryNote) { if (typeof showToast === 'function') showToast('⚠️ That one already has a delivery note'); return; }

    const val = function (id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const rows = document.querySelectorAll('#dn-retro-lines .dn-retro-line-row');
    let lines = [];
    rows.forEach(function (row) {
      const desc = (row.querySelector('.dn-retro-line-desc') || {}).value || '';
      const sku = (row.querySelector('.dn-retro-line-sku') || {}).value || '';
      const unit = (row.querySelector('.dn-retro-line-unit') || {}).value || '';
      const qOrd = parseFloat((row.querySelector('.dn-retro-line-qord') || {}).value) || 0;
      const qDelRaw = (row.querySelector('.dn-retro-line-qdel') || {}).value;
      const qDel = qDelRaw === '' ? qOrd : Math.max(0, parseFloat(qDelRaw) || 0);
      if (desc.trim() && qOrd > 0) lines.push({ description: desc.trim(), sku: sku.trim(), unit: unit.trim() || 'unit', qtyOrdered: qOrd, qtyDelivered: qDel });
    });
    if (!lines.length) { if (typeof showToast === 'function') showToast('⚠️ Add at least one line item'); return; }

    const custName = entry.party && entry.party.name ? entry.party.name : '';
    const deliveryDate = val('dn-retro-date') || todayStr();

    entry.deliveryNote = {
      dnNumber: nextDNNumberV56(),
      refType: entry.type === 'POS Sale' ? 'pos' : 'construction_invoice',
      customerName: custName,
      shipTo: val('dn-retro-shipto'),
      driverName: val('dn-retro-driver'),
      vehicleNo: val('dn-retro-vehicle'),
      carrier: val('dn-retro-carrier'),
      numPackages: val('dn-retro-packages'),
      instructions: val('dn-retro-notes'),
      lines: lines,
      status: computeDNStatusV56(lines),
      deliveryDate: deliveryDate,
      createdAt: todayStr(),
      createdRetroactively: true
    };
    if (typeof saveData === 'function') saveData();
    if (typeof showToast === 'function') showToast('✅ Delivery Note ' + entry.deliveryNote.dnNumber + ' created');
    resetRetroFormV56();
    if (typeof renderDeliveryNotesListV53 === 'function') renderDeliveryNotesListV53();
    else if (typeof nav === 'function') nav('deliverynotes'); // fallback: re-nav to force a refresh
  };

  window.toggleDNRetroPanelV56 = function () {
    const panel = document.getElementById('dn-retro-panel');
    if (!panel) return;
    const opening = panel.style.display !== 'block';
    if (opening) {
      const sel = document.getElementById('dn-retro-entry-select');
      if (sel) {
        const entries = eligiblePastEntriesV56();
        sel.innerHTML = '<option value="">— Select a past sale or invoice —</option>' + entries.map(function (e) {
          return `<option value="${e.id}">${esc(e.date)} — ${esc(e.desc)}</option>`;
        }).join('');
      }
      const dateEl = document.getElementById('dn-retro-date'); if (dateEl && !dateEl.value) dateEl.value = todayStr();
    }
    panel.style.display = opening ? 'block' : 'none';
  };

  function injectRetroSectionV56() {
    if (document.getElementById('dn-retro-toggle-btn')) return;
    const list = document.getElementById('dn-list-v53'); if (!list) return;
    const card = list.closest('.card'); if (!card) return;
    const html = `<div id="dn-retro-section" style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px dashed var(--border2)">
      <button id="dn-retro-toggle-btn" type="button" class="btn btn-outline" onclick="toggleDNRetroPanelV56()">+ Create for a Past Sale / Invoice (forgot at the time?)</button>
      <div id="dn-retro-panel" style="display:none;margin-top:10px;padding:10px;background:var(--bg3);border-radius:6px">
        <div class="fg" style="margin-bottom:6px">
          <label style="font-size:10px">Which sale or invoice was this delivery for?</label>
          <select id="dn-retro-entry-select" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"></select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <div class="fg" style="margin:0"><label style="font-size:10px">Actual Delivery Date</label><input id="dn-retro-date" type="date" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Shipping / Delivery Address</label><input id="dn-retro-shipto" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">
          <div class="fg" style="margin:0"><label style="font-size:10px">Driver / Carrier Name</label><input id="dn-retro-driver" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Vehicle No.</label><input id="dn-retro-vehicle" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Carrier / Company</label><input id="dn-retro-carrier" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px"># Packages / Boxes</label><input id="dn-retro-packages" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
        </div>
        <div class="fg" style="margin:6px 0"><label style="font-size:10px">Special Delivery Instructions</label><input id="dn-retro-notes" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
        <div style="font-size:10px;color:var(--text3);margin:8px 0 4px">What was delivered (the original cart/invoice items aren't recoverable after the fact, so list them here):</div>
        <div id="dn-retro-lines"></div>
        <button type="button" class="btn btn-outline" style="padding:5px 10px;font-size:11px;margin-bottom:8px" onclick="addDNRetroLineV56()">+ Add Line</button>
        <div>
          <button type="button" class="btn btn-gold" onclick="createRetroactiveDeliveryNoteV56()">✅ Create Delivery Note</button>
          <button type="button" class="btn btn-outline" onclick="toggleDNRetroPanelV56()">Cancel</button>
        </div>
      </div>
    </div>`;
    card.insertAdjacentHTML('afterbegin', html);
  }

  const _origNavV56 = window.nav;
  if (typeof _origNavV56 === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV56(page, el);
      if (page === 'deliverynotes') injectRetroSectionV56();
      return result;
    };
  }

  console.log('✅ patch-v56.js loaded — retroactive Delivery Note creation for past sales/invoices');
})();
