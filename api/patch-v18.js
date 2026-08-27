// ═══════════════════════════════════════════════════════════
// PATCH v18 — Forex Adjustments, Phase 1b: PO-based Accounts Payable
// ═══════════════════════════════════════════════════════════
// Extends patch-v15's fx tagging to Purchase Order receiving (retail PO
// receiving via confirmPOReceipt, and construction material PO receiving via
// confirmMaterialPOReceipt). These two work differently from Receipt Intake
// and Deliveries: a PO can be created today and received weeks later, and by
// receiving time the cost fields on screen are already pre-filled numbers
// converted to base currency back when the PO was FIRST created — no
// currency picker exists at receiving time at all.
//
// This means the rate that actually matters for tagging isn't "today's live
// rate" — it's whatever rate was used back at PO creation, since that's what
// actually produced the base-currency numbers that end up posted. So this
// patch:
//
// 1. Captures the currency + the exact cross-rate used at PO creation time
//    (submitPurchaseOrder / submitMaterialPurchaseOrder) and saves both with
//    the PO record itself (see the matching api/db.js update — new
//    `currency`/`fx_rate` columns on hh_purchase_orders).
// 2. At receiving time, reads that SAME saved currency + rate back off the
//    PO record (already cached client-side in PO_ORDERS) and tags the
//    resulting journal entry with it — reusing the exact rate, not a fresh
//    live lookup, so the tag matches what was actually posted.
//
// tagLastEntryWithFx() is redefined here to accept an optional second
// argument (an explicit rate). Called with just one argument, as
// patch-v15's existing wraps do, it behaves identically to before — this is
// a strict superset, not a behavior change for the cases already working.
// ═══════════════════════════════════════════════════════════

function fxCrossRate(fromCurrency){
  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  if(!fromCurrency||fromCurrency===base)return 1;
  const fromRate=getDisplayRate(fromCurrency);
  const baseRate=getDisplayRate(base);
  if(!fromRate||!baseRate)return null;
  return baseRate/fromRate;
}

function tagLastEntryWithFx(currency,explicitRate){
  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  if(!currency||currency===base)return;
  const rate=explicitRate||fxCrossRate(currency);
  if(!rate)return;
  if(!DB||!DB.entries||!DB.entries.length)return;
  const entry=DB.entries[DB.entries.length-1];
  if(!entry||entry.fx)return;
  const apLine=(entry.credits||[]).find(l=>l.acct==='Accounts Payable')
             ||(entry.debits||[]).find(l=>l.acct==='Accounts Payable');
  if(!apLine)return;
  entry.fx={currency,rate,originalAmount:+(apLine.amt/rate).toFixed(4)};
  if(typeof saveData==='function')saveData();
}

// ── Capture currency + rate at PO creation, save it with the PO record ─────
// dbApi is already wrapped (patch-v8, for register/createCompany) — this
// chains onto whatever's currently there and only acts on savePurchaseOrder.
const _origDbApiV18=window.dbApi;
if(typeof _origDbApiV18==='function'){
  window.dbApi=function(body){
    if(body&&body.action==='savePurchaseOrder'&&!body.currency){
      const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
      const isConstruction=body.kind==='construction_materials';
      const curEl=document.getElementById(isConstruction?'mpo-currency':'po-currency');
      const cur=curEl?curEl.value:null;
      if(cur&&cur!==base){
        body.currency=cur;
        body.fxRate=fxCrossRate(cur);
      }
    }
    return _origDbApiV18(body);
  };
}

// ── Tag the entry at receiving time, using the PO's saved currency + rate ──
const _origConfirmPOReceiptV18=window.confirmPOReceipt;
if(typeof _origConfirmPOReceiptV18==='function'){
  window.confirmPOReceipt=async function(){
    const poId=(document.getElementById('rs-po-select')||{}).value;
    const po=(typeof PO_ORDERS!=='undefined'?PO_ORDERS:[]).find(o=>String(o.id)===String(poId));
    const result=await _origConfirmPOReceiptV18();
    if(po)tagLastEntryWithFx(po.currency,po.fx_rate?parseFloat(po.fx_rate):null);
    return result;
  };
}
const _origConfirmMaterialPOReceiptV18=window.confirmMaterialPOReceipt;
if(typeof _origConfirmMaterialPOReceiptV18==='function'){
  window.confirmMaterialPOReceipt=async function(){
    const poId=(document.getElementById('del-po-select')||{}).value;
    const po=(typeof PO_ORDERS!=='undefined'?PO_ORDERS:[]).find(o=>String(o.id)===String(poId));
    const result=await _origConfirmMaterialPOReceiptV18();
    if(po)tagLastEntryWithFx(po.currency,po.fx_rate?parseFloat(po.fx_rate):null);
    return result;
  };
}

console.log('✅ patch-v18.js loaded — PO-based AP entries now tagged with original currency + rate');
