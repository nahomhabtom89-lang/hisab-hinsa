// ═══════════════════════════════════════════════════════════
// PATCH v23 — Customer/AR Forex, Phase A: Construction Invoicing
// ═══════════════════════════════════════════════════════════
// Mirrors what patch-v15 did for the supplier side, but for Accounts
// Receivable via the construction Invoice page — which, unlike Deliveries/
// Receipt Intake, never had a currency picker at all. This patch:
//
// 1. Adds an "Invoice Currency" dropdown to the Invoice form.
// 2. Redefines postInvoice() to convert the entered amount into the
//    company's base currency (via convertToUSD, exactly like every purchase
//    flow already does) BEFORE posting — previously the raw typed number was
//    posted as-is, so a foreign-currency invoice would have been recorded as
//    if it were already in base currency (same class of bug patch-v14 fixed
//    on the registration side).
// 3. Tags the resulting entry with its original currency + rate, reusing
//    tagLastEntryWithFx() — redefined here as a superset that also
//    recognizes an Accounts Receivable line (previously it only checked for
//    Accounts Payable), so the same fx data shape now works for AR too.
//
// This does NOT yet build a "Receive Payment from Customer" flow with
// settlement tracking (the AR equivalent of Pay Supplier), or extend the
// revaluation report to cover AR — those are the next two phases, mirroring
// how the supplier side was built up in stages (v15 → v19 → v20).
//
// POS credit sales (retail) are handled separately in the next patch, since
// that function is already tightly woven with existing VAT/tax-tier logic
// and needs more careful handling.
// ═══════════════════════════════════════════════════════════

// Redefines tagLastEntryWithFx (from patch-v18) as a superset that also
// recognizes an Accounts Receivable line, not just Accounts Payable — and
// adds an optional third argument so a caller can supply the TRUE original
// foreign amount directly, rather than having it reverse-engineered from a
// single line's amount. This matters for invoices with a retention split:
// the Accounts Receivable line only holds the net-of-retention amount, so
// dividing that back through the rate would understate the real foreign-
// currency exposure of the invoice as a whole.
function tagLastEntryWithFx(currency,explicitRate,explicitOriginalAmount){
  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  if(!currency||currency===base)return;
  const rate=explicitRate||fxCrossRate(currency);
  if(!rate)return;
  if(!DB||!DB.entries||!DB.entries.length)return;
  const entry=DB.entries[DB.entries.length-1];
  if(!entry||entry.fx)return;
  const controlLine=(entry.credits||[]).find(l=>l.acct==='Accounts Payable')
                  ||(entry.debits||[]).find(l=>l.acct==='Accounts Payable')
                  ||(entry.debits||[]).find(l=>l.acct==='Accounts Receivable')
                  ||(entry.credits||[]).find(l=>l.acct==='Accounts Receivable');
  if(!controlLine)return;
  const originalAmount=explicitOriginalAmount!==undefined&&explicitOriginalAmount!==null
    ?+explicitOriginalAmount:+(controlLine.amt/rate);
  entry.fx={currency,rate,originalAmount:+originalAmount.toFixed(4)};
  if(typeof saveData==='function')saveData();
}

// Injects the Invoice Currency dropdown, right after the Amount field.
function injectInvoiceCurrencyPicker(){
  if(document.getElementById('invCurrencyPicker'))return;
  const amtInput=document.getElementById('invAmt');
  if(!amtInput)return;
  const amtField=amtInput.closest('.fg');
  if(!amtField)return;
  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  const opts=(typeof CURRENCIES!=='undefined'?CURRENCIES:[]).map(c=>`<option value="${c.code}" ${c.code===base?'selected':''}>${c.code} — ${c.name}</option>`).join('');
  const div=document.createElement('div');
  div.id='invCurrencyPicker';
  div.className='fg';
  div.innerHTML=`<label>Invoice Currency</label><select id="invCurrency">${opts}</select>`;
  amtField.insertAdjacentElement('afterend',div);
}
const _origNavV23=window.nav;
if(typeof _origNavV23==='function'){
  window.nav=async function(page,el){
    const result=await _origNavV23(page,el);
    if(page==='projects'||page==='invoice')injectInvoiceCurrencyPicker();
    return result;
  };
}
// Also try right away in case the Invoice card is already in the DOM (some
// pages render all their cards up front, just hidden) — harmless no-op via
// the guard at the top of the function if the field isn't there yet.
injectInvoiceCurrencyPicker();

// Redefines postInvoice() — identical to the original except the entered
// amount is now converted from the picked currency into the base currency
// before anything else happens, and the resulting entry gets tagged.
function postInvoice(){
  const pid=parseInt(document.getElementById('invProject').value),
    invNo=document.getElementById('invNo').value.trim(),
    rawAmt=parseFloat(document.getElementById('invAmt').value)||0,
    pct=parseFloat(document.getElementById('invPct').value)||0,
    ret=(parseFloat(document.getElementById('invRet').value)||10)/100;
  const curEl=document.getElementById('invCurrency');
  const cur=curEl?curEl.value:((typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD');
  const amt=convertToUSD(rawAmt,cur);
  const p=DB.projects.find(x=>x.id===pid);
  if(!p||!amt)return;
  const custSel=document.getElementById('invCustomer'),custId=custSel?custSel.value:'',customer=custId?CUSTOMERS.find(c=>String(c.id)===String(custId)):null;
  const retAmt=amt*ret,net=amt-retAmt;
  p.billed=(p.billed||0)+amt;
  const entry={
    id:DB.nextId++,date:today(),
    desc:`Invoice ${invNo||''}: ${p.name} (${pct}%)`,
    type:'Invoice',amount:amt,project:p.name,
    debits:[{acct:'Accounts Receivable',amt:net,atype:'asset'},{acct:'Retention Receivable',amt:retAmt,atype:'asset'}],
    credits:[{acct:'Contract Revenue',amt,atype:'revenue'}]
  };
  if(customer)entry.party={type:'customer',id:customer.id,name:customer.name};
  DB.entries.push(entry);
  tagLastEntryWithFx(cur,null,rawAmt);
  saveData();
  renderAll();
  showToast(`✅ Invoice posted — Net: ${fc(net)}${customer?' — '+customer.name:''}`);
}

console.log('✅ patch-v23.js loaded — Construction Invoicing now supports foreign currency');
