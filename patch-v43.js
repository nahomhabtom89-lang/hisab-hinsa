// ═══════════════════════════════════════════════════════════
// PATCH v42 — Fix: POS credit sale FX-tagging silently failing
// ═══════════════════════════════════════════════════════════
// Another pre-existing gap, same root cause as patch-v40 (Stock Intake)
// and the bug already caught and fixed once in patch-v35 for terms
// tagging on POS sales: completeSale() pushes the Sale entry (with the
// Accounts Receivable line) and THEN a separate COGS entry right after
// it. Patch-v24's fx-tagging call runs immediately after completeSale()
// returns and just grabs "the last entry" — which by then is the COGS
// entry, with no AR line on it at all. So tagLastEntryWithFx() silently
// finds nothing to tag and gives up, every single time a POS credit sale
// has any COGS at all (i.e. almost always).
//
// FIX: a robust version that searches backward through the last few
// entries for the most recent untagged one that actually has an AP/AR
// line — the exact same technique already used to fix this same bug
// class in patch-v35 (POS sale terms tagging) and already present in
// patch-v31/v32's POS retagging logic. Runs as one more layer on top of
// the whole completeSale chain, so it only steps in when v24's original
// attempt didn't find anything (an already-tagged entry is left alone).
// ═══════════════════════════════════════════════════════════

function tagLastEntryWithFxRobustV42(currency){
  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  if(!currency||currency===base)return;
  const rate=(typeof fxCrossRate==='function')?fxCrossRate(currency):null;
  if(!rate)return;
  if(!DB||!DB.entries||!DB.entries.length)return;
  const maxLookback=5;
  for(let i=DB.entries.length-1,count=0;i>=0&&count<maxLookback;i--,count++){
    const entry=DB.entries[i];
    if(!entry||entry.fx)continue; // already tagged (e.g. v24 succeeded already) or invalid — keep looking
    const controlLine=(entry.credits||[]).find(l=>l.acct==='Accounts Payable')
                    ||(entry.debits||[]).find(l=>l.acct==='Accounts Payable')
                    ||(entry.debits||[]).find(l=>l.acct==='Accounts Receivable')
                    ||(entry.credits||[]).find(l=>l.acct==='Accounts Receivable');
    if(!controlLine)continue; // e.g. a COGS entry with no AP/AR line — keep looking further back
    entry.fx={currency,rate,originalAmount:+(controlLine.amt/rate).toFixed(4)};
    if(typeof saveData==='function')saveData();
    return;
  }
}
window.tagLastEntryWithFxRobustV42=tagLastEntryWithFxRobustV42;

const _origCompleteSaleV42=window.completeSale;
if(typeof _origCompleteSaleV42==='function'){
  window.completeSale=async function(){
    const payMethod=(document.getElementById('pos-payment')||{}).value;
    const curEl=document.getElementById('pos-customer-currency');
    const cur=(payMethod==='credit'&&curEl)?curEl.value:null;
    const result=await _origCompleteSaleV42.apply(this,arguments);
    if(cur)tagLastEntryWithFxRobustV42(cur);
    return result;
  };
}

console.log('✅ patch-v42.js loaded — POS credit sales in a foreign currency are now reliably FX-tagged, even with a COGS entry in between');
