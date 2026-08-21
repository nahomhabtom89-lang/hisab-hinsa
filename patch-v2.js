/* ============================================================================
   HISABI HENSI — PURCHASING & STOCK-RECEIVE LOGIC PATCH v2
   Implements:
   1. Cost price / sale price independence
   2. OCR priority + automatic inclusive/exclusive VAT detection
   3. Buyer/Seller VAT claimability matrix
   4. Correct inclusive-tax extraction math
   5. Payment-type detection from receipt keywords
   6. Construction module VAT handling (previously missing entirely)

   HOW THIS WORKS: this script runs AFTER your existing app script and safely
   overrides only the specific functions listed below. Function declarations
   in classic <script> tags CAN be redefined by a later <script> tag (the
   later one wins) — this is standard, safe browser behavior, not a hack.
   Nothing else in your index.html needs to change.
============================================================================ */
(function(){
'use strict';

// ── FIX 3 + 4: Buyer/Seller VAT claimability + correct inclusive-tax math ──
// Input VAT is only claimable if BOTH the buyer's own business AND the supplier
// are VAT-registered. If either side fails, the full tax-inclusive amount is
// absorbed into Inventory/Materials — no VAT Receivable line, ever.
function computeClaimableTax(lineAmount,ratePct,isInclusive,buyerVatRegistered,supplierVatRegistered){
  const split=computeTaxSplit(lineAmount,ratePct,isInclusive); // reuses your existing, already-correct math
  const claimable=!!buyerVatRegistered&&!!supplierVatRegistered&&(parseFloat(ratePct)||0)>0;
  return{
    inventoryAmt: claimable?split.base:split.grandTotal,
    recoverableTax: claimable?split.tax:0,
    claimable
  };
}
window.computeClaimableTax=computeClaimableTax;

// ── FIX 1: cost price and sale price are strictly independent ──────────────
// Previously: salePrice = cost * 1.2 was auto-calculated whenever a new
// product was created from a receipt. That's removed — sale price stays 0
// until the Owner deliberately sets it in Catalogue.
async function autoCreateProductFromReceiptLine(name,costPrice,taxTierId,priceInclusive){
  const cost=parseFloat(costPrice)||0;
  const r=await dbApi({action:'saveProduct',companyId:SESSION.companyId,name:(name||'Unnamed Item').trim(),category:'General',sale_price:0,cost_price:cost,qty:0,min_qty:0,unit:'unit',tax_tier_id:taxTierId||'',price_inclusive:!!priceInclusive});
  return r.productId;
}
window.autoCreateProductFromReceiptLine=autoCreateProductFromReceiptLine;

// ── FIX 5: payment-keyword routing (Cash / Mobile Money / Bank / AP) ────────
function buildIntakeJournalEntry(desc,lines,payMethod,acctPrefix,entryType){
  acctPrefix=acctPrefix||'Inventory';entryType=entryType||'Stock Receipt';
  const debits=lines.filter(l=>l.base>0.001).map(l=>({acct:`${acctPrefix} (${l.productName})`,amt:Math.round(l.base*100)/100,atype:'asset'}));
  const totalTax=lines.reduce((s,l)=>s+(l.tax||0),0);
  if(totalTax>0.001)debits.push({acct:'VAT Receivable (Input VAT)',amt:Math.round(totalTax*100)/100,atype:'asset'});
  const grandTotal=lines.reduce((s,l)=>s+l.base+(l.tax||0),0);
  const payAcctMap={cash:'Cash',mobile:'Mobile Money',bank:'Bank Account',credit:'Accounts Payable'};
  const payAcct=payAcctMap[payMethod]||'Accounts Payable';
  const payAtype=payMethod==='credit'?'liability':'asset';
  const credits=[{acct:payAcct,amt:Math.round(grandTotal*100)/100,atype:payAtype}];
  return{id:DB.nextId++,date:today(),desc,type:entryType,amount:Math.round(grandTotal*100)/100,project:'',debits,credits};
}
window.buildIntakeJournalEntry=buildIntakeJournalEntry;

// ── FIX 2 + 4 + 5: rewritten OCR prompt — arithmetic-first inclusive/exclusive
// detection, supplier VAT-registration detection, payment-keyword detection ──
const RECEIPT_PARSE_PROMPT_V2=`You are a data-extraction engine for supplier delivery receipts and invoices.
Return ONLY valid JSON. No markdown, no commentary, no trailing commas, no text outside the JSON.
Structure exactly:
{"supplier":"Supplier name, or empty string if not found","supplierVatRegistered":false,"currency":"ISO currency code such as USD, EUR, UGX, KES — your best read of the document's currency, default to USD only if truly no currency indicator is present","documentGrandTotal":0,"paymentStatus":"credit","items":[{"name":"Product name exactly as written on the receipt","qty":10,"unitCost":1.5,"taxCategory":"standard","taxRatePct":18,"taxInclusive":false}]}

Rules:
1. qty and unitCost must be plain numbers, never strings or currency symbols. unitCost is in whatever currency you detected — do NOT convert it, just report the number as printed.
2. If unit cost isn't stated directly but a line total and quantity are, compute unitCost = lineTotal / qty.
3. List every distinct line item separately — never merge different products into one line.
4. If a field truly cannot be found, use 0 for numbers, "" for text, and false for booleans — never fabricate values.
5. taxCategory: classify EACH item using standard VAT conventions common across East Africa/UK — "standard" for ordinary taxable goods (alcohol, soft drinks, electronics, cosmetics, household goods, processed/packaged foods); "exempt" for goods typically VAT-exempt or zero-rated (fresh unprocessed produce, fresh milk, raw grains/flour, unprocessed agricultural output, basic medicines); "zero" only if the receipt itself explicitly states a 0% rate for that line. Default to "standard" if genuinely unsure.
6. taxRatePct: the ACTUAL numeric tax/VAT rate printed on the receipt itself. This is the source of truth — never fall back to a "typical country rate". If a document-level rate covers the whole invoice, use that number for every item. If no percentage appears anywhere, use 0.
7. taxInclusive — determine this from the RECEIPT'S OWN ARITHMETIC first, wording second, never from a blanket default:
   a. Sum every line item's qty × unitCost you extracted. Call this LINE_SUM.
   b. Find the printed Grand Total / Total Due / Amount Payable and put it in documentGrandTotal (0 if none printed).
   c. If documentGrandTotal is present, compare it to LINE_SUM:
      - documentGrandTotal ≈ LINE_SUM (within rounding) → the line prices already include any tax mentioned → taxInclusive:true for every item.
      - documentGrandTotal ≈ LINE_SUM × (1 + rate/100) — a tax amount was visibly ADDED on top → taxInclusive:false for every item.
      - Neither matches cleanly → go to step d.
   d. No usable total to check: "incl. VAT" / "VAT inclusive" / "tax included" wording, OR a receipt style with NO separate VAT line shown at all (typical retail POS slip) → taxInclusive:true. "excl. VAT" / "plus VAT" / a document showing Subtotal + separate VAT line + Grand Total → taxInclusive:false.
   e. Only if nothing above applies, default to false.
   Getting this wrong causes real accounting errors (VAT added on top of a total that already includes it). ALWAYS attempt the arithmetic check in (a)-(c) before falling back to wording or a default.
8. supplierVatRegistered: true ONLY if the document shows clear evidence — a printed VAT/TIN/GST registration number, a document explicitly titled "Tax Invoice" or "VAT Invoice", or an itemized VAT breakdown with rate and amount. A plain cash receipt or delivery note with no such evidence → false. When in doubt, use false — under-detecting registration is the safe direction, since a buyer can never legitimately claim VAT a supplier wasn't registered to charge.
9. paymentStatus: read payment keywords on the receipt.
   - "cash" if it says "Paid", "Cash", "Received in full", "Card", "Paid by card".
   - "mobile" if it mentions "Mobile Money", "M-Pesa", "MTN Money", "Airtel Money".
   - "bank" if it mentions "Bank Transfer", "EFT", "Wire", "Paid to bank".
   - "credit" if it says "On Account", "Credit", "Invoice Due", "Net 30", "Balance Due", "Unpaid", or shows no payment confirmation at all.
   - If ambiguous, default to "credit" — never assume cash was already paid.`;
window.RECEIPT_PARSE_PROMPT_V2=RECEIPT_PARSE_PROMPT_V2;

async function parseReceiptWithAI(rawText){
  try{
    const countryLabel=(TAX_COUNTRY_OPTIONS.find(c=>c.code===TAX_SETTINGS.country)||{}).label;
    const contextualPrompt=TAX_SETTINGS.is_vat_registered&&countryLabel
      ?RECEIPT_PARSE_PROMPT_V2+`\n\nContext: this business operates in ${countryLabel} and is VAT/GST-registered there. Classify each item's taxCategory using that country's typical exemption conventions where you're aware of them.`
      :RECEIPT_PARSE_PROMPT_V2;
    const res=await fetch('/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:rawText,systemPrompt:contextualPrompt})});
    const data=await res.json();
    const parsed=safeParseReceiptJson(data.result||'');
    if(!parsed||!Array.isArray(parsed.items)||!parsed.items.length){
      setRSReceiptStatus('⚠️ Could not find line items in that document — try manual entry instead.',true);
      return;
    }
    showReceiptReview(parsed);
  }catch(e){
    setRSReceiptStatus('❌ AI parsing failed: '+e.message,true);
  }
}
window.parseReceiptWithAI=parseReceiptWithAI;

function showReceiptReview(parsed){
  RS_PARSED_RECEIPT=parsed;
  if(parsed.items.length===1){
    populateSingleIntakeForm(parsed.supplier,parsed.items[0],parsed.currency,parsed.supplierVatRegistered,parsed.paymentStatus);
    const wrap=document.getElementById('rsReceiptReview');if(wrap){wrap.style.display='none';wrap.innerHTML='';}
    setRSReceiptStatus('✅ Fields auto-filled below from the receipt — please verify, then click "Receive Stock".');
    return;
  }
  renderReceiptReviewTable(parsed);
  setRSReceiptStatus(`✅ Found ${parsed.items.length} item(s) — review and edit below, then confirm.`);
}
window.showReceiptReview=showReceiptReview;

function populateSingleIntakeForm(supplier,item,currency,supplierVatRegistered,paymentStatus){
  const supplierEl=document.getElementById('si-supplier');if(supplierEl)supplierEl.value=supplier||'';
  const curEl=document.getElementById('si-currency');if(curEl&&currency)curEl.value=currency;
  onIntakeCurrencyChange('si-currency','si-currency-hint');
  const match=posFindProduct(item.name,true);
  const tier=(match&&match.tax_tier_id)?getTaxTierById(match.tax_tier_id):pickTierForCategory(item.taxCategory);
  const taxTierId=tier?tier.id:'';
  const priceInclusive=(match&&match.tax_tier_id)?!!match.price_inclusive:!!item.taxInclusive;
  const taxRatePct=(typeof item.taxRatePct==='number'&&item.taxRatePct>0)?item.taxRatePct:(tier?parseFloat(tier.rate):'');
  const wrap=document.getElementById('si-rows');if(wrap){wrap.innerHTML='';window._siRowSeq=0;}
  addManualIntakeRow({parsedName:item.name,qty:item.qty,unitCost:item.unitCost,productId:match?match.id:'',taxTierId,priceInclusive,taxRatePct});
  const invWrap=document.getElementById('si-invoice-wrap');if(invWrap)invWrap.style.display=TAX_SETTINGS.is_vat_registered?'block':'none';
  // NEW: auto-check the supplier VAT-registration checkbox and pre-select payment method
  const svEl=document.getElementById('si-supplier-vat-registered');if(svEl)svEl.checked=!!supplierVatRegistered;
  const payEl=document.getElementById('si-pay');
  if(payEl&&paymentStatus){const validValues=Array.from(payEl.options).map(o=>o.value);if(validValues.includes(paymentStatus))payEl.value=paymentStatus;}
  const reviewWrap=document.getElementById('rsReceiptReview');if(reviewWrap){reviewWrap.style.display='none';reviewWrap.innerHTML='';}
}
window.populateSingleIntakeForm=populateSingleIntakeForm;

// ── FIX 1+3+4+5 wired into retail single/manual stock intake ───────────────
async function receiveStock(){
  const supplier=document.getElementById('si-supplier').value.trim();
  const payMethod=document.getElementById('si-pay').value;
  const invoiceNo=(document.getElementById('si-invoice-no')||{}).value.trim()||'';
  const st=document.getElementById('si-st');
  const buyerRegistered=TAX_SETTINGS.is_vat_registered;
  const supplierRegistered=(document.getElementById('si-supplier-vat-registered')||{}).checked||false;
  const claimablePossible=buyerRegistered&&supplierRegistered;
  if(claimablePossible&&!invoiceNo){st.innerHTML='<span style="color:var(--red3)">Supplier Tax Invoice Number is required to claim Input VAT</span>';return;}
  const rowEls=Array.from(document.querySelectorAll('#si-rows .si-intake-row'));
  const candidates=[];
  const intakeCurrency=(document.getElementById('si-currency')||{}).value||'USD';
  rowEls.forEach(row=>{
    const sel=row.querySelector('.si-row-product');
    const productId=sel?sel.value:'';
    const parsedName=row.dataset.parsedName||'';
    const qty=parseFloat(row.querySelector('.si-row-qty').value)||0;
    const unitCost=convertToUSD(parseFloat(row.querySelector('.si-row-cost').value)||0,intakeCurrency);
    const taxTierSel=row.querySelector('.si-row-tax-tier');
    const taxTierId=taxTierSel?taxTierSel.value:'';
    const rateInput=row.querySelector('.si-row-tax-rate');
    const taxRatePct=rateInput?(parseFloat(rateInput.value)||0):0;
    const priceInclusive=row.querySelector('.si-row-tax-incl')?row.querySelector('.si-row-tax-incl').checked:false;
    if(qty<=0||unitCost<=0)return;
    candidates.push({productId,parsedName,qty,unitCost,taxTierId,taxRatePct,priceInclusive});
  });
  if(!candidates.length){st.innerHTML='<span style="color:var(--red3)">Add at least one item with a quantity and unit cost</span>';return;}
  for(const c of candidates){
    if(!c.productId&&!c.parsedName){st.innerHTML='<span style="color:var(--red3)">Select a product (or use + New) on every row</span>';return;}
  }
  st.innerHTML='<span style="color:var(--text3)">Recording receipt...</span>';
  try{
    const journalLines=[];const autoCreated=[];const tierTotals={};
    for(const c of candidates){
      let productId=c.productId?parseInt(c.productId):null;
      if(!productId){
        productId=await autoCreateProductFromReceiptLine(c.parsedName,c.unitCost,c.taxTierId,c.priceInclusive);
        autoCreated.push(c.parsedName);
      }
      const tier=getTaxTierById(c.taxTierId);
      const{inventoryAmt,recoverableTax,claimable}=computeClaimableTax(c.unitCost*c.qty,c.taxRatePct,c.priceInclusive,buyerRegistered,supplierRegistered);
      await dbApi({action:'receiveStock',companyId:SESSION.companyId,productId,qty:c.qty,unitCost:inventoryAmt/c.qty,supplier,paymentMethod:payMethod});
      await syncProductAfterIntake(productId,c.taxTierId,c.priceInclusive,c.qty,inventoryAmt/c.qty);
      const p=RETAIL_PRODUCTS.find(x=>x.id===productId);
      journalLines.push({productName:p?p.name:(c.parsedName||`Product #${productId}`),base:inventoryAmt,tax:recoverableTax});
      if(claimable&&tier){
        const key=tier.name;
        if(!tierTotals[key])tierTotals[key]={tierName:tier.name,rate:c.taxRatePct,base:0,tax:0};
        tierTotals[key].base+=inventoryAmt;tierTotals[key].tax+=recoverableTax;
      }
    }
    if(autoCreated.length)await loadRetailProducts();
    const totalBase=journalLines.reduce((s,l)=>s+l.base,0),totalTax=journalLines.reduce((s,l)=>s+l.tax,0),totalGrand=totalBase+totalTax;
    const names=journalLines.map(l=>l.productName);
    const intakeEntry=buildIntakeJournalEntry(`Stock received: ${supplier||'supplier'}${invoiceNo?` (Inv# ${invoiceNo})`:''} — ${names.join(', ')}`,journalLines,payMethod);
    const siSupplierSel=document.getElementById('si-supplier-sel');
    const intakeSupplierMatch=(siSupplierSel&&siSupplierSel.value)?SUPPLIERS.find(s=>String(s.id)===String(siSupplierSel.value)):await ensureSupplierExists(supplier);
    if(intakeSupplierMatch)intakeEntry.party={type:'supplier',id:intakeSupplierMatch.id,name:intakeSupplierMatch.name};
    DB.entries.push(intakeEntry);
    if(buyerRegistered){
      for(const t of Object.values(tierTotals)){
        await dbApi({action:'recordVatLedger',companyId:SESSION.companyId,direction:'input',tierName:t.tierName,rate:t.rate,baseAmount:t.base,taxAmount:t.tax,sourceType:'stock_receipt',sourceDesc:`${supplier||'supplier'} — ${names.join(', ')}`,supplierInvoiceNo:invoiceNo,entryDate:today()}).catch(e=>console.error('recordVatLedger',e));
      }
    }
    await saveData();await loadRetailProducts();renderAll();
    const createdMsg=autoCreated.length?` — new product(s): ${autoCreated.join(', ')} (set sale price in Catalogue)`:'';
    const vatMsg=totalTax>0.001?` (base ${fc(totalBase)} + VAT ${fc(totalTax)})`:'';
    st.innerHTML=`<span style="color:var(--green3)">✅ Received ${journalLines.length} item(s) — ${fc(totalGrand)}${vatMsg}${createdMsg}</span>`;
    document.getElementById('si-supplier').value='';
    const invEl=document.getElementById('si-invoice-no');if(invEl)invEl.value='';
    renderManualIntakeRows();
  }catch(e){
    st.innerHTML=`<span style="color:var(--red3)">❌ ${e.message}</span>`;
  }
  setTimeout(()=>{const s=document.getElementById('si-st');if(s)s.innerHTML='';},6000);
}
window.receiveStock=receiveStock;

async function confirmReceiptIntake(){
  const wrap=document.getElementById('rsReceiptReview');if(!wrap)return;
  const supplier=(document.getElementById('rs-review-supplier')||{}).value||'';
  const payMethod=(document.getElementById('rs-review-pay')||{}).value||'credit';
  const invoiceNo=(document.getElementById('rs-review-invoice')||{}).value?.trim()||'';
  const buyerRegistered=TAX_SETTINGS.is_vat_registered;
  const supplierRegistered=RS_PARSED_RECEIPT?!!RS_PARSED_RECEIPT.supplierVatRegistered:false;
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

// ── Receive Against Purchase Order (retail) — add rate input + claimability ─
function renderPOReceiptLines(){
  const wrap=document.getElementById('rs-po-lines');if(!wrap)return;
  const invWrap=document.getElementById('rs-po-invoice-wrap');if(invWrap)invWrap.style.display=TAX_SETTINGS.is_vat_registered?'block':'none';
  const poId=document.getElementById('rs-po-select').value;
  if(!poId){wrap.innerHTML='<div style="color:var(--text3);font-size:12px;padding:10px 0">Select a purchase order above to see its remaining items.</div>';return;}
  const po=PO_ORDERS.find(o=>String(o.id)===String(poId));
  if(!po){wrap.innerHTML='';return;}
  const items=Array.isArray(po.items)?po.items:JSON.parse(po.items||'[]');
  const rows=items.map((it)=>{
    const ordered=parseFloat(it.qty)||0,received=parseFloat(it.receivedQty)||0,remaining=Math.max(0,ordered-received);
    const product=RETAIL_PRODUCTS.find(p=>p.id===it.productId);
    const defaultTierId=product&&product.tax_tier_id?product.tax_tier_id:(getDefaultTaxTier()?getDefaultTaxTier().id:'');
    const defaultTier=getTaxTierById(defaultTierId);
    const defaultRate=defaultTier?parseFloat(defaultTier.rate):'';
    return `<div style="display:grid;grid-template-columns:1.6fr 0.8fr 0.8fr 0.8fr 0.9fr 1fr 0.6fr auto;gap:6px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)" data-po-product-id="${it.productId}">
      <div style="font-size:12px">${it.name}</div>
      <div style="font-size:11px;color:var(--text3);font-family:'JetBrains Mono',monospace">Ord: ${ordered}</div>
      <div style="font-size:11px;color:var(--text3);font-family:'JetBrains Mono',monospace">Recv: ${received}</div>
      <input class="rs-accept-qty" type="number" min="0" max="${remaining}" value="${remaining}" placeholder="Accept" style="background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none"/>
      <input class="rs-accept-cost" type="number" step="0.01" value="${it.unitCost||0}" placeholder="Unit cost" style="background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none"/>
      <select class="rs-accept-tax-tier" onchange="syncIntakeRateFromTier(this)" style="background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text);outline:none">${taxTierSelectOptions(defaultTierId)}</select>
      <input class="rs-accept-tax-rate" type="number" step="0.01" value="${defaultRate}" placeholder="Rate %" style="background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none"/>
      <label style="display:flex;align-items:center;gap:4px;font-size:9px;color:var(--text3);white-space:nowrap"><input type="checkbox" class="rs-accept-tax-incl" style="accent-color:var(--gold2)"/> incl.</label>
    </div>`;
  }).join('');
  wrap.innerHTML=`<div style="display:grid;grid-template-columns:1.6fr 0.8fr 0.8fr 0.8fr 0.9fr 1fr 0.6fr auto;gap:6px;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--text3);padding-bottom:5px;border-bottom:1px solid var(--border2)"><div>Product</div><div>Ord</div><div>Recv</div><div>Accept</div><div>Cost</div><div>Tax Tier</div><div>Rate%</div></div>${rows}`;
}
window.renderPOReceiptLines=renderPOReceiptLines;

async function confirmPOReceipt(){
  const poId=document.getElementById('rs-po-select').value,st=document.getElementById('rs-po-st');
  if(!poId){st.innerHTML='<span style="color:var(--red3)">Select a purchase order</span>';return;}
  const invoiceNo=(document.getElementById('rs-po-invoice')||{}).value?.trim()||'';
  const buyerRegistered=TAX_SETTINGS.is_vat_registered;
  const supplierRegistered=(document.getElementById('rs-po-supplier-vat-registered')||{}).checked||false;
  const claimablePossible=buyerRegistered&&supplierRegistered;
  if(claimablePossible&&!invoiceNo){st.innerHTML='<span style="color:var(--red3)">Supplier Tax Invoice Number is required to claim Input VAT</span>';return;}
  const lineEls=document.querySelectorAll('#rs-po-lines [data-po-product-id]');
  const candidates=[];
  lineEls.forEach(row=>{
    const productId=row.dataset.poProductId;
    const qty=parseFloat(row.querySelector('.rs-accept-qty').value)||0;
    const unitCost=parseFloat(row.querySelector('.rs-accept-cost').value)||0;
    const taxTierSel=row.querySelector('.rs-accept-tax-tier');
    const taxTierId=taxTierSel?taxTierSel.value:'';
    const rateInput=row.querySelector('.rs-accept-tax-rate');
    const taxRatePct=rateInput?(parseFloat(rateInput.value)||0):0;
    const priceInclusive=row.querySelector('.rs-accept-tax-incl')?row.querySelector('.rs-accept-tax-incl').checked:false;
    if(qty>0)candidates.push({productId:parseInt(productId),qty,unitCost,taxTierId,taxRatePct,priceInclusive});
  });
  if(!candidates.length){st.innerHTML='<span style="color:var(--red3)">Enter at least one accepted quantity</span>';return;}
  st.innerHTML='<span style="color:var(--text3)">Confirming receipt...</span>';
  try{
    const splitByProduct={};
    const receipts=candidates.map(c=>{
      const tier=getTaxTierById(c.taxTierId);
      const{inventoryAmt,recoverableTax}=computeClaimableTax(c.unitCost*c.qty,c.taxRatePct,c.priceInclusive,buyerRegistered,supplierRegistered);
      splitByProduct[c.productId]={inventoryAmt,recoverableTax,tierName:tier?tier.name:'',rate:c.taxRatePct};
      return{productId:c.productId,qty:c.qty,unitCost:inventoryAmt/c.qty};
    });
    const r=await dbApi({action:'receivePOStock',companyId:SESSION.companyId,poId:parseInt(poId),receipts});
    const accepted=r.accepted||[];
    const tierTotals={};
    const journalLines=[];
    for(const a of accepted){
      const split=splitByProduct[a.productId]||{inventoryAmt:a.qty*a.unitCost,recoverableTax:0,tierName:'',rate:0};
      const c=candidates.find(x=>x.productId===a.productId);
      if(c)await syncProductAfterIntake(a.productId,c.taxTierId,c.priceInclusive,a.qty,split.inventoryAmt/a.qty);
      journalLines.push({productName:a.name,base:split.inventoryAmt,tax:split.recoverableTax});
      if(claimablePossible&&split.tierName){
        const key=split.tierName||'—';
        if(!tierTotals[key])tierTotals[key]={tierName:split.tierName,rate:split.rate,base:0,tax:0};
        tierTotals[key].base+=split.inventoryAmt;tierTotals[key].tax+=split.recoverableTax;
      }
    }
    const totalBase=journalLines.reduce((s,l)=>s+l.base,0),totalTax=journalLines.reduce((s,l)=>s+l.tax,0),totalGrand=totalBase+totalTax;
    if(totalGrand>0){
      const po=PO_ORDERS.find(o=>String(o.id)===String(poId));
      const poEntry=buildIntakeJournalEntry(`Stock received: PO #${poId} — ${po?po.supplier:'supplier'}${invoiceNo?` (Inv# ${invoiceNo})`:''} (${accepted.map(a=>a.name+' ×'+a.qty).join(', ')})`,journalLines,'credit');
      const supplierMatch=po?await ensureSupplierExists(po.supplier):null;
      if(supplierMatch)poEntry.party={type:'supplier',id:supplierMatch.id,name:supplierMatch.name};
      DB.entries.push(poEntry);
      await saveData();
      if(buyerRegistered){
        for(const t of Object.values(tierTotals)){
          await dbApi({action:'recordVatLedger',companyId:SESSION.companyId,direction:'input',tierName:t.tierName,rate:t.rate,baseAmount:t.base,taxAmount:t.tax,sourceType:'po_receipt',sourceDesc:`PO #${poId} — ${po?po.supplier:'supplier'}`,supplierInvoiceNo:invoiceNo,entryDate:today()}).catch(e=>console.error('recordVatLedger',e));
        }
      }
    }
    await loadRetailProducts();
    await loadPurchaseOrdersCache();
    renderPOReceiptLines();
    renderPOReceiveSelect();
    await renderPOList();
    renderAll();
    const vatMsg=totalTax>0.001?` (base ${fc(totalBase)} + VAT ${fc(totalTax)})`:'';
    st.innerHTML=`<span style="color:var(--green3)">✅ Receipt confirmed${vatMsg} — PO now ${(PO_STATUS_LABEL[r.status]||r.status).toLowerCase()}</span>`;
    showToast(`✅ Stock received — PO #${poId} is now ${PO_STATUS_LABEL[r.status]||r.status}`);
  }catch(e){
    st.innerHTML=`<span style="color:var(--red3)">❌ ${e.message}</span>`;
  }
  setTimeout(()=>{const s=document.getElementById('rs-po-st');if(s)s.innerHTML='';},6000);
}
window.confirmPOReceipt=confirmPOReceipt;

// ═════════════════════════════════════════════════════════════════════════
// FIX 6 — CONSTRUCTION MODULE: previously had NO tax fields at all.
// These overrides give Deliveries + Material Purchase Order receiving the
// exact same VAT logic retail already had, now including the buyer/seller
// claimability matrix.
// ═════════════════════════════════════════════════════════════════════════
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
  return rowId;
}
window.addMaterialIntakeRow=addMaterialIntakeRow;

async function confirmMaterialsDelivery(){
  const supplier=document.getElementById('delSupplier').value.trim();
  const supplierSel=document.getElementById('delSupplierSel');
  const invNo=document.getElementById('delInvNo').value.trim();
  const payMethod=document.getElementById('delPay').value;
  const date=document.getElementById('delDate').value||today();
  const st=document.getElementById('delSt');
  const buyerRegistered=TAX_SETTINGS.is_vat_registered;
  const supplierRegistered=(document.getElementById('del-supplier-vat-registered')||{}).checked||false;
  const claimablePossible=buyerRegistered&&supplierRegistered;
  const taxInvoiceNo=(document.getElementById('del-invoice-no')||{}).value?.trim()||'';
  if(!supplier){st.innerHTML='<span style="color:var(--red3)">Enter a supplier</span>';return;}
  if(claimablePossible&&!taxInvoiceNo){st.innerHTML='<span style="color:var(--red3)">Supplier Tax Invoice Number is required to claim Input VAT</span>';return;}
  const rowEls=Array.from(document.querySelectorAll('#del-rows .del-intake-row'));
  const candidates=[];
  const delCurrency=(document.getElementById('del-currency')||{}).value||'USD';
  rowEls.forEach(row=>{
    const sel=row.querySelector('.material-select');
    const materialId=sel?sel.value:'';
    const parsedName=row.dataset.parsedName||'';
    const qty=parseFloat(row.querySelector('.del-row-qty').value)||0;
    const unitCost=convertToUSD(parseFloat(row.querySelector('.del-row-cost').value)||0,delCurrency);
    const taxTierSel=row.querySelector('.del-row-tax-tier');
    const taxTierId=taxTierSel?taxTierSel.value:'';
    const rateInput=row.querySelector('.del-row-tax-rate');
    const taxRatePct=rateInput?(parseFloat(rateInput.value)||0):0;
    const priceInclusive=row.querySelector('.del-row-tax-incl')?row.querySelector('.del-row-tax-incl').checked:false;
    if(qty<=0||unitCost<=0)return;
    candidates.push({materialId,parsedName,qty,unitCost,taxTierId,taxRatePct,priceInclusive});
  });
  if(!candidates.length){st.innerHTML='<span style="color:var(--red3)">Add at least one item with a quantity and unit cost</span>';return;}
  for(const c of candidates){if(!c.materialId&&!c.parsedName){st.innerHTML='<span style="color:var(--red3)">Select a material (or use + New) on every row</span>';return;}}
  st.innerHTML='<span style="color:var(--text3)">Recording delivery...</span>';
  try{
    let supplierObj=supplierSel&&supplierSel.value?SUPPLIERS.find(s=>String(s.id)===String(supplierSel.value)):null;
    if(!supplierObj)supplierObj=await ensureSupplierExists(supplier);
    const journalLines=[];const namesForHistory=[];const tierTotals={};
    for(const c of candidates){
      let mat=c.materialId?DB.materials.find(m=>String(m.id)===String(c.materialId)):null;
      if(!mat)mat=await ensureMaterialExists(c.parsedName);
      if(!mat)continue;
      const tier=getTaxTierById(c.taxTierId);
      const{inventoryAmt,recoverableTax,claimable}=computeClaimableTax(c.qty*c.unitCost,c.taxRatePct,c.priceInclusive,buyerRegistered,supplierRegistered);
      syncMaterialAfterIntake(mat.id,c.qty,inventoryAmt/c.qty,date);
      journalLines.push({productName:mat.name,base:inventoryAmt,tax:recoverableTax});
      namesForHistory.push(`${mat.name} ×${c.qty}`);
      if(claimable&&tier){
        const key=tier.name;
        if(!tierTotals[key])tierTotals[key]={tierName:tier.name,rate:c.taxRatePct,base:0,tax:0};
        tierTotals[key].base+=inventoryAmt;tierTotals[key].tax+=recoverableTax;
      }
    }
    const totalBase=journalLines.reduce((s,l)=>s+l.base,0),totalTax=journalLines.reduce((s,l)=>s+l.tax,0),total=totalBase+totalTax;
    const entry=buildIntakeJournalEntry(`Delivery: ${supplier}${invNo?` (Inv# ${invNo})`:''} — ${namesForHistory.join(', ')}`,journalLines,payMethod,'Construction Materials','Delivery');
    if(supplierObj)entry.party={type:'supplier',id:supplierObj.id,name:supplierObj.name};
    DB.entries.push(entry);
    DB.deliveries.push({id:Date.now(),supplier,invNo,items:namesForHistory.join(', '),total,pay:payMethod,date});
    await saveData();
    if(buyerRegistered){
      for(const t of Object.values(tierTotals)){
        await dbApi({action:'recordVatLedger',companyId:SESSION.companyId,direction:'input',tierName:t.tierName,rate:t.rate,baseAmount:t.base,taxAmount:t.tax,sourceType:'material_delivery',sourceDesc:`Delivery: ${supplier} — ${namesForHistory.join(', ')}`,supplierInvoiceNo:taxInvoiceNo,entryDate:date}).catch(e=>console.error('recordVatLedger',e));
      }
    }
    renderAll();
    const vatMsg=totalTax>0.001?` (base ${fc(totalBase)} + VAT ${fc(totalTax)})`:'';
    st.innerHTML=`<span style="color:var(--green3)">✅ Received ${journalLines.length} item(s) — ${fc(total)}${vatMsg}</span>`;
    document.getElementById('delSupplier').value='';
    if(supplierSel)supplierSel.value='';
    document.getElementById('delInvNo').value='';
    const invNoEl=document.getElementById('del-invoice-no');if(invNoEl)invNoEl.value='';
    renderMaterialIntakeRows();
  }catch(e){
    st.innerHTML=`<span style="color:var(--red3)">❌ ${e.message}</span>`;
  }
  setTimeout(()=>{const s=document.getElementById('delSt');if(s)s.innerHTML='';},6000);
}
window.confirmMaterialsDelivery=confirmMaterialsDelivery;

function renderMaterialIntakeRows(){
  const wrap=document.getElementById('del-rows');if(!wrap)return;
  wrap.innerHTML='';window._delRowSeq=0;
  addMaterialIntakeRow();
  const invEl=document.getElementById('delInvNo');if(invEl)invEl.value='';
}
window.renderMaterialIntakeRows=renderMaterialIntakeRows;

// ── Construction: Receive Against Purchase Order — add tax fields ──────────
function renderMaterialPOReceiptLines(){
  const wrap=document.getElementById('del-po-lines');if(!wrap)return;
  const poId=document.getElementById('del-po-select').value;
  if(!poId){wrap.innerHTML='<div style="color:var(--text3);font-size:12px;padding:10px 0">Select a purchase order above to see its remaining items.</div>';return;}
  const po=PO_ORDERS.find(o=>String(o.id)===String(poId));
  if(!po){wrap.innerHTML='';return;}
  const items=Array.isArray(po.items)?po.items:JSON.parse(po.items||'[]');
  const rows=items.map(it=>{
    const ordered=parseFloat(it.qty)||0,received=parseFloat(it.receivedQty)||0,remaining=Math.max(0,ordered-received);
    const defaultTierId=getDefaultTaxTier()?getDefaultTaxTier().id:'';
    const defaultTier=getTaxTierById(defaultTierId);
    const defaultRate=defaultTier?parseFloat(defaultTier.rate):'';
    return `<div style="display:grid;grid-template-columns:1.5fr 0.7fr 0.7fr 0.7fr 0.9fr 1fr 0.6fr" style="gap:7px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)" data-po-material-id="${it.productId}">
      <div style="font-size:12px">${it.name}</div>
      <div style="font-size:11px;color:var(--text3);font-family:'JetBrains Mono',monospace">Ord: ${ordered}</div>
      <div style="font-size:11px;color:var(--text3);font-family:'JetBrains Mono',monospace">Recv: ${received}</div>
      <input class="del-po-accept-qty" type="number" min="0" max="${remaining}" value="${remaining}" placeholder="Accept qty" style="background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none"/>
      <input class="del-po-accept-cost" type="number" step="0.01" value="${it.unitCost||0}" placeholder="Unit cost" style="background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none"/>
      <select class="del-po-accept-tax-tier" onchange="syncIntakeRateFromTier(this)" style="background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text);outline:none">${taxTierSelectOptions(defaultTierId)}</select>
      <input class="del-po-accept-tax-rate" type="number" step="0.01" value="${defaultRate}" placeholder="Rate %" style="background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:7px 9px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none"/>
    </div>`;
  }).join('');
  wrap.innerHTML=`<div style="display:grid;grid-template-columns:1.5fr 0.7fr 0.7fr 0.7fr 0.9fr 1fr 0.6fr;gap:7px;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--text3);padding-bottom:5px;border-bottom:1px solid var(--border2)"><div>Material</div><div>Ord</div><div>Recv</div><div>Accept</div><div>Cost</div><div>Tax Tier</div><div>Rate%</div></div>${rows}`;
}
window.renderMaterialPOReceiptLines=renderMaterialPOReceiptLines;

async function confirmMaterialPOReceipt(){
  const poId=document.getElementById('del-po-select').value,st=document.getElementById('del-po-st');
  if(!poId){st.innerHTML='<span style="color:var(--red3)">Select a purchase order</span>';return;}
  const buyerRegistered=TAX_SETTINGS.is_vat_registered;
  const supplierRegistered=(document.getElementById('del-po-supplier-vat-registered')||{}).checked||false;
  const claimablePossible=buyerRegistered&&supplierRegistered;
  const invoiceNo=(document.getElementById('del-po-invoice-no')||{}).value?.trim()||'';
  if(claimablePossible&&!invoiceNo){st.innerHTML='<span style="color:var(--red3)">Supplier Tax Invoice Number is required to claim Input VAT</span>';return;}
  const lineEls=document.querySelectorAll('#del-po-lines [data-po-material-id]');
  const candidates=[];
  lineEls.forEach(row=>{
    const materialId=row.dataset.poMaterialId;
    const qty=parseFloat(row.querySelector('.del-po-accept-qty').value)||0;
    const unitCost=parseFloat(row.querySelector('.del-po-accept-cost').value)||0;
    const taxTierSel=row.querySelector('.del-po-accept-tax-tier');
    const taxTierId=taxTierSel?taxTierSel.value:'';
    const rateInput=row.querySelector('.del-po-accept-tax-rate');
    const taxRatePct=rateInput?(parseFloat(rateInput.value)||0):0;
    if(qty>0)candidates.push({materialId,qty,unitCost,taxTierId,taxRatePct});
  });
  if(!candidates.length){st.innerHTML='<span style="color:var(--red3)">Enter at least one accepted quantity</span>';return;}
  st.innerHTML='<span style="color:var(--text3)">Confirming receipt...</span>';
  try{
    const po=PO_ORDERS.find(o=>String(o.id)===String(poId));
    if(!po)throw new Error('Purchase order not found');
    const items=Array.isArray(po.items)?po.items:JSON.parse(po.items||'[]');
    const journalLines=[];const namesForHistory=[];const tierTotals={};
    for(const c of candidates){
      const mat=DB.materials.find(m=>String(m.id)===String(c.materialId));
      if(!mat)continue;
      const tier=getTaxTierById(c.taxTierId);
      const{inventoryAmt,recoverableTax,claimable}=computeClaimableTax(c.qty*c.unitCost,c.taxRatePct,false,buyerRegistered,supplierRegistered);
      syncMaterialAfterIntake(mat.id,c.qty,inventoryAmt/c.qty,today());
      journalLines.push({productName:mat.name,base:inventoryAmt,tax:recoverableTax});
      namesForHistory.push(`${mat.name} ×${c.qty}`);
      if(claimable&&tier){
        const key=tier.name;
        if(!tierTotals[key])tierTotals[key]={tierName:tier.name,rate:c.taxRatePct,base:0,tax:0};
        tierTotals[key].base+=inventoryAmt;tierTotals[key].tax+=recoverableTax;
      }
      const line=items.find(it=>String(it.productId)===String(c.materialId));
      if(line)line.receivedQty=(parseFloat(line.receivedQty)||0)+c.qty;
    }
    const allFull=items.length>0&&items.every(it=>(parseFloat(it.receivedQty)||0)>=(parseFloat(it.qty)||0)-0.0001);
    const anyReceived=items.some(it=>(parseFloat(it.receivedQty)||0)>0);
    const newStatus=allFull?'completed':(anyReceived?'partial':'pending');
    await dbApi({action:'updatePurchaseOrderStatus',companyId:SESSION.companyId,poId:parseInt(poId),items,status:newStatus});
    const totalBase=journalLines.reduce((s,l)=>s+l.base,0),totalTax=journalLines.reduce((s,l)=>s+l.tax,0),total=totalBase+totalTax;
    if(total>0){
      const entry=buildIntakeJournalEntry(`Delivery: PO #${poId} — ${po.supplier} (${namesForHistory.join(', ')})`,journalLines,'credit','Construction Materials','Delivery');
      const supplierMatch=await ensureSupplierExists(po.supplier);
      if(supplierMatch)entry.party={type:'supplier',id:supplierMatch.id,name:supplierMatch.name};
      DB.entries.push(entry);
      DB.deliveries.push({id:Date.now(),supplier:po.supplier,invNo:`PO #${poId}`,items:namesForHistory.join(', '),total,pay:'credit',date:today()});
      await saveData();
      if(buyerRegistered){
        for(const t of Object.values(tierTotals)){
          await dbApi({action:'recordVatLedger',companyId:SESSION.companyId,direction:'input',tierName:t.tierName,rate:t.rate,baseAmount:t.base,taxAmount:t.tax,sourceType:'po_receipt',sourceDesc:`PO #${poId} — ${po.supplier}`,supplierInvoiceNo:invoiceNo,entryDate:today()}).catch(e=>console.error('recordVatLedger',e));
        }
      }
    }
    await loadPurchaseOrdersCache();
    renderMaterialPOReceiptLines();
    renderMaterialPOReceiveSelect();
    renderAll();
    const vatMsg=totalTax>0.001?` (base ${fc(totalBase)} + VAT ${fc(totalTax)})`:'';
    st.innerHTML=`<span style="color:var(--green3)">✅ Receipt confirmed${vatMsg} — PO now ${(PO_STATUS_LABEL[newStatus]||newStatus).toLowerCase()}</span>`;
    showToast(`✅ Materials received — PO #${poId} is now ${PO_STATUS_LABEL[newStatus]||newStatus}`);
  }catch(e){
    st.innerHTML=`<span style="color:var(--red3)">❌ ${e.message}</span>`;
  }
  setTimeout(()=>{const s=document.getElementById('del-po-st');if(s)s.innerHTML='';},6000);
}
window.confirmMaterialPOReceipt=confirmMaterialPOReceipt;

// ── Wrap injectRetailPages to add the new checkbox/rate UI to retail pages ──
const _origInjectRetailPages=window.injectRetailPages;
function injectRetailPages(){
  if(typeof _origInjectRetailPages==='function')_origInjectRetailPages();

  // Manual Stock Intake — supplier VAT-registered checkbox (invoice field already exists)
  if(!document.getElementById('si-supplier-vat-registered')){
    const invWrap=document.getElementById('si-invoice-wrap');
    if(invWrap){
      invWrap.insertAdjacentHTML('beforebegin',`<div class="fg"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text2)"><input type="checkbox" id="si-supplier-vat-registered" style="accent-color:var(--gold2)"/> Supplier is VAT-registered (has TIN / issues Tax Invoice)</label></div>`);
    }
  }
  // Add mobile/bank payment options to manual intake + PO creation
  ['si-pay','po-pay'].forEach(id=>{
    const sel=document.getElementById(id);
    if(sel&&!sel.querySelector('option[value="mobile"]')){
      sel.insertAdjacentHTML('beforeend','<option value="mobile">Mobile Money</option><option value="bank">Bank</option>');
    }
  });

  // Receive Against PO — supplier VAT-registered checkbox
  if(!document.getElementById('rs-po-supplier-vat-registered')){
    const invWrap=document.getElementById('rs-po-invoice-wrap');
    if(invWrap){
      invWrap.insertAdjacentHTML('beforebegin',`<div class="fg"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text2)"><input type="checkbox" id="rs-po-supplier-vat-registered" style="accent-color:var(--gold2)"/> Supplier is VAT-registered (has TIN / issues Tax Invoice)</label></div>`);
    }
  }
}
window.injectRetailPages=injectRetailPages;

// ── One-time DOM injection for the CONSTRUCTION Deliveries page (static HTML,
//    present from page load — no wrapping needed) ──────────────────────────
function injectConstructionTaxUI(){
  // Manual delivery — supplier VAT-registered checkbox + invoice number field
  if(!document.getElementById('del-supplier-vat-registered')){
    const hint=document.getElementById('del-currency-hint');
    if(hint){
      hint.insertAdjacentHTML('afterend',`
        <div class="fg"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text2)"><input type="checkbox" id="del-supplier-vat-registered" style="accent-color:var(--gold2)"/> Supplier is VAT-registered (has TIN / issues Tax Invoice)</label></div>
        <div class="fg" id="del-invoice-wrap" style="display:none"><label>Supplier Tax Invoice Number <span style="color:var(--red3)">*</span></label><input id="del-invoice-no" type="text" placeholder="Required to claim Input VAT"/></div>
      `);
      const cb=document.getElementById('del-supplier-vat-registered');
      if(cb)cb.addEventListener('change',function(){
        const w=document.getElementById('del-invoice-wrap');
        if(w)w.style.display=(TAX_SETTINGS.is_vat_registered&&this.checked)?'block':'none';
      });
    }
  }
  // Add Mobile Money option to construction delivery payment select
  const delPay=document.getElementById('delPay');
  if(delPay&&!delPay.querySelector('option[value="mobile"]')){
    delPay.insertAdjacentHTML('beforeend','<option value="mobile">Mobile Money</option>');
  }
  // Receive Against Purchase Order (construction) — supplier VAT checkbox + invoice field
  if(!document.getElementById('del-po-supplier-vat-registered')){
    const poSelect=document.getElementById('del-po-select');
    if(poSelect&&poSelect.parentElement){
      poSelect.parentElement.insertAdjacentHTML('afterend',`
        <div class="fg"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text2)"><input type="checkbox" id="del-po-supplier-vat-registered" style="accent-color:var(--gold2)"/> Supplier is VAT-registered (has TIN / issues Tax Invoice)</label></div>
        <div class="fg"><label>Supplier Tax Invoice Number</label><input id="del-po-invoice-no" type="text" placeholder="Required to claim Input VAT"/></div>
      `);
    }
  }
}

// Run once at load (Deliveries markup is static HTML already in the document)
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',injectConstructionTaxUI);
}else{
  injectConstructionTaxUI();
}
// Also re-run whenever the Deliveries page is navigated to, in case any prior
// re-render touched that section (cheap no-op if elements already exist).
const _origNav=window.nav;
if(typeof _origNav==='function'){
  window.nav=async function(page,el){
    const result=await _origNav(page,el);
    if(page==='deliveries')injectConstructionTaxUI();
    return result;
  };
}

console.log('✅ Hisabi Hensi purchasing/stock-receive patch v2 loaded — cost/sale price independence, buyer/seller VAT matrix, inclusive tax math, payment detection, and construction VAT handling are now active.');
})();
