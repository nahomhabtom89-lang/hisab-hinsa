// ═══════════════════════════════════════════════════════════
// PATCH v38 — Early Payment Discount, Phase 4: Combine with FX (Pay Supplier)
// ═══════════════════════════════════════════════════════════
// The documented gap from v36/v37: a foreign-currency invoice that ALSO
// has payment terms. Scoped to Pay Supplier first (AP), same "AP first"
// approach as the rest of this feature — Receive Payment's FX+discount
// combination is a follow-up once this is confirmed working.
//
// THE MATH (per the architecture doc's §3, verified below before shipping):
//   1. Compute the discount in the invoice's OWN currency first — same
//      engine (evaluateDiscountV35), just fed the foreign amount being
//      settled instead of a base-currency one.
//   2. The discount itself is valued at the ORIGINALLY RECORDED rate — it's
//      a trade term, not a currency position, so it shouldn't carry any
//      FX gain/loss of its own.
//   3. The actual cash paid converts the NET (post-discount) foreign
//      amount at TODAY'S rate — that's where the FX exposure lives.
//   4. The FX gain/loss is isolated from the discount by construction —
//      exactly the same netAdjustment formula already used for plain FX
//      invoices, just computed against the discounted net amount.
//
// Debits:  Accounts Payable (bookedPortion, unchanged — full original
//          amount at the original rate, discount or not)
// Credits: Cash (net foreign amount × today's rate)
//        + Purchase Discount Received (discount × recorded rate)
//        + Realized FX Gain (if any) — or a debit Realized FX Loss instead
// ═══════════════════════════════════════════════════════════

// ── FX-row discount preview (mirrors computePaySupplierDiscountV36, but
// operates on the FOREIGN amount being settled, not a base-currency one —
// evaluateDiscountV35 is currency-agnostic, so this just works) ─────────
function computePaySupplierFxDiscountV38(inv, paymentDate, foreignAmt, overrideOn, overrideGrant){
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

function renderPaySupplierFxDiscountRowV38(inv){
  if(!inv.terms) return '';
  return `<div class="ps-fx-discount-block" data-invoice-id="${inv.id}" style="margin-top:6px;padding:6px 8px;background:var(--bg3);border-radius:5px;font-size:10px">
    <div class="ps-fx-discount-status" data-invoice-id="${inv.id}" style="color:var(--text3)"></div>
    <label style="display:flex;align-items:center;gap:5px;margin-top:4px;cursor:pointer;color:var(--text3)">
      <input type="checkbox" class="ps-fx-discount-override-chk" data-invoice-id="${inv.id}" onchange="onPaySupplierFxDiscountChange(${inv.id})"/> Override
    </label>
    <div class="ps-fx-discount-override-row" data-invoice-id="${inv.id}" style="display:none;margin-top:4px">
      <select class="ps-fx-discount-override-dir" data-invoice-id="${inv.id}" onchange="onPaySupplierFxDiscountChange(${inv.id})" style="width:100%;margin-bottom:4px;background:var(--bg2);border:1px solid var(--border2);border-radius:4px;padding:4px;color:var(--text);font-size:10px">
        <option value="grant">Grant discount anyway</option>
        <option value="deny">Deny discount</option>
      </select>
      <input type="text" class="ps-fx-discount-override-reason" data-invoice-id="${inv.id}" placeholder="Reason (required)" oninput="onPaySupplierFxDiscountChange(${inv.id})" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:4px;padding:4px 6px;color:var(--text);font-size:10px"/>
    </div>
  </div>`;
}

function onPaySupplierFxDiscountChange(invoiceId){
  refreshPaySupplierFxDiscountV38(invoiceId);
  recalcPaySupplierTotal();
}
window.onPaySupplierFxDiscountChange = onPaySupplierFxDiscountChange;

function refreshPaySupplierFxDiscountV38(invoiceId){
  const statusEl = document.querySelector(`.ps-fx-discount-status[data-invoice-id="${invoiceId}"]`);
  if(!statusEl) return;
  const open = getOpenAPInvoices(PS_SUPPLIER_ID);
  const inv = open.find(x=>String(x.id)===String(invoiceId));
  if(!inv || !inv.terms || !inv.fx) return;
  const settleEl = document.querySelector(`.ps-fx-settle[data-invoice-id="${invoiceId}"]`);
  const foreignAmt = settleEl ? (parseFloat(settleEl.value)||0) : 0;
  const dateEl = document.getElementById('ps-date');
  const paymentDate = dateEl ? dateEl.value : today();
  const chk = document.querySelector(`.ps-fx-discount-override-chk[data-invoice-id="${invoiceId}"]`);
  const overrideOn = chk ? chk.checked : false;
  const overrideRow = document.querySelector(`.ps-fx-discount-override-row[data-invoice-id="${invoiceId}"]`);
  if(overrideRow) overrideRow.style.display = overrideOn ? 'block' : 'none';
  const dirEl = document.querySelector(`.ps-fx-discount-override-dir[data-invoice-id="${invoiceId}"]`);
  const overrideGrant = dirEl ? dirEl.value === 'grant' : true;
  const result = computePaySupplierFxDiscountV38(inv, paymentDate, foreignAmt, overrideOn, overrideGrant);
  if(result.eligible && result.discount > 0.0001){
    statusEl.innerHTML = `<span style="color:var(--green3)">💰 ${inv.terms.code}${result.overridden?' (override)':''}: discount ${result.discount.toLocaleString(undefined,{maximumFractionDigits:2})} ${inv.fx.currency}</span> — you'll settle ${(foreignAmt-result.discount).toLocaleString(undefined,{maximumFractionDigits:2})} ${inv.fx.currency}`;
  } else if(result.hasTerms){
    statusEl.innerHTML = `<span style="color:var(--text3)">${inv.terms.code}: ${result.reason||'no discount on this payment'}</span>`;
  }
}
window.refreshPaySupplierFxDiscountV38 = refreshPaySupplierFxDiscountV38;

// ── Extend renderPaySupplierRow (v36) further: fx rows WITH terms now
// get the discount block too. Assignment style, not a bare declaration —
// a same-named "function renderPaySupplierRow(){}" later in this file
// would hoist and get captured as "_orig" instead of v36's real version,
// causing the exact infinite-recursion bug already caught and fixed once.
const _origRenderPaySupplierRowV38 = window.renderPaySupplierRow;
window.renderPaySupplierRow = function(inv){
  const html = _origRenderPaySupplierRowV38(inv);
  if(!inv.fx || !inv.terms) return html; // non-fx handled by v36; fx-without-terms unchanged
  return html.replace('</td>\n    </tr>', `${renderPaySupplierFxDiscountRowV38(inv)}</td>\n    </tr>`);
};

// ── Extend onPayFxRowChange (v21) to also refresh the fx discount block ──
const _origOnPayFxRowChangeV38 = window.onPayFxRowChange;
window.onPayFxRowChange = function(invoiceId){
  _origOnPayFxRowChangeV38(invoiceId);
  refreshPaySupplierFxDiscountV38(invoiceId);
};

// ── Extend recalcPaySupplierTotal (v36) to also fold in fx-row discounts ──
const _origRecalcPaySupplierTotalV38 = window.recalcPaySupplierTotal;
window.recalcPaySupplierTotal = function(){
  document.querySelectorAll('.ps-fx-settle').forEach(el=>{
    const invId = el.dataset.invoiceId;
    if(document.querySelector(`.ps-fx-discount-status[data-invoice-id="${invId}"]`)) refreshPaySupplierFxDiscountV38(invId);
  });
  _origRecalcPaySupplierTotalV38();
};

// ── Extend openPaySupplierModal to prime fx-row discount previews too ───
const _origOpenPaySupplierModalV38 = window.openPaySupplierModal;
window.openPaySupplierModal = function(supplierId){
  const result = _origOpenPaySupplierModalV38(supplierId);
  const open = getOpenAPInvoices(supplierId);
  open.forEach(inv=>{ if(inv.terms && inv.fx) refreshPaySupplierFxDiscountV38(inv.id); });
  return result;
};

// ── recordSupplierPayment: full redefinition (same reason v19→v21→v28→v36
// each were — the FX loop's math genuinely changes). Identical to v36 for
// everything except the FX settlement loop, which now applies the
// discount math derived above.
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

  // Non-FX rows (unchanged from v36) ------------------------------------
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

  // FX rows — NOW with discount support ----------------------------------
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

    const inv=open.find(x=>String(x.id)===String(id));
    let discountForeign=0,discountBase=0,overrideUsed=false,overrideReason='';
    if(inv&&inv.terms){
      const chk=document.querySelector(`.ps-fx-discount-override-chk[data-invoice-id="${id}"]`);
      const overrideOn=chk?chk.checked:false;
      const dirEl=document.querySelector(`.ps-fx-discount-override-dir[data-invoice-id="${id}"]`);
      const overrideGrant=dirEl?dirEl.value==='grant':true;
      const reasonEl=document.querySelector(`.ps-fx-discount-override-reason[data-invoice-id="${id}"]`);
      if(overrideOn && !(reasonEl&&reasonEl.value.trim())){
        st.innerHTML='<span style="color:var(--red3)">A reason is required for every discount override.</span>';return;
      }
      const result=computePaySupplierFxDiscountV38(inv,paymentDate,foreignSettled,overrideOn,overrideGrant);
      if(result.eligible){
        discountForeign=result.discount;
        discountBase=+(discountForeign*recordedRate).toFixed(2); // valued at the ORIGINAL rate — a trade term, not an FX position
      }
      if(overrideOn){ overrideUsed=true; overrideReason=reasonEl?reasonEl.value.trim():''; }
    }

    const netForeignToPay=+(foreignSettled-discountForeign).toFixed(4);
    const bookedPortion=+(foreignSettled*recordedRate).toFixed(2);
    const actualCashPaid=+(netForeignToPay*rate).toFixed(2); // the NET (post-discount) foreign amount, at TODAY'S rate

    settlements.push({invoiceId:parseInt(id),amount:bookedPortion});
    totalBooked+=bookedPortion;totalActual+=actualCashPaid;totalDiscount+=discountBase;
    if(overrideUsed) discountOverrides.push({invoiceId:parseInt(id),applied:discountBase>0,reason:overrideReason,by:(SESSION&&SESSION.username)||'',at:new Date().toISOString()});
    if(isForeignPayment){
      const invEntry=DB.entries.find(e=>e.id===parseInt(id));
      const invCurrency=invEntry&&invEntry.fx?invEntry.fx.currency:null;
      if(invCurrency&&invCurrency===foreignAcct.currency)foreignAcctAmt+=netForeignToPay;
      else foreignAcctAmt+=actualCashPaid/foreignAcctRate;
    }
  }

  if(!settlements.length){st.innerHTML='<span style="color:var(--red3)">Enter at least one amount to apply</span>';return;}

  totalBooked=+totalBooked.toFixed(2);
  totalActual=+totalActual.toFixed(2);
  totalDiscount=+totalDiscount.toFixed(2);
  const netAdjustment=+(totalActual-totalBooked+totalDiscount).toFixed(2); // FX gain/loss only, isolated from discount by construction

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
window.recordSupplierPayment=recordSupplierPayment;
window.computePaySupplierFxDiscountV38=computePaySupplierFxDiscountV38;

console.log('✅ patch-v38.js loaded — Pay Supplier now applies Early Payment Discounts to foreign-currency invoices too');
