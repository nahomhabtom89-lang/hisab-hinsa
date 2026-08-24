// ═══════════════════════════════════════════════════════════
// PATCH v8 — Country → Currency at Registration
// ═══════════════════════════════════════════════════════════
// What this does:
// 1. Adds a "Country" picker to the Register form (shown alongside the existing
//    Construction/Retail mode picker).
// 2. Sends that country to the backend on register/createCompany, which resolves it
//    to the country's own currency and stores it as the company's local_currency —
//    instead of every new company always defaulting to SSP.
// 3. Also seeds Tax Settings with that same country immediately, so the Owner doesn't
//    have to separately pick their country again in Settings.
// 4. After login, automatically switches the topbar's currency view to the company's
//    own local currency (instead of always showing USD first) and prefills the
//    exchange rate from the live feed when one is available — so multi-currency
//    "just works" for a newly registered business without any manual Settings step.
//
// IMPORTANT — what does NOT change: the app's internal ledger is still always USD.
// Every journal entry, report, and stored total still posts in USD, exactly as before.
// This patch only changes which currency is auto-selected for VIEWING/ENTERING amounts
// day-to-day (the same thing the existing "Local Display Currency" Settings field already
// controlled) and does so automatically at registration instead of requiring a manual step.
// ═══════════════════════════════════════════════════════════

// Same country list/labels as the backend's COUNTRY_TAX_DEFAULTS (api/db.js), so the
// country picked at registration matches what later shows up pre-selected in Tax Settings.
const HH_COUNTRY_OPTIONS=[
  {code:'UG',label:'Uganda'},{code:'KE',label:'Kenya'},{code:'TZ',label:'Tanzania'},{code:'RW',label:'Rwanda'},
  {code:'SS',label:'South Sudan'},{code:'ET',label:'Ethiopia'},{code:'ZM',label:'Zambia'},{code:'NG',label:'Nigeria'},
  {code:'GH',label:'Ghana'},{code:'CI',label:"Côte d'Ivoire"},{code:'SN',label:'Senegal'},{code:'ZA',label:'South Africa'},
  {code:'BW',label:'Botswana'},{code:'NA',label:'Namibia'},{code:'ZW',label:'Zimbabwe'},{code:'EG',label:'Egypt'},
  {code:'MA',label:'Morocco'},{code:'TN',label:'Tunisia'},{code:'DZ',label:'Algeria'},{code:'GB',label:'United Kingdom'},
  {code:'DE',label:'Germany'},{code:'FR',label:'France'},{code:'IT',label:'Italy'},{code:'ES',label:'Spain'},
  {code:'NL',label:'Netherlands'},{code:'BE',label:'Belgium'},{code:'IE',label:'Ireland'},{code:'PT',label:'Portugal'},
  {code:'AT',label:'Austria'},{code:'SE',label:'Sweden'},{code:'DK',label:'Denmark'},{code:'NO',label:'Norway'},
  {code:'FI',label:'Finland'},{code:'CH',label:'Switzerland'},{code:'PL',label:'Poland'},{code:'CZ',label:'Czechia'},
  {code:'GR',label:'Greece'},{code:'RO',label:'Romania'},{code:'HU',label:'Hungary'},{code:'TR',label:'Turkey'},
  {code:'US',label:'United States'},{code:'CA',label:'Canada'},{code:'MX',label:'Mexico'},{code:'BR',label:'Brazil'},
  {code:'AR',label:'Argentina'},{code:'CL',label:'Chile'},{code:'CO',label:'Colombia'},{code:'PE',label:'Peru'},
  {code:'AE',label:'United Arab Emirates'},{code:'SA',label:'Saudi Arabia'},{code:'IL',label:'Israel'},{code:'QA',label:'Qatar'},
  {code:'JP',label:'Japan'},{code:'KR',label:'South Korea'},{code:'CN',label:'China'},{code:'IN',label:'India'},
  {code:'AU',label:'Australia'},{code:'NZ',label:'New Zealand'},{code:'SG',label:'Singapore'},{code:'ID',label:'Indonesia'},
  {code:'PH',label:'Philippines'},{code:'VN',label:'Vietnam'},{code:'TH',label:'Thailand'},{code:'PK',label:'Pakistan'},
  {code:'BD',label:'Bangladesh'},{code:'OTHER',label:"My country isn't listed"},
];
const HH_COUNTRY_CURRENCY={
  UG:'UGX',KE:'KES',TZ:'TZS',RW:'RWF',SS:'SSP',ET:'ETB',ZM:'ZMW',NG:'NGN',GH:'GHS',
  CI:'XOF',SN:'XOF',ZA:'ZAR',BW:'BWP',NA:'NAD',ZW:'ZWL',EG:'EGP',MA:'MAD',TN:'TND',DZ:'DZD',
  GB:'GBP',DE:'EUR',FR:'EUR',IT:'EUR',ES:'EUR',NL:'EUR',BE:'EUR',IE:'EUR',PT:'EUR',AT:'EUR',
  SE:'SEK',DK:'DKK',NO:'NOK',FI:'EUR',CH:'CHF',PL:'PLN',CZ:'CZK',GR:'EUR',RO:'RON',HU:'HUF',
  TR:'TRY',US:'USD',CA:'CAD',MX:'MXN',BR:'BRL',AR:'ARS',CL:'CLP',CO:'COP',PE:'PEN',
  AE:'AED',SA:'SAR',IL:'ILS',QA:'QAR',JP:'JPY',KR:'KRW',CN:'CNY',IN:'INR',AU:'AUD',NZ:'NZD',
  SG:'SGD',ID:'IDR',PH:'PHP',VN:'VND',TH:'THB',PK:'PKR',BD:'BDT',OTHER:'USD',
};
let REG_COUNTRY='OTHER';

// Reads the currently selected country and updates the small "your currency will be..."
// preview text under the dropdown. Also keeps REG_COUNTRY in sync.
function onRegCountryChange(){
  const sel=document.getElementById('regCountrySelect');if(!sel)return;
  REG_COUNTRY=sel.value;
  const cur=HH_COUNTRY_CURRENCY[REG_COUNTRY]||'USD';
  const info=(typeof CURRENCIES!=='undefined'?CURRENCIES.find(c=>c.code===cur):null)||{name:cur,symbol:''};
  const prev=document.getElementById('regCurrencyPreview');
  if(prev)prev.innerHTML=`💱 Your currency will be set to <strong>${cur}</strong> — ${info.name}. You can change this later in Settings.`;
}

// Injects the Country picker into the registration form, right after the existing
// Construction/Retail mode picker. Idempotent — safe to call every time toggleReg() runs.
const _origToggleRegV8=window.toggleReg;
if(typeof _origToggleRegV8==='function'){
  window.toggleReg=function(){
    const result=_origToggleRegV8();
    if(_isReg){
      const rf=document.getElementById('regFields');
      if(rf&&!document.getElementById('regCountryPicker')){
        const d=document.createElement('div');
        d.id='regCountryPicker';d.className='lf';d.style.marginBottom='13px';
        d.innerHTML=`<label>Country</label><select id="regCountrySelect" onchange="onRegCountryChange()" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:9px 11px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none">${HH_COUNTRY_OPTIONS.map(c=>`<option value="${c.code}" ${c.code===REG_COUNTRY?'selected':''}>${c.label}</option>`).join('')}</select><div id="regCurrencyPreview" style="font-size:10px;color:var(--text3);margin-top:6px"></div>`;
        const modePicker=document.getElementById('regModePicker');
        if(modePicker&&modePicker.parentNode===rf)modePicker.insertAdjacentElement('afterend',d);
        else rf.appendChild(d);
      }
      onRegCountryChange();
    }
    return result;
  };
}

// Injects the chosen country into the register/createCompany API calls. This is done at
// the dbApi() level (rather than rewriting doLogin/createCompany) so we don't have to
// reproduce their existing logic — much lower risk of breaking login/registration.
const _origDbApiV8=window.dbApi;
if(typeof _origDbApiV8==='function'){
  window.dbApi=function(body){
    if(body&&(body.action==='register'||body.action==='createCompany')&&!body.country){
      body.country=(typeof REG_COUNTRY!=='undefined'&&REG_COUNTRY)?REG_COUNTRY:'OTHER';
    }
    return _origDbApiV8(body);
  };
}

// After entering a company, make sure the local currency the backend picked (from the
// registration country) is actually reflected in the UI immediately:
//  - if no manual exchange rate was ever saved for this company, prefill SSP_RATE from the
//    live feed for its currency (this is what makes "multi-currency ... live rate" work
//    out of the box, without the Owner needing to click "Use Live Rate" in Settings first)
//  - switch the topbar currency view to the company's own currency instead of always USD
const _origEnterCompanyV8=window.enterCompany;
if(typeof _origEnterCompanyV8==='function'){
  window.enterCompany=async function(c){
    const result=await _origEnterCompanyV8(c);
    try{
      const raw=c.ssp_rate;
      const hasManualRate=raw!==null&&raw!==undefined&&raw!==''&&parseFloat(raw)>0;
      if(!hasManualRate&&LOCAL_CURRENCY&&LOCAL_CURRENCY!=='USD'){
        if(FX_RATES&&FX_RATES[LOCAL_CURRENCY]){
          SSP_RATE=FX_RATES[LOCAL_CURRENCY];
        }
      }
      if(LOCAL_CURRENCY&&LOCAL_CURRENCY!=='USD'&&typeof setCur==='function'){
        setCur(LOCAL_CURRENCY);
      }
    }catch(e){console.error('patch-v8 enterCompany currency setup',e);}
    return result;
  };
}

console.log('✅ patch-v8.js loaded — country-based currency at registration');
