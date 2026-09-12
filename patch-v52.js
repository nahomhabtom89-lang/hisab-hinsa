// ═══════════════════════════════════════════════════════════
// PATCH v52 — Delivery Note, Phase 1: Embedded Toggle + Capture
// ═══════════════════════════════════════════════════════════
// Adds a "📦 Generate Delivery Note for this Sale/Invoice" checkbox
// directly inside the existing POS Register and Invoice screens — no
// separate page, nothing typed twice. Checking it reveals a small panel
// (shipping address, driver, vehicle, packages, instructions) and tags
// the resulting journal entry with entry.deliveryNote = {...}, the same
// riding-on-the-entry design already used for entry.fx (v15+) and
// entry.terms (v35). No backend change needed — DB.entries is already
// saved wholesale by saveData(), so extra properties on an entry persist
// automatically.
//
// IMPORTANT SCOPE NOTE — read before changing anything here:
// The construction Invoice screen (postInvoice) has NO line items at
// all — it's a gross-amount + %-complete + retention billing screen,
// not an itemized one. So unlike POS (which has real cart lines with
// real quantities), a construction delivery note has nothing to pull
// item/quantity data FROM. This patch adds a small manual line-item
// builder (same look as the existing Purchase-Order line builder) inside
// the same toggle panel, so it's still one form — the user just has to
// type what's being delivered because the underlying invoice doesn't
// carry that data anywhere.
//
// Customers currently have no saved address field in this app, so
// "ship to" is a blank field the user fills in each time — it does NOT
// auto-fill from a customer record (there's nothing to fill from yet).
//
// Data shape tagged onto the entry:
//   entry.deliveryNote = {
//     dnNumber: 'DN-0007',            // sequential, derived by scanning
//                                      // existing tagged entries — no
//                                      // separate counter needed
//     refType: 'pos' | 'construction_invoice',
//     customerName, shipTo, driverName, vehicleNo, carrier,
//     numPackages, instructions,
//     deliveryDate, createdAt,
//     status: 'full' | 'partial' | 'pending',
//     lines: [{ description, unit, qtyOrdered, qtyDelivered }]
//   }
//
// Verified with a standalone Node.js simulation before shipping:
//   - numbering increments correctly and skips already-tagged entries
//   - the POS "last entry" trap (a trailing COGS entry pushed right
//     after the sale) is handled via lookback-search, same pattern as
//     v35/v42 — the literal last entry is never assumed
//   - an aborted sale/invoice (nothing actually pushed to DB.entries)
//     is NOT retroactively tagged onto some older, unrelated entry
// ═══════════════════════════════════════════════════════════

(function () {
  function todayStr() { return (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10); }

  // POS_CART is declared with `let` in index.html (not `var`), so it NEVER
  // attaches to window — window.POS_CART is always undefined regardless of
  // the real cart contents. This bit v52 exactly like the RETAIL_NAV bug in
  // v53: `(window.POS_CART || [])` silently evaluated to [] every time,
  // which is why delivery notes shipped with zero line items even though
  // the sale itself clearly had real items in it. Fix: resolve via
  // window[name] first, falling back to an eval'd bare-identifier lookup
  // in this script's own scope (classic <script> tags share one global
  // lexical environment) — same pattern used to fix the sidebar bug.
  function _dnResolveGlobalV52(name) {
    if (typeof window[name] !== 'undefined') return window[name];
    try { return eval(name); } catch (e) { return undefined; }
  }
  function _dnGetPOSCartV52() {
    const c = _dnResolveGlobalV52('POS_CART');
    return Array.isArray(c) ? c : [];
  }

  // ── Numbering — derived by scanning, no new persisted counter needed ──
  function nextDNNumberV52() {
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
  window.nextDNNumberV52 = nextDNNumberV52;

  function computeDNStatusV52(lines) {
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
  window.computeDNStatusV52 = computeDNStatusV52;

  // ── Lookback tagging (Lesson 1 — never assume the literal last entry) ──
  // Only called when the caller has already confirmed a NEW entry was
  // actually pushed (DB.entries.length grew) — otherwise an aborted sale
  // or invoice would wrongly stamp a delivery note onto some older,
  // unrelated entry that happens to be the most recent untagged one.
  function tagLastEntryWithDeliveryNoteV52(entryTypeFilter, dnPartial) {
    if (!dnPartial) return;
    if (!DB || !DB.entries || !DB.entries.length) return;
    const maxLookback = 5;
    for (let i = DB.entries.length - 1, count = 0; i >= 0 && count < maxLookback; i--, count++) {
      const entry = DB.entries[i];
      if (!entry || entry.deliveryNote) continue;
      if (entry.type !== entryTypeFilter) continue;
      entry.deliveryNote = Object.assign({
        dnNumber: nextDNNumberV52(),
        createdAt: todayStr(),
        deliveryDate: todayStr(),
        status: computeDNStatusV52(dnPartial.lines)
      }, dnPartial);
      if (typeof saveData === 'function') saveData();
      return;
    }
  }
  window.tagLastEntryWithDeliveryNoteV52 = tagLastEntryWithDeliveryNoteV52;

  // ── POS panel ──────────────────────────────────────────────────────
  function renderDNPartialLinesPOSV52() {
    const wrap = document.getElementById('dn-pos-lines'); if (!wrap) return;
    const cart = _dnGetPOSCartV52();
    if (!cart.length) { wrap.innerHTML = '<div style="font-size:11px;color:var(--text3)">Cart is empty</div>'; return; }
    wrap.innerHTML = cart.map(function (item) {
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;font-size:11px">
        <span style="flex:1">${item.name} <span style="color:var(--text3)">(ordered ${item.qty})</span></span>
        <input id="dn-pos-qtydel-${item.id}" type="number" min="0" step="1" value="${item.qty}" style="width:60px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;padding:3px 6px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text);outline:none;text-align:center"/>
      </div>`;
    }).join('');
  }

  window.toggleDNPanelPOS = function () {
    const toggle = document.getElementById('dn-pos-toggle');
    const panel = document.getElementById('dn-pos-panel');
    if (panel) panel.style.display = (toggle && toggle.checked) ? 'block' : 'none';
  };
  window.toggleDNPartialPOS = function () {
    const on = (document.getElementById('dn-pos-partial-toggle') || {}).checked;
    const wrap = document.getElementById('dn-pos-lines');
    if (!wrap) return;
    wrap.style.display = on ? 'block' : 'none';
    if (on) renderDNPartialLinesPOSV52();
  };

  function injectPOSDeliveryNotePanelV52() {
    if (document.getElementById('dn-pos-toggle')) return;
    const btn = document.querySelector('[onclick="completeSale()"]');
    if (!btn) return;
    const html = `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border2)">
      <label style="display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text2);cursor:pointer">
        <input id="dn-pos-toggle" type="checkbox" onchange="toggleDNPanelPOS()"/> 📦 Generate Delivery Note for this Sale
      </label>
      <div id="dn-pos-panel" style="display:none;margin-top:8px;padding:10px;background:var(--bg3);border-radius:6px">
        <div class="fg" style="margin-bottom:6px"><label style="font-size:10px">Shipping / Delivery Address</label>
          <textarea id="dn-pos-shipto" rows="2" placeholder="Type the delivery address" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none;resize:vertical"></textarea></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <div class="fg" style="margin:0"><label style="font-size:10px">Driver / Carrier Name</label><input id="dn-pos-driver" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Vehicle No.</label><input id="dn-pos-vehicle" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Carrier / Company</label><input id="dn-pos-carrier" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px"># Packages / Boxes</label><input id="dn-pos-packages" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
        </div>
        <div class="fg" style="margin:6px 0"><label style="font-size:10px">Special Delivery Instructions</label><input id="dn-pos-notes" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
        <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text3);cursor:pointer">
          <input id="dn-pos-partial-toggle" type="checkbox" onchange="toggleDNPartialPOS()"/> This is a partial delivery (not everything shipping in full)
        </label>
        <div id="dn-pos-lines" style="display:none;margin-top:6px"></div>
      </div>
    </div>`;
    btn.insertAdjacentHTML('beforebegin', html);
  }

  function readPOSDeliveryNoteDataV52(cartSnapshot) {
    const toggle = document.getElementById('dn-pos-toggle');
    if (!toggle || !toggle.checked) return null;
    const val = function (id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const partialOn = (document.getElementById('dn-pos-partial-toggle') || {}).checked;
    const lines = (cartSnapshot || []).map(function (item) {
      const qOrd = parseFloat(item.qty) || 0;
      let qDel = qOrd;
      if (partialOn) {
        const inp = document.getElementById('dn-pos-qtydel-' + item.id);
        if (inp && inp.value !== '') qDel = Math.max(0, parseFloat(inp.value) || 0);
      }
      return { description: item.name, sku: item.sku || '', unit: item.unit || 'unit', qtyOrdered: qOrd, qtyDelivered: qDel };
    });
    return {
      refType: 'pos', shipTo: val('dn-pos-shipto'), driverName: val('dn-pos-driver'),
      vehicleNo: val('dn-pos-vehicle'), carrier: val('dn-pos-carrier'),
      numPackages: val('dn-pos-packages'), instructions: val('dn-pos-notes'), lines: lines
    };
  }

  function resetPOSDeliveryNotePanelV52() {
    const toggle = document.getElementById('dn-pos-toggle'); if (toggle) toggle.checked = false;
    const partial = document.getElementById('dn-pos-partial-toggle'); if (partial) partial.checked = false;
    ['dn-pos-shipto', 'dn-pos-driver', 'dn-pos-vehicle', 'dn-pos-carrier', 'dn-pos-packages', 'dn-pos-notes'].forEach(function (id) { const el = document.getElementById(id); if (el) el.value = ''; });
    const panel = document.getElementById('dn-pos-panel'); if (panel) panel.style.display = 'none';
    const linesWrap = document.getElementById('dn-pos-lines'); if (linesWrap) { linesWrap.style.display = 'none'; linesWrap.innerHTML = ''; }
  }

  // ── Construction Invoice panel ───────────────────────────────────────
  let _dnInvLineSeq = 0;
  window.addDNInvLineV52 = function () {
    const wrap = document.getElementById('dn-inv-lines'); if (!wrap) return;
    const id = 'dnil-' + (_dnInvLineSeq++);
    const row = document.createElement('div');
    row.className = 'dn-inv-line-row';
    row.dataset.lineId = id;
    row.style.cssText = 'display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr auto;gap:6px;margin-bottom:5px;align-items:center';
    row.innerHTML = `
      <input class="dn-inv-line-desc" type="text" placeholder="Item / material description" style="background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <input class="dn-inv-line-sku" type="text" placeholder="SKU / part no." style="background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <input class="dn-inv-line-unit" type="text" placeholder="unit (bags, m³...)" style="background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <input class="dn-inv-line-qord" type="number" placeholder="Qty Ordered" min="0" style="background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <input class="dn-inv-line-qdel" type="number" placeholder="Qty Delivered" min="0" style="background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/>
      <button type="button" onclick="this.closest('.dn-inv-line-row').remove()" style="padding:6px 9px;background:transparent;border:1px solid rgba(192,48,42,.3);border-radius:5px;color:var(--red3);cursor:pointer;font-size:12px">✕</button>
    `;
    wrap.appendChild(row);
  };

  function injectInvoiceDeliveryNotePanelV52() {
    if (document.getElementById('dn-inv-toggle')) return;
    const btnRow = document.querySelector('#pg-invoice .btn-row');
    if (!btnRow) return;
    const html = `<div style="margin:10px 0;padding-top:10px;border-top:1px dashed var(--border2)">
      <label style="display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text2);cursor:pointer">
        <input id="dn-inv-toggle" type="checkbox" onchange="document.getElementById('dn-inv-panel').style.display=this.checked?'block':'none'"/> 📦 Generate Delivery Note for this Invoice
      </label>
      <div id="dn-inv-panel" style="display:none;margin-top:8px;padding:10px;background:var(--bg3);border-radius:6px">
        <div class="fg" style="margin-bottom:6px"><label style="font-size:10px">Shipping / Delivery Address</label>
          <textarea id="dn-inv-shipto" rows="2" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none;resize:vertical"></textarea></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <div class="fg" style="margin:0"><label style="font-size:10px">Driver / Carrier Name</label><input id="dn-inv-driver" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Vehicle No.</label><input id="dn-inv-vehicle" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px">Carrier / Company</label><input id="dn-inv-carrier" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
          <div class="fg" style="margin:0"><label style="font-size:10px"># Packages / Boxes</label><input id="dn-inv-packages" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
        </div>
        <div class="fg" style="margin:6px 0"><label style="font-size:10px">Special Delivery Instructions</label><input id="dn-inv-notes" type="text" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-size:11px;color:var(--text);outline:none"/></div>
        <div style="font-size:10px;color:var(--text3);margin:8px 0 4px">This screen doesn't carry line items, so list what's being delivered here:</div>
        <div id="dn-inv-lines"></div>
        <button type="button" class="btn btn-outline" style="padding:5px 10px;font-size:11px" onclick="addDNInvLineV52()">+ Add Line</button>
      </div>
    </div>`;
    btnRow.insertAdjacentHTML('beforebegin', html);
  }

  function readInvoiceDeliveryNoteDataV52() {
    const toggle = document.getElementById('dn-inv-toggle');
    if (!toggle || !toggle.checked) return null;
    const val = function (id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const rows = document.querySelectorAll('#dn-inv-lines .dn-inv-line-row');
    let lines = [];
    rows.forEach(function (row) {
      const desc = (row.querySelector('.dn-inv-line-desc') || {}).value || '';
      const sku = (row.querySelector('.dn-inv-line-sku') || {}).value || '';
      const unit = (row.querySelector('.dn-inv-line-unit') || {}).value || '';
      const qOrd = parseFloat((row.querySelector('.dn-inv-line-qord') || {}).value) || 0;
      const qDelRaw = (row.querySelector('.dn-inv-line-qdel') || {}).value;
      const qDel = qDelRaw === '' ? qOrd : Math.max(0, parseFloat(qDelRaw) || 0);
      if (desc.trim() && qOrd > 0) lines.push({ description: desc.trim(), sku: sku.trim(), unit: unit.trim() || 'unit', qtyOrdered: qOrd, qtyDelivered: qDel });
    });
    if (!lines.length) {
      // Fallback: box was checked but no lines typed — never ship an
      // empty delivery note. See the scope note at the top of this file.
      lines = [{ description: 'See Invoice for billing detail', sku: '', unit: 'lot', qtyOrdered: 1, qtyDelivered: 1 }];
    }
    return {
      refType: 'construction_invoice', shipTo: val('dn-inv-shipto'), driverName: val('dn-inv-driver'),
      vehicleNo: val('dn-inv-vehicle'), carrier: val('dn-inv-carrier'),
      numPackages: val('dn-inv-packages'), instructions: val('dn-inv-notes'), lines: lines
    };
  }

  function resetInvoiceDeliveryNotePanelV52() {
    const toggle = document.getElementById('dn-inv-toggle'); if (toggle) toggle.checked = false;
    ['dn-inv-shipto', 'dn-inv-driver', 'dn-inv-vehicle', 'dn-inv-carrier', 'dn-inv-packages', 'dn-inv-notes'].forEach(function (id) { const el = document.getElementById(id); if (el) el.value = ''; });
    const panel = document.getElementById('dn-inv-panel'); if (panel) panel.style.display = 'none';
    const linesEl = document.getElementById('dn-inv-lines'); if (linesEl) linesEl.innerHTML = '';
  }

  // ── Wire into completeSale (POS) ─────────────────────────────────────
  const _origCompleteSaleV52 = window.completeSale;
  if (typeof _origCompleteSaleV52 === 'function') {
    window.completeSale = async function () {
      const beforeLen = (DB && DB.entries) ? DB.entries.length : 0;
      const cartSnapshot = _dnGetPOSCartV52().map(function (i) { return Object.assign({}, i); });
      const custEl = document.getElementById('pos-customer');
      const custOpt = custEl && custEl.selectedOptions && custEl.selectedOptions[0];
      const dnData = readPOSDeliveryNoteDataV52(cartSnapshot);
      if (dnData && custOpt && custOpt.value) dnData.customerName = custOpt.textContent;
      const result = await _origCompleteSaleV52.apply(this, arguments);
      const afterLen = (DB && DB.entries) ? DB.entries.length : 0;
      if (afterLen > beforeLen) tagLastEntryWithDeliveryNoteV52('POS Sale', dnData);
      resetPOSDeliveryNotePanelV52();
      return result;
    };
  }

  const _origRenderPOSCartV52 = window.renderPOSCart;
  if (typeof _origRenderPOSCartV52 === 'function') {
    window.renderPOSCart = function () {
      const result = _origRenderPOSCartV52.apply(this, arguments);
      const partialToggle = document.getElementById('dn-pos-partial-toggle');
      if (partialToggle && partialToggle.checked) renderDNPartialLinesPOSV52();
      return result;
    };
  }

  const _origInjectRetailPagesV52 = window.injectRetailPages;
  if (typeof _origInjectRetailPagesV52 === 'function') {
    window.injectRetailPages = function () {
      const result = _origInjectRetailPagesV52.apply(this, arguments);
      injectPOSDeliveryNotePanelV52();
      return result;
    };
  }

  // ── Wire into postInvoice (construction) ─────────────────────────────
  const _origPostInvoiceV52 = window.postInvoice;
  if (typeof _origPostInvoiceV52 === 'function') {
    window.postInvoice = function () {
      const beforeLen = (DB && DB.entries) ? DB.entries.length : 0;
      const custEl = document.getElementById('invCustomer');
      const custOpt = custEl && custEl.selectedOptions && custEl.selectedOptions[0];
      const dnData = readInvoiceDeliveryNoteDataV52();
      if (dnData && custOpt && custOpt.value) dnData.customerName = custOpt.textContent;
      const result = _origPostInvoiceV52.apply(this, arguments);
      const afterLen = (DB && DB.entries) ? DB.entries.length : 0;
      if (afterLen > beforeLen) tagLastEntryWithDeliveryNoteV52('Invoice', dnData);
      resetInvoiceDeliveryNotePanelV52();
      return result;
    };
  }

  // ── Hook everything up via nav() ──────────────────────────────────────
  const _origNavV52 = window.nav;
  if (typeof _origNavV52 === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV52(page, el);
      if (page === 'pos') injectPOSDeliveryNotePanelV52();
      if (page === 'invoice') injectInvoiceDeliveryNotePanelV52();
      return result;
    };
  }

  console.log('✅ patch-v52.js loaded — Delivery Note toggle + capture (POS + construction Invoice)');
})();
