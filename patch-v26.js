// ═══════════════════════════════════════════════════════════
// PATCH v26 — Unified FX Revaluation: AP + AR together
// ═══════════════════════════════════════════════════════════
// Extends patch-v20's revaluation report to also include open, foreign-
// currency-tagged Accounts Receivable (invoices from patch-v23/v24),
// alongside Accounts Payable. The core complexity: the SAME rate-movement
// adjustment means opposite things depending on which side it's on — owing
// more (AP) is a loss, being owed more (AR) is a gain. This was verified
// with 5 test scenarios (pure AP, pure AR, and three mixed cases including
// gains AND losses on both sides at once) before writing this — every case
// balances exactly.
//
// CONVENTION CHANGE from patch-v20/v22: computeFxRevaluation()'s returned
// `total` now means the NET P&L IMPACT directly — positive = net gain,
// negative = net loss. (v20's original `total` meant the opposite — positive
// meant loss — which only worked because AP-only revaluation never needed to
// mix sign conventions.) postFxRevaluation() and the dashboard FX Exposure
// card (patch-v22) are both redefined here to match this clearer,
// consistent convention.
//
// The posted adjustment entry now has up to 5 lines instead of 2: separate
// debit/credit lines for the real AR and AP balance-sheet changes, plus one
// net Unrealized FX Gain or Loss line for the income statement — proper
// double-entry practice, not just netting everything into one number.
// ═══════════════════════════════════════════════════════════

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
    const pnlImpact=it.type==='AP'?-adjustment:adjustment; // + = gain, - = loss, either type
    return{entryId:it.entry.id,type:it.type,partyName:it.partyName,desc:it.entry.desc,date:it.entry.date,
      currency:fx.currency,remainingForeign,recordedRate,currentRate,booked:it.remaining,revalued,adjustment,pnlImpact};
  }).filter(Boolean);
  const total=+(rows.reduce((s,r)=>s+r.pnlImpact,0)).toFixed(2); // net P&L impact: + = gain, - = loss
  return{rows,total};
}

async function postFxRevaluation(){
  const st=document.getElementById('fxr-st');
  const {rows,total}=computeFxRevaluation();
  if(!rows.length){if(st)st.innerHTML='<span style="color:var(--text3)">Nothing to post.</span>';return;}
  if(Math.abs(total)<0.01){if(st)st.innerHTML='<span style="color:var(--text3)">No material net adjustment (rates have not moved enough).</span>';return;}

  let arGain=0,arLoss=0,apGain=0,apLoss=0;
  rows.forEach(r=>{
    if(r.type==='AR'){if(r.adjustment>0)arGain+=r.adjustment;else arLoss+=-r.adjustment;}
    else{if(r.adjustment>0)apLoss+=r.adjustment;else apGain+=-r.adjustment;}
  });
  arGain=+arGain.toFixed(2);arLoss=+arLoss.toFixed(2);apGain=+apGain.toFixed(2);apLoss=+apLoss.toFixed(2);
  const netPnl=+((arGain+apGain)-(arLoss+apLoss)).toFixed(2);

  const todayStr=today();
  rows.forEach(r=>{
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
  if(netPnl<-0.01)debits.push({acct:'Unrealized FX Loss',amt:-netPnl,atype:'expense'});
  else if(netPnl>0.01)credits.push({acct:'Unrealized FX Gain',amt:netPnl,atype:'income'});

  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  const adjEntry={
    id:DB.nextId++,date:todayStr,
    desc:`Unrealized FX revaluation — ${rows.length} open ${base} item${rows.length>1?'s':''} re-priced at today's rate`,
    type:'FX Revaluation',amount:Math.abs(netPnl)||Math.max(arGain+apGain,arLoss+apLoss),project:'',
    debits,credits
  };
  DB.entries.push(adjEntry);
  await saveData();
  renderAll();
  if(st)st.innerHTML=`<span style="color:var(--green3)">✅ Posted a net ${netPnl>0?'gain':'loss'} of ${fc(Math.abs(netPnl))}.</span>`;
  openFxRevaluationModal();
}

// ── Modal table now shows a Type column and per-row gain/loss coloring ────
function openFxRevaluationModal(){
  ensureFxRevaluationModal();
  const {rows,total}=computeFxRevaluation();
  const tableEl=document.getElementById('fxr-table');
  if(!rows.length){
    tableEl.innerHTML='<div style="text-align:center;padding:20px;color:var(--text3)">No open foreign-currency invoices to revalue right now.</div>';
  }else{
    tableEl.innerHTML=`<table><thead><tr><th>Type</th><th>Party</th><th>Currency</th><th>Foreign Amt</th><th>Recorded Rate</th><th>Today's Rate</th><th>Booked</th><th>Revalued</th><th>Gain/(Loss)</th></tr></thead><tbody>${
      rows.map(r=>`<tr>
        <td><span class="tag ${r.type==='AP'?'t-orange':'t-blue'}" style="font-size:9px">${r.type==='AP'?'Payable':'Receivable'}</span></td>
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

// ── Dashboard FX Exposure card: updated for the new sign convention ────────
// (total now means net P&L directly: + = gain, - = loss)
const _origRenderHomeKpisV26=window.renderHomeKpis;
if(typeof _origRenderHomeKpisV26==='function'){
  window.renderHomeKpis=function(){
    const result=_origRenderHomeKpisV26();
    try{
      const el=document.getElementById('homeKpis');
      const existing=document.getElementById('fxExposureKpi');
      if(existing)existing.remove();
      if(el&&typeof computeFxRevaluation==='function'){
        const{rows,total}=computeFxRevaluation();
        if(rows.length){
          const isGain=total>0.01;
          const isLoss=total<-0.01;
          const card=document.createElement('div');
          card.className='kpi';
          card.id='fxExposureKpi';
          card.style.cursor='pointer';
          card.title="Click to open the FX Revaluation report";
          card.onclick=function(){if(typeof openFxRevaluationModal==='function')openFxRevaluationModal();};
          const display=(!isGain&&!isLoss)?'—':(isGain?'+':'-')+fc(Math.abs(total));
          card.innerHTML=`<div class="kpi-lbl">FX Exposure</div><div class="kpi-val ${isLoss?'neg':isGain?'pos':''}">${display}</div>`;
          el.appendChild(card);
        }
      }
    }catch(e){console.error('patch-v26 fx exposure kpi',e);}
    return result;
  };
}

console.log('✅ patch-v26.js loaded — FX Revaluation now covers both Accounts Payable and Accounts Receivable');
