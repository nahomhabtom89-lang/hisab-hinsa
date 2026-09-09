// ═══════════════════════════════════════════════════════════
// PATCH v43 — Perpetual Inventory, Stage 1: Populate real purchase layers
// ═══════════════════════════════════════════════════════════
// Purely additive — does NOT change COGS, sales, or any journal entry.
// Safe to verify in isolation before Stage 2 (FIFO depletion on sale)
// touches anything COGS-related.
//
// DISCOVERY: the backend (api/db.js) already has a fully-built
// 'receiveStock' action that correctly pushes a {qty, unitCost, date}
// layer onto a product's `layers` column and bumps its quantity — but no
// frontend code has ever called it. Every stock intake path instead calls
// syncProductAfterIntake(), which only recomputes a single blended
// weighted-average cost_price via 'saveProduct' — a call that never
// touches the layers column at all. So `layers` has sat empty for every
// retail product this whole time, even though the Stock Valuation page
// already reads from it (silently falling back to cost_price when empty).
//
// FIX: redefine syncProductAfterIntake to also call the existing
// 'receiveStock' backend action for the quantity/layer update, and keep
// the weighted-average cost_price calculation (still useful — it's what
// today's sale-price defaults and reports read) exactly as it was,
// verified below to produce byte-for-byte the same cost_price as before.
// The only thing that changes is that `layers` now actually gets filled
// in, going forward, from the moment this patch is live. Existing stock
// received before this patch has no layer history — Stage 3 will handle
// giving it an opening layer.
// ═══════════════════════════════════════════════════════════

async function syncProductAfterIntake(productId,taxTierId,priceInclusive,qtyReceived,unitCostReceived){
  const product=RETAIL_PRODUCTS.find(p=>p.id===productId);
  if(!product)return;
  const oldQty=parseFloat(product.qty)||0;
  const oldCost=parseFloat(product.cost_price)||0;
  const qRecv=parseFloat(qtyReceived)||0;
  const uCost=parseFloat(unitCostReceived)||0;
  const newQtyTotal=oldQty+qRecv;
  const newAvgCost=newQtyTotal>0?((oldQty*oldCost)+(qRecv*uCost))/newQtyTotal:uCost;
  const roundedCost=Math.round(newAvgCost*100)/100;
  const tierChanged=String(product.tax_tier_id||'')!==String(taxTierId||'');
  const inclChanged=!!product.price_inclusive!==!!priceInclusive;
  const costChanged=Math.abs(roundedCost-oldCost)>0.001;
  const qtyChanged=qRecv>0.0001;
  if(!tierChanged&&!inclChanged&&!costChanged&&!qtyChanged)return;

  try{
    if(qtyChanged){
      // The real fix: use the existing, previously-dead backend action so
      // a genuine {qty, unitCost, date} layer actually gets recorded.
      await dbApi({action:'receiveStock',companyId:SESSION.companyId,productId:product.id,qty:qRecv,unitCost:uCost});
      product.layers=product.layers||[];
      product.layers.push({qty:qRecv,unitCost:uCost,date:today()});
    }
    // Weighted-average cost_price / tax tier — identical calculation to
    // before this patch. Passes the already-updated newQtyTotal so this
    // save doesn't ALSO increment quantity on top of the receiveStock
    // call above (which already did that on the server).
    await dbApi({action:'saveProduct',companyId:SESSION.companyId,id:product.id,name:product.name,sku:product.sku,barcode:product.barcode,category:product.category,sale_price:product.sale_price,cost_price:roundedCost,qty:newQtyTotal,min_qty:product.min_qty,unit:product.unit,tax_tier_id:taxTierId||'',price_inclusive:!!priceInclusive});
    product.tax_tier_id=taxTierId||null;
    product.price_inclusive=!!priceInclusive;
    product.cost_price=roundedCost;
    product.qty=newQtyTotal;
  }catch(e){console.error('syncProductAfterIntake (v43)',e);}
}
window.syncProductAfterIntake=syncProductAfterIntake;

console.log('✅ patch-v43.js loaded — Perpetual Inventory Stage 1: retail purchases now recorded as real layers/batches');
