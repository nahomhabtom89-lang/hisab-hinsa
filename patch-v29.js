// ═══════════════════════════════════════════════════════════
// PATCH v29 — Foreign Currency Accounts, Phase 3: Revaluation
// ═══════════════════════════════════════════════════════════
// Extends the unified FX Revaluation report (patch-v26, which already
// covers AP + AR) to also revalue foreign-currency Cash/Bank balances —
// money you're actually holding, which shifts in base-currency value just
// from holding it as rates move, even with zero new transactions.
//
// Design (verified before writing this): unlike AP/AR invoices, a cash
// account has no single "entry" to attach re-basing info to — but it turns
// out none is needed. The account's "book value" (patch-v27's
// getForeignAccountBookValue, new here) is simply the running sum of every
// base-currency amount ever posted to it, and posting the revaluation
// adjustment AS a normal entry to that same account (with foreignAmt: 0,
// since holdings don't change — only their recorded value does) makes the
// book value self-correcting: the next revaluation run automatically only
// sees movement since the last one. No double-counting, verified with a
// 2-run simulation.
//
// Same P&L sign convention as AR: an asset becoming worth MORE is a gain.
// Redefines getAllOpenFxItems/computeFxRevaluation/postFxRevaluation/
// openFxRevaluationModal from patch-v26 as supersets — AP/AR behavior is
// completely unchanged, foreign accounts are simply added as a third
// category of row.
// ═══════════════════════════════════════════════════════════

function getForeignAccountBookValue(acctId){
  const acct=(typeof FOREIGN_ACCOUNTS!=='undefined'?FOREIGN_ACCOUNTS:[]).find(a=>String(a.id)===String(acctId));
  if(!acct)return 0;
  const glName=foreignAccountGLName(acct);
  let bal=0;
  (DB.entries||[]).forEach(e=>{
    (e.debits||[]).forEach(l=>{if(l.acct===glName)bal+=(+l.amt||0);});
    (e.credits||[]).forEach(l=>{if(l.acct===glName)bal-=(+l.amt||0);});
  });
  return +bal.toFixed(2);
}

function getAllOpenFxItems(){
  const items=[];
  (DB.entries||[]).forEach(e=>{
    if(!e.fx||!e.party)return;
    if(e.party.type==='supplier'){
      const apLine=(e.credits||[]).find(l=>l.acct==='Accounts Payable');
      if(!apLine)return;
      const booked=getCurrentBookedAmount(e);
      const settled=getSettledAmountForInvoice(e.id);
      const remaining=+(booked-settled).toFixed(2);
      if(remaining<=0.01)return;
      items.push({entry:e,partyName:e.party.name,remaining,type:'AP'});
    }else if(e.party.type==='customer'){
      const arLine=(e.debits||[]).find(l=>l.acct==='Accounts Receivable');
      if(!arLine)return;
      const booked=getCurrentBookedAmount(e);
      const settled=getSettledAmountForInvoice(e.id);
      const remaining=+(booked-settled).toFixed(2);
      if(remaining<=0.01)return;
      items.push({entry:e,partyName:e.party.name,remaining,type:'AR'});
    }
  });
  return items;
}

function computeFxRevaluation(){
  const items=getAllOpenFxItems();
  const rows=items.map(it=>{
    const fx=it.entry.fx;
    const recordedRate=getCurrentFxRate(it.entry);
    const currentRate=fxCrossRate(fx.currency);
    if(!currentRate||!recordedRate)return null;
    const remainingForeign=+(it.remaining/recordedRate).toFixed(4);
    const revalued=+(remainingForeign*currentRate).toFixed(2);
    const adjustment=+(revalued-it.remaining).toFixed(2);
    const pnlImpact=it.type==='AP'?-adjustment:adjustment;
    return{acctId:null,entryId:it.entry.id,type:it.type,partyName:it.partyName,desc:it.entry.desc,date:it.entry.date,
      currency:fx.currency,remainingForeign,recordedRate,currentRate,booked:it.remaining,revalued,adjustment,pnlImpact};
  }).filter(Boolean);

  (typeof FOREIGN_ACCOUNTS!=='undefined'?FOREIGN_ACCOUNTS:[]).forEach(acct=>{
    const foreignBalance=getForeignAccountBalance(acct.id);
    if(Math.abs(foreignBalance)<0.01)return; // nothing held right now — nothing to revalue
    const bookValue=getForeignAccountBookValue(acct.id);
    const currentRate=fxCrossRate(acct.currency);
    if(!currentRate)return;
    const revalued=+(foreignBalance*currentRate).toFixed(2);
    const adjustment=+(revalued-bookValue).toFixed(2);
    const impliedRecordedRate=foreignBalance!==0?+(bookValue/foreignBalance).toFixed(4):currentRate;
    rows.push({acctId:acct.id,entryId:null,type:'CASH',partyName:acct.name,desc:`${acct.baseType} balance held`,date:'',
      currency:acct.currency,remainingForeign:foreignBalance,recordedRate:impliedRecordedRate,currentRate,
      booked:bookValue,revalued,adjustment,pnlImpact:adjustment});
  });

  const total=+(rows.reduce((s,r)=>s+r.pnlImpact,0)).toFixed(2);
  return{rows,total};
}

async function postFxRevaluation(){
  const st=document.getElementById('fxr-st');
  const {rows,total}=computeFxRevaluation();
  if(!rows.length){if(st)st.innerHTML='<span style="color:var(--text3)">Nothing to post.</span>';return;}
  if(Math.abs(total)<0.01){if(st)st.innerHTML='<span style="color:var(--text3)">No material net adjustment (rates have not moved enough).</span>';return;}

  let arGain=0,arLoss=0,apGain=0,apLoss=0;
  const cashLines=[];
  rows.forEach(r=>{
    if(r.type==='AR'){if(r.adjustment>0)arGain+=r.adjustment;else arLoss+=-r.adjustment;}
    else if(r.type==='AP'){if(r.adjustment>0)apLoss+=r.adjustment;else apGain+=-r.adjustment;}
    else if(r.type==='CASH'){
      const acct=(typeof FOREIGN_ACCOUNTS!=='undefined'?FOREIGN_ACCOUNTS:[]).find(a=>String(a.id)===String(r.acctId));
      if(!acct||Math.abs(r.adjustment)<0.01)return;
      cashLines.push({acct:foreignAccountGLName(acct),currency:acct.currency,amt:Math.abs(r.adjustment),isGain:r.adjustment>0});
    }
  });
  arGain=+arGain.toFixed(2);arLoss=+arLoss.toFixed(2);apGain=+apGain.toFixed(2);apLoss=+apLoss.toFixed(2);
  const cashGainTotal=+cashLines.filter(c=>c.isGain).reduce((s,c)=>s+c.amt,0).toFixed(2);
  const cashLossTotal=+cashLines.filter(c=>!c.isGain).reduce((s,c)=>s+c.amt,0).toFixed(2);
  const netPnl=+((arGain+apGain+cashGainTotal)-(arLoss+apLoss+cashLossTotal)).toFixed(2);

  const todayStr=today();
  rows.forEach(r=>{
    if(r.entryId==null)return; // CASH rows aren't tied to one entry — nothing to re-base there
    const entry=DB.entries.find(e=>e.id===r.entryId);
    if(!entry)return;
    entry.fxAdjustments=entry.fxAdjustments||[];
    entry.fxAdjustments.push({date:todayStr,rate:r.currentRate,amount:r.adjustment});
  });

  const debits=[],credits=[];
  if(arGain>0)debits.push({acct:'Accounts Receivable',amt:arGain,atype:'asset'});
  if(apGain>0)debits.push({acct:'Accounts Payable',amt:apGain,atype:'liability'});
  if(arLoss>0)credits.push({acct:'Accounts Receivable',amt:arLoss,atype:'asset'});
  if(apLoss>0)credits.push({acct:'Accounts Payable',amt:apLoss,atype:'liability'});
  cashLines.forEach(cl=>{
    const line={acct:cl.acct,amt:cl.amt,atype:'asset',foreignAmt:0,currency:cl.currency};
    if(cl.isGain)debits.push(line);else credits.push(line);
  });
  if(netPnl<-0.01)debits.push({acct:'Unrealized FX Loss',amt:-netPnl,atype:'expense'});
  else if(netPnl>0.01)credits.push({acct:'Unrealized FX Gain',amt:netPnl,atype:'income'});

  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  const adjEntry={
    id:DB.nextId++,date:todayStr,
    desc:`Unrealized FX revaluation — ${rows.length} open ${base} item${rows.length>1?'s':''} re-priced at today's rate`,
    type:'FX Revaluation',amount:Math.abs(netPnl)||Math.max(arGain+apGain+cashGainTotal,arLoss+apLoss+cashLossTotal),project:'',
    debits,credits
  };
  DB.entries.push(adjEntry);
  await saveData();
  renderAll();
  if(st)st.innerHTML=`<span style="color:var(--green3)">✅ Posted a net ${netPnl>0?'gain':'loss'} of ${fc(Math.abs(netPnl))}.</span>`;
  openFxRevaluationModal();
}

function openFxRevaluationModal(){
  ensureFxRevaluationModal();
  const {rows,total}=computeFxRevaluation();
  const tableEl=document.getElementById('fxr-table');
  if(!rows.length){
    tableEl.innerHTML='<div style="text-align:center;padding:20px;color:var(--text3)">No open foreign-currency invoices or held balances to revalue right now.</div>';
  }else{
    const typeLabel={AP:'Payable',AR:'Receivable',CASH:'Held Balance'};
    const typeTag={AP:'t-orange',AR:'t-blue',CASH:'t-gold'};
    tableEl.innerHTML=`<table><thead><tr><th>Type</th><th>Party / Account</th><th>Currency</th><th>Foreign Amt</th><th>Recorded Rate</th><th>Today's Rate</th><th>Booked</th><th>Revalued</th><th>Gain/(Loss)</th></tr></thead><tbody>${
      rows.map(r=>`<tr>
        <td><span class="tag ${typeTag[r.type]}" style="font-size:9px">${typeLabel[r.type]}</span></td>
        <td style="font-size:11px">${r.partyName}</td>
        <td>${r.currency}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${r.remainingForeign.toLocaleString()}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${r.recordedRate.toLocaleString(undefined,{maximumFractionDigits:4})}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${r.currentRate.toLocaleString(undefined,{maximumFractionDigits:4})}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${fc(r.booked)}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${fc(r.revalued)}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:${r.pnlImpact<0?'var(--red3)':r.pnlImpact>0?'var(--green3)':'var(--text3)'}">${r.pnlImpact<0?'(':''}${fc(Math.abs(r.pnlImpact))}${r.pnlImpact<0?')':''}</td>
      </tr>`).join('')
    }</tbody></table>`;
  }
  const totalEl=document.getElementById('fxr-total');
  const isGain=total>0;
  totalEl.innerHTML=rows.length?`Net Unrealized ${isGain?'Gain':'Loss'}: <span style="color:${isGain?'var(--green3)':'var(--red3)'}">${fc(Math.abs(total))}</span>`:'';
  document.getElementById('fxr-st').textContent='';
  document.getElementById('fxRevalModal').style.display='flex';
}

console.log('✅ patch-v29.js loaded — FX Revaluation now also covers held foreign cash/bank balances');
