// ═══════════════════════════════════════════════════════════
// PATCH v48 — Fix: respect the existing WAC/FIFO Settings toggle
// ═══════════════════════════════════════════════════════════
// Settings → Inventory Costing already has a WAC/FIFO switch
// (INV_COSTING_METHOD, company-wide, defaults to 'WAC') — it's been there
// since before this session. Turns out it never actually did anything:
// getMaterialAvgCost() always computed weighted-average regardless of
// which button was selected, and retail products didn't have any
// FIFO-capable calculation at all until patch-v43-v47 built one tonight.
// Those patches built real FIFO — but didn't check this existing setting
// before using it, so a company that had deliberately chosen WAC would
// have been silently switched to FIFO. This patch fixes that: layers
// still get recorded either way (harmless, and means switching to FIFO
// later has real history to work with), but the actual calculations now
// branch on the setting, same as the toggle always implied they would.
//
//  - INV_COSTING_METHOD === 'FIFO': behaves exactly as v43-v47 already
//    built — true batch-by-batch FIFO cost and the precise Inventory/COGS
//    discount split.
//  - INV_COSTING_METHOD === 'WAC' (the default): COGS uses the blended
//    average cost_price x qty, exactly like the app always did before
//    tonight — and the purchase-discount split falls back to the simple
//    100% "Purchase Discount Received" treatment (v36's original design),
//    since WAC philosophically blends every unit together and has no
//    concept of "which specific units are still on hand."
// ═══════════════════════════════════════════════════════════

const _origComputeFifoCostV48 = window.computeFifoCost;
window.computeFifoCost = function(productId, qty){
  const product = RETAIL_PRODUCTS.find(p=>p.id===productId);
  if(!product) return 0;
  if((typeof INV_COSTING_METHOD!=='undefined'?INV_COSTING_METHOD:'WAC')!=='FIFO'){
    // WAC selected — same calculation the app always used before tonight.
    return (parseFloat(qty)||0) * (parseFloat(product.cost_price)||0);
  }
  return _origComputeFifoCostV48(productId, qty);
};

const _origComputePreciseDiscountSplitV48 = window.computePreciseDiscountSplitV47;
if(typeof _origComputePreciseDiscountSplitV48 === 'function'){
  window.computePreciseDiscountSplitV47 = function(invoiceEntry, discountAmt){
    if((typeof INV_COSTING_METHOD!=='undefined'?INV_COSTING_METHOD:'WAC')!=='FIFO'){
      // WAC selected — no per-layer remaining quantity to split against,
      // so this falls back to the simple, original treatment: the whole
      // discount posts to Purchase Discount Received, exactly as v36
      // originally worked.
      return { inventoryCredits:[], cogsCredit:0, fallbackToOther:discountAmt };
    }
    return _origComputePreciseDiscountSplitV48(invoiceEntry, discountAmt);
  };
}

console.log('✅ patch-v48.js loaded — FIFO vs WAC now correctly follows your existing Settings → Inventory Costing choice');
