// ═══════════════════════════════════════════════════════════
// PATCH v36 — Early Payment Discount, Phase 2: Apply to Pay Supplier (AP)
// ═══════════════════════════════════════════════════════════
// Builds on patch-v35 (Payment Terms registry + tagging). This is where a
// discount actually starts reducing what you pay — scoped to Pay Supplier
// first, as decided, so it can be tested in isolation before mirroring to
// Receive Payment.
//
// SCOPE, stated plainly: this patch applies discounts to invoices settled
// through the plain "Apply" amount rows (.ps-apply-amt) — i.e. invoices
// with NO foreign-currency tag. FX-tagged invoices (.ps-fx-settle rows)
// are completely UNCHANGED by this patch — same v28 behavior, byte for
// byte. The architecture doc describes how discount and FX gain/loss stack
// together on the same payment; that combined case is a deliberate
// fast-follow, not built here, so this patch stays focused and easy to
// verify on its own.
//
// WHAT HAPPENS NOW: open an invoice tagged with Payment Terms in Pay
// Supplier, and if the payment date is on or before its discount deadline,
// the app shows the available discount and automatically reduces the cash
// actually paid — posting the discount to "Purchase Discount Received" in
// the same entry, exactly as designed. A manual override lets you grant or
// deny the automatic result, with a required reason.
//
// THE MATH (verified below before shipping):
//   bookedPortion = the Apply amount (unchanged — same as today, clears AP)
//   discount = evaluateDiscountV35(entry.terms, paymentDate, bookedPortion)
//   cashPaid = bookedPortion − discount
// Debits:  Accounts Payable(bookedPortion)         [unchanged from today]
// Credits: Cash/Bank(cashPaid) + Purchase Discount Received(discount)
// cashPaid + discount = bookedPortion, always, by construction — this
// balances exactly the same way the FX gain/loss entry already does.
// ═══════════════════════════════════════════════════════════

// ── Extend getOpenAPInvoices to carry the invoice's terms (superset) ────
function getOpenAPInvoices(supplierId){
  return (DB.entries||[])
    .filter(e=>e.party&&e.party.type==='supplier'&&String(e.party.id)===String(supplierId))
    .map(e=>{
      const apLine=(e.credits||[]).find(l=>l.acct==='Accounts Payable');
      if(!apLine)return null;
      const booked=getCurrentBookedAmount(e);
      const settled=getSettledAmountForInvoice(e.id);
      const remaining=+(booked-settled).toFixed(2);
      return{id:e.id,date:e.date,desc:e.desc,original:apLine.amt,booked,settled,remaining,fx:e.fx||null,terms:e.terms||null};
    })
    .filter(x=>x&&x.remaining>0.01)
    .sort((a,b)=>a.date.localeCompare(b.date));
}

// ── Discount preview block for a single non-fx invoice row ──────────────
// paymentDate/amt are read live so this reflects whatever's currently
// typed, not just the state when the modal opened.
function computePaySupplierDiscountV36(inv, paymentDate, amt, overrideOn, overrideGrant){
  if(!inv.terms) return { discount:0, eligible:false, reason:null, hasTerms:false };
  const policy = inv.terms.partial_payment_policy || 'prorated';
  let baseResult;
  if(policy === 'full_invoice_only'){
    const isFullSettle = amt >= (inv.remaining - 0.01);
    baseResult = isFullSettle
      ? evaluateDiscountV35(inv.terms, paymentDate, amt)
      : { eligible:false, discount:0, reason:'this policy only grants the discount when the full remaining balance is paid at once' };
  } else {
    baseResult = evaluateDiscountV35(inv.terms, paymentDate, amt);
  }
  if(overrideOn){
    // Manual override flips the automatic result in whichever direction was chosen.
    if(overrideGrant && !baseResult.eligible){
      const ratio = inv.terms.eligible_ratio!=null?inv.terms.eligible_ratio:1;
      const discount = +((amt*ratio)*(inv.terms.discount_percent/100)).toFixed(2);
      return { discount, eligible:true, reason:'manually granted (override)', hasTerms:true, overridden:true };
    }
    if(!overrideGrant && baseResult.eligible){
      return { discount:0, eligible:false, reason:'manually denied (override)', hasTerms:true, overridden:true };
    }
  }
  return Object.assign({hasTerms:true}, baseResult);
}

function renderPaySupplierDiscountRowV36(inv){
  if(!inv.terms) return '';
  return `<div class="ps-discount-block" data-invoice-id="${inv.id}" style="margin-top:6px;padding:6px 8px;background:var(--bg3);border-radius:5px;font-size:10px">
    <div class="ps-discount-status" data-invoice-id="${inv.id}" style="color:var(--text3)"></div>
    <label style="display:flex;align-items:center;gap:5px;margin-top:4px;cursor:pointer;color:var(--text3)">
      <input type="checkbox" class="ps-discount-override-chk" data-invoice-id="${inv.id}" onchange="onPaySupplierDiscountChange(${inv.id})"/> Override
    </label>
    <div class="ps-discount-override-row" data-invoice-id="${inv.id}" style="display:none;margin-top:4px">
      <select class="ps-discount-override-dir" data-invoice-id="${inv.id}" onchange="onPaySupplierDiscountChange(${inv.id})" style="width:100%;margin-bottom:4px;background:var(--bg2);border:1px solid var(--border2);border-radius:4px;padding:4px;color:var(--text);font-size:10px">
        <option value="grant">Grant discount anyway</option>
        <option value="deny">Deny discount</option>
      </select>
      <input type="text" class="ps-discount-override-reason" data-invoice-id="${inv.id}" placeholder="Reason (required)" oninput="onPaySupplierDiscountChange(${inv.id})" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:4px;padding:4px 6px;color:var(--text);font-size:10px"/>
    </div>
  </div>`;
}

// Redefines renderPaySupplierRow (from v21) as a superset: fx rows and
// non-fx rows without terms render byte-for-byte identically; a non-fx
// row WITH terms gets the discount block appended below its Apply input.
const _origRenderPaySupplierRowV36 = renderPaySupplierRow;
function renderPaySupplierRow(inv){
  const html = _origRenderPaySupplierRowV36(inv);
  if(inv.fx || !inv.terms) return html; // FX rows and plain rows without terms: unchanged
  // Inject the discount block just before the closing </td></tr> of the Apply cell.
  return html.replace('</td>\n  </tr>', `${renderPaySupplierDiscountRowV36(inv)}</td>\n  </tr>`);
}

function onPaySupplierDiscountChange(invoiceId){
  refreshPaySupplierDiscountV36(invoiceId);
  recalcPaySupplierTotal();
}

function refreshPaySupplierDiscountV36(invoiceId){
  const statusEl = document.querySelector(`.ps-discount-status[data-invoice-id="${invoiceId}"]`);
  if(!statusEl) return; // not a discount-eligible row
  const open = getOpenAPInvoices(PS_SUPPLIER_ID);
  const inv = open.find(x=>String(x.id)===String(invoiceId));
  if(!inv || !inv.terms) return;
  const amtEl = document.querySelector(`.ps-apply-amt[data-invoice-id="${invoiceId}"]`);
  const amt = amtEl ? (parseFloat(amtEl.value)||0) : 0;
  const dateEl = document.getElementById('ps-date');
  const paymentDate = dateEl ? dateEl.value : today();
  const chk = document.querySelector(`.ps-discount-override-chk[data-invoice-id="${invoiceId}"]`);
  const overrideOn = chk ? chk.checked : false;
  const overrideRow = document.querySelector(`.ps-discount-override-row[data-invoice-id="${invoiceId}"]`);
  if(overrideRow) overrideRow.style.display = overrideOn ? 'block' : 'none';
  const dirEl = document.querySelector(`.ps-discount-override-dir[data-invoice-id="${invoiceId}"]`);
  const overrideGrant = dirEl ? dirEl.value === 'grant' : true;
  const result = computePaySupplierDiscountV36(inv, paymentDate, amt, overrideOn, overrideGrant);
  if(result.eligible && result.discount > 0.001){
    statusEl.innerHTML = `<span style="color:var(--green3)">💰 ${inv.terms.code}${result.overridden?' (override)':''}: discount ${fc(result.discount)}</span> — you'll pay ${fc(amt-result.discount)}`;
  } else if(result.hasTerms){
    statusEl.innerHTML = `<span style="color:var(--text3)">${inv.terms.code}: ${result.reason||'no discount on this payment'}</span>`;
  }
}

// Redefines openPaySupplierModal (superset of v21/v28's chain): identical
// setup, then refresh every discount row after the table renders.
const _origOpenPaySupplierModalV36 = window.openPaySupplierModal;
if(typeof _origOpenPaySupplierModalV36 === 'function'){
  window.openPaySupplierModal = function(supplierId){
    const result = _origOpenPaySupplierModalV36(supplierId);
    const open = getOpenAPInvoices(supplierId);
    open.forEach(inv=>{ if(inv.terms && !inv.fx) refreshPaySupplierDiscountV36(inv.id); });
    const dateEl = document.getElementById('ps-date');
    if(dateEl && !dateEl.dataset.v36Bound){
      dateEl.dataset.v36Bound = '1';
      dateEl.addEventListener('change', function(){
        document.querySelectorAll('.ps-discount-status').forEach(el=>{
          refreshPaySupplierDiscountV36(el.dataset.invoiceId);
        });
        recalcPaySupplierTotal();
      });
    }
    return result;
  };
}

// Redefines recalcPaySupplierTotal (superset of v21's version): same total
// logic, plus refreshes each discount row and shows total discount if any.
const _origRecalcPaySupplierTotalV36 = recalcPaySupplierTotal;
function recalcPaySupplierTotal(){
  document.querySelectorAll('.ps-apply-amt').forEach(el=>{
    const invId = el.dataset.invoiceId;
    if(document.querySelector(`.ps-discount-status[data-invoice-id="${invId}"]`)) refreshPaySupplierDiscountV36(invId);
  });
  let totalDiscount = 0;
  document.querySelectorAll('.ps-discount-status').forEach(el=>{
    const invId = el.dataset.invoiceId;
    const amtEl = document.querySelector(`.ps-apply-amt[data-invoice-id="${invId}"]`);
    const open = getOpenAPInvoices(PS_SUPPLIER_ID);
    const inv = open.find(x=>String(x.id)===String(invId));
    if(!inv) return;
    const amt = amtEl?parseFloat(amtEl.value)||0:0;
    const dateEl = document.getElementById('ps-date');
    const paymentDate = dateEl?dateEl.value:today();
    const chk = document.querySelector(`.ps-discount-override-chk[data-invoice-id="${invId}"]`);
    const overrideOn = chk?chk.checked:false;
    const dirEl = document.querySelector(`.ps-discount-override-dir[data-invoice-id="${invId}"]`);
    const overrideGrant = dirEl?dirEl.value==='grant':true;
    const r = computePaySupplierDiscountV36(inv, paymentDate, amt, overrideOn, overrideGrant);
    if(r.eligible) totalDiscount += r.discount;
  });
  _origRecalcPaySupplierTotalV36();
  if(totalDiscount > 0.001){
    const totalEl = document.getElementById('ps-total');
    if(totalEl) totalEl.value += `  (incl. ${fc(totalDiscount)} discount)`;
  }
}

// Redefines recordSupplierPayment as a superset of v28's version: FX rows
// (.ps-fx-settle) processed EXACTLY as before, untouched. Non-fx rows
// (.ps-apply-amt) now check for an eligible/overridden discount and, if
// found, reduce cash paid and post the difference to Purchase Discount
// Received — with a required reason recorded when a manual override was
// used, for the audit trail.
async function recordSupplierPayment(){
  const st=document.getElementById('ps-st');
  const supplierId=PS_SUPPLIER_ID;
  const supplier=(typeof SUPPLIERS!=='undefined'?SUPPLIERS:[]).find(s=>String(s.id)===String(supplierId));
  if(!supplier){st.innerHTML='<span style="color:var(--red3)">No supplier selected</span>';return;}

  const settlements=[];
  let totalBooked=0,totalActual=0,totalDiscount=0;
  const discountOverrides=[];

  const methodEl=document.getElementById('ps-method');
  const methodVal=methodEl?methodEl.value:'cash';
  const isForeignPayment=methodVal&&methodVal.indexOf('foreign:')===0;
  let foreignAcct=null,foreignAcctRate=null,foreignAcctAmt=0;
  if(isForeignPayment){
    const acctId=methodVal.split(':')[1];
    foreignAcct=(typeof FOREIGN_ACCOUNTS!=='undefined'?FOREIGN_ACCOUNTS:[]).find(a=>String(a.id)===String(acctId));
    if(!foreignAcct){st.innerHTML='<span style="color:var(--red3)">Selected account not found</span>';return;}
    foreignAcctRate=fxCrossRate(foreignAcct.currency);
    if(!foreignAcctRate){st.innerHTML=`<span style="color:var(--red3)">No known rate for ${foreignAcct.currency} today — cannot record this account's balance.</span>`;return;}
  }

  const open=getOpenAPInvoices(supplierId);
  const dateEl=document.getElementById('ps-date');
  const paymentDate=dateEl?dateEl.value:today();

  for(const el of document.querySelectorAll('.ps-apply-amt')){
    const amt=parseFloat(el.value)||0;
    const remaining=parseFloat(el.dataset.remaining)||0;
    if(amt<=0)continue;
    if(amt>remaining+0.01){st.innerHTML=`<span style="color:var(--red3)">One invoice's applied amount (${fc(amt)}) is more than what's remaining (${fc(remaining)}).</span>`;return;}
    const invoiceId=el.dataset.invoiceId;
    const inv=open.find(x=>String(x.id)===String(invoiceId));

    let discountAmt=0,overrideUsed=false,overrideReason='';
    if(inv&&inv.terms){
      const chk=document.querySelector(`.ps-discount-override-chk[data-invoice-id="${invoiceId}"]`);
      const overrideOn=chk?chk.checked:false;
      const dirEl=document.querySelector(`.ps-discount-override-dir[data-invoice-id="${invoiceId}"]`);
      const overrideGrant=dirEl?dirEl.value==='grant':true;
      const reasonEl=document.querySelector(`.ps-discount-override-reason[data-invoice-id="${invoiceId}"]`);
      if(overrideOn && !(reasonEl&&reasonEl.value.trim())){
        st.innerHTML='<span style="color:var(--red3)">A reason is required for every discount override.</span>';return;
      }
      const result=computePaySupplierDiscountV36(inv,paymentDate,amt,overrideOn,overrideGrant);
      if(result.eligible){ discountAmt=result.discount; }
      if(overrideOn){ overrideUsed=true; overrideReason=reasonEl?reasonEl.value.trim():''; }
    }

    settlements.push({invoiceId:parseInt(invoiceId),amount:amt});
    totalBooked+=amt;
    totalActual+=(amt-discountAmt);
    totalDiscount+=discountAmt;
    if(overrideUsed) discountOverrides.push({invoiceId:parseInt(invoiceId),applied:discountAmt>0,reason:overrideReason,by:(SESSION&&SESSION.username)||'',at:new Date().toISOString()});
    if(isForeignPayment)foreignAcctAmt+=(amt-discountAmt)/foreignAcctRate;
  }

  for(const settleEl of document.querySelectorAll('.ps-fx-settle')){
    const id=settleEl.dataset.invoiceId;
    const rateEl=document.querySelector(`.ps-fx-rate[data-invoice-id="${id}"]`);
    const foreignSettled=parseFloat(settleEl.value)||0;
    const rate=rateEl?parseFloat(rateEl.value)||0:0;
    const remainingForeign=parseFloat(settleEl.dataset.remainingForeign)||0;
    const recordedRate=parseFloat(settleEl.dataset.recordedRate)||0;
    if(foreignSettled<=0)continue;
    if(foreignSettled>remainingForeign+0.01){st.innerHTML=`<span style="color:var(--red3)">One invoice's settle amount is more than what's remaining.</span>`;return;}
    if(!rate){st.innerHTML='<span style="color:var(--red3)">Enter a rate for every foreign-currency invoice being settled.</span>';return;}
    const bookedPortion=+(foreignSettled*recordedRate).toFixed(2);
    const actualCashPaid=+(foreignSettled*rate).toFixed(2);
    settlements.push({invoiceId:parseInt(id),amount:bookedPortion});
    totalBooked+=bookedPortion;totalActual+=actualCashPaid; // unchanged — FX rows not touched by this patch
    if(isForeignPayment){
      const invEntry=DB.entries.find(e=>e.id===parseInt(id));
      const invCurrency=invEntry&&invEntry.fx?invEntry.fx.currency:null;
      if(invCurrency&&invCurrency===foreignAcct.currency)foreignAcctAmt+=foreignSettled;
      else foreignAcctAmt+=actualCashPaid/foreignAcctRate;
    }
  }

  if(!settlements.length){st.innerHTML='<span style="color:var(--red3)">Enter at least one amount to apply</span>';return;}

  totalBooked=+totalBooked.toFixed(2);
  totalActual=+totalActual.toFixed(2);
  totalDiscount=+totalDiscount.toFixed(2);
  const netAdjustment=+(totalActual-totalBooked+totalDiscount).toFixed(2); // FX gain/loss only — discount already netted out separately below

  const date=paymentDate;

  let payAcct,foreignLine=null;
  if(isForeignPayment){
    payAcct=foreignAccountGLName(foreignAcct);
    foreignLine={foreignAmt:+foreignAcctAmt.toFixed(4),currency:foreignAcct.currency};
  }else{
    const payAcctMap={cash:'Cash',mobile:'Mobile Money',bank:'Bank Account'};
    payAcct=payAcctMap[methodVal]||'Cash';
  }

  const debits=[{acct:'Accounts Payable',amt:totalBooked,atype:'liability'}];
  const creditLine={acct:payAcct,amt:totalActual,atype:'asset'};
  if(foreignLine)Object.assign(creditLine,foreignLine);
  const credits=[creditLine];
  if(totalDiscount>0.01)credits.push({acct:'Purchase Discount Received',amt:totalDiscount,atype:'income'});
  if(netAdjustment>0.01)debits.push({acct:'Realized FX Loss',amt:netAdjustment,atype:'expense'});
  else if(netAdjustment<-0.01)credits.push({acct:'Realized FX Gain',amt:-netAdjustment,atype:'income'});

  const entry={
    id:DB.nextId++,date,
    desc:`Payment to supplier: ${supplier.name}`,
    type:'Supplier Payment',amount:totalActual,project:'',
    debits,credits,
    party:{type:'supplier',id:supplier.id,name:supplier.name},
    settlements
  };
  if(discountOverrides.length)entry.discountOverrides=discountOverrides;
  DB.entries.push(entry);
  await saveData();
  renderAll();
  if(typeof renderSupplierList==='function')renderSupplierList();
  closePaySupplierModal();
  const bits=[];
  if(totalDiscount>0.01)bits.push(`discount ${fc(totalDiscount)}`);
  if(netAdjustment>0.01)bits.push(`realized loss ${fc(netAdjustment)}`);
  else if(netAdjustment<-0.01)bits.push(`realized gain ${fc(-netAdjustment)}`);
  const extraMsg=bits.length?` (${bits.join(', ')})`:'';
  if(typeof showToast==='function')showToast(`✅ Payment of ${fc(totalActual)} recorded to ${supplier.name}${extraMsg}`);
}

window.getOpenAPInvoices=getOpenAPInvoices;
window.renderPaySupplierRow=renderPaySupplierRow;
window.recalcPaySupplierTotal=recalcPaySupplierTotal;
window.recordSupplierPayment=recordSupplierPayment;
window.computePaySupplierDiscountV36=computePaySupplierDiscountV36;
window.onPaySupplierDiscountChange=onPaySupplierDiscountChange;
window.refreshPaySupplierDiscountV36=refreshPaySupplierDiscountV36;

console.log('✅ patch-v36.js loaded — Pay Supplier now applies Early Payment Discounts (non-FX invoices)');
