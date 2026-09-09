// ═══════════════════════════════════════════════════════════
// PATCH v46 — Perpetual Inventory, Stage 4a: Link layers back to their invoice
// ═══════════════════════════════════════════════════════════
// Needed for the precise purchase-discount split (Stage 4b, next): to know
// how much of a SPECIFIC purchase is still on hand at payment time, each
// layer needs to know which invoice created it. patch-v43 pushes a new
// layer per product per purchase, always as the LAST element in that
// product's layers array — so right after a purchase fully completes
// (entry pushed, product synced), the most recently added layer on each
// product debited by that entry IS the one it just created. This patch
// tags it with that entry's id.
// ═══════════════════════════════════════════════════════════

function tagNewLayersWithInvoiceV46(){
  if(!DB||!DB.entries||!DB.entries.length)return;
  const entry=DB.entries[DB.entries.length-1];
  if(!entry)return;
  const touchedProducts=[];
  (entry.debits||[]).forEach(function(line){
    const m=/^Inventory \((.+)\)$/.exec(line.acct);
    if(!m)return;
    const productName=m[1];
    const product=RETAIL_PRODUCTS.find(function(p){ return p.name===productName; });
    if(!product||!Array.isArray(product.layers)||!product.layers.length)return;
    const lastLayer=product.layers[product.layers.length-1];
    if(lastLayer&&lastLayer.invoiceId==null){
      lastLayer.invoiceId=entry.id;
      // Also capture the layer's starting quantity, separately from its
      // current (depleting) qty — needed by Stage 4b to compute what
      // fraction of THIS specific purchase is still on hand at payment
      // time. Safe to set here since nothing has depleted this layer yet.
      if(lastLayer.originalQty==null) lastLayer.originalQty=lastLayer.qty;
      touchedProducts.push(product);
    }
  });
  touchedProducts.forEach(async function(product){
    try{
      await dbApi({action:'saveProduct',companyId:SESSION.companyId,id:product.id,name:product.name,sku:product.sku,barcode:product.barcode,category:product.category,sale_price:product.sale_price,cost_price:product.cost_price,qty:product.qty,min_qty:product.min_qty,unit:product.unit,tax_tier_id:product.tax_tier_id,price_inclusive:product.price_inclusive,layers:product.layers});
    }catch(e){console.error('patch-v46: failed to persist layer invoice tag for',product.name,e);}
  });
}
window.tagNewLayersWithInvoiceV46=tagNewLayersWithInvoiceV46;

function wrapForLayerTaggingV46(fnName){
  const orig=window[fnName];
  if(typeof orig!=='function')return;
  window[fnName]=async function(){
    const beforeLen=DB.entries.length;
    const result=await orig.apply(this,arguments);
    if(DB.entries.length>beforeLen) tagNewLayersWithInvoiceV46();
    return result;
  };
}
wrapForLayerTaggingV46('receiveStock');
wrapForLayerTaggingV46('confirmReceiptIntake');

console.log('✅ patch-v46.js loaded — Perpetual Inventory Stage 4a: purchase layers now link back to their invoice');
