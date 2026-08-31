// ═══════════════════════════════════════════════════════════
// PATCH v30 — Transfer Funds Between Accounts
// ═══════════════════════════════════════════════════════════
// Lets money move between ANY two accounts — Cash, Bank Account, Mobile
// Money, or any foreign account from the v27 registry — in any direction:
// base→foreign, foreign→base, or foreign→foreign (e.g. converting a USD
// cash box directly into a EUR bank account).
//
// KEY CONCEPT — average cost basis: when money leaves a foreign account,
// its "book value" (what it's worth on your books) is computed using that
// account's AVERAGE recorded rate (its current book value ÷ its current
// foreign balance — the same "implied rate" already shown in the FX
// Revaluation report). The difference between that book value and what the
// amount is actually worth at TODAY's live rate is a REALIZED gain or
// loss — the same concept as paying off an invoice, just applied to a pure
// currency conversion instead. Verified before writing this: a 200 USD
// transfer at an average cost of 3700, converted at today's rate of 3800,
// correctly balances with a 20,000 realized gain.
//
// Moving money between two base-currency accounts (e.g. Cash → Bank) or
// acquiring NEW foreign currency from your base currency degrades cleanly
// to a plain transfer with zero gain/loss — verified as part of the same
// design work.
// ═══════════════════════════════════════════════════════════

function getAllAccountOptions(){
  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  const opts=[
    {value:'base:Cash',label:`Cash (${base})`,currency:base,glName:'Cash'},
    {value:'base:Bank Account',label:`Bank Account (${base})`,currency:base,glName:'Bank Account'},
    {value:'base:Mobile Money',label:`Mobile Money (${base})`,currency:base,glName:'Mobile Money'}
  ];
  (typeof FOREIGN_ACCOUNTS!=='undefined'?FOREIGN_ACCOUNTS:[]).forEach(a=>{
    opts.push({value:'foreign:'+a.id,label:`${a.name} (${a.currency})`,currency:a.currency,glName:foreignAccountGLName(a)});
  });
  return opts;
}

function ensureTransferModal(){
  if(document.getElementById('transferModal'))return;
  const div=document.createElement('div');
  div.id='transferModal';
  div.style.cssText='display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:5000;align-items:center;justify-content:center;padding:20px';
  div.innerHTML=`
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:20px;width:100%;max-width:480px;box-shadow:var(--shadow)">
      <div style="font-family:'Noto Sans Ethiopic',sans-serif;font-size:15px;font-weight:700;color:var(--text);margin-bottom:14px">🔄 Transfer Funds</div>
      <div class="fg"><label>From</label><select id="tf-from" onchange="onTransferAccountChange()"></select></div>
      <div class="fg"><label>To</label><select id="tf-to" onchange="onTransferAccountChange()"></select></div>
      <div class="fg"><label id="tf-amt-label">Amount</label><input id="tf-amt" type="number" step="0.01" oninput="onTransferAccountChange()"/></div>
      <div id="tf-preview" style="font-size:11px;color:var(--gold3);margin-bottom:8px"></div>
      <div class="fg"><label>Date</label><input id="tf-date" type="date"/></div>
      <div id="tf-st" style="font-size:11px;margin:4px 0 8px"></div>
      <div class="btn-row" style="margin-top:0">
        <button class="btn btn-gold" onclick="recordTransfer()">✅ Transfer</button>
        <button class="btn btn-outline" onclick="closeTransferModal()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(div);
}

function populateTransferDropdowns(){
  const opts=getAllAccountOptions();
  const fromSel=document.getElementById('tf-from'),toSel=document.getElementById('tf-to');
  fromSel.innerHTML=opts.map(o=>`<option value="${o.value}">${o.label}</option>`).join('');
  toSel.innerHTML=opts.map(o=>`<option value="${o.value}">${o.label}</option>`).join('');
  if(opts.length>1)toSel.selectedIndex=1;
}

function openTransferModal(){
  ensureTransferModal();
  populateTransferDropdowns();
  document.getElementById('tf-amt').value='';
  document.getElementById('tf-date').value=today();
  document.getElementById('tf-st').textContent='';
  onTransferAccountChange();
  document.getElementById('transferModal').style.display='flex';
}
function closeTransferModal(){const m=document.getElementById('transferModal');if(m)m.style.display='none';}

function onTransferAccountChange(){
  const fromVal=(document.getElementById('tf-from')||{}).value;
  const toVal=(document.getElementById('tf-to')||{}).value;
  const opts=getAllAccountOptions();
  const fromOpt=opts.find(o=>o.value===fromVal),toOpt=opts.find(o=>o.value===toVal);
  const amtLabel=document.getElementById('tf-amt-label');
  if(amtLabel&&fromOpt)amtLabel.textContent=`Amount (${fromOpt.currency})`;
  const amt=parseFloat((document.getElementById('tf-amt')||{}).value)||0;
  const preview=document.getElementById('tf-preview');
  if(!preview||!fromOpt||!toOpt)return;
  if(fromOpt.currency===toOpt.currency){
    preview.textContent=amt>0?`= ${amt.toLocaleString()} ${toOpt.currency} (same currency, no conversion)`:'';
    return;
  }
  const fromRate=fxCrossRate(fromOpt.currency),toRate=fxCrossRate(toOpt.currency);
  if(!fromRate||!toRate){preview.innerHTML='<span style="color:var(--red3)">No known live rate for one of these currencies</span>';return;}
  const baseVal=amt*fromRate;
  const amtTo=baseVal/toRate;
  preview.textContent=amt>0?`≈ ${amtTo.toLocaleString(undefined,{maximumFractionDigits:2})} ${toOpt.currency} at today's rate`:'';
}

async function recordTransfer(){
  const st=document.getElementById('tf-st');
  const fromVal=(document.getElementById('tf-from')||{}).value;
  const toVal=(document.getElementById('tf-to')||{}).value;
  const amt=parseFloat((document.getElementById('tf-amt')||{}).value)||0;
  const date=(document.getElementById('tf-date')||{}).value||today();
  if(!fromVal||!toVal){st.innerHTML='<span style="color:var(--red3)">Pick both accounts</span>';return;}
  if(fromVal===toVal){st.innerHTML='<span style="color:var(--red3)">Pick two different accounts</span>';return;}
  if(amt<=0){st.innerHTML='<span style="color:var(--red3)">Enter an amount</span>';return;}

  const opts=getAllAccountOptions();
  const fromOpt=opts.find(o=>o.value===fromVal),toOpt=opts.find(o=>o.value===toVal);
  if(!fromOpt||!toOpt)return;

  const fromRate=fxCrossRate(fromOpt.currency),toRate=fxCrossRate(toOpt.currency);
  if(!fromRate||!toRate){st.innerHTML='<span style="color:var(--red3)">No known live rate for one of these currencies</span>';return;}

  let totalBooked;
  if(fromVal.indexOf('foreign:')===0){
    const acctId=fromVal.split(':')[1];
    const foreignBal=getForeignAccountBalance(acctId);
    const bookVal=getForeignAccountBookValue(acctId);
    if(Math.abs(foreignBal)<0.0001){st.innerHTML='<span style="color:var(--red3)">This account has no balance to transfer from.</span>';return;}
    const avgRate=bookVal/foreignBal;
    totalBooked=+(amt*avgRate).toFixed(2);
  }else{
    totalBooked=+(amt*fromRate).toFixed(2); // base-currency account: fromRate is always 1, so totalBooked==amt
  }
  const totalActual=+(amt*fromRate).toFixed(2);
  const netAdjustment=+(totalActual-totalBooked).toFixed(2);
  const amountTo=+(totalActual/toRate).toFixed(4);

  const debitLine={acct:toOpt.glName,amt:totalActual,atype:'asset'};
  if(toVal.indexOf('foreign:')===0){debitLine.foreignAmt=amountTo;debitLine.currency=toOpt.currency;}
  const creditLine={acct:fromOpt.glName,amt:totalBooked,atype:'asset'};
  if(fromVal.indexOf('foreign:')===0){creditLine.foreignAmt=amt;creditLine.currency=fromOpt.currency;}

  const debits=[debitLine],credits=[creditLine];
  if(netAdjustment>0.01)credits.push({acct:'Realized FX Gain',amt:netAdjustment,atype:'income'});
  else if(netAdjustment<-0.01)debits.push({acct:'Realized FX Loss',amt:-netAdjustment,atype:'expense'});

  const entry={
    id:DB.nextId++,date,
    desc:`Transfer: ${fromOpt.label} → ${toOpt.label}`,
    type:'Transfer',amount:totalActual,project:'',
    debits,credits
  };
  DB.entries.push(entry);
  await saveData();
  renderAll();
  closeTransferModal();
  const gainLossMsg=netAdjustment>0.01?` (realized gain ${fc(netAdjustment)})`:netAdjustment<-0.01?` (realized loss ${fc(-netAdjustment)})`:'';
  if(typeof showToast==='function')showToast(`✅ Transferred ${amt.toLocaleString()} ${fromOpt.currency} → ${amountTo.toLocaleString()} ${toOpt.currency}${gainLossMsg}`);
}

function injectTransferButton(){
  if(document.getElementById('transferFundsBtn'))return;
  const fcaCard=document.getElementById('fcaCard');
  if(!fcaCard)return;
  const btn=document.createElement('button');
  btn.id='transferFundsBtn';
  btn.className='btn btn-outline';
  btn.style.marginTop='10px';
  btn.textContent='🔄 Transfer Funds Between Accounts';
  btn.onclick=openTransferModal;
  fcaCard.appendChild(btn);
}
const _origNavV30=window.nav;
if(typeof _origNavV30==='function'){
  window.nav=async function(page,el){
    const result=await _origNavV30(page,el);
    if(page==='settings')injectTransferButton();
    return result;
  };
}

console.log('✅ patch-v30.js loaded — Transfer Funds between any accounts, with realized gain/loss on conversion');
