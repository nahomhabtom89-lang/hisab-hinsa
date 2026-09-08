// ═══════════════════════════════════════════════════════════
// PATCH v39 — Early Payment Discount, Phase 5: Combine with FX (Receive Payment)
// ═══════════════════════════════════════════════════════════
// Mirrors patch-v38 (Pay Supplier + FX) onto Receive Payment — a foreign
// customer with payment terms, paying within the discount window. Same
// math, same override mechanism; only the side of the books changes:
//
//   AP (v38): discount reduces cash PAID OUT, credits Purchase Discount
//             Received (income)
//   AR (this): discount reduces cash COLLECTED, debits Sales Discount
//             Allowed (expense)
//
// THE MATH (identical structure to v38):
//   1. Discount computed in the invoice's OWN currency first.
//   2. Discount valued at the ORIGINALLY RECORDED rate (a trade term, no
//      FX exposure of its own).
//   3. Cash actually collected converts the NET (post-discount) foreign
//      amount at TODAY'S rate — the FX exposure lives here.
//   4. FX gain/loss isolated from the discount by construction, same
//      sign convention v25/v28/v37 already use for AR (+ = gain).
//
// Debits:  Cash/Bank (net foreign amount × today's rate)
//        + Sales Discount Allowed (discount × recorded rate)
//        + Realized FX Loss (if any)
// Credits: Accounts Receivable (bookedPortion, unchanged)
//        + Realized FX Gain (if any)
// ═══════════════════════════════════════════════════════════

function computeReceivePaymentFxDiscountV39(inv, paymentDate, foreignAmt, overrideOn, overrideGrant){
  if(!inv.terms) return { discount:0, eligible:false, reason:null, hasTerms:false };
  const policy = inv.terms.partial_payment_policy || 'prorated';
  let baseResult;
  if(policy === 'full_invoice_only'){
    const entry=DB.entries.find(e=>e.id===inv.id);
    const recordedRate=entry?(getCurrentFxRate(entry)||inv.fx.rate):inv.fx.rate;
    const remainingForeign=+(inv.remaining/recordedRate).toFixed(4);
    const isFullSettle = foreignAmt >= (remainingForeign - 0.01);
    baseResult = isFullSettle
      ? evaluateDiscountV35(inv.terms, paymentDate, foreignAmt)
      : { eligible:false, discount:0, reason:'this policy only grants the discount when the full remaining balance is paid at once' };
  } else {
    baseResult = evaluateDiscountV35(inv.terms, paymentDate, foreignAmt);
  }
  if(overrideOn){
    if(overrideGrant && !baseResult.eligible){
      const ratio = inv.terms.eligible_ratio!=null?inv.terms.eligible_ratio:1;
      const discount = +((foreignAmt*ratio)*(inv.terms.discount_percent/100)).toFixed(4);
      return { discount, eligible:true, reason:'manually granted (override)', hasTerms:true, overridden:true };
    }
    if(!overrideGrant && baseResult.eligible){
      return { discount:0, eligible:false, reason:'manually denied (override)', hasTerms:true, overridden:true };
    }
  }
  return Object.assign({hasTerms:true}, baseResult);
}

function renderReceivePaymentFxDiscountRowV39(inv){
  if(!inv.terms) return '';
  return `<div class="rp-fx-discount-block" data-invoice-id="${inv.id}" style="margin-top:6px;padding:6px 8px;background:var(--bg3);border-radius:5px;font-size:10px">
    <div class="rp-fx-discount-status" data-invoice-id="${inv.id}" style="color:var(--text3)"></div>
    <label style="display:flex;align-items:center;gap:5px;margin-top:4px;cursor:pointer;color:var(--text3)">
      <input type="checkbox" class="rp-fx-discount-override-chk" data-invoice-id="${inv.id}" onchange="onReceivePaymentFxDiscountChange(${inv.id})"/> Override
    </label>
    <div class="rp-fx-discount-override-row" data-invoice-id="${inv.id}" style="display:none;margin-top:4px">
      <select class="rp-fx-discount-override-dir" data-invoice-id="${inv.id}" onchange="onReceivePaymentFxDiscountChange(${inv.id})" style="width:100%;margin-bottom:4px;background:var(--bg2);border:1px solid var(--border2);border-radius:4px;padding:4px;color:var(--text);font-size:10px">
        <option value="grant">Grant discount anyway</option>
        <option value="deny">Deny discount</option>
      </select>
      <input type="text" class="rp-fx-discount-override-reason" data-invoice-id="${inv.id}" placeholder="Reason (required)" oninput="onReceivePaymentFxDiscountChange(${inv.id})" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:4px;padding:4px 6px;color:var(--text);font-size:10px"/>
    </div>
  </div>`;
}

function onReceivePaymentFxDiscountChange(invoiceId){
  refreshReceivePaymentFxDiscountV39(invoiceId);
  recalcReceivePaymentTotal();
}
window.onReceivePaymentFxDiscountChange = onReceivePaymentFxDiscountChange;

function refreshReceivePaymentFxDiscountV39(invoiceId){
  const statusEl = document.querySelector(`.rp-fx-discount-status[data-invoice-id="${invoiceId}"]`);
  if(!statusEl) return;
  const open = getOpenARInvoices(RP_CUSTOMER_ID);
  const inv = open.find(x=>String(x.id)===String(invoiceId));
  if(!inv || !inv.terms || !inv.fx) return;
  const settleEl = document.querySelector(`.rp-fx-settle[data-invoice-id="${invoiceId}"]`);
  const foreignAmt = settleEl ? (parseFloat(settleEl.value)||0) : 0;
  const dateEl = document.getElementById('rp-date');
  const paymentDate = dateEl ? dateEl.value : today();
  const chk = document.querySelector(`.rp-fx-discount-override-chk[data-invoice-id="${invoiceId}"]`);
  const overrideOn = chk ? chk.checked : false;
  const overrideRow = document.querySelector(`.rp-fx-discount-override-row[data-invoice-id="${invoiceId}"]`);
  if(overrideRow) overrideRow.style.display = overrideOn ? 'block' : 'none';
  const dirEl = document.querySelector(`.rp-fx-discount-override-dir[data-invoice-id="${invoiceId}"]`);
  const overrideGrant = dirEl ? dirEl.value === 'grant' : true;
  const result = computeReceivePaymentFxDiscountV39(inv, paymentDate, foreignAmt, overrideOn, overrideGrant);
  if(result.eligible && result.discount > 0.0001){
    statusEl.innerHTML = `<span style="color:var(--green3)">💰 ${inv.terms.code}${result.overridden?' (override)':''}: discount ${result.discount.toLocaleString(undefined,{maximumFractionDigits:2})} ${inv.fx.currency}</span> — you'll collect ${(foreignAmt-result.discount).toLocaleString(undefined,{maximumFractionDigits:2})} ${inv.fx.currency}`;
  } else if(result.hasTerms){
    statusEl.innerHTML = `<span style="color:var(--text3)">${inv.terms.code}: ${result.reason||'no discount on this payment'}</span>`;
  }
}
window.refreshReceivePaymentFxDiscountV39 = refreshReceivePaymentFxDiscountV39;

// ── Extend renderReceivePaymentRow (v37) further: fx rows WITH terms ────
// Assignment style, not a bare declaration — same hoisting trap already
// caught and fixed once for v36/v37.
const _origRenderReceivePaymentRowV39 = window.renderReceivePaymentRow;
window.renderReceivePaymentRow = function(inv){
  const html = _origRenderReceivePaymentRowV39(inv);
  if(!inv.fx || !inv.terms) return html;
  return html.replace('</td>\n    </tr>', `${renderReceivePaymentFxDiscountRowV39(inv)}</td>\n    </tr>`);
};

const _origOnReceiveFxRowChangeV39 = window.onReceiveFxRowChange;
window.onReceiveFxRowChange = function(invoiceId){
  _origOnReceiveFxRowChangeV39(invoiceId);
  refreshReceivePaymentFxDiscountV39(invoiceId);
};

const _origRecalcReceivePaymentTotalV39 = window.recalcReceivePaymentTotal;
window.recalcReceivePaymentTotal = function(){
  document.querySelectorAll('.rp-fx-settle').forEach(el=>{
    const invId = el.dataset.invoiceId;
    if(document.querySelector(`.rp-fx-discount-status[data-invoice-id="${invId}"]`)) refreshReceivePaymentFxDiscountV39(invId);
  });
  _origRecalcReceivePaymentTotalV39();
};

const _origOpenReceivePaymentModalV39 = window.openReceivePaymentModal;
window.openReceivePaymentModal = function(customerId){
  const result = _origOpenReceivePaymentModalV39(customerId);
  const open = getOpenARInvoices(customerId);
  open.forEach(inv=>{ if(inv.terms && inv.fx) refreshReceivePaymentFxDiscountV39(inv.id); });
  return result;
};

// ── recordCustomerPayment: full redefinition (same reason v25→v28→v37
// each were). Identical to v37 except the FX settlement loop now applies
// the discount math.
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

  // Non-FX rows (unchanged from v37) -------------------------------------
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

  // FX rows — NOW with discount support ------------------------------------
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

    const inv=open.find(x=>String(x.id)===String(id));
    let discountForeign=0,discountBase=0,overrideUsed=false,overrideReason='';
    if(inv&&inv.terms){
      const chk=document.querySelector(`.rp-fx-discount-override-chk[data-invoice-id="${id}"]`);
      const overrideOn=chk?chk.checked:false;
      const dirEl=document.querySelector(`.rp-fx-discount-override-dir[data-invoice-id="${id}"]`);
      const overrideGrant=dirEl?dirEl.value==='grant':true;
      const reasonEl=document.querySelector(`.rp-fx-discount-override-reason[data-invoice-id="${id}"]`);
      if(overrideOn && !(reasonEl&&reasonEl.value.trim())){
        st.innerHTML='<span style="color:var(--red3)">A reason is required for every discount override.</span>';return;
      }
      const result=computeReceivePaymentFxDiscountV39(inv,paymentDate,foreignSettled,overrideOn,overrideGrant);
      if(result.eligible){
        discountForeign=result.discount;
        discountBase=+(discountForeign*recordedRate).toFixed(2); // valued at the ORIGINAL rate
      }
      if(overrideOn){ overrideUsed=true; overrideReason=reasonEl?reasonEl.value.trim():''; }
    }

    const netForeignToCollect=+(foreignSettled-discountForeign).toFixed(4);
    const bookedPortion=+(foreignSettled*recordedRate).toFixed(2);
    const actualCashReceived=+(netForeignToCollect*rate).toFixed(2); // NET foreign amount at TODAY'S rate

    settlements.push({invoiceId:parseInt(id),amount:bookedPortion});
    totalBooked+=bookedPortion;totalActual+=actualCashReceived;totalDiscount+=discountBase;
    if(overrideUsed) discountOverrides.push({invoiceId:parseInt(id),applied:discountBase>0,reason:overrideReason,by:(SESSION&&SESSION.username)||'',at:new Date().toISOString()});
    if(isForeignPayment){
      const invEntry=DB.entries.find(e=>e.id===parseInt(id));
      const invCurrency=invEntry&&invEntry.fx?invEntry.fx.currency:null;
      if(invCurrency&&invCurrency===foreignAcct.currency)foreignAcctAmt+=netForeignToCollect;
      else foreignAcctAmt+=actualCashReceived/foreignAcctRate;
    }
  }

  if(!settlements.length){st.innerHTML='<span style="color:var(--red3)">Enter at least one amount to apply</span>';return;}

  totalBooked=+totalBooked.toFixed(2);
  totalActual=+totalActual.toFixed(2);
  totalDiscount=+totalDiscount.toFixed(2);
  const netAdjustment=+(totalActual-totalBooked+totalDiscount).toFixed(2); // FX gain/loss only, isolated from discount, + = gain (AR sign convention)

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
window.recordCustomerPayment=recordCustomerPayment;
window.computeReceivePaymentFxDiscountV39=computeReceivePaymentFxDiscountV39;

console.log('✅ patch-v39.js loaded — Receive Payment now applies Early Payment Discounts to foreign-currency invoices too');

