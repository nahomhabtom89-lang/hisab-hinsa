// ═══════════════════════════════════════════════════════════
// PATCH v28 — Foreign Currency Accounts, Phase 2: Wire Into Payments
// ═══════════════════════════════════════════════════════════
// Extends Pay Supplier and Receive Payment (v19/v21/v25) so any foreign
// account created in patch-v27's registry becomes a selectable "Payment
// Method" / "Received Via" option, alongside Cash/Mobile Money/Bank.
//
// When a foreign account is chosen, the resulting journal line is tagged
// with `foreignAmt` and `currency`, computed from the payment's total base-
// currency amount converted at TODAY's live rate for that account's
// currency — this is deliberately independent of whatever rate the
// SETTLED INVOICE itself was tagged at, since the invoice's currency and
// the account holding the cash aren't necessarily the same currency.
//
// This is what makes patch-v27's getForeignAccountBalance() start showing
// real, non-zero balances — before this patch, no transaction anywhere
// could actually route money into or out of a foreign account.
//
// recordSupplierPayment/recordCustomerPayment are redefined here as a
// superset of v21/v25's versions — identical output for Cash/Mobile
// Money/Bank (unchanged), with foreign-account routing added as a new
// branch.
// ═══════════════════════════════════════════════════════════

function appendForeignAccountOptions(selectId){
  const sel=document.getElementById(selectId);
  if(!sel)return;
  Array.from(sel.querySelectorAll('option[data-foreign-acct]')).forEach(o=>o.remove());
  (typeof FOREIGN_ACCOUNTS!=='undefined'?FOREIGN_ACCOUNTS:[]).forEach(a=>{
    const opt=document.createElement('option');
    opt.value='foreign:'+a.id;
    opt.textContent=`${a.name} (${a.currency})`;
    opt.dataset.foreignAcct='1';
    sel.appendChild(opt);
  });
}

const _origOpenPaySupplierModalV28=window.openPaySupplierModal;
if(typeof _origOpenPaySupplierModalV28==='function'){
  window.openPaySupplierModal=function(supplierId){
    const result=_origOpenPaySupplierModalV28(supplierId);
    appendForeignAccountOptions('ps-method');
    return result;
  };
}
const _origOpenReceivePaymentModalV28=window.openReceivePaymentModal;
if(typeof _origOpenReceivePaymentModalV28==='function'){
  window.openReceivePaymentModal=function(customerId){
    const result=_origOpenReceivePaymentModalV28(customerId);
    appendForeignAccountOptions('rp-method');
    return result;
  };
}

async function recordSupplierPayment(){
  const st=document.getElementById('ps-st');
  const supplierId=PS_SUPPLIER_ID;
  const supplier=(typeof SUPPLIERS!=='undefined'?SUPPLIERS:[]).find(s=>String(s.id)===String(supplierId));
  if(!supplier){st.innerHTML='<span style="color:var(--red3)">No supplier selected</span>';return;}

  const settlements=[];
  let totalBooked=0,totalActual=0;

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

  for(const el of document.querySelectorAll('.ps-apply-amt')){
    const amt=parseFloat(el.value)||0;
    const remaining=parseFloat(el.dataset.remaining)||0;
    if(amt<=0)continue;
    if(amt>remaining+0.01){st.innerHTML=`<span style="color:var(--red3)">One invoice's applied amount (${fc(amt)}) is more than what's remaining (${fc(remaining)}).</span>`;return;}
    settlements.push({invoiceId:parseInt(el.dataset.invoiceId),amount:amt});
    totalBooked+=amt;totalActual+=amt;
    if(isForeignPayment)foreignAcctAmt+=amt/foreignAcctRate; // base-currency amount, converted at today's rate
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
    totalBooked+=bookedPortion;totalActual+=actualCashPaid;
    if(isForeignPayment){
      const invEntry=DB.entries.find(e=>e.id===parseInt(id));
      const invCurrency=invEntry&&invEntry.fx?invEntry.fx.currency:null;
      // Exact match: use the precise foreign amount already known for this invoice,
      // rather than recomputing it — the invoice's own settlement rate (which the
      // user may have typed in manually, e.g. their bank's actual rate) can differ
      // slightly from today's live feed, and re-deriving from totalActual/liveRate
      // would silently produce the wrong foreign amount drawn from the account.
      if(invCurrency&&invCurrency===foreignAcct.currency)foreignAcctAmt+=foreignSettled;
      else foreignAcctAmt+=actualCashPaid/foreignAcctRate;
    }
  }

  if(!settlements.length){st.innerHTML='<span style="color:var(--red3)">Enter at least one amount to apply</span>';return;}

  totalBooked=+totalBooked.toFixed(2);
  totalActual=+totalActual.toFixed(2);
  const netAdjustment=+(totalActual-totalBooked).toFixed(2);

  const date=(document.getElementById('ps-date')||{}).value||today();

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
  DB.entries.push(entry);
  await saveData();
  renderAll();
  if(typeof renderSupplierList==='function')renderSupplierList();
  closePaySupplierModal();
  const gainLossMsg=netAdjustment>0.01?` (realized loss ${fc(netAdjustment)})`:netAdjustment<-0.01?` (realized gain ${fc(-netAdjustment)})`:'';
  if(typeof showToast==='function')showToast(`✅ Payment of ${fc(totalActual)} recorded to ${supplier.name}${gainLossMsg}`);
}

async function recordCustomerPayment(){
  const st=document.getElementById('rp-st');
  const customerId=RP_CUSTOMER_ID;
  const customer=(typeof CUSTOMERS!=='undefined'?CUSTOMERS:[]).find(c=>String(c.id)===String(customerId));
  if(!customer){st.innerHTML='<span style="color:var(--red3)">No customer selected</span>';return;}

  const settlements=[];
  let totalBooked=0,totalActual=0;

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

  for(const el of document.querySelectorAll('.rp-apply-amt')){
    const amt=parseFloat(el.value)||0;
    const remaining=parseFloat(el.dataset.remaining)||0;
    if(amt<=0)continue;
    if(amt>remaining+0.01){st.innerHTML=`<span style="color:var(--red3)">One invoice's applied amount (${fc(amt)}) is more than what's remaining (${fc(remaining)}).</span>`;return;}
    settlements.push({invoiceId:parseInt(el.dataset.invoiceId),amount:amt});
    totalBooked+=amt;totalActual+=amt;
    if(isForeignPayment)foreignAcctAmt+=amt/foreignAcctRate;
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
    totalBooked+=bookedPortion;totalActual+=actualCashReceived;
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
  const netAdjustment=+(totalActual-totalBooked).toFixed(2); // + = realized gain (AR side)

  const date=(document.getElementById('rp-date')||{}).value||today();

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
  DB.entries.push(entry);
  await saveData();
  renderAll();
  if(typeof renderCustomerList==='function')renderCustomerList();
  closeReceivePaymentModal();
  const gainLossMsg=netAdjustment>0.01?` (realized gain ${fc(netAdjustment)})`:netAdjustment<-0.01?` (realized loss ${fc(-netAdjustment)})`:'';
  if(typeof showToast==='function')showToast(`✅ Received ${fc(totalActual)} from ${customer.name}${gainLossMsg}`);
}

console.log('✅ patch-v28.js loaded — Pay Supplier and Receive Payment can now route through foreign accounts');
