// ═══════════════════════════════════════════════════════════
// PATCH v49 — Clearer Live/Manual rate widget in Pay Supplier / Receive Payment
// ═══════════════════════════════════════════════════════════
// Replaces the plain "At rate" number field with the same Live/Manual
// radio-button style already used on every currency picker (patch-v34) —
// "○ Live (1 USD = 0.86 EUR)" / "● Manual: 1 USD = [___] EUR" — instead
// of one small number box you have to guess the meaning of.
//
// IMPORTANT — what this does NOT change: the underlying .ps-fx-rate /
// .rp-fx-rate input that recordSupplierPayment()/recordCustomerPayment()
// actually read at submit time keeps EXACTLY the same value and meaning
// it always had ("1 <foreign currency> = ? <base currency>") — the whole
// payment/discount/FX-gain-loss math from v38/v39 is completely
// untouched. This patch only changes how that value gets SET: instead of
// typing straight into a "1 EUR = ?" box, you pick Live or type "1 USD =
// ?" (matching the convention used everywhere else in the app), and this
// patch converts that into the correct underlying rate automatically.
// ═══════════════════════════════════════════════════════════

(function () {
  // Converts the more intuitive "1 USD = ? currency" number into the
  // "1 currency = ? USD" convention the payment math actually uses.
  function usdToForeignAsForeignToUsd(usdToForeignRate) {
    if (!usdToForeignRate || usdToForeignRate <= 0) return null;
    return +(1 / usdToForeignRate).toFixed(6);
  }

  function buildRateWidgetHtml(prefix, invoiceId, currency, liveUsdToForeign, currentForeignToUsd) {
    const base = (typeof BASE_CURRENCY !== 'undefined' && BASE_CURRENCY) ? BASE_CURRENCY : 'USD';
    // Guess whether the currently-set rate matches "live" or looks manual.
    const liveForeignToUsd = liveUsdToForeign ? +(1 / liveUsdToForeign).toFixed(6) : null;
    const isLive = liveForeignToUsd != null && Math.abs((currentForeignToUsd || 0) - liveForeignToUsd) < 0.0005;
    const manualGuess = isLive ? '' : (currentForeignToUsd ? (+(1 / currentForeignToUsd)).toFixed(4) : '');
    return `<div class="${prefix}-rate-picker" data-invoice-id="${invoiceId}" style="font-size:11px;color:var(--text3);margin-top:2px">
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;margin-bottom:3px">
        <input type="radio" name="${prefix}-ratemode-${invoiceId}" class="${prefix}-ratemode-live" data-invoice-id="${invoiceId}" ${isLive ? 'checked' : ''} onchange="window.__v49OnRateModeChange('${prefix}',${invoiceId})"/>
        ${liveUsdToForeign ? `Live (1 ${base} = ${liveUsdToForeign.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${currency})` : `Live — no rate available for ${currency}`}
      </label>
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
        <input type="radio" name="${prefix}-ratemode-${invoiceId}" class="${prefix}-ratemode-manual" data-invoice-id="${invoiceId}" ${isLive ? '' : 'checked'} onchange="window.__v49OnRateModeChange('${prefix}',${invoiceId})"/>
        Manual: 1 ${base} =
        <input type="number" step="0.0001" class="${prefix}-manual-usd-rate" data-invoice-id="${invoiceId}" value="${manualGuess}" placeholder="rate" style="width:80px;background:var(--bg2);border:1px solid var(--border2);border-radius:4px;padding:4px 6px;color:var(--text);font-family:'JetBrains Mono',monospace;font-size:11px" oninput="window.__v49OnManualRateInput('${prefix}',${invoiceId})"/>
        ${currency}
      </label>
    </div>`;
  }

  window.__v49OnRateModeChange = function (prefix, invoiceId) {
    const liveRadio = document.querySelector(`.${prefix}-ratemode-live[data-invoice-id="${invoiceId}"]`);
    const hiddenRate = document.querySelector(`.${prefix}-fx-rate[data-invoice-id="${invoiceId}"]`);
    if (!hiddenRate) return;
    if (liveRadio && liveRadio.checked) {
      const currencyEl = hiddenRate.dataset.currency;
      const live = currencyEl ? fxCrossRate(currencyEl) : null;
      if (live) hiddenRate.value = (+live).toFixed(6);
    }
    hiddenRate.dispatchEvent(new Event('input', { bubbles: true }));
  };

  window.__v49OnManualRateInput = function (prefix, invoiceId) {
    const manualEl = document.querySelector(`.${prefix}-manual-usd-rate[data-invoice-id="${invoiceId}"]`);
    const manualRadio = document.querySelector(`.${prefix}-ratemode-manual[data-invoice-id="${invoiceId}"]`);
    const hiddenRate = document.querySelector(`.${prefix}-fx-rate[data-invoice-id="${invoiceId}"]`);
    if (!manualEl || !hiddenRate) return;
    if (manualRadio) manualRadio.checked = true; // typing implies manual mode
    const usdToForeign = parseFloat(manualEl.value);
    const converted = usdToForeignAsForeignToUsd(usdToForeign);
    if (converted) hiddenRate.value = converted;
    hiddenRate.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // Post-processes the rendered rows in the DOM once the modal is open,
  // since regex-matching already-rendered dynamic HTML (with real numbers
  // substituted in) is fragile — this runs right after
  // openPaySupplierModal / openReceivePaymentModal finish building rows.
  function upgradeRateFieldsV49(prefix, invoices) {
    invoices.forEach(function (inv) {
      if (!inv.fx) return;
      const oldInput = document.querySelector(`.${prefix}-fx-rate[data-invoice-id="${inv.id}"]`);
      if (!oldInput || oldInput.dataset.v49Upgraded) return;
      oldInput.dataset.v49Upgraded = '1';
      oldInput.dataset.currency = inv.fx.currency;
      const currentForeignToUsd = parseFloat(oldInput.value) || null;
      const liveUsdToForeign = (typeof getDisplayRate === 'function') ? getDisplayRate(inv.fx.currency) : null;
      const widget = document.createElement('div');
      widget.innerHTML = buildRateWidgetHtml(prefix, inv.id, inv.fx.currency, liveUsdToForeign, currentForeignToUsd);
      oldInput.style.display = 'none'; // keep it in the DOM (submit code still reads it), just hide it visually
      oldInput.insertAdjacentElement('afterend', widget.firstElementChild);
    });
  }

  const _origOpenPaySupplierModalV49 = window.openPaySupplierModal;
  if (typeof _origOpenPaySupplierModalV49 === 'function') {
    window.openPaySupplierModal = function (supplierId) {
      const result = _origOpenPaySupplierModalV49(supplierId);
      const open = getOpenAPInvoices(supplierId);
      upgradeRateFieldsV49('ps', open);
      return result;
    };
  }
  const _origOpenReceivePaymentModalV49 = window.openReceivePaymentModal;
  if (typeof _origOpenReceivePaymentModalV49 === 'function') {
    window.openReceivePaymentModal = function (customerId) {
      const result = _origOpenReceivePaymentModalV49(customerId);
      const open = getOpenARInvoices(customerId);
      upgradeRateFieldsV49('rp', open);
      return result;
    };
  }

  console.log('✅ patch-v49.js loaded — clearer Live/Manual rate picker in Pay Supplier and Receive Payment');
})();
