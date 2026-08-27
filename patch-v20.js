// ═══════════════════════════════════════════════════════════
// PATCH v20 — Forex Adjustments, Phase 2: Unrealized Revaluation Report
// ═══════════════════════════════════════════════════════════
// This is the payoff for everything built in v15/v18 (currency tagging) and
// v19 (open-item settlement tracking): a report that finds every still-open,
// foreign-currency-tagged Accounts Payable balance, re-prices it at today's
// live rate, shows the gain or loss, and posts the adjustment.
//
// KEY DESIGN CHOICE — non-destructive re-basing:
// Running this twice must NOT double-count. But the fix is deliberately NOT
// to overwrite the original invoice entry's booked amount (that would erase
// the historical record of what was actually invoiced). Instead, each
// revaluation appends a small record to that entry's `fxAdjustments` array
// (date, the rate used, the adjustment amount). The "currently recorded
// rate" for an item is the rate from its MOST RECENT adjustment, or the
// original entry.fx.rate if it's never been revalued. This way:
//   - the original entry is never rewritten — full audit trail preserved
//   - running revaluation again only captures movement SINCE the last run
//   - a partial payment in between two revaluation runs is still handled
//     correctly, since "remaining" is always recomputed fresh
// (Verified with a 3-run simulation before writing this: rate moves
// 3700->3800->3800 (same, correctly zero)->3900, and each run's adjustment
// only reflects its own incremental movement.)
//
// The adjustment itself posts as ONE aggregate journal entry — standard
// practice for FX revaluation is a company-level "mark to market" entry,
// not a per-supplier transaction, so it isn't tagged with any one party.
// ═══════════════════════════════════════════════════════════

function getCurrentBookedAmount(entry){
  const apLine=(entry.credits||[]).find(l=>l.acct==='Accounts Payable');
  if(!apLine)return 0;
  const adjTotal=(entry.fxAdjustments||[]).reduce((s,a)=>s+(+a.amount||0),0);
  return +(apLine.amt+adjTotal).toFixed(2);
}
function getCurrentFxRate(entry){
  if(!entry.fx)return null;
  const adj=entry.fxAdjustments||[];
  if(adj.length)return adj[adj.length-1].rate;
  return entry.fx.rate;
}

// Redefines getOpenAPInvoices (from patch-v19) to account for any prior
// revaluation adjustments — a strict superset: identical output when
// fxAdjustments doesn't exist on an entry, matching v19's original behavior.
function getOpenAPInvoices(supplierId){
  return (DB.entries||[])
    .filter(e=>e.party&&e.party.type==='supplier'&&String(e.party.id)===String(supplierId))
    .map(e=>{
      const apLine=(e.credits||[]).find(l=>l.acct==='Accounts Payable');
      if(!apLine)return null;
      const booked=getCurrentBookedAmount(e);
      const settled=getSettledAmountForInvoice(e.id);
      const remaining=+(booked-settled).toFixed(2);
      return{id:e.id,date:e.date,desc:e.desc,original:apLine.amt,booked,settled,remaining,fx:e.fx||null};
    })
    .filter(x=>x&&x.remaining>0.01)
    .sort((a,b)=>a.date.localeCompare(b.date));
}

function getAllOpenFxItems(){
  const items=[];
  (DB.entries||[]).forEach(e=>{
    if(!e.fx||!e.party||e.party.type!=='supplier')return;
    const apLine=(e.credits||[]).find(l=>l.acct==='Accounts Payable');
    if(!apLine)return;
    const booked=getCurrentBookedAmount(e);
    const settled=getSettledAmountForInvoice(e.id);
    const remaining=+(booked-settled).toFixed(2);
    if(remaining<=0.01)return;
    items.push({entry:e,supplierName:e.party.name,remaining});
  });
  return items;
}

function computeFxRevaluation(){
  const items=getAllOpenFxItems();
  const rows=items.map(it=>{
    const fx=it.entry.fx;
    const recordedRate=getCurrentFxRate(it.entry);
    const currentRate=fxCrossRate(fx.currency);
    if(!currentRate||!recordedRate)return null; // unknown live rate — skip, can't revalue reliably
    const remainingForeign=+(it.remaining/recordedRate).toFixed(4);
    const revalued=+(remainingForeign*currentRate).toFixed(2);
    const adjustment=+(revalued-it.remaining).toFixed(2);
    return{entryId:it.entry.id,supplierName:it.supplierName,desc:it.entry.desc,date:it.entry.date,
      currency:fx.currency,remainingForeign,recordedRate,currentRate,booked:it.remaining,revalued,adjustment};
  }).filter(Boolean);
  const total=+(rows.reduce((s,r)=>s+r.adjustment,0)).toFixed(2);
  return{rows,total};
}

async function postFxRevaluation(){
  const st=document.getElementById('fxr-st');
  const {rows,total}=computeFxRevaluation();
  if(!rows.length){if(st)st.innerHTML='<span style="color:var(--text3)">Nothing to post.</span>';return;}
  if(Math.abs(total)<0.01){if(st)st.innerHTML='<span style="color:var(--text3)">No material net adjustment (rates have not moved enough).</span>';return;}
  const todayStr=today();
  rows.forEach(r=>{
    const entry=DB.entries.find(e=>e.id===r.entryId);
    if(!entry)return;
    entry.fxAdjustments=entry.fxAdjustments||[];
    entry.fxAdjustments.push({date:todayStr,rate:r.currentRate,amount:r.adjustment});
  });
  const absTotal=+Math.abs(total).toFixed(2);
  const isLoss=total>0; // owe MORE in base currency now = loss
  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  const adjEntry={
    id:DB.nextId++,date:todayStr,
    desc:`Unrealized FX revaluation — ${rows.length} open ${base} item${rows.length>1?'s':''} re-priced at today's rate`,
    type:'FX Revaluation',amount:absTotal,project:'',
    debits: isLoss ? [{acct:'Unrealized FX Loss',amt:absTotal,atype:'expense'}] : [{acct:'Accounts Payable',amt:absTotal,atype:'liability'}],
    credits: isLoss ? [{acct:'Accounts Payable',amt:absTotal,atype:'liability'}] : [{acct:'Unrealized FX Gain',amt:absTotal,atype:'income'}]
  };
  DB.entries.push(adjEntry);
  await saveData();
  renderAll();
  if(st)st.innerHTML=`<span style="color:var(--green3)">✅ Posted a net ${isLoss?'loss':'gain'} of ${fc(absTotal)}.</span>`;
  openFxRevaluationModal(); // refresh the table to show the now-zeroed adjustments
}

// ── Modal ────────────────────────────────────────────────────────────────
function ensureFxRevaluationModal(){
  if(document.getElementById('fxRevalModal'))return;
  const div=document.createElement('div');
  div.id='fxRevalModal';
  div.style.cssText='display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:5000;align-items:center;justify-content:center;padding:20px';
  div.innerHTML=`
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:20px;width:100%;max-width:760px;max-height:85vh;overflow-y:auto;box-shadow:var(--shadow)">
      <div style="font-family:'Noto Sans Ethiopic',sans-serif;font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px">📉 Unrealized FX Revaluation</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:14px">Every open foreign-currency Accounts Payable balance, re-priced at today's live rate.</div>
      <div id="fxr-table"></div>
      <div id="fxr-total" style="margin-top:10px;font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700"></div>
      <div id="fxr-st" style="font-size:11px;margin:8px 0"></div>
      <div class="btn-row" style="margin-top:0">
        <button class="btn btn-gold" onclick="postFxRevaluation()">✅ Post Adjustment</button>
        <button class="btn btn-outline" onclick="document.getElementById('fxRevalModal').style.display='none'">Close</button>
      </div>
    </div>`;
  document.body.appendChild(div);
}

function openFxRevaluationModal(){
  ensureFxRevaluationModal();
  const {rows,total}=computeFxRevaluation();
  const tableEl=document.getElementById('fxr-table');
  if(!rows.length){
    tableEl.innerHTML='<div style="text-align:center;padding:20px;color:var(--text3)">No open foreign-currency invoices to revalue right now.</div>';
  }else{
    tableEl.innerHTML=`<table><thead><tr><th>Supplier</th><th>Currency</th><th>Foreign Amt</th><th>Recorded Rate</th><th>Today's Rate</th><th>Booked</th><th>Revalued</th><th>Gain/(Loss)</th></tr></thead><tbody>${
      rows.map(r=>`<tr>
        <td style="font-size:11px">${r.supplierName}</td>
        <td>${r.currency}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${r.remainingForeign.toLocaleString()}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${r.recordedRate.toLocaleString(undefined,{maximumFractionDigits:4})}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${r.currentRate.toLocaleString(undefined,{maximumFractionDigits:4})}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${fc(r.booked)}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${fc(r.revalued)}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:${r.adjustment>0?'var(--red3)':r.adjustment<0?'var(--green3)':'var(--text3)'}">${r.adjustment>0?'(':''}${fc(Math.abs(r.adjustment))}${r.adjustment>0?')':''}</td>
      </tr>`).join('')
    }</tbody></table>`;
  }
  const totalEl=document.getElementById('fxr-total');
  const isLoss=total>0;
  totalEl.innerHTML=rows.length?`Net Unrealized ${isLoss?'Loss':'Gain'}: <span style="color:${isLoss?'var(--red3)':'var(--green3)'}">${fc(Math.abs(total))}</span>`:'';
  document.getElementById('fxr-st').textContent='';
  document.getElementById('fxRevalModal').style.display='flex';
}

// ── Entry point: a button in Settings, next to Multi-Currency ──────────────
function injectFxRevaluationButton(){
  if(document.getElementById('fxRevalEntryCard'))return;
  const cards=document.querySelectorAll('#pg-settings .card');
  for(const card of cards){
    const hdr=card.querySelector('.card-hdr');
    if(hdr&&hdr.textContent.includes('Multi-Currency')){
      const div=document.createElement('div');
      div.id='fxRevalEntryCard';
      div.className='card';
      div.innerHTML=`<div class="card-hdr">📉 FX Revaluation</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:10px">Re-price open foreign-currency supplier balances at today's live rate and post any gain or loss.</div>
        <button class="btn btn-gold" onclick="openFxRevaluationModal()">📉 Run FX Revaluation</button>`;
      card.parentNode.insertBefore(div,card.nextSibling);
      break;
    }
  }
}
const _origNavV20=window.nav;
if(typeof _origNavV20==='function'){
  window.nav=async function(page,el){
    const result=await _origNavV20(page,el);
    if(page==='settings')injectFxRevaluationButton();
    return result;
  };
}

console.log('✅ patch-v20.js loaded — FX Revaluation report ready in Settings');
