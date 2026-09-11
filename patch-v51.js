// ═══════════════════════════════════════════════════════════
// PATCH v51 — Extend duplicate-click protection to Receive Stock & POS sale
// ═══════════════════════════════════════════════════════════
// patch-v16/v17 built solid double-tap protection (a re-entry guard +
// "⏳ Confirming..." button feedback) — but only wired it into FOUR
// functions: confirmReceiptIntake, confirmMaterialsDelivery,
// confirmPOReceipt, confirmMaterialPOReceipt. Two important ones were
// missed entirely:
//   - receiveStock() — the plain manual "Receive Stock" form (no PO) —
//     the exact screen in the screenshot showing four identical $8.86
//     "Stock received: fhz/ — apple" entries from rapid taps.
//   - completeSale() — POS Register's "Complete Sale" button, flagged as
//     the same risk on the sales side.
//
// FIX: reuses v16/v17's own guardAgainstDoubleSubmit() and
// withConfirmFeedback() helpers directly (they're already global
// functions) — no new logic to write or verify from scratch, just wiring
// the same proven protection onto the two functions that were missed.
// Applied as the OUTERMOST wrap on each — after every other patch tonight
// (terms tagging, fx tagging, FIFO, discount splitting, etc.) — so the
// button lock covers the ENTIRE operation start to finish, and a second
// tap is blocked before any of that inner logic even starts.
//
// This does NOT retroactively remove duplicate entries already created
// (like the four $8.86 ones in the screenshot) — those still need
// deleting manually with the ✕ button on each Journal entry, same as v16
// noted for its original fix.
// ═══════════════════════════════════════════════════════════

if(typeof window.receiveStock==='function' && typeof guardAgainstDoubleSubmit==='function' && typeof withConfirmFeedback==='function'){
  window.receiveStock=withConfirmFeedback(guardAgainstDoubleSubmit(window.receiveStock,'receiveStock'),'receiveStock');
}
if(typeof window.completeSale==='function' && typeof guardAgainstDoubleSubmit==='function' && typeof withConfirmFeedback==='function'){
  window.completeSale=withConfirmFeedback(guardAgainstDoubleSubmit(window.completeSale,'completeSale'),'completeSale');
}

console.log('✅ patch-v51.js loaded — Receive Stock and Complete Sale are now also protected from duplicate double-tap posting');
