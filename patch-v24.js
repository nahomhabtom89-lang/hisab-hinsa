// ═══════════════════════════════════════════════════════════
// PATCH v24 — Customer/AR Forex, Phase A (part 2): POS Credit Sales
// ═══════════════════════════════════════════════════════════
// Deliberately much lighter-touch than patch-v23 (Invoicing). Every product
// price in POS is already entered in the base currency, and completeSale()'s
// VAT/COGS/inventory math all correctly operates on that base-currency total
// already — none of that needs to change or even be touched.
//
// The only thing that needs currency awareness is a CREDIT sale's Accounts
// Receivable balance: this patch adds a currency picker next to the customer
// selector (shown only when it's shown, since it's injected as a child of
// the same wrapper), and SAFE-WRAPS completeSale() — reading the chosen
// currency before the original runs, tagging the resulting entry with it
// afterward, via tagLastEntryWithFx() (already defined by patch-v23,
// reused here as-is). The original completeSale() is never redefined, so
// the existing VAT/COGS/inventory logic is completely untouched.
// ═══════════════════════════════════════════════════════════

function injectPOSCustomerCurrencyPicker(){
  if(document.getElementById('posCustomerCurrencyPicker'))return;
  const wrap=document.getElementById('pos-customer-wrap');
  if(!wrap)return;
  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  const opts=(typeof CURRENCIES!=='undefined'?CURRENCIES:[]).map(c=>`<option value="${c.code}" ${c.code===base?'selected':''}>${c.code} — ${c.name}</option>`).join('');
  const div=document.createElement('div');
  div.id='posCustomerCurrencyPicker';
  div.style.marginTop='7px';
  div.innerHTML=`<label style="font-size:10px;color:var(--text2);display:block;margin-bottom:4px">Customer's Currency (for this credit balance)</label><select id="pos-customer-currency" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 9px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none">${opts}</select>`;
  wrap.appendChild(div);
}
const _origNavV24=window.nav;
if(typeof _origNavV24==='function'){
  window.nav=async function(page,el){
    const result=await _origNavV24(page,el);
    if(page==='pos')injectPOSCustomerCurrencyPicker();
    return result;
  };
}
injectPOSCustomerCurrencyPicker(); // in case the POS page markup is already present, just hidden

const _origCompleteSaleV24=window.completeSale;
if(typeof _origCompleteSaleV24==='function'){
  window.completeSale=async function(){
    const payMethod=(document.getElementById('pos-payment')||{}).value;
    const curEl=document.getElementById('pos-customer-currency');
    const cur=(payMethod==='credit'&&curEl)?curEl.value:null;
    const result=await _origCompleteSaleV24();
    if(cur&&typeof tagLastEntryWithFx==='function')tagLastEntryWithFx(cur);
    return result;
  };
}

console.log('✅ patch-v24.js loaded — POS credit sales now support tagging a foreign-currency customer balance');
