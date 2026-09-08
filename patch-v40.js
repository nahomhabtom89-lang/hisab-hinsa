// ═══════════════════════════════════════════════════════════
// PATCH v40 — Fix: manual "Receive Stock" (no PO) never got FX-tagged
// ═══════════════════════════════════════════════════════════
// A pre-existing gap, not something introduced by the Early Payment
// Discount work — patch-v15 (multi-currency arc) correctly built
// tagLastEntryWithFx() and wired it into the AI-receipt-review flow
// (confirmReceiptIntake) and Construction Deliveries
// (confirmMaterialsDelivery), but the plain manual "Receive Stock" form
// with no purchase order (receiveStock(), the "MANUAL STOCK INTAKE"
// section) was never connected to it. So a credit purchase entered
// through that specific form — even with a foreign Invoice Currency
// explicitly selected — never got entry.fx set, meaning Pay Supplier had
// nothing to show a foreign-currency settle/rate row for. This is exactly
// what surfaced while testing the discount+FX combination (patch-v38):
// the discount was tagging correctly (that's patch-v35, unaffected), but
// the FX side had nothing to attach to.
//
// FIX: reuse the existing tagLastEntryWithFx(currency) helper (already
// defined globally by patch-v15) — no need to reimplement any logic, just
// wire it into receiveStock() the same way it's already wired into the
// other two intake paths.
// ═══════════════════════════════════════════════════════════

const _origReceiveStockV40 = window.receiveStock;
if (typeof _origReceiveStockV40 === 'function') {
  window.receiveStock = async function () {
    const cur = (document.getElementById('si-currency') || {}).value || 'USD';
    const result = await _origReceiveStockV40.apply(this, arguments);
    if (typeof tagLastEntryWithFx === 'function') tagLastEntryWithFx(cur);
    return result;
  };
}

console.log('✅ patch-v40.js loaded — manual Receive Stock (no PO) now tags foreign-currency purchases for FX tracking too');
