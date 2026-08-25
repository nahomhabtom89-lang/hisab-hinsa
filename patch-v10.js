// ═══════════════════════════════════════════════════════════
// PATCH v10 — Fix stale "converted to USD" hint after base-currency ledger
// ═══════════════════════════════════════════════════════════
// patch-v9 changed the ledger to record in each company's own base currency
// instead of always USD, but onIntakeCurrencyChange() — the little hint shown
// under every "Invoice Currency" dropdown (receipts, deliveries, POs, material
// POs) — was never updated. Two bugs as a result:
//
// 1. It always compared the chosen currency to 'USD' to decide whether any
//    conversion is needed, so for a company whose base currency is NOT USD
//    (e.g. UGX), picking their OWN currency still showed a rate line talking
//    about USD, instead of correctly showing nothing (no conversion needed).
// 2. Even when a genuine foreign currency was picked, the rate shown and the
//    "converted to ___ automatically" text always said USD, when transactions
//    are now actually converted into the company's base currency.
//
// This patch redefines onIntakeCurrencyChange() (a single shared function used
// by every intake screen) to compare against BASE_CURRENCY instead of the
// literal string 'USD', and to show the correct cross-rate and target currency.
// For any company still on BASE_CURRENCY==='USD' (unmigrated / legacy), this
// behaves identically to the original — only companies with a real base
// currency see a difference, which is the intended fix.
// ═══════════════════════════════════════════════════════════

function onIntakeCurrencyChange(selectId,hintId){
  const sel=document.getElementById(selectId),hint=document.getElementById(hintId);
  if(!sel||!hint)return;
  const code=sel.value;
  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  if(code===base){hint.textContent='';return;}
  const fromRate=getDisplayRate(code),baseRate=getDisplayRate(base);
  if(fromRate&&baseRate){
    const cross=baseRate/fromRate;
    hint.innerHTML=`<span style="color:var(--text3)">1 ${code} = ${cross.toLocaleString(undefined,{maximumFractionDigits:4})} ${base}${code===LOCAL_CURRENCY?' (your local rate)':' (live)'} — costs entered below will be converted to ${base} automatically.</span>`;
  }else{
    hint.innerHTML=`<span style="color:var(--orange3)">⚠️ No known rate for ${code} — amounts won't convert. Set a rate for it in Settings first, or enter costs in ${base}.</span>`;
  }
}

console.log('✅ patch-v10.js loaded — invoice-currency hint now reflects base currency');
