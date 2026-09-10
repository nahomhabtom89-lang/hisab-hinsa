// ═══════════════════════════════════════════════════════════
// PATCH v50 — POS cart: show a foreign-currency reference alongside base
// ═══════════════════════════════════════════════════════════
// Base currency stays the primary, authoritative figure everywhere in
// the cart — nothing about pricing, totals, or what actually gets posted
// changes. This only ADDS a small "≈ €XXX.XX" reference next to each
// line and the total, purely for the cashier's convenience, once Payment
// is set to Credit and a customer currency other than base is picked.
// Uses the same live/manual rate (patch-v34) as everywhere else in the
// app — if that currency is set to Manual, the reference reflects your
// manual rate automatically.
// ═══════════════════════════════════════════════════════════

(function () {
  function getPosRefCurrency() {
    const payEl = document.getElementById('pos-payment');
    if (!payEl || payEl.value !== 'credit') return null;
    const curEl = document.getElementById('pos-customer-currency');
    if (!curEl) return null;
    const base = (typeof BASE_CURRENCY !== 'undefined' && BASE_CURRENCY) ? BASE_CURRENCY : 'USD';
    if (!curEl.value || curEl.value === base) return null;
    return curEl.value;
  }

  function formatForeignRef(baseAmt, currency) {
    const rate = (typeof fxCrossRate === 'function') ? fxCrossRate(currency) : null; // "1 currency = ? base"
    if (!rate) return '';
    const foreignAmt = baseAmt / rate;
    return `≈ ${foreignAmt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  }

  const _origRenderPOSCartV50 = window.renderPOSCart;
  if (typeof _origRenderPOSCartV50 === 'function') {
    window.renderPOSCart = function () {
      const result = _origRenderPOSCartV50.apply(this, arguments);
      const currency = getPosRefCurrency();

      // Clean up any previous reference spans first (handles switching
      // back to cash/base currency, or an empty cart).
      document.querySelectorAll('.pos-fx-ref').forEach(function (el) { el.remove(); });
      if (!currency || !POS_CART || !POS_CART.length) return result;

      const cartEl = document.getElementById('pos-cart-items');
      if (cartEl) {
        const rows = cartEl.children;
        POS_CART.forEach(function (item, i) {
          const row = rows[i];
          if (!row) return;
          const lineAmt = (typeof getCartLineAmounts === 'function') ? getCartLineAmounts(item) : { grand: item.sale_price * item.qty };
          const ref = formatForeignRef(lineAmt.grand, currency);
          if (!ref) return;
          const refEl = document.createElement('div');
          refEl.className = 'pos-fx-ref';
          refEl.style.cssText = 'font-size:10px;color:var(--gold3);text-align:right;width:80px;margin-top:1px';
          refEl.textContent = ref;
          // Insert right after the amount column (the 3rd child: name div, qty input, amount div).
          const amountDiv = row.children && row.children[2];
          if (amountDiv) amountDiv.insertAdjacentElement('afterend', refEl);
        });
      }

      const totalEl = document.getElementById('pos-total');
      if (totalEl && totalEl.parentElement) {
        const totals = (typeof getPOSTotals === 'function') ? getPOSTotals() : null;
        const ref = totals ? formatForeignRef(totals.total, currency) : '';
        if (ref) {
          const refEl = document.createElement('div');
          refEl.className = 'pos-fx-ref';
          refEl.style.cssText = 'font-size:11px;color:var(--gold3);text-align:right;margin-top:2px';
          refEl.textContent = ref;
          totalEl.parentElement.insertAdjacentElement('afterend', refEl);
        }
      }
      return result;
    };
  }

  const _origTogglePosCustomerPickerV50 = window.togglePosCustomerPicker;
  if (typeof _origTogglePosCustomerPickerV50 === 'function') {
    window.togglePosCustomerPicker = function () {
      const result = _origTogglePosCustomerPickerV50.apply(this, arguments);
      if (typeof renderPOSCart === 'function') renderPOSCart();
      return result;
    };
  }

  const _origInjectPOSCustomerCurrencyPickerV50 = window.injectPOSCustomerCurrencyPicker;
  if (typeof _origInjectPOSCustomerCurrencyPickerV50 === 'function') {
    window.injectPOSCustomerCurrencyPicker = function () {
      const result = _origInjectPOSCustomerCurrencyPickerV50.apply(this, arguments);
      const curEl = document.getElementById('pos-customer-currency');
      if (curEl && !curEl.dataset.v50Bound) {
        curEl.dataset.v50Bound = '1';
        curEl.addEventListener('change', function () { if (typeof renderPOSCart === 'function') renderPOSCart(); });
      }
      return result;
    };
  }

  console.log('✅ patch-v50.js loaded — POS cart now shows a foreign-currency reference alongside base currency for credit sales');
})();
