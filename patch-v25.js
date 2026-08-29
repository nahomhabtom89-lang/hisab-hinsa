// ═══════════════════════════════════════════════════════════
// PATCH v25 — Customer/AR Forex, Phase B: Receive Payment
// ═══════════════════════════════════════════════════════════
// Mirrors patch-v19 (Pay Supplier) and patch-v21 (realized gain/loss) but
// for the customer side: a "💰 Receive" button next to each customer opens
// their open invoices, lets you record how much of each is being collected,
// and — for foreign-currency-tagged invoices — captures a realized gain or
// loss the same way Pay Supplier does.
//
// IMPORTANT SIGN FLIP vs Pay Supplier: for a payable, owing MORE than
// booked is a LOSS. For a receivable, being owed (and then collecting) MORE
// than booked is a GAIN — the exact opposite. This was verified with a
// dedicated calculation before writing this patch (both directions balance
// correctly).
//
// getCurrentBookedAmount (from patch-v20) is redefined here as a superset
// that also recognizes an Accounts Receivable debit line, not just Accounts
// Payable credit — a strict superset, identical output for AP entries.
// getSettledAmountForInvoice (from patch-v19) is reused as-is — it already
// works for any entry type, since it just sums settlements by invoiceId
// regardless of party type.
// ═══════════════════════════════════════════════════════════

function getCurrentBookedAmount(entry){
  const line=(entry.credits||[]).find(l=>l.acct==='Accounts Payable')
          ||(entry.debits||[]).find(l=>l.acct==='Accounts Receivable');
  if(!line)return 0;
  const adjTotal=(entry.fxAdjustments||[]).reduce((s,a)=>s+(+a.amount||0),0);
  return +(line.amt+adjTotal).toFixed(2);
}

function getOpenARInvoices(customerId){
  return (DB.entries||[])
    .filter(e=>e.party&&e.party.type==='customer'&&String(e.party.id)===String(customerId))
    .map(e=>{
      const arLine=(e.debits||[]).find(l=>l.acct==='Accounts Receivable');
      if(!arLine)return null;
      const booked=getCurrentBookedAmount(e);
      const settled=getSettledAmountForInvoice(e.id);
      const remaining=+(booked-settled).toFixed(2);
      return{id:e.id,date:e.date,desc:e.desc,original:arLine.amt,booked,settled,remaining,fx:e.fx||null};
    })
    .filter(x=>x&&x.remaining>0.01)
    .sort((a,b)=>a.date.localeCompare(b.date));
}

// ── Modal (mirrors ensurePaySupplierModal) ──────────────────────────────
function ensureReceivePaymentModal(){
  if(document.getElementById('receivePaymentModal'))return;
  const div=document.createElement('div');
  div.id='receivePaymentModal';
  div.style.cssText='display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:5000;align-items:center;justify-content:center;padding:20px';
  div.innerHTML=`
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:20px;width:100%;max-width:520px;max-height:85vh;overflow-y:auto;box-shadow:var(--shadow)">
      <div id="rp-title" style="font-family:'Noto Sans Ethiopic',sans-serif;font-size:15px;font-weight:700;color:var(--text);margin-bottom:14px">💰 Receive Payment</div>
      <div id="rp-invoices" style="margin-bottom:14px"></div>
      <div class="fg"><label>Total Received</label><input id="rp-total" type="text" readonly style="background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:9px 11px;font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--gold3);width:100%"/></div>
      <div class="fg"><label>Received Via</label>
        <select id="rp-method" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:9px 11px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none">
          <option value="cash">Cash</option><option value="mobile">Mobile Money</option><option value="bank">Bank Account</option>
        </select>
      </div>
      <div class="fg"><label>Date</label><input id="rp-date" type="date"/></div>
      <div id="rp-st" style="font-size:11px;margin:4px 0 8px"></div>
      <div class="btn-row" style="margin-top:0">
        <button class="btn btn-gold" onclick="recordCustomerPayment()">✅ Record Receipt</button>
        <button class="btn btn-outline" onclick="closeReceivePaymentModal()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(div);
}

let RP_CUSTOMER_ID=null;

function renderReceivePaymentRow(inv){
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
        <div style="font-size:9px;color:var(--text3)">Collect (${inv.fx.currency})</div>
        <input class="rp-fx-settle" data-invoice-id="${inv.id}" data-recorded-rate="${recordedRate}" data-remaining-foreign="${remainingForeign}" type="number" step="0.01" value="${remainingForeign}" oninput="onReceiveFxRowChange(${inv.id})" style="width:90px;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:5px 6px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text)"/>
        <div style="font-size:9px;color:var(--text3);margin-top:3px">At rate</div>
        <input class="rp-fx-rate" data-invoice-id="${inv.id}" type="number" step="0.0001" value="${(+liveRate).toFixed(4)}" oninput="onReceiveFxRowChange(${inv.id})" style="width:90px;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:5px 6px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text)"/>
        <div id="rp-fx-pay-${inv.id}" style="font-size:10px;color:var(--gold3);margin-top:3px"></div>
      </td>
    </tr>`;
  }
  return `<tr>
    <td style="font-size:11px">${inv.date}</td>
    <td style="font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${inv.desc}">${inv.desc}</td>
    <td style="font-family:'JetBrains Mono',monospace;color:var(--orange3)">${fc(inv.remaining)}</td>
    <td><input class="rp-apply-amt" data-invoice-id="${inv.id}" data-remaining="${inv.remaining}" type="number" step="0.01" value="${inv.remaining}" oninput="recalcReceivePaymentTotal()" style="width:100px;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text)"/></td>
  </tr>`;
}

function onReceiveFxRowChange(invoiceId){
  const settleEl=document.querySelector(`.rp-fx-settle[data-invoice-id="${invoiceId}"]`);
  const rateEl=document.querySelector(`.rp-fx-rate[data-invoice-id="${invoiceId}"]`);
  const payDiv=document.getElementById(`rp-fx-pay-${invoiceId}`);
  if(settleEl&&rateEl&&payDiv){
    const pay=(parseFloat(settleEl.value)||0)*(parseFloat(rateEl.value)||0);
    payDiv.textContent=`= ${fc(pay)}`;
  }
  recalcReceivePaymentTotal();
}

function openReceivePaymentModal(customerId){
  ensureReceivePaymentModal();
  RP_CUSTOMER_ID=customerId;
  const customer=(typeof CUSTOMERS!=='undefined'?CUSTOMERS:[]).find(c=>String(c.id)===String(customerId));
  document.getElementById('rp-title').textContent=`💰 Receive from ${customer?customer.name:'Customer'}`;
  const open=getOpenARInvoices(customerId);
  const wrap=document.getElementById('rp-invoices');
  if(!open.length){
    wrap.innerHTML='<div style="text-align:center;padding:14px;color:var(--text3)">No open invoices for this customer — nothing to collect.</div>';
  }else{
    wrap.innerHTML=`<table><thead><tr><th>Date</th><th>Description</th><th>Remaining</th><th>Apply / Collect</th></tr></thead><tbody>${
      open.map(renderReceivePaymentRow).join('')
    }</tbody></table>`;
    open.forEach(inv=>{if(inv.fx)onReceiveFxRowChange(inv.id);});
  }
  document.getElementById('rp-date').value=today();
  document.getElementById('rp-st').textContent='';
  recalcReceivePaymentTotal();
  document.getElementById('receivePaymentModal').style.display='flex';
}

function closeReceivePaymentModal(){
  const m=document.getElementById('receivePaymentModal');
  if(m)m.style.display='none';
  RP_CUSTOMER_ID=null;
}

function recalcReceivePaymentTotal(){
  let total=0;
  document.querySelectorAll('.rp-apply-amt').forEach(el=>{total+=parseFloat(el.value)||0;});
  document.querySelectorAll('.rp-fx-settle').forEach(settleEl=>{
    const id=settleEl.dataset.invoiceId;
    const rateEl=document.querySelector(`.rp-fx-rate[data-invoice-id="${id}"]`);
    total+=(parseFloat(settleEl.value)||0)*(rateEl?parseFloat(rateEl.value)||0:0);
  });
  const totalEl=document.getElementById('rp-total');
  if(totalEl)totalEl.value=(typeof fc==='function'?fc(total):total.toFixed(2));
}

async function recordCustomerPayment(){
  const st=document.getElementById('rp-st');
  const customerId=RP_CUSTOMER_ID;
  const customer=(typeof CUSTOMERS!=='undefined'?CUSTOMERS:[]).find(c=>String(c.id)===String(customerId));
  if(!customer){st.innerHTML='<span style="color:var(--red3)">No customer selected</span>';return;}

  const settlements=[];
  let totalBooked=0,totalActual=0;

  for(const el of document.querySelectorAll('.rp-apply-amt')){
    const amt=parseFloat(el.value)||0;
    const remaining=parseFloat(el.dataset.remaining)||0;
    if(amt<=0)continue;
    if(amt>remaining+0.01){st.innerHTML=`<span style="color:var(--red3)">One invoice's applied amount (${fc(amt)}) is more than what's remaining (${fc(remaining)}).</span>`;return;}
    settlements.push({invoiceId:parseInt(el.dataset.invoiceId),amount:amt});
    totalBooked+=amt;totalActual+=amt;
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
  }

  if(!settlements.length){st.innerHTML='<span style="color:var(--red3)">Enter at least one amount to apply</span>';return;}

  totalBooked=+totalBooked.toFixed(2);
  totalActual=+totalActual.toFixed(2);
  // NOTE the flipped sign vs Pay Supplier: for AR, receiving MORE than booked is a GAIN.
  const netAdjustment=+(totalActual-totalBooked).toFixed(2); // + = realized gain, - = realized loss

  const method=(document.getElementById('rp-method')||{}).value||'cash';
  const date=(document.getElementById('rp-date')||{}).value||today();
  const recvAcctMap={cash:'Cash',mobile:'Mobile Money',bank:'Bank Account'};
  const recvAcct=recvAcctMap[method]||'Cash';

  const debits=[{acct:recvAcct,amt:totalActual,atype:'asset'}];
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

// ── Wire up the 💰 Receive button next to each customer ────────────────
const _origRenderCustomerListV25=window.renderCustomerList;
if(typeof _origRenderCustomerListV25==='function'){
  window.renderCustomerList=function(){
    const result=_origRenderCustomerListV25();
    document.querySelectorAll('#customerList [onclick^="togglePartyLedger(\'customer\'"]').forEach(btn=>{
      if(btn.dataset.receiveBtnAdded)return;
      btn.dataset.receiveBtnAdded='1';
      const match=btn.getAttribute('onclick').match(/togglePartyLedger\('customer',(\d+)\)/);
      if(!match)return;
      const customerId=match[1];
      const recvBtn=document.createElement('button');
      recvBtn.className='btn btn-gold';
      recvBtn.style.cssText='font-size:10px;padding:3px 7px;margin-right:4px';
      recvBtn.textContent='💰 Receive';
      recvBtn.onclick=()=>openReceivePaymentModal(customerId);
      btn.parentNode.insertBefore(recvBtn,btn);
    });
    return result;
  };
}

console.log('✅ patch-v25.js loaded — Receive Payment now links customer receipts to specific open invoices');
