// ═══════════════════════════════════════════════════════════
// PATCH v27 — Foreign Currency Accounts, Phase 1: Account Registry
// ═══════════════════════════════════════════════════════════
// Foundation for tracking real foreign-currency cash/bank balances (e.g. a
// USD cash box or USD bank account alongside your base-currency ones) — a
// different problem from the AP/AR forex work: those track OPEN INVOICES,
// this tracks BALANCES YOU ACTUALLY HOLD, which shift in value just from
// holding them as rates move, even with zero new transactions.
//
// This patch is just the registry: create/list/delete named foreign
// accounts (e.g. "USD Cash Box"). Each one becomes its own real GL account
// name (existing reports — Balance Sheet, Trial Balance — will pick it up
// automatically once money actually flows through it, exactly like
// "Unrealized FX Gain" and every other new account name introduced by
// earlier patches; no special registration needed there).
//
// Stored via the SAME generic save/load mechanism patch-v7 already uses for
// Payroll Settings — no backend/database changes needed at all for this
// phase.
//
// NOT yet built (coming in later phases): actually routing money from Pay
// Supplier / Receive Payment / POS into one of these accounts, and revaluing
// their balances. This phase only lets you set up the accounts themselves.
// ═══════════════════════════════════════════════════════════

let FOREIGN_ACCOUNTS=[];
window.FOREIGN_ACCOUNTS=FOREIGN_ACCOUNTS;

async function loadForeignAccounts(){
  try{
    const r=await dbApi({action:'load',companyId:SESSION.companyId});
    const d=(r&&r.data)||{};
    FOREIGN_ACCOUNTS=Array.isArray(d.foreignAccounts)?d.foreignAccounts:[];
    window.FOREIGN_ACCOUNTS=FOREIGN_ACCOUNTS;
  }catch(e){console.error('loadForeignAccounts',e);}
}

async function saveForeignAccountsToServer(){
  await dbApi({action:'save',companyId:SESSION.companyId,key:'foreignAccounts',value:FOREIGN_ACCOUNTS});
}

// The GL account name each foreign account is posted under — kept distinct
// and predictable so reports show it clearly (e.g. "Bank Account (USD) — USD Wallet").
function foreignAccountGLName(acct){
  return `${acct.baseType} (${acct.currency}) — ${acct.name}`;
}

// Net foreign-currency balance for one account — sums the `foreignAmt` on
// every journal line that touches it. Returns 0 for a brand-new account
// with no transactions yet, which is correct.
function getForeignAccountBalance(acctId){
  const acct=FOREIGN_ACCOUNTS.find(a=>String(a.id)===String(acctId));
  if(!acct)return 0;
  const glName=foreignAccountGLName(acct);
  let bal=0;
  (DB.entries||[]).forEach(e=>{
    (e.debits||[]).forEach(l=>{if(l.acct===glName)bal+=(+l.foreignAmt||0);});
    (e.credits||[]).forEach(l=>{if(l.acct===glName)bal-=(+l.foreignAmt||0);});
  });
  return +bal.toFixed(2);
}

async function addForeignAccount(){
  const st=document.getElementById('fca-st');
  const nameEl=document.getElementById('fca-name'),curEl=document.getElementById('fca-currency'),typeEl=document.getElementById('fca-basetype');
  const name=(nameEl.value||'').trim(),currency=curEl.value,baseType=typeEl.value;
  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  if(!name){st.innerHTML='<span style="color:var(--red3)">Enter a name for this account</span>';return;}
  if(currency===base){st.innerHTML=`<span style="color:var(--red3)">Pick a currency other than your base currency (${base}) — otherwise it's not a foreign account.</span>`;return;}
  const id=Date.now();
  FOREIGN_ACCOUNTS.push({id,name,currency,baseType});
  await saveForeignAccountsToServer();
  nameEl.value='';
  st.innerHTML='<span style="color:var(--green3)">✅ Added</span>';
  renderForeignAccountsCard();
}

async function deleteForeignAccount(id){
  const acct=FOREIGN_ACCOUNTS.find(a=>String(a.id)===String(id));
  if(acct&&getForeignAccountBalance(id)!==0){
    if(!confirm(`${acct.name} still has a non-zero balance. Delete it anyway? (Past transactions will keep showing its name in reports — this only stops it appearing as a payment option.)`))return;
  }
  FOREIGN_ACCOUNTS=FOREIGN_ACCOUNTS.filter(a=>String(a.id)!==String(id));
  window.FOREIGN_ACCOUNTS=FOREIGN_ACCOUNTS;
  await saveForeignAccountsToServer();
  renderForeignAccountsCard();
}

function renderForeignAccountsCard(){
  const list=document.getElementById('fca-list');
  if(!list)return;
  if(!FOREIGN_ACCOUNTS.length){
    list.innerHTML='<div style="font-size:11px;color:var(--text3);padding:8px 0">No foreign-currency accounts yet.</div>';
  }else{
    list.innerHTML=FOREIGN_ACCOUNTS.map(a=>{
      const bal=getForeignAccountBalance(a.id);
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border2)">
        <div><div style="font-size:12px;color:var(--text)">${a.name}</div><div style="font-size:10px;color:var(--text3)">${a.baseType} · ${a.currency}</div></div>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--gold3)">${bal.toLocaleString()} ${a.currency}</div>
          <button class="btn btn-outline" style="font-size:10px;padding:3px 7px;color:var(--red3)" onclick="deleteForeignAccount(${a.id})">✕</button>
        </div>
      </div>`;
    }).join('');
  }
}

function injectForeignAccountsCard(){
  if(document.getElementById('fcaCard'))return;
  const cards=document.querySelectorAll('#pg-settings .card');
  for(const card of cards){
    const hdr=card.querySelector('.card-hdr');
    if(hdr&&hdr.textContent.includes('FX Revaluation')){
      const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
      const opts=(typeof CURRENCIES!=='undefined'?CURRENCIES:[]).filter(c=>c.code!==base).map(c=>`<option value="${c.code}">${c.code} — ${c.name}</option>`).join('');
      const div=document.createElement('div');
      div.id='fcaCard';
      div.className='card';
      div.innerHTML=`<div class="card-hdr">🌍 Foreign Currency Accounts</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:10px">Real cash or bank balances your business holds in a currency other than ${base}.</div>
        <div id="fca-list"></div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border2)">
          <div class="fg"><label>Account Name</label><input id="fca-name" type="text" placeholder="e.g. USD Cash Box"/></div>
          <div class="fg"><label>Type</label><select id="fca-basetype"><option value="Cash">Cash</option><option value="Bank Account">Bank Account</option><option value="Mobile Money">Mobile Money</option></select></div>
          <div class="fg"><label>Currency</label><select id="fca-currency">${opts}</select></div>
          <div id="fca-st" style="font-size:11px;margin:4px 0 8px"></div>
          <button class="btn btn-gold" onclick="addForeignAccount()">+ Add Account</button>
        </div>`;
      card.parentNode.insertBefore(div,card.nextSibling);
      break;
    }
  }
  renderForeignAccountsCard();
}

const _origEnterCompanyV27=window.enterCompany;
if(typeof _origEnterCompanyV27==='function'){
  window.enterCompany=async function(c){
    const result=await _origEnterCompanyV27(c);
    await loadForeignAccounts();
    return result;
  };
}
const _origNavV27=window.nav;
if(typeof _origNavV27==='function'){
  window.nav=async function(page,el){
    const result=await _origNavV27(page,el);
    if(page==='settings')injectForeignAccountsCard();
    return result;
  };
}

console.log('✅ patch-v27.js loaded — Foreign Currency Accounts registry ready in Settings');
