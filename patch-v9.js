// ═══════════════════════════════════════════════════════════
// PATCH v9 — Real Base Currency Ledger (not just display)
// ═══════════════════════════════════════════════════════════
// Builds on patch-v8 (which set a company's DISPLAY currency from its registration
// country). This patch goes further: the company's own currency becomes the TRUE
// internal ledger unit, not just what's shown on screen.
//
// Before this patch: every transaction was converted to USD and stored in USD,
// no matter what currency the company actually operates in. "Local Display
// Currency" only reformatted USD amounts for viewing.
//
// After this patch: every transaction is converted into the company's own
// base_currency (set once at registration, from the backend) and stored in THAT
// currency. Local Display Currency still works exactly as before — you can still
// view in any currency, live-rate converted — it's just now converting from the
// company's real base currency instead of always assuming USD underneath.
//
// This is done by redefining exactly two functions — convertToUSD() and fc() —
// which every part of the app already routes every amount through. Nothing else
// needs to change. Both functions are written to reduce to byte-for-byte the
// SAME behavior as before whenever BASE_CURRENCY is 'USD' (which it still is for
// any company that hasn't been migrated), so this cannot break existing companies
// that stay on USD.
//
// Per the Owner's explicit instruction, the backend for this patch (see the
// updated api/db.js) also retroactively syncs base_currency to match each
// existing company's local_currency, since current data is test data only. This
// means: for a company that already has local_currency set to something other
// than USD, its OLD stored transaction numbers will now be interpreted as being
// in that new base currency, without the underlying numbers themselves being
// re-stated — so old totals in that company will look off by the exchange-rate
// factor. Fine for test data; if you want clean numbers, start a fresh test
// company after this deploys, or clear that company's transactions.
// ═══════════════════════════════════════════════════════════

// The company's true ledger currency, loaded from the backend at login. Defaults
// to 'USD' so anything that runs before enterCompany() finishes behaves exactly
// like the app did before this patch.
let BASE_CURRENCY='USD';

// Redefines the app's single currency-in conversion function. Every entry point
// (receipts, POs, deliveries, worker salaries, project values, mobile money —
// all already calling convertToUSD(amount, fromCurrency) today) automatically
// starts storing amounts in BASE_CURRENCY instead of always USD, with zero
// changes needed at any of those call sites.
function convertToUSD(amount, fromCurrency){
  const amt=parseFloat(amount)||0;
  let amountInUSD;
  if(!fromCurrency||fromCurrency==='USD'){
    amountInUSD=amt;
  }else{
    const rate=getDisplayRate(fromCurrency); // 1 USD = rate units of fromCurrency
    amountInUSD=rate?amt/rate:amt; // unknown rate — same fallback as the original function
  }
  if(!BASE_CURRENCY||BASE_CURRENCY==='USD'){
    return amountInUSD; // legacy/unmigrated company — ledger stays USD, unchanged behavior
  }
  const baseRate=getDisplayRate(BASE_CURRENCY); // 1 USD = baseRate units of BASE_CURRENCY
  if(!baseRate)return amountInUSD; // no known rate for the base currency — can't convert further
  return amountInUSD*baseRate;
}

// Redefines the app's single display-formatting function. Every fc(n) call across
// the whole app (dashboards, reports, invoices, POS, everywhere) automatically
// starts treating stored numbers as BASE_CURRENCY-denominated instead of always
// USD-denominated, with zero changes needed anywhere fc() is called.
function fc(n){
  const amt=+(n||0);
  const baseRate=getDisplayRate(BASE_CURRENCY);
  let amountInUSD;
  if(!BASE_CURRENCY||BASE_CURRENCY==='USD'||!baseRate){
    amountInUSD=amt; // legacy/unmigrated company, or unknown base rate — treat as already-USD
  }else{
    amountInUSD=amt/baseRate;
  }
  if(CUR==='USD'){
    return '$'+amountInUSD.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  }
  const curRate=getDisplayRate(CUR);
  if(!curRate){
    return '$'+amountInUSD.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); // no known rate — same fallback as the original function
  }
  const converted=amountInUSD*curRate;
  return currencySymbol(CUR)+' '+converted.toLocaleString(undefined,{maximumFractionDigits:Math.abs(converted)>=1000?0:2});
}

// Loads BASE_CURRENCY from the company record after login, alongside everything
// patch-v8 already sets up (LOCAL_CURRENCY, live rate prefill, topbar currency).
const _origEnterCompanyV9=window.enterCompany;
if(typeof _origEnterCompanyV9==='function'){
  window.enterCompany=async function(c){
    const result=await _origEnterCompanyV9(c);
    try{
      BASE_CURRENCY=c.base_currency||LOCAL_CURRENCY||'USD';
    }catch(e){console.error('patch-v9 enterCompany base currency setup',e);}
    return result;
  };
}

console.log('✅ patch-v9.js loaded — ledger now records in each company\'s own base currency');

