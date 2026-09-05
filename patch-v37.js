// ═══════════════════════════════════════════════════════════
// PATCH v37 — Early Payment Discount, Phase 3: Mirror to Receive Payment (AR)
// ═══════════════════════════════════════════════════════════
// Mirrors patch-v36 (Pay Supplier) onto Receive Payment — same engine
// (patch-v35), same override mechanism, same scope decisions. The only
// real difference is which side of the books the discount lands on:
//
//   AP (Pay Supplier, v36): discount REDUCES cash paid out,
//                            posts to Purchase Discount Received (income)
//   AR (Receive Payment):   discount REDUCES cash collected,
//                            posts to Sales Discount Allowed (expense)
//
// This matches the architecture doc exactly:
//   Debit  Cash/Bank (net of discount)
//   Debit  Sales Discount Allowed (the discount)
//   Credit Accounts Receivable (full invoice amount)
//
// SAME SCOPE as v36: applies to invoices settled through the plain
// "Apply" rows (.rp-apply-amt) — i.e. no foreign-currency tag. FX-tagged
// invoices (.rp-fx-settle) are completely UNCHANGED — same v28 behavior.
//
// THE MATH (verified below before shipping):
//   bookedPortion = the Apply amount (unchanged, clears AR)
//   discount = evaluateDiscountV35(entry.terms, paymentDate, bookedPortion)
//   cashReceived = bookedPortion − discount
// Debits:  Cash/Bank(cashReceived) + Sales Discount Allowed(discount)
// Credits: Accounts Receivable(bookedPortion)          [unchanged]
// cashReceived + discount = bookedPortion, always — balances by
// construction, same as v36 and the existing FX gain/loss mechanism.
// ═══════════════════════════════════════════════════════════

// ── Extend getOpenARInvoices to carry the invoice's terms (superset) ────
function getOpenARInvoices(customerId){
  return (DB.entries||[])
    .filter(e=>e.party&&e.party.type==='customer'&&String(e.party.id)===String(customerId))
    .map(e=>{
      const arLine=(e.debits||[]).find(l=>l.acct==='Accounts Receivable');
      if(!arLine)return null;
      const booked=getCurrentBookedAmount(e);
      const settled=getSettledAmountForInvoice(e.id);
      const remaining=+(booked-settled).toFixed(2);
      return{id:e.id,date:e.date,desc:e.desc,original:arLine.amt,booked,settled,remaining,fx:e.fx||null,terms:e.terms||null};
    })
    .filter(x=>x&&x.remaining>0.01)
    .sort((a,b)=>a.date.localeCompare(b.date));
}

// ── Discount preview block — identical logic to v36's Pay Supplier version ──
function computeReceivePaymentDiscountV37(inv, paymentDate, amt, overrideOn, overrideGrant){
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

function renderReceivePaymentDiscountRowV37(inv){
  if(!inv.terms) return '';
  return `<div class="rp-discount-block" data-invoice-id="${inv.id}" style="margin-top:6px;padding:6px 8px;background:var(--bg3);border-radius:5px;font-size:10px">
    <div class="rp-discount-status" data-invoice-id="${inv.id}" style="color:var(--text3)"></div>
    <label style="display:flex;align-items:center;gap:5px;margin-top:4px;cursor:pointer;color:var(--text3)">
      <input type="checkbox" class="rp-discount-override-chk" data-invoice-id="${inv.id}" onchange="onReceivePaymentDiscountChange(${inv.id})"/> Override
    </label>
    <div class="rp-discount-override-row" data-invoice-id="${inv.id}" style="display:none;margin-top:4px">
      <select class="rp-discount-override-dir" data-invoice-id="${inv.id}" onchange="onReceivePaymentDiscountChange(${inv.id})" style="width:100%;margin-bottom:4px;background:var(--bg2);border:1px solid var(--border2);border-radius:4px;padding:4px;color:var(--text);font-size:10px">
        <option value="grant">Grant discount anyway</option>
        <option value="deny">Deny discount</option>
      </select>
      <input type="text" class="rp-discount-override-reason" data-invoice-id="${inv.id}" placeholder="Reason (required)" oninput="onReceivePaymentDiscountChange(${inv.id})" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:4px;padding:4px 6px;color:var(--text);font-size:10px"/>
    </div>
  </div>`;
}

// NOTE: must be an assignment (window.X = function(){}), not a bare
// "function X(){}" declaration — a same-named declaration later in this
// file would hoist to the top and get captured as "_orig" instead of
// v25/v28's real original, causing infinite self-recursion (the exact bug
// caught and fixed in patch-v36 before it shipped this way).
const _origRenderReceivePaymentRowV37 = renderReceivePaymentRow;
window.renderReceivePaymentRow = function(inv){
  const html = _origRenderReceivePaymentRowV37(inv);
  if(inv.fx || !inv.terms) return html;
  return html.replace('</td>\n  </tr>', `${renderReceivePaymentDiscountRowV37(inv)}</td>\n  </tr>`);
};

function onReceivePaymentDiscountChange(invoiceId){
  refreshReceivePaymentDiscountV37(invoiceId);
  recalcReceivePaymentTotal();
}

function refreshReceivePaymentDiscountV37(invoiceId){
  const statusEl = document.querySelector(`.rp-discount-status[data-invoice-id="${invoiceId}"]`);
  if(!statusEl) return;
  const open = getOpenARInvoices(RP_CUSTOMER_ID);
  const inv = open.find(x=>String(x.id)===String(invoiceId));
  if(!inv || !inv.terms) return;
  const amtEl = document.querySelector(`.rp-apply-amt[data-invoice-id="${invoiceId}"]`);
  const amt = amtEl ? (parseFloat(amtEl.value)||0) : 0;
  const dateEl = document.getElementById('rp-date');
  const paymentDate = dateEl ? dateEl.value : today();
  const chk = document.querySelector(`.rp-discount-override-chk[data-invoice-id="${invoiceId}"]`);
  const overrideOn = chk ? chk.checked : false;
  const overrideRow = document.querySelector(`.rp-discount-override-row[data-invoice-id="${invoiceId}"]`);
  if(overrideRow) overrideRow.style.display = overrideOn ? 'block' : 'none';
  const dirEl = document.querySelector(`.rp-discount-override-dir[data-invoice-id="${invoiceId}"]`);
  const overrideGrant = dirEl ? dirEl.value === 'grant' : true;
  const result = computeReceivePaymentDiscountV37(inv, paymentDate, amt, overrideOn, overrideGrant);
  if(result.eligible && result.discount > 0.001){
    statusEl.innerHTML = `<span style="color:var(--green3)">💰 ${inv.terms.code}${result.overridden?' (override)':''}: discount ${fc(result.discount)}</span> — you'll collect ${fc(amt-result.discount)}`;
  } else if(result.hasTerms){
    statusEl.innerHTML = `<span style="color:var(--text3)">${inv.terms.code}: ${result.reason||'no discount on this payment'}</span>`;
  }
}

const _origOpenReceivePaymentModalV37 = window.openReceivePaymentModal;
if(typeof _origOpenReceivePaymentModalV37 === 'function'){
  window.openReceivePaymentModal = function(customerId){
    const result = _origOpenReceivePaymentModalV37(customerId);
    const open = getOpenARInvoices(customerId);
    open.forEach(inv=>{ if(inv.terms && !inv.fx) refreshReceivePaymentDiscountV37(inv.id); });
    const dateEl = document.getElementById('rp-date');
    if(dateEl && !dateEl.dataset.v37Bound){
      dateEl.dataset.v37Bound = '1';
      dateEl.addEventListener('change', function(){
        document.querySelectorAll('.rp-discount-status').forEach(el=>{
          refreshReceivePaymentDiscountV37(el.dataset.invoiceId);
        });
        recalcReceivePaymentTotal();
      });
    }
    return result;
  };
}

const _origRecalcReceivePaymentTotalV37 = recalcReceivePaymentTotal;
window.recalcReceivePaymentTotal = function(){
  document.querySelectorAll('.rp-apply-amt').forEach(el=>{
    const invId = el.dataset.invoiceId;
    if(document.querySelector(`.rp-discount-status[data-invoice-id="${invId}"]`)) refreshReceivePaymentDiscountV37(invId);
  });
  let totalDiscount = 0;
  document.querySelectorAll('.rp-discount-status').forEach(el=>{
    const invId = el.dataset.invoiceId;
    const amtEl = document.querySelector(`.rp-apply-amt[data-invoice-id="${invId}"]`);
    const open = getOpenARInvoices(RP_CUSTOMER_ID);
    const inv = open.find(x=>String(x.id)===String(invId));
    if(!inv) return;
    const amt = amtEl?parseFloat(amtEl.value)||0:0;
    const dateEl = document.getElementById('rp-date');
    const paymentDate = dateEl?dateEl.value:today();
    const chk = document.querySelector(`.rp-discount-override-chk[data-invoice-id="${invId}"]`);
    const overrideOn = chk?chk.checked:false;
    const dirEl = document.querySelector(`.rp-discount-override-dir[data-invoice-id="${invId}"]`);
    const overrideGrant = dirEl?dirEl.value==='grant':true;
    const r = computeReceivePaymentDiscountV37(inv, paymentDate, amt, overrideOn, overrideGrant);
    if(r.eligible) totalDiscount += r.discount;
  });
  _origRecalcReceivePaymentTotalV37();
  if(totalDiscount > 0.001){
    const totalEl = document.getElementById('rp-total');
    if(totalEl) totalEl.value += `  (incl. ${fc(totalDiscount)} discount)`;
  }
};

// Redefines recordCustomerPayment as a superset of v28's version: FX rows
// (.rp-fx-settle) processed EXACTLY as before, untouched. Non-fx rows
// (.rp-apply-amt) now check for an eligible/overridden discount, reduce
// cash collected, and post the difference to Sales Discount Allowed.
async function recordCustomerPayment(){
  const st=document.getElementById('rp-st');
  const customerId=RP_CUSTOMER_ID;
  const customer=(typeof CUSTOMERS!=='undefined'?CUSTOMERS:[]).find(c=>String(c.id)===String(customerId));
  if(!customer){st.innerHTML='<span style="color:var(--red3)">No customer selected</span>';return;}

  const settlements=[];
  let totalBooked=0,totalActual=0,totalDiscount=0;
  const discountOverrides=[];

  const methodEl=document.getElementById('rp-method');
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

  const open=getOpenARInvoices(customerId);
  const dateEl=document.getElementById('rp-date');
  const paymentDate=dateEl?dateEl.value:today();

  for(const el of document.querySelectorAll('.rp-apply-amt')){
    const amt=parseFloat(el.value)||0;
    const remaining=parseFloat(el.dataset.remaining)||0;
    if(amt<=0)continue;
    if(amt>remaining+0.01){st.innerHTML=`<span style="color:var(--red3)">One invoice's applied amount (${fc(amt)}) is more than what's remaining (${fc(remaining)}).</span>`;return;}
    const invoiceId=el.dataset.invoiceId;
    const inv=open.find(x=>String(x.id)===String(invoiceId));

    let discountAmt=0,overrideUsed=false,overrideReason='';
    if(inv&&inv.terms){
      const chk=document.querySelector(`.rp-discount-override-chk[data-invoice-id="${invoiceId}"]`);
      const overrideOn=chk?chk.checked:false;
      const dirEl=document.querySelector(`.rp-discount-override-dir[data-invoice-id="${invoiceId}"]`);
      const overrideGrant=dirEl?dirEl.value==='grant':true;
      const reasonEl=document.querySelector(`.rp-discount-override-reason[data-invoice-id="${invoiceId}"]`);
      if(overrideOn && !(reasonEl&&reasonEl.value.trim())){
        st.innerHTML='<span style="color:var(--red3)">A reason is required for every discount override.</span>';return;
      }
      const result=computeReceivePaymentDiscountV37(inv,paymentDate,amt,overrideOn,overrideGrant);
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

  for(const settleEl of document.querySelectorAll('.rp-fx-settle')){
    const id=settleEl.dataset.invoiceId;
    const rateEl=document.querySelector(`.rp-fx-rate[data-invoice-id="${id}"]`);
    const foreignSettled=parseFloat(settleEl.value)||0;
    const rate=rateEl?parseFloat(rateEl.value)||0:0;
    const remainingForeign=parseFloat(settleEl.dataset.remainingForeign)||0;
    const recordedRate=parseFloat(settleEl.dataset.recordedRate)||0;
    if(foreignSettled<=0)continue;
    if(foreignSettled>remainingForeign+0.01){st.innerHTML=`<span style="color:var(--red3)">One invoice's collect amount is more than what's remaining.</span>`;return;}
    if(!rate){st.innerHTML='<span style="color:var(--red3)">Enter a rate for every foreign-currency invoice being collected.</span>';return;}
    const bookedPortion=+(foreignSettled*recordedRate).toFixed(2);
    const actualCashReceived=+(foreignSettled*rate).toFixed(2);
    settlements.push({invoiceId:parseInt(id),amount:bookedPortion});
    totalBooked+=bookedPortion;totalActual+=actualCashReceived; // unchanged — FX rows not touched by this patch
    if(isForeignPayment){
      const invEntry=DB.entries.find(e=>e.id===parseInt(id));
      const invCurrency=invEntry&&invEntry.fx?invEntry.fx.currency:null;
      if(invCurrency&&invCurrency===foreignAcct.currency)foreignAcctAmt+=foreignSettled;
      else foreignAcctAmt+=actualCashReceived/foreignAcctRate;
    }
  }

  if(!settlements.length){st.innerHTML='<span style="color:var(--red3)">Enter at least one amount to apply</span>';return;}

  totalBooked=+totalBooked.toFixed(2);
  totalActual=+totalActual.toFixed(2);
  totalDiscount=+totalDiscount.toFixed(2);
  const netAdjustment=+(totalActual-totalBooked+totalDiscount).toFixed(2); // FX gain/loss only, sign as v25/v28: + = gain

  const date=paymentDate;

  let recvAcct,foreignLine=null;
  if(isForeignPayment){
    recvAcct=foreignAccountGLName(foreignAcct);
    foreignLine={foreignAmt:+foreignAcctAmt.toFixed(4),currency:foreignAcct.currency};
  }else{
    const recvAcctMap={cash:'Cash',mobile:'Mobile Money',bank:'Bank Account'};
    recvAcct=recvAcctMap[methodVal]||'Cash';
  }

  const debitLine={acct:recvAcct,amt:totalActual,atype:'asset'};
  if(foreignLine)Object.assign(debitLine,foreignLine);
  const debits=[debitLine];
  if(totalDiscount>0.01)debits.push({acct:'Sales Discount Allowed',amt:totalDiscount,atype:'expense'});
  const credits=[{acct:'Accounts Receivable',amt:totalBooked,atype:'asset'}];
  if(netAdjustment>0.01)credits.push({acct:'Realized FX Gain',amt:netAdjustment,atype:'income'});
  else if(netAdjustment<-0.01)debits.push({acct:'Realized FX Loss',amt:-netAdjustment,atype:'expense'});

  const entry={
    id:DB.nextId++,date,
    desc:`Payment received from customer: ${customer.name}`,
    type:'Customer Payment',amount:totalActual,project:'',
    debits,credits,
    party:{type:'customer',id:customer.id,name:customer.name},
    settlements
  };
  if(discountOverrides.length)entry.discountOverrides=discountOverrides;
  DB.entries.push(entry);
  await saveData();
  renderAll();
  if(typeof renderCustomerList==='function')renderCustomerList();
  closeReceivePaymentModal();
  const bits=[];
  if(totalDiscount>0.01)bits.push(`discount ${fc(totalDiscount)}`);
  if(netAdjustment>0.01)bits.push(`realized gain ${fc(netAdjustment)}`);
  else if(netAdjustment<-0.01)bits.push(`realized loss ${fc(-netAdjustment)}`);
  const extraMsg=bits.length?` (${bits.join(', ')})`:'';
  if(typeof showToast==='function')showToast(`✅ Received ${fc(totalActual)} from ${customer.name}${extraMsg}`);
}

window.getOpenARInvoices=getOpenARInvoices;
window.renderReceivePaymentRow=renderReceivePaymentRow;
window.recalcReceivePaymentTotal=recalcReceivePaymentTotal;
window.recordCustomerPayment=recordCustomerPayment;
window.computeReceivePaymentDiscountV37=computeReceivePaymentDiscountV37;
window.onReceivePaymentDiscountChange=onReceivePaymentDiscountChange;
window.refreshReceivePaymentDiscountV37=refreshReceivePaymentDiscountV37;

console.log('✅ patch-v37.js loaded — Receive Payment now applies Early Payment Discounts (non-FX invoices)');
