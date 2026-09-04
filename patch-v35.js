// ═══════════════════════════════════════════════════════════
// PATCH v35 — Early Payment Discount, Phase 1: Foundation
// ═══════════════════════════════════════════════════════════
// This is the groundwork layer for prompt-payment discounts (e.g. "2/10
// Net 30"), covering BOTH construction and retail, BOTH purchases (AP) and
// sales (AR). It does NOT yet change any money — no discount is actually
// applied to a payment yet. That's Phase 2 (next patch), scoped to
// Accounts Payable / Pay Supplier first, verified, then mirrored to AR —
// same incremental approach used throughout the multi-currency work.
//
// What THIS patch does:
//  1. A "Payment Terms" registry (Settings) — reusable presets like
//     "2/10 Net 30", stored via the same generic key-value mechanism as
//     FOREIGN_ACCOUNTS (patch-v27). Nothing here is mandatory — every
//     screen below still works exactly as before if no terms are picked.
//  2. The shared calculation engine: discount_deadline / net_due_date
//     (calendar-day math), and the discount-eligibility check described
//     in the architecture doc — used by Phase 2, not yet wired to any UI.
//  3. A "Payment Terms" dropdown injected next to the Payment method
//     field, on every screen that creates an open AP or AR balance:
//       AP: Stock Intake (si-pay), multi-item Receipt Review
//           (rs-review-pay), construction Deliveries (delPay)
//       AR: POS credit sale (pos-customer-currency's screen),
//           construction Invoicing (postInvoice)
//     Picking "— No Terms —" (the default) means the invoice behaves
//     exactly as it does today — nothing changes for anyone who doesn't
//     use this feature.
//  4. When terms ARE picked, the resulting entry gets tagged with
//     entry.terms = {...} — the same design already used for entry.fx:
//     a small metadata block riding on the journal entry itself, since
//     invoices in this app are journal entries, not separate DB rows.
//
// Note on PO-based material receiving (confirmMaterialPOReceipt): not
// covered by this patch — only the manual/receipt-based intake screens
// are. Flagging as a known gap, same as Stock Intake's original fx-tagging
// scope (patch-v15) — can be added in a follow-up if needed.
// ═══════════════════════════════════════════════════════════

(function () {
  window.PAYMENT_TERMS = window.PAYMENT_TERMS || [];

  // ── Persistence (mirrors FOREIGN_ACCOUNTS, patch-v27) ────────────────
  async function loadPaymentTermsV35() {
    try {
      // 'load' always returns the WHOLE company data blob (every key at
      // once) — it does not filter by the key you ask for. Same pattern
      // FOREIGN_ACCOUNTS (v27) uses: pull the one field we care about out
      // of that blob ourselves.
      const r = await dbApi({ action: 'load', companyId: SESSION.companyId });
      const d = (r && r.data) || {};
      PAYMENT_TERMS = Array.isArray(d.paymentTerms) ? d.paymentTerms : [];
    } catch (e) { PAYMENT_TERMS = []; }
    window.PAYMENT_TERMS = PAYMENT_TERMS;
  }
  async function savePaymentTermsV35() {
    await dbApi({ action: 'save', companyId: SESSION.companyId, key: 'paymentTerms', value: PAYMENT_TERMS });
    window.PAYMENT_TERMS = PAYMENT_TERMS;
  }

  // ── Calculation engine (shared by AP and AR, used starting Phase 2) ──
  // Calendar-day addition — matches how every date field in this app
  // already works (no business-day logic anywhere else to be consistent
  // with).
  function addDaysV35(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + (parseInt(days) || 0));
    return d.toISOString().slice(0, 10);
  }

  // discountBase: 'gross' (full amount, default) or 'pre_tax' (excludes tax)
  function computeEligibleRatioV35(discountBase, invoiceAmount, taxAmount) {
    if (discountBase === 'pre_tax' && invoiceAmount > 0) {
      return Math.max(0, (invoiceAmount - (taxAmount || 0)) / invoiceAmount);
    }
    return 1; // 'gross' — full invoice amount is eligible
  }

  // Builds the terms metadata block to attach to a new invoice entry.
  function buildTermsBlockV35(termsId, invoiceDateStr, invoiceAmount, taxAmount) {
    const terms = PAYMENT_TERMS.find(function (t) { return String(t.id) === String(termsId); });
    if (!terms) return null;
    const invoiceDate = invoiceDateStr || today();
    const discountDeadline = addDaysV35(invoiceDate, terms.discount_days);
    const netDueDate = addDaysV35(invoiceDate, terms.net_days);
    const eligibleRatio = computeEligibleRatioV35(terms.discount_base, invoiceAmount, taxAmount);
    const eligibleBase = +(invoiceAmount * eligibleRatio).toFixed(2);
    const eligibleDiscountAmount = +(eligibleBase * (terms.discount_percent / 100)).toFixed(2);
    return {
      termsId: terms.id,
      code: terms.code,
      discount_percent: terms.discount_percent,
      discount_days: terms.discount_days,
      net_days: terms.net_days,
      discount_base: terms.discount_base || 'gross',
      partial_payment_policy: terms.partial_payment_policy || 'prorated',
      invoice_date: invoiceDate,
      discount_deadline: discountDeadline,
      net_due_date: netDueDate,
      eligible_ratio: eligibleRatio,
      eligible_discount_amount: eligibleDiscountAmount
    };
  }
  window.buildTermsBlockV35 = buildTermsBlockV35;

  // Evaluates whether — and how much — discount a specific payment earns.
  // amountBeingPaid: the amount (invoice-currency, or base-currency if the
  // invoice has no fx tag) of THIS payment. Handles prorated partial
  // payments per §4 of the design doc: each payment is judged on its own,
  // against the SAME invoice's discount_deadline.
  function evaluateDiscountV35(termsBlock, paymentDateStr, amountBeingPaid) {
    if (!termsBlock) return { eligible: false, discount: 0, reason: 'no payment terms on this invoice' };
    const onTime = paymentDateStr <= termsBlock.discount_deadline; // inclusive, calendar-date string compare (YYYY-MM-DD sorts correctly)
    if (!onTime) return { eligible: false, discount: 0, reason: 'past discount deadline (' + termsBlock.discount_deadline + ')' };
    const eligiblePortion = +(amountBeingPaid * termsBlock.eligible_ratio).toFixed(2);
    const discount = +(eligiblePortion * (termsBlock.discount_percent / 100)).toFixed(2);
    return { eligible: true, discount: discount, reason: 'within discount window (by ' + termsBlock.discount_deadline + ')' };
  }
  window.evaluateDiscountV35 = evaluateDiscountV35;

  // Generic tagger — mirrors tagLastEntryWithFx (patch-v15/v23): finds the
  // entry just pushed, tags it if it has an open AP or AR line and a
  // terms preset was actually selected (blank/no selection = do nothing,
  // entry behaves exactly as before).
  function tagLastEntryWithTermsV35(termsId, invoiceDateStr) {
    if (!termsId) return; // "— No Terms —" selected, nothing to do
    if (!DB || !DB.entries || !DB.entries.length) return;
    const entry = DB.entries[DB.entries.length - 1];
    if (!entry || entry.terms) return;
    const controlLine = (entry.credits || []).find(function (l) { return l.acct === 'Accounts Payable'; })
      || (entry.debits || []).find(function (l) { return l.acct === 'Accounts Payable'; })
      || (entry.debits || []).find(function (l) { return l.acct === 'Accounts Receivable'; })
      || (entry.credits || []).find(function (l) { return l.acct === 'Accounts Receivable'; });
    if (!controlLine) return; // cash-paid entry, nothing open to apply terms to
    const taxLine = (entry.debits || []).concat(entry.credits || []).find(function (l) { return l.acct === 'VAT Receivable (Input VAT)' || l.acct === 'VAT Payable (Output VAT)'; });
    const termsBlock = buildTermsBlockV35(termsId, invoiceDateStr, controlLine.amt, taxLine ? taxLine.amt : 0);
    if (termsBlock) {
      entry.terms = termsBlock;
      if (typeof saveData === 'function') saveData();
    }
  }
  window.tagLastEntryWithTermsV35 = tagLastEntryWithTermsV35;

  // ── Settings UI: Payment Terms registry ──────────────────────────────
  function renderPaymentTermsCardV35() {
    const list = document.getElementById('pt-list');
    if (!list) return;
    if (!PAYMENT_TERMS.length) {
      list.innerHTML = '<div style="text-align:center;padding:14px;color:var(--text3);font-size:11px">No payment terms yet — add one below (e.g. 2/10 Net 30)</div>';
      return;
    }
    list.innerHTML = PAYMENT_TERMS.map(function (t) {
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--bg3);border-radius:6px;margin-bottom:6px;font-size:11px">
        <div><b style="color:var(--gold3)">${t.code}</b> — ${t.discount_percent}% if paid within ${t.discount_days}d, full due in ${t.net_days}d
        <span style="color:var(--text3)"> (${t.applies_to}, ${t.discount_base}, ${t.partial_payment_policy})</span></div>
        <button class="btn btn-outline" style="padding:4px 9px;font-size:10px" onclick="window.__deletePaymentTermV35('${t.id}')">Delete</button>
      </div>`;
    }).join('');
  }
  window.renderPaymentTermsCardV35 = renderPaymentTermsCardV35;

  window.__deletePaymentTermV35 = async function (id) {
    PAYMENT_TERMS = PAYMENT_TERMS.filter(function (t) { return String(t.id) !== String(id); });
    await savePaymentTermsV35();
    renderPaymentTermsCardV35();
  };

  window.addPaymentTermV35 = async function () {
    const code = (document.getElementById('pt-code') || {}).value || '';
    const discPct = parseFloat((document.getElementById('pt-disc-pct') || {}).value);
    const discDays = parseInt((document.getElementById('pt-disc-days') || {}).value);
    const netDays = parseInt((document.getElementById('pt-net-days') || {}).value);
    const appliesTo = (document.getElementById('pt-applies-to') || {}).value || 'both';
    const st = document.getElementById('pt-st');
    if (!code.trim() || !(discPct > 0) || !(discDays > 0) || !(netDays >= discDays)) {
      if (st) st.innerHTML = '<span style="color:var(--red3)">Fill in a valid code, discount %, discount days, and net days (net days must be ≥ discount days)</span>';
      return;
    }
    PAYMENT_TERMS.push({
      id: Date.now(), code: code.trim(), discount_percent: discPct, discount_days: discDays, net_days: netDays,
      applies_to: appliesTo, discount_base: 'gross', partial_payment_policy: 'prorated', active: true
    });
    await savePaymentTermsV35();
    renderPaymentTermsCardV35();
    ['pt-code', 'pt-disc-pct', 'pt-disc-days', 'pt-net-days'].forEach(function (id) { const el = document.getElementById(id); if (el) el.value = ''; });
    if (st) { st.innerHTML = '<span style="color:var(--green3)">✅ Added</span>'; setTimeout(function () { st.innerHTML = ''; }, 3000); }
  };

  function injectPaymentTermsCardV35() {
    if (document.getElementById('pt-card')) return;
    const settingsPage = document.getElementById('pg-settings');
    if (!settingsPage) return;
    const div = document.createElement('div');
    div.className = 'card';
    div.id = 'pt-card';
    div.innerHTML = `<div class="card-hdr">📅 Payment Terms (Early Payment Discounts)</div>
      <div id="pt-list"></div>
      <div class="fgrid" style="margin-top:8px">
        <div class="fg"><label>Code (e.g. "2/10 Net 30")</label><input id="pt-code" type="text" placeholder="2/10 Net 30"/></div>
        <div class="fg"><label>Discount %</label><input id="pt-disc-pct" type="number" step="0.1" placeholder="2"/></div>
        <div class="fg"><label>Discount Days</label><input id="pt-disc-days" type="number" placeholder="10"/></div>
        <div class="fg"><label>Net Days</label><input id="pt-net-days" type="number" placeholder="30"/></div>
        <div class="fg"><label>Applies To</label><select id="pt-applies-to"><option value="both">Both AP &amp; AR</option><option value="AP">Purchases only</option><option value="AR">Sales only</option></select></div>
      </div>
      <div class="btn-row"><button class="btn btn-gold" onclick="window.addPaymentTermV35()">➕ Add Term</button></div>
      <div id="pt-st" style="font-size:11px;margin-top:6px"></div>`;
    settingsPage.appendChild(div);
    renderPaymentTermsCardV35();
  }

  // ── Inline "Payment Terms" picker, injected next to Payment fields ──
  function injectTermsPickerV35(payElId, widgetKey, appliesToFilter) {
    const payEl = document.getElementById(payElId);
    if (!payEl) return;
    // Prefer the standard .fg field wrapper; fall back to the nearest
    // parent div (covers pos-customer-currency, which isn't wrapped in
    // .fg) so this still works everywhere a currency/payment field lives.
    const fgWrap = payEl.closest('.fg') || payEl.closest('div');
    if (!fgWrap) return;
    const pickerId = 'termspicker-' + widgetKey;
    let picker = document.getElementById(pickerId);
    const opts = '<option value="">— No Terms —</option>' + PAYMENT_TERMS
      .filter(function (t) { return t.active !== false && (t.applies_to === 'both' || t.applies_to === appliesToFilter); })
      .map(function (t) { return `<option value="${t.id}">${t.code}</option>`; }).join('');
    if (!picker) {
      picker = document.createElement('div');
      picker.className = 'fg';
      picker.id = pickerId;
      picker.innerHTML = `<label>Payment Terms</label><select id="terms-${widgetKey}"></select>`;
      fgWrap.insertAdjacentElement('afterend', picker);
    }
    const sel = document.getElementById('terms-' + widgetKey);
    if (sel) { const prev = sel.value; sel.innerHTML = opts; if (prev) sel.value = prev; }
  }

  function readTermsSelValueV35(widgetKey) {
    const el = document.getElementById('terms-' + widgetKey);
    return el ? el.value : '';
  }

  // ── Wire into every AP/AR-creating screen ────────────────────────────

  // 1) Stock Intake (retail, manual/single-item)
  const _origReceiveStockV35 = window.receiveStock;
  if (typeof _origReceiveStockV35 === 'function') {
    window.receiveStock = async function () {
      const termsId = readTermsSelValueV35('si-pay');
      const result = await _origReceiveStockV35.apply(this, arguments);
      tagLastEntryWithTermsV35(termsId, today());
      return result;
    };
  }

  // 2) Multi-item Receipt Review (retail, after Smart Document Import)
  const _origConfirmReceiptIntakeV35 = window.confirmReceiptIntake;
  if (typeof _origConfirmReceiptIntakeV35 === 'function') {
    window.confirmReceiptIntake = async function () {
      const termsId = readTermsSelValueV35('rs-review-pay');
      const result = await _origConfirmReceiptIntakeV35.apply(this, arguments);
      tagLastEntryWithTermsV35(termsId, today());
      return result;
    };
  }
  const _origRenderReceiptReviewTableV35 = window.renderReceiptReviewTable;
  if (typeof _origRenderReceiptReviewTableV35 === 'function') {
    window.renderReceiptReviewTable = function (parsed) {
      const result = _origRenderReceiptReviewTableV35(parsed);
      injectTermsPickerV35('rs-review-pay', 'rs-review-pay', 'AP');
      return result;
    };
  }

  // 3) Construction Deliveries (manual/receipt-based)
  const _origConfirmMaterialsDeliveryV35 = window.confirmMaterialsDelivery;
  if (typeof _origConfirmMaterialsDeliveryV35 === 'function') {
    window.confirmMaterialsDelivery = async function () {
      const termsId = readTermsSelValueV35('delPay');
      const dateEl = document.getElementById('delDate');
      const invDate = (dateEl && dateEl.value) || today();
      const result = await _origConfirmMaterialsDeliveryV35.apply(this, arguments);
      tagLastEntryWithTermsV35(termsId, invDate);
      return result;
    };
  }

  // 4) POS credit sale (retail) — chains on top of patch-v32's wrap
  const _origCompleteSaleV35 = window.completeSale;
  if (typeof _origCompleteSaleV35 === 'function') {
    window.completeSale = async function () {
      const posCur = document.getElementById('pos-customer-currency');
      const widgetKey = posCur ? 'pos-customer-currency' : null;
      const termsId = widgetKey ? readTermsSelValueV35(widgetKey) : '';
      const result = await _origCompleteSaleV35.apply(this, arguments);
      tagLastEntryWithTermsV35(termsId, today());
      return result;
    };
  }
  const _origInjectPOSCustomerCurrencyPickerV35 = window.injectPOSCustomerCurrencyPicker;
  if (typeof _origInjectPOSCustomerCurrencyPickerV35 === 'function') {
    window.injectPOSCustomerCurrencyPicker = function () {
      const result = _origInjectPOSCustomerCurrencyPickerV35();
      injectTermsPickerV35('pos-customer-currency', 'pos-customer-currency', 'AR');
      return result;
    };
  }

  // 5) Construction Invoicing
  const _origPostInvoiceV35 = window.postInvoice;
  if (typeof _origPostInvoiceV35 === 'function') {
    window.postInvoice = function () {
      const termsId = readTermsSelValueV35('invAmt');
      const result = _origPostInvoiceV35.apply(this, arguments);
      tagLastEntryWithTermsV35(termsId, today());
      return result;
    };
  }
  function injectInvoiceTermsPickerV35() {
    const amtInput = document.getElementById('invAmt');
    if (!amtInput) return;
    injectTermsPickerV35('invAmt', 'invAmt', 'AR');
  }

  // ── Hook everything up: nav(), enterCompany() ────────────────────────
  const _origNavV35 = window.nav;
  if (typeof _origNavV35 === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV35(page, el);
      if (page === 'settings') injectPaymentTermsCardV35();
      if (page === 'stockin') injectTermsPickerV35('si-pay', 'si-pay', 'AP');
      if (page === 'deliveries') injectTermsPickerV35('delPay', 'delPay', 'AP');
      if (page === 'projects' || page === 'invoice') injectInvoiceTermsPickerV35();
      return result;
    };
  }
  const _origEnterCompanyV35 = window.enterCompany;
  if (typeof _origEnterCompanyV35 === 'function') {
    window.enterCompany = async function (c) {
      const result = await _origEnterCompanyV35(c);
      await loadPaymentTermsV35();
      return result;
    };
  }

  console.log('✅ patch-v35.js loaded — Payment Terms foundation (registry + tagging, both AP & AR, construction & retail)');
})();
