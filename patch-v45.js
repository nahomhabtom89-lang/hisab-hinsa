// ═══════════════════════════════════════════════════════════
// PATCH v45 — Perpetual Inventory, Stage 3: Opening layers for old stock
// ═══════════════════════════════════════════════════════════
// Not strictly required for correctness — computeFifoCost() (patch-v44)
// already gracefully falls back to blended cost_price for any quantity
// not covered by tracked layers, so nothing breaks without this. What
// this DOES add: stability. Without an opening layer, that fallback
// recalculates against cost_price fresh every time old stock sells, and
// cost_price can drift as new purchases come in. With an explicit
// opening layer, that starting quantity's cost is locked in once, the
// same way every other layer already works.
//
// Runs once per product, automatically, on login — idempotent (checks
// whether tracked layers already cover the product's quantity before
// doing anything, so it's safe even if it runs on every login forever).
// ═══════════════════════════════════════════════════════════

async function migrateOpeningLayersV45(){
  if(!Array.isArray(RETAIL_PRODUCTS))return;
  for(const product of RETAIL_PRODUCTS){
    const qty=parseFloat(product.qty)||0;
    if(qty<=0.0001)continue;
    const layers=Array.isArray(product.layers)?product.layers:[];
    const trackedQty=layers.reduce((s,l)=>s+(parseFloat(l.qty)||0),0);
    const shortfall=+(qty-trackedQty).toFixed(4);
    if(shortfall<=0.0001)continue; // already fully covered by real layers, nothing to do
    const openingLayer={qty:shortfall,unitCost:parseFloat(product.cost_price)||0,date:'opening-balance'};
    product.layers=layers.concat([openingLayer]);
    try{
      await dbApi({action:'saveProduct',companyId:SESSION.companyId,id:product.id,name:product.name,sku:product.sku,barcode:product.barcode,category:product.category,sale_price:product.sale_price,cost_price:product.cost_price,qty:product.qty,min_qty:product.min_qty,unit:product.unit,tax_tier_id:product.tax_tier_id,price_inclusive:product.price_inclusive,layers:product.layers});
    }catch(e){console.error('patch-v45: failed to save opening layer for',product.name,e);}
  }
}
window.migrateOpeningLayersV45=migrateOpeningLayersV45;

const _origEnterCompanyV45=window.enterCompany;
if(typeof _origEnterCompanyV45==='function'){
  window.enterCompany=async function(c){
    const result=await _origEnterCompanyV45(c);
    migrateOpeningLayersV45(); // fire-and-forget, doesn't block login
    return result;
  };
}

console.log('✅ patch-v45.js loaded — Perpetual Inventory Stage 3: existing stock now gets a stable opening layer');
