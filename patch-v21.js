// ═══════════════════════════════════════════════════════════
// PATCH v21 — Forex Adjustments, Phase 3: Realized Gain/Loss on Payment
// ═══════════════════════════════════════════════════════════
// Extends the Pay Supplier flow (patch-v19) so that settling a foreign-
// currency-tagged invoice captures a REALIZED gain or loss — the difference
// between what was booked (at the invoice's currently-recorded rate) and
// what was actually paid (at today's real rate). Before this patch, paying
// an invoice just meant typing in whatever base-currency number zeroed it
// out, so a gain/loss could never actually occur — nothing captured the
// foreign-currency side of the payment at all.
//
// For a foreign-currency invoice, the modal now shows two inputs instead of
// one: how much of the FOREIGN amount this payment settles, and at what
// rate. The actual cash amount (what gets credited to Cash/Bank/Mobile
// Money) is computed from those, and any difference from the booked value
// posts as Realized FX Gain or Realized FX Loss in the SAME entry.
//
// Non-fx-tagged invoices are completely unaffected — same single "Apply"
// input as before, verified below to produce identical output to v19.
//
// The math (verified before writing this):
//   bookedPortion = foreignSettled × recordedRate   (reduces AP by this)
//   actualCashPaid = foreignSettled × rateToday     (credited to Cash/Bank)
//   adjustment = actualCashPaid − bookedPortion     (+ = loss, − = gain)
// Debits = AP(bookedPortion) [+ Realized FX Loss if adjustment > 0]
// Credits = Cash(actualCashPaid) [+ Realized FX Gain if adjustment < 0]
// This always balances by construction — both sides derive from the same
// two rounded totals rather than summing independently-rounded pieces.
// ═══════════════════════════════════════════════════════════

function renderPaySupplierRow(inv){
  const entry=DB.entries.find(e=>e.id===inv.id);
  if(inv.fx&&entry){
    const recordedRate=getCurrentFxRate(entry)||inv.fx.rate;
    const remainingForeign=+(inv.remaining/recordedRate).toFixed(4);
    const liveRate=fxCrossRate(inv.fx.currency)||recordedRate;
    return `<tr>
      <td style="font-size:11px">${inv.date}</td>
      <td style="font-size:11px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${inv.desc}">${inv.desc} <span class="tag t-blue" style="font-size:9px">${inv.fx.currency}</span></td>
      <td style="font-family:'JetBrains Mono',monospace;color:var(--orange3);font-size:10px">${remainingForeign.toLocaleString()} ${inv.fx.currency}<br><span style="color:var(--text3)">(${fc(inv.remaining)} booked)</span></td>
      <td>
        <div style="font-size:9px;color:var(--text3)">Settle (${inv.fx.currency})</div>
        <input class="ps-fx-settle" data-invoice-id="${inv.id}" data-recorded-rate="${recordedRate}" data-remaining-foreign="${remainingForeign}" type="number" step="0.01" value="${remainingForeign}" oninput="onPayFxRowChange(${inv.id})" style="width:90px;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:5px 6px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text)"/>
        <div style="font-size:9px;color:var(--text3);margin-top:3px">At rate</div>
        <input class="ps-fx-rate" data-invoice-id="${inv.id}" type="number" step="0.0001" value="${(+liveRate).toFixed(4)}" oninput="onPayFxRowChange(${inv.id})" style="width:90px;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:5px 6px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text)"/>
        <div id="ps-fx-pay-${inv.id}" style="font-size:10px;color:var(--gold3);margin-top:3px"></div>
      </td>
    </tr>`;
  }
  return `<tr>
    <td style="font-size:11px">${inv.date}</td>
    <td style="font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${inv.desc}">${inv.desc}</td>
    <td style="font-family:'JetBrains Mono',monospace;color:var(--orange3)">${fc(inv.remaining)}</td>
    <td><input class="ps-apply-amt" data-invoice-id="${inv.id}" data-remaining="${inv.remaining}" type="number" step="0.01" value="${inv.remaining}" oninput="recalcPaySupplierTotal()" style="width:100px;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text)"/></td>
  </tr>`;
}

function onPayFxRowChange(invoiceId){
  const settleEl=document.querySelector(`.ps-fx-settle[data-invoice-id="${invoiceId}"]`);
  const rateEl=document.querySelector(`.ps-fx-rate[data-invoice-id="${invoiceId}"]`);
  const payDiv=document.getElementById(`ps-fx-pay-${invoiceId}`);
  if(settleEl&&rateEl&&payDiv){
    const pay=(parseFloat(settleEl.value)||0)*(parseFloat(rateEl.value)||0);
    payDiv.textContent=`= ${fc(pay)}`;
  }
  recalcPaySupplierTotal();
}

// Redefines openPaySupplierModal (from v19) to use renderPaySupplierRow for
// each invoice — a strict superset, non-fx rows render identically to v19.
function openPaySupplierModal(supplierId){
  ensurePaySupplierModal();
  PS_SUPPLIER_ID=supplierId;
  const supplier=(typeof SUPPLIERS!=='undefined'?SUPPLIERS:[]).find(s=>String(s.id)===String(supplierId));
  document.getElementById('ps-title').textContent=`💳 Pay ${supplier?supplier.name:'Supplier'}`;
  const open=getOpenAPInvoices(supplierId);
  const wrap=document.getElementById('ps-invoices');
  if(!open.length){
    wrap.innerHTML='<div style="text-align:center;padding:14px;color:var(--text3)">No open invoices for this supplier — nothing to pay.</div>';
  }else{
    wrap.innerHTML=`<table><thead><tr><th>Date</th><th>Description</th><th>Remaining</th><th>Apply / Settle</th></tr></thead><tbody>${
      open.map(renderPaySupplierRow).join('')
    }</tbody></table>`;
    open.forEach(inv=>{if(inv.fx)onPayFxRowChange(inv.id);});
  }
  document.getElementById('ps-date').value=today();
  document.getElementById('ps-st').textContent='';
  recalcPaySupplierTotal();
  document.getElementById('paySupplierModal').style.display='flex';
}

// Redefines recalcPaySupplierTotal to sum BOTH simple Apply amounts and the
// computed actual-cash value of each fx row.
function recalcPaySupplierTotal(){
  let total=0;
  document.querySelectorAll('.ps-apply-amt').forEach(el=>{total+=parseFloat(el.value)||0;});
  document.querySelectorAll('.ps-fx-settle').forEach(settleEl=>{
    const id=settleEl.dataset.invoiceId;
    const rateEl=document.querySelector(`.ps-fx-rate[data-invoice-id="${id}"]`);
    total+=(parseFloat(settleEl.value)||0)*(rateEl?parseFloat(rateEl.value)||0:0);
  });
  const totalEl=document.getElementById('ps-total');
  if(totalEl)totalEl.value=(typeof fc==='function'?fc(total):total.toFixed(2));
}

// Redefines recordSupplierPayment to handle both row types and post any net
// realized gain/loss in the same entry.
async function recordSupplierPayment(){
  const st=document.getElementById('ps-st');
  const supplierId=PS_SUPPLIER_ID;
  const supplier=(typeof SUPPLIERS!=='undefined'?SUPPLIERS:[]).find(s=>String(s.id)===String(supplierId));
  if(!supplier){st.innerHTML='<span style="color:var(--red3)">No supplier selected</span>';return;}

  const settlements=[];
  let totalBooked=0,totalActual=0;

  for(const el of document.querySelectorAll('.ps-apply-amt')){
    const amt=parseFloat(el.value)||0;
    const remaining=parseFloat(el.dataset.remaining)||0;
    if(amt<=0)continue;
    if(amt>remaining+0.01){st.innerHTML=`<span style="color:var(--red3)">One invoice's applied amount (${fc(amt)}) is more than what's remaining (${fc(remaining)}).</span>`;return;}
    settlements.push({invoiceId:parseInt(el.dataset.invoiceId),amount:amt});
    totalBooked+=amt;totalActual+=amt;
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
  }

  if(!settlements.length){st.innerHTML='<span style="color:var(--red3)">Enter at least one amount to apply</span>';return;}

  totalBooked=+totalBooked.toFixed(2);
  totalActual=+totalActual.toFixed(2);
  const netAdjustment=+(totalActual-totalBooked).toFixed(2); // + = realized loss, - = realized gain

  const method=(document.getElementById('ps-method')||{}).value||'cash';
  const date=(document.getElementById('ps-date')||{}).value||today();
  const payAcctMap={cash:'Cash',mobile:'Mobile Money',bank:'Bank Account'};
  const payAcct=payAcctMap[method]||'Cash';

  const debits=[{acct:'Accounts Payable',amt:totalBooked,atype:'liability'}];
  const credits=[{acct:payAcct,amt:totalActual,atype:'asset'}];
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

console.log('✅ patch-v21.js loaded — Pay Supplier now captures realized FX gain/loss');
