/* ============================================================================
   HISABI HENSI — PURCHASING & STOCK-RECEIVE LOGIC PATCH v5
   Fixes: uploading a receipt in Deliveries (construction mode) produced rows
   with NO tax rate at all, regardless of what the receipt showed — so VAT
   was silently dropped instead of being absorbed into Construction Materials
   cost (for a non-VAT-registered buyer) or claimed as Input VAT (if eligible).

   ROOT CAUSE: patch-v2 upgraded addMaterialIntakeRow() to DISPLAY tax tier/
   rate/inclusive fields, and upgraded confirmMaterialsDelivery() to USE them
   correctly — but the function that actually reads an uploaded receipt and
   creates those rows, handleMaterialsReceiptUpload(), was never updated to
   pass the AI's detected tax info into each row. Every row was created with
   blank tax fields no matter what the receipt said.

   FIX: handleMaterialsReceiptUpload() now uses the same improved receipt
   prompt (RECEIPT_PARSE_PROMPT_V2), passes each item's detected tax tier/
   rate/inclusive into addMaterialIntakeRow(), auto-fills (but leaves fully
   reviewable) the "Supplier is VAT-registered" checkbox, and detects payment
   method from the receipt's own text — exactly matching the retail Receive
   Stock flow this was modeled on.

   Loads AFTER patch-v2.js, patch-v3.js, patch-v4.js.
============================================================================ */
(function(){
'use strict';

async function handleMaterialsReceiptUpload(file){
  if(!file)return;
  const dz=document.getElementById('delReceiptDropzone');
  try{
    if(dz)dz.style.opacity='0.6';
    setDelReceiptStatus('⏳ Reading document...');
    let text='';
    if(file.type==='application/pdf'||file.name.toLowerCase().endsWith('.pdf'))text=await extractTextFromPDF(file,setDelReceiptStatus);
    else if(file.type.startsWith('image/'))text=await extractTextFromImage(file,setDelReceiptStatus);
    else{setDelReceiptStatus('⚠️ Unsupported file type — use an image or PDF',true);return;}
    text=(text||'').trim();
    if(!text){setDelReceiptStatus('⚠️ No text found in that document',true);return;}
    setDelReceiptStatus('🤖 Extracting supplier, items, quantities, and tax...');
    // Use the improved v2 prompt (arithmetic-based inclusive detection, explicit
    // rate extraction, supplier VAT-registration detection, payment detection) —
    // the original construction upload used the older, plainer prompt.
    const res=await fetch('/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:text,systemPrompt:RECEIPT_PARSE_PROMPT_V2})});
    const data=await res.json();
    const parsed=safeParseReceiptJson(data.result||'');
    if(!parsed||!Array.isArray(parsed.items)||!parsed.items.length){
      setDelReceiptStatus('⚠️ Could not find line items in that document — try manual entry instead.',true);
      return;
    }
    const supplierEl=document.getElementById('delSupplier');if(supplierEl)supplierEl.value=parsed.supplier||'';
    onDelSupplierTextInput();
    const curEl=document.getElementById('del-currency');if(curEl&&parsed.currency)curEl.value=parsed.currency;
    onIntakeCurrencyChange('del-currency','del-currency-hint');
    const wrap=document.getElementById('del-rows');if(wrap){wrap.innerHTML='';window._delRowSeq=0;}
    // THE ACTUAL FIX: pass each item's detected tax tier/rate/inclusive through
    // to the row, instead of dropping it as the original code did. A blank
    // rate (never a silent fallback to your country's default) means the
    // receipt showed no tax for that item — exactly as patch-v3 already does
    // for the retail flow.
    parsed.items.forEach(it=>{
      const match=findMaterialByName(it.name);
      const tier=(match&&match.tax_tier_id)?getTaxTierById(match.tax_tier_id):pickTierForCategory(it.taxCategory);
      const taxTierId=tier?tier.id:'';
      const priceInclusive=(match&&match.tax_tier_id)?!!match.price_inclusive:!!it.taxInclusive;
      const taxRatePct=(typeof it.taxRatePct==='number'&&it.taxRatePct>0)?it.taxRatePct:'';
      addMaterialIntakeRow({parsedName:it.name,qty:it.qty,unitCost:it.unitCost,materialId:match?match.id:'',taxTierId,priceInclusive,taxRatePct});
    });
    // Auto-check (but always human-reviewable) the supplier VAT-registered checkbox
    const svEl=document.getElementById('del-supplier-vat-registered');
    if(svEl){
      svEl.checked=!!parsed.supplierVatRegistered;
      const invWrap=document.getElementById('del-invoice-wrap');
      if(invWrap)invWrap.style.display=(TAX_SETTINGS.is_vat_registered&&svEl.checked)?'block':'none';
    }
    // Payment detection: the deterministic text-based detector (patch v4) wins
    // over the AI's own field whenever it finds a clear signal on the receipt.
    const textDetected=(typeof detectPaymentFromText==='function')?detectPaymentFromText(text):null;
    const detectedPayment=textDetected||parsed.paymentStatus;
    const payEl=document.getElementById('delPay');
    if(payEl&&detectedPayment){
      const validValues=Array.from(payEl.options).map(o=>o.value);
      if(validValues.includes(detectedPayment))payEl.value=detectedPayment;
    }
    setDelReceiptStatus(`✅ Found ${parsed.items.length} item(s) — review the rows below (including tax rate and supplier VAT status), then confirm.`);
  }catch(err){
    setDelReceiptStatus('❌ '+err.message,true);
  }finally{
    if(dz)dz.style.opacity='1';
    const f=document.getElementById('delReceiptFile');if(f)f.value='';
  }
}
window.handleMaterialsReceiptUpload=handleMaterialsReceiptUpload;

console.log('✅ Hisabi Hensi patch v5 loaded — construction Deliveries receipt upload now correctly passes detected tax rate, supplier VAT-registration status, and payment method into the review rows instead of dropping them.');
})();
