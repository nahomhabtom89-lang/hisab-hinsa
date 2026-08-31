// ═══════════════════════════════════════════════════════════
// PATCH v31 — POS Instant Sales Into Foreign Accounts
// ═══════════════════════════════════════════════════════════
// Handles the "sell and receive money directly in a foreign currency"
// case for instant POS payments (previously only credit sales, via
// patch-v24, could touch a foreign currency at all).
//
// Deliberately does NOT redefine completeSale() — that function has
// extensive VAT/COGS/inventory logic already carefully built up across many
// earlier patches, and touching it directly would be high-risk for no real
// benefit. Instead: foreign accounts are added as extra options on the
// existing Payment dropdown. When one is chosen, the dropdown is
// TEMPORARILY switched to "card" (a value the original function already
// handles safely, routing to Bank Account) before calling the original —
// letting all existing VAT/COGS/inventory logic run completely untouched —
// then AFTERWARDS, the just-posted entry's Bank Account line is found and
// renamed to the foreign account, with foreignAmt/currency attached.
//
// IMPORTANT: the just-posted sale entry is found by searching for
// type==='POS Sale' specifically, NOT by assuming it's the last entry in
// DB.entries — completeSale() can push a SEPARATE COGS entry immediately
// after the sale entry when cogs > 0, which would otherwise be the last
// entry and get incorrectly matched instead.
//
// Known minor limitation: the backend's saved POS sale record and the
// success toast will show "card" as the payment method rather than the
// specific foreign account name — a small cosmetic/reporting trade-off for
// keeping this change low-risk. The actual journal entry (what drives every
// financial report) is fully correct.
// ═══════════════════════════════════════════════════════════

function injectPOSForeignPaymentOptions(){
  const sel=document.getElementById('pos-payment');
  if(!sel)return;
  Array.from(sel.querySelectorAll('option[data-foreign-acct]')).forEach(o=>o.remove());
  (typeof FOREIGN_ACCOUNTS!=='undefined'?FOREIGN_ACCOUNTS:[]).forEach(a=>{
    const opt=document.createElement('option');
    opt.value='foreign:'+a.id;
    opt.textContent=`🌍 ${a.name} (${a.currency})`;
    opt.dataset.foreignAcct='1';
    sel.appendChild(opt);
  });
}
const _origNavV31=window.nav;
if(typeof _origNavV31==='function'){
  window.nav=async function(page,el){
    const result=await _origNavV31(page,el);
    if(page==='pos')injectPOSForeignPaymentOptions();
    return result;
  };
}
injectPOSForeignPaymentOptions(); // in case the POS page markup is already present, just hidden

const _origCompleteSaleV31=window.completeSale;
if(typeof _origCompleteSaleV31==='function'){
  window.completeSale=async function(){
    const sel=document.getElementById('pos-payment');
    const originalVal=sel?sel.value:'';
    const isForeign=originalVal&&originalVal.indexOf('foreign:')===0;
    let foreignAcct=null;
    if(isForeign){
      const acctId=originalVal.split(':')[1];
      foreignAcct=(typeof FOREIGN_ACCOUNTS!=='undefined'?FOREIGN_ACCOUNTS:[]).find(a=>String(a.id)===String(acctId));
      if(!foreignAcct){showToast('⚠️ Selected account not found');return;}
      if(sel)sel.value='card'; // safe, already-handled value — routes to Bank Account
    }
    const result=await _origCompleteSaleV31();
    if(isForeign&&foreignAcct){
      const entry=[...DB.entries].reverse().find(e=>e.type==='POS Sale');
      const line=entry&&(entry.debits||[]).find(l=>l.acct==='Bank Account');
      if(line){
        const acctRate=fxCrossRate(foreignAcct.currency);
        if(acctRate){
          line.acct=foreignAccountGLName(foreignAcct);
          line.foreignAmt=+(line.amt/acctRate).toFixed(4);
          line.currency=foreignAcct.currency;
          await saveData();
          renderAll();
        }
      }
      if(sel)sel.value=originalVal; // restore the visual selection for next sale
    }
    return result;
  };
}

console.log('✅ patch-v31.js loaded — POS instant sales can now route into foreign accounts');
