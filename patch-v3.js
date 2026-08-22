/* ============================================================================
   HISABI HENSI — PURCHASING & STOCK-RECEIVE LOGIC PATCH v3
   Fixes two real bugs found by testing (receipts with 3+ items, e.g. Sunshine
   General Traders / Metro Office Supplies, $81.31 total, NO VAT shown at all):

   BUG A: Receipts with more than 1 line item use a different review screen
   (the "multi-item review table") than single-item receipts. Patch v2 only
   added the "Supplier is VAT-registered" checkbox + payment auto-fill to the
   SINGLE-item screen. The multi-item screen silently trusted whatever the AI
   guessed for supplier VAT-registration, with no checkbox for you to see or
   correct it — so a wrong AI guess went straight to the ledger unreviewed.

   BUG B: Even when the receipt shows NO tax rate at all, if the AI reported
   0%, the code was silently substituting your country's configured default
   VAT tier rate (e.g. 18%) instead of leaving it at 0%. This directly broke
   "OCR priority" (fix #2 from the original spec) and is why $81.31 became
   $95.95 with a phantom $14.64 VAT line, twice (journal entries #33 and #34).

   This patch loads AFTER patch-v2.js and safely re-overrides the two
   functions responsible. Nothing else changes.
============================================================================ */
(function(){
'use strict';

// ── BUG B FIX: never fall back to the tier's configured rate when the AI
// found no explicit rate on the receipt. An empty rate forces the human to
// notice and decide, instead of silently taxing a receipt that showed none. ──
function pickDefaultRate(aiRatePct,tier){
  if(typeof aiRatePct==='number'&&aiRatePct>0)return aiRatePct;
  return ''; // leave blank — do NOT fall back to tier.rate
}

// ── BUG A + B FIX: single-item screen — same as v2, but rate no longer
// silently falls back to the tier default. ──────────────────────────────────
function populateSingleIntakeForm(supplier,item,currency,supplierVatRegistered,paymentStatus){
  const supplierEl=document.getElementById('si-supplier');if(supplierEl)supplierEl.value=supplier||'';
  const curEl=document.getElementById('si-currency');if(curEl&&currency)curEl.value=currency;
  onIntakeCurrencyChange('si-currency','si-currency-hint');
  const match=posFindProduct(item.name,true);
  const tier=(match&&match.tax_tier_id)?getTaxTierById(match.tax_tier_id):pickTierForCategory(item.taxCategory);
  const taxTierId=tier?tier.id:'';
  const priceInclusive=(match&&match.tax_tier_id)?!!match.price_inclusive:!!item.taxInclusive;
  const taxRatePct=pickDefaultRate(item.taxRatePct,tier);
  const wrap=document.getElementById('si-rows');if(wrap){wrap.innerHTML='';window._siRowSeq=0;}
  addManualIntakeRow({parsedName:item.name,qty:item.qty,unitCost:item.unitCost,productId:match?match.id:'',taxTierId,priceInclusive,taxRatePct});
  const invWrap=document.getElementById('si-invoice-wrap');if(invWrap)invWrap.style.display=TAX_SETTINGS.is_vat_registered?'block':'none';
  const svEl=document.getElementById('si-supplier-vat-registered');if(svEl)svEl.checked=!!supplierVatRegistered;
  const payEl=document.getElementById('si-pay');
  if(payEl&&paymentStatus){const validValues=Array.from(payEl.options).map(o=>o.value);if(validValues.includes(paymentStatus))payEl.value=paymentStatus;}
  const reviewWrap=document.getElementById('rsReceiptReview');if(reviewWrap){reviewWrap.style.display='none';reviewWrap.innerHTML='';}
}
window.populateSingleIntakeForm=populateSingleIntakeForm;

// ── BUG A + B FIX: multi-item review table — now includes a visible,
// editable "Supplier is VAT-registered" checkbox (pre-filled from the AI's
// guess but ALWAYS reviewable/correctable by you before anything posts),
// payment-method pre-fill with Mobile Money/Bank options, and no more silent
// rate fallback to the tier default. ────────────────────────────────────────
let _rsReviewRowSeq2=0;
function renderReceiptReviewTable(parsed){
  const wrap=document.getElementById('rsReceiptReview');if(!wrap)return;
  const vatOn=TAX_SETTINGS.is_vat_registered;
  const rows=parsed.items.map(it=>{
    const rowId='rsrow2-'+(_rsReviewRowSeq2++);
    const match=posFindProduct(it.name,true);
    const options='<option value="">— no match, will auto-create on confirm —</option>'+RETAIL_PRODUCTS.map(p=>`<option value="${p.id}" ${match&&match.id===p.id?'selected':''}>${p.name}</option>`).join('');
    const aiTier=pickTierForCategory(it.taxCategory);
    const defaultTier=(match&&match.tax_tier_id)?getTaxTierById(match.tax_tier_id):aiTier;
    const defaultInclusive=(match&&match.tax_tier_id)?!!match.price_inclusive:!!it.taxInclusive;
    const defaultRate=pickDefaultRate(it.taxRatePct,defaultTier);
    const aiHint=(!match&&aiTier)?`<div style="font-size:9px;color:var(--purple3);margin-top:2px">🤖 AI: ${aiTier.name}${it.taxRatePct?` · ${it.taxRatePct}% (from receipt)`:' · no rate found on receipt'}${it.taxInclusive?' · incl.':''}</div>`:'';
    return `<div class="rs-review-row" data-row-id="${rowId}" data-parsed-name="${(it.name||'').replace(/"/g,'&quot;')}" style="display:grid;grid-template-columns:1.3fr auto 0.7fr 0.8fr 0.9fr 0.6fr auto;gap:7px;align-items:end;padding:8px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:3px">Receipt said: "${it.name}"</div>
        <select class="rs-review-product" id="sel-${rowId}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none">${options}</select>
        ${aiHint}
      </div>
      <button type="button" onclick="openQuickAddProduct('sel-${rowId}')" title="Add a new product without leaving this page" style="padding:7px 9px;background:transparent;border:1px dashed var(--gold2);border-radius:5px;color:var(--gold2);cursor:pointer;font-size:11px;white-space:nowrap">+ New</button>
      <div><div style="font-size:10px;color:var(--text3);margin-bottom:3px">Qty</div><input class="rs-review-qty" type="number" value="${it.qty||0}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none"/></div>
      <div><div style="font-size:10px;color:var(--text3);margin-bottom:3px">Unit Cost</div><input class="rs-review-cost" type="number" step="0.01" value="${it.unitCost||0}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none"/></div>
      <div><div style="font-size:10px;color:var(--text3);margin-bottom:3px">Tax Tier</div><select class="rs-review-tax-tier" onchange="syncIntakeRateFromTier(this)" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text);outline:none">${taxTierSelectOptions(defaultTier?defaultTier.id:'')}</select></div>
      <div><div style="font-size:10px;color:var(--text3);margin-bottom:3px" title="Blank means the receipt showed no tax — review before posting">Rate %</div><input class="rs-review-tax-rate" type="number" step="0.01" value="${defaultRate}" placeholder="0" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none"/></div>
      <label style="display:flex;align-items:center;gap:4px;font-size:9px;color:var(--text3);padding-bottom:7px;white-space:nowrap"><input type="checkbox" class="rs-review-tax-incl" ${defaultInclusive?'checked':''} style="accent-color:var(--gold2)"/> incl.</label>
    </div>`;
  }).join('');
  wrap.style.display='block';
  const taxHint=vatOn
    ?`<div class="alert al-info" style="margin-bottom:10px"><span class="alert-ico">🤖</span><div class="alert-body">Tax tiers below are auto-classified by AI for new items (🤖 badge). A BLANK rate means the receipt showed no tax at all — leave it blank unless you know tax genuinely applies. Review every row, and confirm the supplier's VAT-registration status below, before confirming.</div></div>`
    :`<div class="alert al-warn" style="margin-bottom:10px"><span class="alert-ico">💰</span><div class="alert-body">This business isn't VAT-registered. If a tax tier applies to a row, that tax is absorbed straight into Inventory cost — nothing is tracked as a VAT Receivable.</div></div>`;
  wrap.innerHTML=`
    <div class="fgrid"><div class="fg"><label>Supplier</label><input id="rs-review-supplier" type="text" value="${(parsed.supplier||'').replace(/"/g,'&quot;')}" placeholder="Supplier name"/></div><div class="fg"><label>Invoice Currency</label><select id="rs-review-currency" class="entry-currency-select" onchange="onIntakeCurrencyChange('rs-review-currency','rs-review-currency-hint')"></select></div><div class="fg"><label>Payment</label><select id="rs-review-pay"><option value="credit">Credit (AP)</option><option value="cash">Cash</option><option value="mobile">Mobile Money</option><option value="bank">Bank</option></select></div></div>
    <div id="rs-review-currency-hint" style="font-size:10px;color:var(--text3);margin:-4px 0 8px"></div>
    <div class="fg"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text2)"><input type="checkbox" id="rs-review-supplier-vat-registered" style="accent-color:var(--gold2)"/> Supplier is VAT-registered (has TIN / issues Tax Invoice) — review this, the AI's guess may be wrong</label></div>
    ${vatOn?`<div class="fg"><label>Supplier Tax Invoice Number <span style="color:var(--red3)">*</span> (required only if claiming Input VAT)</label><input id="rs-review-invoice" type="text" placeholder="Required for VAT-registered businesses claiming Input VAT"/></div>`:''}
    ${taxHint}
    ${rows}
    <div class="btn-row"><button class="btn btn-gold" onclick="confirmReceiptIntake()">✅ Confirm Receive All</button><button class="btn btn-outline" onclick="cancelReceiptReview()">Cancel</button></div>
  `;
  const curSel=document.getElementById('rs-review-currency');
  if(curSel){curSel.innerHTML=currencySelectOptions(parsed.currency||'USD');onIntakeCurrencyChange('rs-review-currency','rs-review-currency-hint');}
  // Pre-fill (but never silently trust) the AI's own findings — always human-reviewable
  const svEl=document.getElementById('rs-review-supplier-vat-registered');if(svEl)svEl.checked=!!parsed.supplierVatRegistered;
  const payEl=document.getElementById('rs-review-pay');
  if(payEl&&parsed.paymentStatus){const validValues=Array.from(payEl.options).map(o=>o.value);if(validValues.includes(parsed.paymentStatus))payEl.value=parsed.paymentStatus;}
}
window.renderReceiptReviewTable=renderReceiptReviewTable;

// ── BUG A FIX: confirmReceiptIntake now reads the CHECKBOX the human
// reviewed/corrected, instead of trusting the AI's raw field directly. ──────
async function confirmReceiptIntake(){
  const wrap=document.getElementById('rsReceiptReview');if(!wrap)return;
  const supplier=(document.getElementById('rs-review-supplier')||{}).value||'';
  const payMethod=(document.getElementById('rs-review-pay')||{}).value||'credit';
  const invoiceNo=(document.getElementById('rs-review-invoice')||{}).value?.trim()||'';
  const buyerRegistered=TAX_SETTINGS.is_vat_registered;
  // Read the human-reviewed checkbox, not the raw AI field — this is the fix.
  const supplierRegistered=(document.getElementById('rs-review-supplier-vat-registered')||{}).checked||false;
  const claimablePossible=buyerRegistered&&supplierRegistered;
  if(claimablePossible&&!invoiceNo){setRSReceiptStatus('⚠️ Supplier Tax Invoice Number is required to claim Input VAT.',true);return;}
  const rowEls=Array.from(wrap.querySelectorAll('.rs-review-row'));
  const candidates=[];let skipped=0;
  const intakeCurrency=(document.getElementById('rs-review-currency')||{}).value||'USD';
  rowEls.forEach(row=>{
    const sel=row.querySelector('.rs-review-product');
    const productId=sel?sel.value:'';
    const parsedName=row.dataset.parsedName||'';
    const qty=parseFloat(row.querySelector('.rs-review-qty').value)||0;
    const unitCost=convertToUSD(parseFloat(row.querySelector('.rs-review-cost').value)||0,intakeCurrency);
    const taxTierSel=row.querySelector('.rs-review-tax-tier');
    const taxTierId=taxTierSel?taxTierSel.value:'';
    const rateInput=row.querySelector('.rs-review-tax-rate');
    const taxRatePct=rateInput?(parseFloat(rateInput.value)||0):0;
    const priceInclusive=row.querySelector('.rs-review-tax-incl')?row.querySelector('.rs-review-tax-incl').checked:false;
    if(qty<=0||unitCost<=0){skipped++;return;}
    candidates.push({productId,parsedName,qty,unitCost,taxTierId,taxRatePct,priceInclusive});
  });
  if(!candidates.length){setRSReceiptStatus('⚠️ No rows have both a quantity and a unit cost — nothing to receive.',true);return;}
  setRSReceiptStatus('⏳ Recording receipt...');
  try{
    const lines=[];const autoCreated=[];
    for(const c of candidates){
      let productId=c.productId?parseInt(c.productId):null;
      if(!productId){
        productId=await autoCreateProductFromReceiptLine(c.parsedName,c.unitCost,c.taxTierId,c.priceInclusive);
        autoCreated.push(c.parsedName||'Unnamed Item');
      }
      const tier=getTaxTierById(c.taxTierId);
      const{inventoryAmt,recoverableTax}=computeClaimableTax(c.unitCost*c.qty,c.taxRatePct,c.priceInclusive,buyerRegistered,supplierRegistered);
      lines.push({productId,qty:c.qty,unitCostForStock:inventoryAmt/c.qty,inventoryAmt,recoverableTax,tierName:tier?tier.name:'',rate:c.taxRatePct,taxTierId:c.taxTierId,priceInclusive:c.priceInclusive});
    }
    if(autoCreated.length)await loadRetailProducts();
    const tierTotals={};
    const journalLines=[];
    for(const line of lines){
      await dbApi({action:'receiveStock',companyId:SESSION.companyId,productId:line.productId,qty:line.qty,unitCost:line.unitCostForStock,supplier,paymentMethod:payMethod});
      await syncProductAfterIntake(line.productId,line.taxTierId,line.priceInclusive,line.qty,line.unitCostForStock);
      const p=RETAIL_PRODUCTS.find(x=>x.id===line.productId);
      journalLines.push({productName:p?p.name:`Product #${line.productId}`,base:line.inventoryAmt,tax:line.recoverableTax});
      if(claimablePossible&&line.tierName){
        const key=line.tierName||'—';
        if(!tierTotals[key])tierTotals[key]={tierName:line.tierName,rate:line.rate,base:0,tax:0};
        tierTotals[key].base+=line.inventoryAmt;tierTotals[key].tax+=line.recoverableTax;
      }
    }
    const names=lines.map(l=>{const p=RETAIL_PRODUCTS.find(x=>x.id===l.productId);return p?`${p.name} ×${l.qty}`:`#${l.productId} ×${l.qty}`;});
    const totalBase=journalLines.reduce((s,l)=>s+l.base,0),totalTax=journalLines.reduce((s,l)=>s+l.tax,0),totalGrand=totalBase+totalTax;
    const receiptEntry=buildIntakeJournalEntry(`Stock received (from receipt): ${supplier||'supplier'}${invoiceNo?` (Inv# ${invoiceNo})`:''} — ${names.join(', ')}`,journalLines,payMethod);
    const receiptSupplierMatch=await ensureSupplierExists(supplier);
    if(receiptSupplierMatch)receiptEntry.party={type:'supplier',id:receiptSupplierMatch.id,name:receiptSupplierMatch.name};
    DB.entries.push(receiptEntry);
    if(buyerRegistered){
      for(const t of Object.values(tierTotals)){
        await dbApi({action:'recordVatLedger',companyId:SESSION.companyId,direction:'input',tierName:t.tierName,rate:t.rate,baseAmount:t.base,taxAmount:t.tax,sourceType:'stock_receipt',sourceDesc:`Receipt: ${supplier||'supplier'} — ${names.join(', ')}`,supplierInvoiceNo:invoiceNo,entryDate:today()}).catch(e=>console.error('recordVatLedger',e));
      }
    }
    await saveData();
    await loadRetailProducts();
    renderAll();
    cancelReceiptReview();
    const createdMsg=autoCreated.length?` — created new product(s): ${autoCreated.join(', ')} (set your sale price in Catalogue)`:'';
    const vatMsg=totalTax>0.001?` (base ${fc(totalBase)} + VAT ${fc(totalTax)})`:'';
    setRSReceiptStatus(`✅ Received ${lines.length} item(s) — ${fc(totalGrand)} recorded${vatMsg}${createdMsg}${skipped?` (${skipped} row(s) skipped — no qty/cost)`:''}`);
    showToast(`✅ Stock receipt recorded — ${fc(totalGrand)}${autoCreated.length?` (${autoCreated.length} new product${autoCreated.length>1?'s':''})`:''}`);
  }catch(e){
    setRSReceiptStatus('❌ '+e.message,true);
  }
}
window.confirmReceiptIntake=confirmReceiptIntake;

console.log('✅ Hisabi Hensi patch v3 loaded — multi-item receipt review now shows a reviewable Supplier VAT-registered checkbox, and blank/zero tax rates on a receipt are never silently replaced by your country default.');
})();
