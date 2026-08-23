/* ============================================================================
   HISABI HENSI — PURCHASING & STOCK-RECEIVE LOGIC PATCH v6
   Adds a SAFETY NET, not a "fix" — this is different from patches v2-v5.

   WHAT WAS OBSERVED: the same receipt image, uploaded multiple times, kept
   describing "Rebars 12mm ×20" (the receipt actually shows qty 40). Whether
   the final dollar amount came out right or wrong depended on whether the AI
   computed unit cost as (printed line total ÷ its own misread quantity) or
   read the printed unit-price column directly. This is OCR/AI text-reading
   reliability — a real limitation of extracting numbers from an image, not
   an accounting-logic bug. No JavaScript patch can force perfect OCR.

   WHAT THIS PATCH DOES: it can't guarantee perfect extraction, but it CAN
   make an extraction mistake visible to you before it posts, instead of
   silently slipping through. The AI is now also asked to report each line
   item's own printed total. If qty × unit cost doesn't match that printed
   total, a clear ⚠️ warning appears directly on that row — so a misread
   quantity shows up as something to double-check, not a silent wrong number
   in your ledger.

   RECOMMENDATION: always glance at the qty/cost fields against the actual
   receipt before clicking "Confirm Receive All" — that review screen exists
   specifically so you can catch exactly this kind of AI misread.

   Loads AFTER patch-v2.js through patch-v5.js.
============================================================================ */
(function(){
'use strict';

// ── Extended prompt: same as V2, plus each item now also reports its own
// printed line total (used ONLY for cross-checking on the client — the AI
// is told not to let this influence its qty/unitCost answers). ─────────────
const RECEIPT_PARSE_PROMPT_V3=RECEIPT_PARSE_PROMPT_V2.replace(
  '"items":[{"name":"Product name exactly as written on the receipt","qty":10,"unitCost":1.5,"taxCategory":"standard","taxRatePct":18,"taxInclusive":false}]}',
  '"items":[{"name":"Product name exactly as written on the receipt","qty":10,"unitCost":1.5,"lineTotal":15,"taxCategory":"standard","taxRatePct":18,"taxInclusive":false}]}'
) + `

10. lineTotal: report the TOTAL value printed for THIS SPECIFIC line item on the receipt (the rightmost "Total" column value for that row), as a plain number, independent of how you calculated qty/unitCost. This is used only for cross-checking — report exactly what is printed, even if it seems inconsistent with qty×unitCost. If no per-line total is printed, use 0.`;
window.RECEIPT_PARSE_PROMPT_V3=RECEIPT_PARSE_PROMPT_V3;

// ── Cross-check helper: does qty × unitCost match the AI's own reported
// printed line total? Returns null if there's nothing to check against. ────
function checkLineTotalMismatch(qty,unitCost,lineTotal){
  const lt=parseFloat(lineTotal)||0;
  if(lt<=0)return null; // receipt didn't show a per-line total — nothing to cross-check
  const expected=Math.round((parseFloat(qty)||0)*(parseFloat(unitCost)||0)*100)/100;
  if(Math.abs(expected-lt)>0.02){
    return `⚠️ This row totals ${expected.toFixed(2)} but the receipt shows ${lt.toFixed(2)} for this line — double-check the quantity/unit cost before confirming.`;
  }
  return null;
}
window.checkLineTotalMismatch=checkLineTotalMismatch;

// Small reusable renderer + live-updating listener for the warning line under a row.
function attachMismatchWarning(rowEl,qtySelector,costSelector,lineTotal){
  const warnId='mismatch-'+Math.random().toString(36).slice(2);
  const warnDiv=document.createElement('div');
  warnDiv.id=warnId;
  warnDiv.style.cssText='grid-column:1/-1;font-size:10px;color:var(--orange3);margin-top:-3px;display:none';
  rowEl.appendChild(warnDiv);
  function update(){
    const qtyEl=rowEl.querySelector(qtySelector),costEl=rowEl.querySelector(costSelector);
    if(!qtyEl||!costEl)return;
    const msg=checkLineTotalMismatch(qtyEl.value,costEl.value,lineTotal);
    warnDiv.textContent=msg||'';
    warnDiv.style.display=msg?'block':'none';
  }
  const qtyEl=rowEl.querySelector(qtySelector),costEl=rowEl.querySelector(costSelector);
  if(qtyEl)qtyEl.addEventListener('input',update);
  if(costEl)costEl.addEventListener('input',update);
  update();
}
window.attachMismatchWarning=attachMismatchWarning;

// ── Construction: addMaterialIntakeRow now accepts prefill.lineTotal and
// shows the warning live under the row. ─────────────────────────────────────
function addMaterialIntakeRow(prefill){
  const wrap=document.getElementById('del-rows');if(!wrap)return;
  prefill=prefill||{};
  const rowId='del-row-'+(window._delRowSeq=(window._delRowSeq||0)+1);
  const row=document.createElement('div');
  row.className='del-intake-row';
  row.dataset.rowId=rowId;
  row.dataset.parsedName=prefill.parsedName||'';
  row.style.cssText='display:grid;grid-template-columns:1.3fr auto 0.7fr 0.8fr 1fr 0.6fr auto auto;gap:7px;align-items:end;margin-bottom:7px;padding-bottom:7px;border-bottom:1px solid var(--border)';
  const initialTier=getTaxTierById(prefill.taxTierId||'');
  const initialRate=(prefill.taxRatePct!==undefined&&prefill.taxRatePct!==null&&prefill.taxRatePct!=='')?prefill.taxRatePct:(initialTier?parseFloat(initialTier.rate):'');
  row.innerHTML=`
    <div class="fg" style="margin:0"><label>Material</label><select class="material-select" id="sel-${rowId}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:9px 11px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none">${materialSelectOptions(prefill.materialId||'')}</select></div>
    <button type="button" onclick="openQuickAddMaterial('sel-${rowId}')" title="Add a new material without leaving this page" style="padding:9px 10px;background:transparent;border:1px dashed var(--gold2);border-radius:5px;color:var(--gold2);cursor:pointer;font-size:11px;white-space:nowrap">+ New</button>
    <div class="fg" style="margin:0"><label>Qty</label><input class="del-row-qty" type="number" value="${prefill.qty||''}" placeholder="50"/></div>
    <div class="fg" style="margin:0"><label>Unit Cost</label><input class="del-row-cost" type="number" step="0.01" value="${prefill.unitCost||''}" placeholder="25.00"/></div>
    <div class="fg" style="margin:0"><label>Tax Tier</label><select class="del-row-tax-tier" onchange="syncIntakeRateFromTier(this)" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:9px 11px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text);outline:none">${taxTierSelectOptions(prefill.taxTierId||'')}</select></div>
    <div class="fg" style="margin:0"><label title="Read straight off the receipt when available">Rate %</label><input class="del-row-tax-rate" type="number" step="0.01" value="${initialRate}" placeholder="18"/></div>
    <label style="display:flex;align-items:center;gap:4px;font-size:9px;color:var(--text3);padding-bottom:9px;white-space:nowrap"><input type="checkbox" class="del-row-tax-incl" ${prefill.priceInclusive?'checked':''} style="accent-color:var(--gold2)"/> incl.</label>
    <button type="button" onclick="this.closest('.del-intake-row').remove()" title="Remove this item" style="padding:9px 11px;background:transparent;border:1px solid rgba(192,48,42,.3);border-radius:5px;color:var(--red3);cursor:pointer;font-size:14px">✕</button>
  `;
  wrap.appendChild(row);
  if(prefill.lineTotal)attachMismatchWarning(row,'.del-row-qty','.del-row-cost',prefill.lineTotal);
  return rowId;
}
window.addMaterialIntakeRow=addMaterialIntakeRow;

// ── Construction: handleMaterialsReceiptUpload now uses V3 (adds lineTotal)
// and passes it through to each row for cross-checking. ─────────────────────
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
    const res=await fetch('/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:text,systemPrompt:RECEIPT_PARSE_PROMPT_V3})});
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
    let anyMismatch=false;
    parsed.items.forEach(it=>{
      const match=findMaterialByName(it.name);
      const tier=(match&&match.tax_tier_id)?getTaxTierById(match.tax_tier_id):pickTierForCategory(it.taxCategory);
      const taxTierId=tier?tier.id:'';
      const priceInclusive=(match&&match.tax_tier_id)?!!match.price_inclusive:!!it.taxInclusive;
      const taxRatePct=(typeof it.taxRatePct==='number'&&it.taxRatePct>0)?it.taxRatePct:'';
      addMaterialIntakeRow({parsedName:it.name,qty:it.qty,unitCost:it.unitCost,materialId:match?match.id:'',taxTierId,priceInclusive,taxRatePct,lineTotal:it.lineTotal});
      if(checkLineTotalMismatch(it.qty,it.unitCost,it.lineTotal))anyMismatch=true;
    });
    const svEl=document.getElementById('del-supplier-vat-registered');
    if(svEl){
      svEl.checked=!!parsed.supplierVatRegistered;
      const invWrap=document.getElementById('del-invoice-wrap');
      if(invWrap)invWrap.style.display=(TAX_SETTINGS.is_vat_registered&&svEl.checked)?'block':'none';
    }
    const textDetected=(typeof detectPaymentFromText==='function')?detectPaymentFromText(text):null;
    const detectedPayment=textDetected||parsed.paymentStatus;
    const payEl=document.getElementById('delPay');
    if(payEl&&detectedPayment){
      const validValues=Array.from(payEl.options).map(o=>o.value);
      if(validValues.includes(detectedPayment))payEl.value=detectedPayment;
    }
    setDelReceiptStatus(anyMismatch
      ?`⚠️ Found ${parsed.items.length} item(s) — one or more rows below don't match their printed line total. Please review carefully before confirming.`
      :`✅ Found ${parsed.items.length} item(s) — review the rows below, then confirm.`);
  }catch(err){
    setDelReceiptStatus('❌ '+err.message,true);
  }finally{
    if(dz)dz.style.opacity='1';
    const f=document.getElementById('delReceiptFile');if(f)f.value='';
  }
}
window.handleMaterialsReceiptUpload=handleMaterialsReceiptUpload;

console.log('✅ Hisabi Hensi patch v6 loaded — receipt rows now show a warning when quantity × unit cost doesn\'t match the line total printed on the receipt, so an AI/OCR misread is visible before you confirm instead of silently posting.');
})();
