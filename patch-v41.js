// ═══════════════════════════════════════════════════════════
// PATCH v41 — Readability fix: FX + discount rows were too cramped
// ═══════════════════════════════════════════════════════════
// Once patch-v38/v39 added the discount block onto an already-tight FX
// settlement column (Settle + At rate + pay-preview, all in one narrow
// <td>), the combined content got visually cramped — tiny 9-10px labels,
// a narrow rate input, hard to read. This patch does two things:
//
//  1. Widens and enlarges the Settle / At rate inputs and their labels
//     via injected CSS (no changes to any calculation logic at all).
//  2. Adds a clearly-visible "Live: 1 EUR = X USD" reference line right
//     next to the editable rate field, so it's obvious the live feed (or
//     your manual override, per patch-v34) is actually feeding a real
//     number in — separate from the editable box itself, which you can
//     still type over for this one payment as always.
//
// Purely cosmetic/informational — no money math changes here.
// ═══════════════════════════════════════════════════════════

(function () {
  const css = `
    td:has(.ps-fx-settle) > div, td:has(.ps-fx-rate) > div,
    td:has(.rp-fx-settle) > div, td:has(.rp-fx-rate) > div {
      font-size: 11px !important;
      margin-bottom: 3px !important;
    }
    .ps-fx-settle, .ps-fx-rate, .rp-fx-settle, .rp-fx-rate {
      width: 120px !important;
      font-size: 13px !important;
      padding: 7px 9px !important;
      margin-bottom: 2px !important;
    }
    [id^="ps-fx-pay-"], [id^="rp-fx-pay-"] {
      font-size: 12px !important;
      margin-top: 4px !important;
    }
    .ps-discount-block, .ps-fx-discount-block, .rp-discount-block, .rp-fx-discount-block {
      font-size: 12px !important;
      padding: 10px !important;
      line-height: 1.5 !important;
    }
    .ps-discount-status, .ps-fx-discount-status, .rp-discount-status, .rp-fx-discount-status {
      font-size: 12px !important;
    }
    .fx-live-rate-ref {
      font-size: 11px !important;
      color: var(--gold3, #d4a656) !important;
      margin: 3px 0 !important;
    }
  `;
  const styleTag = document.createElement('style');
  styleTag.id = 'v41-fx-readability';
  styleTag.textContent = css;
  document.head.appendChild(styleTag);

  // Adds a small "Live: 1 EUR = 1.10 USD" reference line right after each
  // rate input, purely informational — doesn't touch the editable value.
  function annotateLiveRateV41(inputClass, currencyLookupFn) {
    document.querySelectorAll('.' + inputClass).forEach(function (input) {
      const invoiceId = input.dataset.invoiceId;
      const refId = 'fxliveref-' + inputClass + '-' + invoiceId;
      if (document.getElementById(refId)) return; // already annotated
      const currency = currencyLookupFn(invoiceId);
      if (!currency) return;
      const live = (typeof fxCrossRate === 'function') ? fxCrossRate(currency) : null;
      const base = (typeof BASE_CURRENCY !== 'undefined' && BASE_CURRENCY) ? BASE_CURRENCY : 'USD';
      const ref = document.createElement('div');
      ref.id = refId;
      ref.className = 'fx-live-rate-ref';
      ref.textContent = live
        ? `Live: 1 ${currency} = ${(+live).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${base}`
        : `No live rate available for ${currency} — using the invoice's original rate`;
      input.insertAdjacentElement('afterend', ref);
    });
  }

  function refreshAnnotationsV41() {
    if (typeof PS_SUPPLIER_ID !== 'undefined' && PS_SUPPLIER_ID) {
      const open = (typeof getOpenAPInvoices === 'function') ? getOpenAPInvoices(PS_SUPPLIER_ID) : [];
      annotateLiveRateV41('ps-fx-rate', function (id) {
        const inv = open.find(function (x) { return String(x.id) === String(id); });
        return inv && inv.fx ? inv.fx.currency : null;
      });
    }
    if (typeof RP_CUSTOMER_ID !== 'undefined' && RP_CUSTOMER_ID) {
      const open = (typeof getOpenARInvoices === 'function') ? getOpenARInvoices(RP_CUSTOMER_ID) : [];
      annotateLiveRateV41('rp-fx-rate', function (id) {
        const inv = open.find(function (x) { return String(x.id) === String(id); });
        return inv && inv.fx ? inv.fx.currency : null;
      });
    }
  }

  const _origOpenPaySupplierModalV41 = window.openPaySupplierModal;
  if (typeof _origOpenPaySupplierModalV41 === 'function') {
    window.openPaySupplierModal = function (supplierId) {
      const result = _origOpenPaySupplierModalV41(supplierId);
      refreshAnnotationsV41();
      return result;
    };
  }
  const _origOpenReceivePaymentModalV41 = window.openReceivePaymentModal;
  if (typeof _origOpenReceivePaymentModalV41 === 'function') {
    window.openReceivePaymentModal = function (customerId) {
      const result = _origOpenReceivePaymentModalV41(customerId);
      refreshAnnotationsV41();
      return result;
    };
  }

  console.log('✅ patch-v41.js loaded — FX + discount rows are clearer now, with a visible live-rate reference');
})();
