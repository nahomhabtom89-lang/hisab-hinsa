// ═══════════════════════════════════════════════════════════
// PATCH v16 — Prevent duplicate journal entries from double-clicking Confirm
// ═══════════════════════════════════════════════════════════
// None of the four "confirm and post" functions (Receipt Intake, Deliveries,
// PO Receiving, Material PO Receiving) had any protection against being
// triggered twice — no button lock, no in-progress flag. A double-click, or
// clicking again because the first click seemed unresponsive while the async
// save was still running, posts the exact same journal entry a second time,
// silently doubling Inventory and Accounts Payable. This is exactly what
// happened with the duplicate "Stock Receipt" entries from MEGAMART.
//
// This patch adds a simple re-entry guard around each of the four functions:
// if one is already running, a second call is blocked outright (with a
// console warning) instead of running through to completion again. This
// wraps the CURRENT version of each function — i.e. it sits on top of
// patch-v15's currency-tagging wraps for confirmReceiptIntake and
// confirmMaterialsDelivery, so both the guard and the fx-tagging still work
// together correctly.
//
// This does NOT retroactively fix any duplicate entries already posted (like
// the MEGAMART one in the screenshot) — those need to be deleted manually
// using the ✕ button already on each Journal entry.
// ═══════════════════════════════════════════════════════════

function guardAgainstDoubleSubmit(fn,label){
  let running=false;
  return async function(...args){
    if(running){
      console.warn(`⚠️ Blocked a duplicate submit of ${label} — it's already running.`);
      return;
    }
    running=true;
    try{
      return await fn.apply(this,args);
    }finally{
      running=false;
    }
  };
}

if(typeof window.confirmReceiptIntake==='function'){
  window.confirmReceiptIntake=guardAgainstDoubleSubmit(window.confirmReceiptIntake,'confirmReceiptIntake');
}
if(typeof window.confirmMaterialsDelivery==='function'){
  window.confirmMaterialsDelivery=guardAgainstDoubleSubmit(window.confirmMaterialsDelivery,'confirmMaterialsDelivery');
}
if(typeof window.confirmPOReceipt==='function'){
  window.confirmPOReceipt=guardAgainstDoubleSubmit(window.confirmPOReceipt,'confirmPOReceipt');
}
if(typeof window.confirmMaterialPOReceipt==='function'){
  window.confirmMaterialPOReceipt=guardAgainstDoubleSubmit(window.confirmMaterialPOReceipt,'confirmMaterialPOReceipt');
}

console.log('✅ patch-v16.js loaded — Confirm buttons now blocked from double-posting');
