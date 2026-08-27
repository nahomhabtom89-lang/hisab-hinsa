// ═══════════════════════════════════════════════════════════
// PATCH v17 — "Confirming..." button feedback for the four post-to-ledger actions
// ═══════════════════════════════════════════════════════════
// patch-v16 confirmed working (blocked 4 of 5 rapid taps, only 1 entry
// posted) — but the underlying reason people tap repeatedly is that nothing
// on screen visibly changes when they tap once, so it's natural to assume it
// didn't register. This patch makes the button itself show the state clearly:
// it becomes disabled and says "⏳ Confirming..." for the whole duration of
// the real operation, then reverts.
//
// This wraps the ALREADY-GUARDED functions from patch-v16 with its own,
// SEPARATE in-flight flag — deliberately not just re-using v16's guard
// directly. Here's why that distinction matters: if a blocked (duplicate)
// call were allowed to touch the button, its near-instant "finally" cleanup
// would re-enable the button and erase "Confirming..." WHILE the real,
// still-running first call is genuinely still in progress underneath —
// exactly undoing the feedback we're trying to add. With this patch's own
// flag, only the call that actually gets through controls the button; every
// blocked extra tap is invisible to it, exactly as it should be.
// ═══════════════════════════════════════════════════════════

function withConfirmFeedback(fn,onclickPrefix){
  let inFlight=false;
  return async function(...args){
    if(inFlight){
      // Another tap is already genuinely in progress — don't touch the
      // button (it's already correctly showing "Confirming..."). Just pass
      // this call straight through; patch-v16's own guard will block it.
      return fn.apply(this,args);
    }
    inFlight=true;
    const btn=document.querySelector(`[onclick^="${onclickPrefix}("]`);
    let originalText=null;
    if(btn){
      originalText=btn.textContent;
      btn.disabled=true;
      btn.textContent='⏳ Confirming...';
      btn.style.opacity='0.6';
      btn.style.cursor='not-allowed';
    }
    try{
      return await fn.apply(this,args);
    }finally{
      inFlight=false;
      if(btn){
        btn.disabled=false;
        btn.textContent=originalText;
        btn.style.opacity='';
        btn.style.cursor='';
      }
    }
  };
}

if(typeof window.confirmReceiptIntake==='function'){
  window.confirmReceiptIntake=withConfirmFeedback(window.confirmReceiptIntake,'confirmReceiptIntake');
}
if(typeof window.confirmMaterialsDelivery==='function'){
  window.confirmMaterialsDelivery=withConfirmFeedback(window.confirmMaterialsDelivery,'confirmMaterialsDelivery');
}
if(typeof window.confirmPOReceipt==='function'){
  window.confirmPOReceipt=withConfirmFeedback(window.confirmPOReceipt,'confirmPOReceipt');
}
if(typeof window.confirmMaterialPOReceipt==='function'){
  window.confirmMaterialPOReceipt=withConfirmFeedback(window.confirmMaterialPOReceipt,'confirmMaterialPOReceipt');
}

console.log('✅ patch-v17.js loaded — Confirm buttons now show "Confirming..." while posting');
