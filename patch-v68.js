// ═══════════════════════════════════════════════════════════
// PATCH v68 — POS Receipt / Invoice printing
// ═══════════════════════════════════════════════════════════
// Every POS sale already gets a unique journal entry id (DB.nextId++,
// the same counter used everywhere else in this app) — that id IS the
// receipt/sale number, nothing new needed to generate one. This patch:
//   1. Prints a document right after Complete Sale — a CASH RECEIPT for
//      cash/mobile/card payment, an INVOICE for a credit sale — with
//      that number on it, to hand to the customer.
//   2. Makes ANY past sale reprintable by its number (not just the one
//      that just happened), via printPOSReceiptV68(saleId) fetching the
//      pos_sales record fresh rather than relying on in-memory state —
//      this is also what patch-v63.js's Sales Returns "find by receipt
//      number" now looks up against.
//
// This directly enables the thing patch-v63.js flagged as a real
// limitation: a cash sale never gets a customer attached, so a return
// against one couldn't be matched by customer. It still can't be — but
// with a real number now printed on the receipt itself, the return can
// look the ORIGINAL sale up by that number directly instead, regardless
// of whether a customer was ever on file for it.
// ═══════════════════════════════════════════════════════════

(function () {
  function todayStr() { return (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function fmtMoney(n) { return (typeof fc === 'function') ? fc(n) : '$' + (parseFloat(n) || 0).toFixed(2); }

  const PAY_LABEL_V68 = { cash: 'Cash', mobile: 'Mobile Money', card: 'Card', credit: 'Credit (Customer Account)' };

  async function fetchPOSSaleRecordV68(saleId) {
    try {
      const r = await dbApi({ action: 'listPOSSales', companyId: SESSION.companyId, limit: 1000 });
      return (r.sales || []).find(function (s) { return String(s.journal_entry_id) === String(saleId); }) || null;
    } catch (e) { console.error('fetchPOSSaleRecordV68', e); return null; }
  }
  function saleItemsV68(s) { return Array.isArray(s.items) ? s.items : (JSON.parse(s.items || '[]')); }

  // ═══════════════════════════════════════════════════════════
  // Print page
  // ═══════════════════════════════════════════════════════════
  function injectPOSReceiptPrintPageV68() {
    if (document.getElementById('pg-pos-receipt-print-v68')) return;
    const main = document.querySelector('.main'); if (!main) return;
    const page = document.createElement('div');
    page.className = 'page'; page.id = 'pg-pos-receipt-print-v68';
    page.innerHTML = `<div class="no-print" style="margin-bottom:14px;display:flex;gap:8px">
        <button class="btn btn-outline" onclick="nav('pos')">← Back</button>
        <button class="btn btn-gold" onclick="window.print()">🖨️ Print</button>
      </div>
      <div id="pos-receipt-content-v68" style="background:#fff;color:#111;padding:14px 10px;width:300px;margin:0 auto;font-family:'Courier New',Courier,monospace;border-radius:2px;box-shadow:0 0 8px rgba(0,0,0,0.15)"></div>`;
    main.appendChild(page);
  }
  const _posReceiptStyleV68 = document.createElement('style');
  _posReceiptStyleV68.textContent = `
    @media print{
      body.pos-receipt-printing-v68 .page{display:none!important}
      body.pos-receipt-printing-v68 #pg-pos-receipt-print-v68{display:block!important}
      #pos-receipt-content-v68{box-shadow:none!important;width:100%!important;max-width:80mm}
      @page{margin:4mm}
    }
    #pos-receipt-content-v68 *{color:#111!important;box-sizing:border-box}
    #pos-receipt-content-v68 .r68-dash{border-top:1px dashed #333;margin:8px 0}
    #pos-receipt-content-v68 .r68-row{display:flex;justify-content:space-between;font-size:11.5px;line-height:1.5}
    #pos-receipt-content-v68 .r68-item-name{font-size:11.5px;line-height:1.4}
  `;
  document.head.appendChild(_posReceiptStyleV68);

  window.printPOSReceiptV68 = async function (saleId, autoTrigger) {
    const entry = (DB.entries || []).find(function (e) { return e.id === saleId; });
    if (!entry) { if (typeof showToast === 'function') showToast('⚠️ Sale #' + saleId + ' not found'); return; }
    const record = await fetchPOSSaleRecordV68(saleId);
    if (!record) { if (typeof showToast === 'function') showToast('⚠️ No item detail on file for sale #' + saleId); return; }

    injectPOSReceiptPrintPageV68();
    const content = document.getElementById('pos-receipt-content-v68');
    if (!content) return;

    const isCredit = record.payment_method === 'credit';
    const docTitle = isCredit ? 'INVOICE' : 'SALES RECEIPT';
    const items = saleItemsV68(record);
    const ts = record.created_at ? new Date(record.created_at) : new Date();
    const dateStr = ts.toLocaleDateString();
    const timeStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Real-receipt style: item name on its own line, qty × unit price and
    // the line total on the next — this is what a thermal-printer receipt
    // actually looks like (narrow paper can't fit a 4-column table), not
    // a formal document table.
    const itemsHtml = items.map(function (it) {
      const qty = parseFloat(it.qty) || 0, price = parseFloat(it.sale_price) || 0;
      return `<div style="margin-bottom:5px">
        <div class="r68-item-name">${esc(it.name)}</div>
        <div class="r68-row"><span>${qty} x ${fmtMoney(price)}</span><span>${fmtMoney(qty * price)}</span></div>
      </div>`;
    }).join('');
    const customerLine = entry.party ? entry.party.name : 'Walk-in Customer';

    content.innerHTML = `
      <div style="text-align:center">
        <div style="font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">${esc((typeof BIZ_NAME !== 'undefined' && BIZ_NAME) || 'Company')}</div>
        <div style="font-size:11px;margin-top:2px">${docTitle}</div>
      </div>
      <div class="r68-dash"></div>
      <div style="font-size:11px">
        <div class="r68-row"><span>Receipt #</span><span>${saleId}</span></div>
        <div class="r68-row"><span>Date</span><span>${esc(dateStr)} ${esc(timeStr)}</span></div>
        <div class="r68-row"><span>Cashier</span><span>${esc(record.cashier || '—')}</span></div>
        <div class="r68-row"><span>Customer</span><span>${esc(customerLine)}</span></div>
      </div>
      <div class="r68-dash"></div>
      ${itemsHtml}
      <div class="r68-dash"></div>
      <div style="font-size:11.5px">
        <div class="r68-row"><span>Subtotal</span><span>${fmtMoney(record.subtotal)}</span></div>
        ${record.discount > 0.001 ? (`<div class="r68-row"><span>Discount</span><span>-${fmtMoney(record.discount)}</span></div>`) : ''}
      </div>
      <div class="r68-dash"></div>
      <div class="r68-row" style="font-size:15px;font-weight:700"><span>TOTAL</span><span>${fmtMoney(record.total)}</span></div>
      <div class="r68-row" style="font-size:11px;margin-top:4px;color:#333"><span>Paid via</span><span>${esc(PAY_LABEL_V68[record.payment_method] || record.payment_method)}</span></div>
      <div class="r68-dash"></div>
      <div style="text-align:center;font-size:11px;margin-top:6px">
        ${isCredit ? 'Payment due per your account terms.<br/>Keep this invoice for your records.' : 'Thank you for shopping with us!<br/>Please keep this receipt for any return.'}
      </div>
      <div style="text-align:center;font-size:10px;color:#777;margin-top:10px">*** #${saleId} ***</div>
    `;
    document.body.classList.add('pos-receipt-printing-v68');
    await nav('pos-receipt-print-v68');
    if (autoTrigger) {
      window.print(); // blocks until the browser's print dialog is dismissed
      await nav('pos'); // back to the till, ready for the next sale
    }
  };

  // ═══════════════════════════════════════════════════════════
  // Auto-Print toggle — same spot patch-v52's own "Generate Delivery
  // Note" checkbox uses (right before the Complete Sale button), so it
  // sits somewhere the cashier already looks before every sale. State is
  // saved to this browser's localStorage — a per-till convenience, not
  // company data, so it doesn't need a backend round-trip and correctly
  // stays set the way this specific counter/computer wants it, sale
  // after sale, until someone changes it here again.
  // ═══════════════════════════════════════════════════════════
  function isAutoPrintOnV68() {
    try { return localStorage.getItem('hh_pos_autoprint_v68') === '1'; } catch (e) { return false; }
  }
  window.toggleAutoPrintV68 = function (on) {
    try { localStorage.setItem('hh_pos_autoprint_v68', on ? '1' : '0'); } catch (e) { /* ignore */ }
  };
  function injectAutoPrintToggleV68() {
    if (document.getElementById('pos68-autoprint-toggle')) return;
    const btn = document.querySelector('[onclick="completeSale()"]');
    if (!btn) return;
    const html = `<label style="display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text2);cursor:pointer;margin-top:8px">
      <input id="pos68-autoprint-toggle" type="checkbox" ${isAutoPrintOnV68() ? 'checked' : ''} onchange="toggleAutoPrintV68(this.checked)"/> 🖨️ Auto-print receipt on every sale
    </label>`;
    btn.insertAdjacentHTML('beforebegin', html);
  }

  // ═══════════════════════════════════════════════════════════
  // Offer to print right after Complete Sale — a persistent little
  // notice near the cart, updated with each sale's own number. When
  // Auto-Print is OFF (the default), this is the only thing that
  // happens — nothing prints on its own, same as before. When it's ON,
  // printing fires immediately and this notice becomes a "reprint if
  // needed" fallback rather than the main path.
  // ═══════════════════════════════════════════════════════════
  function injectLastReceiptNoticeV68() {
    if (document.getElementById('pos68-last-receipt')) return;
    const clearBtn = document.querySelector('.pos-right button[onclick^="POS_CART=[]"]');
    if (!clearBtn || !clearBtn.parentNode) return;
    const div = document.createElement('div');
    div.id = 'pos68-last-receipt';
    div.style.cssText = 'display:none;margin-top:10px;padding:8px 10px;background:var(--bg3);border-radius:6px;font-size:11px;display:flex;justify-content:space-between;align-items:center';
    clearBtn.parentNode.insertBefore(div, clearBtn.nextSibling);
  }

  function showLastReceiptNoticeV68(saleId, total, payMethod) {
    injectLastReceiptNoticeV68();
    const div = document.getElementById('pos68-last-receipt');
    if (!div) return;
    const docWord = payMethod === 'credit' ? 'Invoice' : 'Receipt';
    div.style.display = 'flex';
    div.innerHTML = `<span>✅ Sale #${saleId} — ${fmtMoney(total)}</span><button class="btn btn-gold" style="padding:4px 10px;font-size:11px" onclick="printPOSReceiptV68(${saleId})">🖨️ ${isAutoPrintOnV68() ? 'Reprint' : 'Print'} ${docWord}</button>`;
  }

  const _origCompleteSaleV68 = window.completeSale;
  if (typeof _origCompleteSaleV68 === 'function') {
    window.completeSale = async function () {
      const beforeNextId = DB.nextId;
      const payMethodEl = document.getElementById('pos-payment');
      const payMethodSnapshot = payMethodEl ? payMethodEl.value : 'cash';
      const result = await _origCompleteSaleV68.apply(this, arguments);
      // The sale's journal entry uses DB.nextId++ as its very first
      // increment inside the original function, so if a sale actually
      // posted, its id is exactly the value DB.nextId held beforehand.
      const saleEntry = (DB.entries || []).find(function (e) { return e.id === beforeNextId && e.type === 'POS Sale'; });
      if (saleEntry) {
        showLastReceiptNoticeV68(saleEntry.id, saleEntry.amount, payMethodSnapshot);
        if (isAutoPrintOnV68()) printPOSReceiptV68(saleEntry.id, true);
      }
      return result;
    };
  }

  // ── nav() — clear the printing body class when leaving the print page,
  // and make sure the toggle + notice element exist once the POS page is
  // up ──
  const _origNavV68 = window.nav;
  if (typeof _origNavV68 === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV68(page, el);
      if (page !== 'pos-receipt-print-v68') document.body.classList.remove('pos-receipt-printing-v68');
      if (page === 'pos') { injectLastReceiptNoticeV68(); injectAutoPrintToggleV68(); }
      return result;
    };
  }

  console.log('✅ patch-v68.js loaded — POS sales now print a Cash Receipt or Invoice with a real receipt number, reprintable anytime via printPOSReceiptV68(saleId), with an Auto-Print toggle for hands-free printing every sale');
})();
