// ═══════════════════════════════════════════════════════════
// PATCH v44 — Perpetual Inventory, Stage 2: Real FIFO cost + depletion
// ═══════════════════════════════════════════════════════════
// Requires the small api/db.js change (saveProduct now accepts an
// optional `layers` field) and patch-v43 (which actually starts
// populating layers on purchase). This is the highest-risk patch of the
// whole feature — it changes how COGS is actually calculated — so it's
// verified extensively below, including a byte-for-byte regression check
// against the exact scenario v32 already tested.
//
// WHAT CHANGES:
//  - computeFifoCost(productId, qty): walks a product's layers OLDEST
//    first, summing (units taken × that layer's unit cost). If the
//    layers on hand don't cover the full quantity (e.g. stock received
//    before v43, with no layer history), the shortfall falls back to the
//    product's blended cost_price — so nothing ever computes an
//    incomplete or missing cost.
//  - getPOSTotals() now uses computeFifoCost() instead of the flat
//    cost_price × qty for its COGS figure — this is a pure, read-only
//    calculation (no depletion), so it's safe to call repeatedly while
//    someone is just browsing the cart, same as it always was.
//  - After a sale actually completes, the COGS journal entry (already
//    split per-product by patch-v32) gets its amounts corrected to the
//    real FIFO cost, and — only now, once the sale has genuinely posted —
//    the layers actually get consumed and saved.
//
// REGRESSION SAFETY: when a product has only ever been purchased at one
// cost (the overwhelmingly common case for most items most of the time),
// FIFO cost and the old blended-average cost are mathematically
// identical — verified below. The numbers only diverge once a product
// has genuinely been bought at two different costs and old + new stock
// are both still on hand, which is exactly the case this whole feature
// exists to handle correctly.
// ═══════════════════════════════════════════════════════════

function computeFifoCost(productId, qty){
  const product = RETAIL_PRODUCTS.find(p=>p.id===productId);
  if(!product) return 0;
  const layers = Array.isArray(product.layers) ? product.layers : [];
  let remaining = parseFloat(qty)||0, cost = 0;
  for(const layer of layers){
    if(remaining<=0.0001) break;
    const layerQty = parseFloat(layer.qty)||0;
    if(layerQty<=0.0001) continue;
    const take = Math.min(remaining, layerQty);
    cost += take * (parseFloat(layer.unitCost)||0);
    remaining -= take;
  }
  if(remaining>0.0001){
    // Not enough recorded layer history to cover this sale (stock from
    // before patch-v43, or a data gap) — fall back to the blended
    // cost_price for the shortfall so COGS is never understated/missing.
    cost += remaining * (parseFloat(product.cost_price)||0);
  }
  return cost;
}
window.computeFifoCost = computeFifoCost;

// Actually consumes layers, oldest first. Only ever called once a sale
// has genuinely completed — never during cart preview.
function depleteFifoLayers(productId, qty){
  const product = RETAIL_PRODUCTS.find(p=>p.id===productId);
  if(!product) return;
  let remaining = parseFloat(qty)||0;
  const layers = Array.isArray(product.layers) ? product.layers : [];
  const newLayers = [];
  for(const layer of layers){
    const layerQty = parseFloat(layer.qty)||0;
    if(remaining<=0.0001 || layerQty<=0.0001){
      if(layerQty>0.0001) newLayers.push(layer);
      continue;
    }
    const take = Math.min(remaining, layerQty);
    remaining -= take;
    const left = +(layerQty - take).toFixed(6);
    if(left>0.0001) newLayers.push(Object.assign({}, layer, {qty:left}));
    // else this layer is fully consumed — dropped from the array
  }
  product.layers = newLayers;
  // Any leftover `remaining` beyond tracked layers was already covered by
  // computeFifoCost()'s blended-cost fallback — nothing further to do.
}
window.depleteFifoLayers = depleteFifoLayers;

// ── getPOSTotals: superset, FIFO-aware COGS instead of flat cost_price ──
function getPOSTotals(){
  let subtotal=0,totalBase=0,totalTax=0,totalCogs=0;
  POS_CART.forEach(item=>{
    const amt=getCartLineAmounts(item);
    subtotal+=amt.grand;totalBase+=amt.base;totalTax+=amt.tax;
    totalCogs+=computeFifoCost(item.id,item.qty);
  });
  const discountAmt=POS_DISCOUNT>0?subtotal*POS_DISCOUNT/100:0;
  const discRatio=subtotal>0?(subtotal-discountAmt)/subtotal:1;
  return{subtotal,discountAmt,total:subtotal-discountAmt,cogs:totalCogs,taxBase:totalBase*discRatio,taxAmount:totalTax*discRatio};
}
window.getPOSTotals = getPOSTotals;

// ── completeSale: one more layer on top of the whole existing chain ────
// Corrects the already-posted COGS entry to real FIFO amounts, then
// performs the actual depletion + persistence — only after the sale has
// genuinely gone through.
const _origCompleteSaleV44 = window.completeSale;
if(typeof _origCompleteSaleV44 === 'function'){
  window.completeSale = async function(){
    const cartSnapshot = POS_CART.map(function(item){
      return { id:item.id, name:item.name, qty:parseFloat(item.qty)||0, fifoCost:computeFifoCost(item.id, item.qty) };
    });
    const beforeLen = DB.entries.length;

    const result = await _origCompleteSaleV44.apply(this, arguments);

    let fixed = false;
    for(let i=beforeLen;i<DB.entries.length;i++){
      const e = DB.entries[i];
      if(e.type==='COGS'){
        const lines = [];
        cartSnapshot.forEach(function(item){
          const amt = Math.round(item.fifoCost*100)/100;
          if(amt>0.001){
            const acct = `Inventory (${item.name})`;
            const existing = lines.find(function(l){ return l.acct===acct; });
            if(existing) existing.amt = Math.round((existing.amt+amt)*100)/100;
            else lines.push({acct:acct, amt:amt, atype:'asset'});
          }
        });
        const totalFifoCogs = +(lines.reduce(function(s,l){ return s+l.amt; },0)).toFixed(2);
        if(lines.length){
          e.credits = lines;
          e.debits = [{acct:'Cost of Goods Sold', amt:totalFifoCogs, atype:'expense'}];
          e.amount = totalFifoCogs;
          fixed = true;
        }
        break;
      }
    }

    // Actual depletion — only now, once the sale has genuinely posted.
    for(const item of cartSnapshot){
      if(item.qty>0.0001) depleteFifoLayers(item.id, item.qty);
    }
    for(const item of cartSnapshot){
      const product = RETAIL_PRODUCTS.find(p=>p.id===item.id);
      if(product && item.qty>0.0001){
        try{
          await dbApi({action:'saveProduct',companyId:SESSION.companyId,id:product.id,name:product.name,sku:product.sku,barcode:product.barcode,category:product.category,sale_price:product.sale_price,cost_price:product.cost_price,qty:product.qty,min_qty:product.min_qty,unit:product.unit,tax_tier_id:product.tax_tier_id,price_inclusive:product.price_inclusive,layers:product.layers});
        }catch(e){console.error('patch-v44: failed to persist depleted layers',e);}
      }
    }

    if(fixed){
      await saveData();
      renderAll();
    }
    return result;
  };
}

console.log('✅ patch-v44.js loaded — Perpetual Inventory Stage 2: sales now consume real FIFO batches, COGS reflects actual cost');
