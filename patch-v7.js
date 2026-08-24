/* ============================================================================
   HISABI HENSI — GLOBALIZATION & ACCESSIBILITY PATCH v7
   1. Removes hardcoded Uganda PAYE tax bands / NSSF rates — payroll tax is
      now configurable per company in Settings, defaulting to $0 until the
      Owner sets up rates for their own country.
   2. Sidebar navigation and home-page chips now show English-only labels
      instead of Tigrinya + English.
   3. Fixes a curated set of static Tigrinya text on the Login/Company
      screens, topbar brand, and AI Advisor's greeting message.
   4. Makes every clickable element in the app keyboard-accessible: many
      buttons in this app are <div onclick=...> instead of real <button>
      elements, which means a keyboard-only user could never Tab to them at
      all. This patch finds every such element (now and in the future, via
      a MutationObserver) and makes it focusable and operable with
      Enter/Space, with a visible focus ring.

   Loads AFTER patch-v2.js through patch-v6.js.
============================================================================ */
(function(){
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 1. CONFIGURABLE PAYROLL TAX (replaces hardcoded Uganda PAYE/NSSF)
// ═══════════════════════════════════════════════════════════════════════
// Stored the same way Tax Settings already are — via the generic save/load
// actions, under data_key 'payrollSettings'. No backend schema change needed.
let PAYROLL_SETTINGS={
  incomeTaxName:'Income Tax',
  incomeTaxBands:[], // [{upTo:Number, rate:Number(0-1)}] — empty = no tax until configured
  employeeContribName:'Employee Social Security',
  employeeContribRate:0, // 0-1
  employerContribName:'Employer Social Security',
  employerContribRate:0  // 0-1
};
window.PAYROLL_SETTINGS=PAYROLL_SETTINGS;

async function loadPayrollSettings(){
  try{
    const r=await dbApi({action:'load',companyId:SESSION.companyId});
    const d=(r&&r.data)||{};
    if(d.payrollSettings){
      window.PAYROLL_SETTINGS=Object.assign({},PAYROLL_SETTINGS,d.payrollSettings);
      PAYROLL_SETTINGS=window.PAYROLL_SETTINGS;
    }
  }catch(e){console.error('loadPayrollSettings',e);}
}
window.loadPayrollSettings=loadPayrollSettings;

async function savePayrollSettingsUI(){
  const st=document.getElementById('payrollSettingsSt');
  const bandsRaw=(document.getElementById('payrollBandsInput')||{}).value||'';
  // Format expected: one band per line, "upTo,ratePercent" e.g. "500,10" meaning up to 500 taxed at 10%.
  // Last line can use "Infinity,rate" or just leave upTo blank for the top band.
  const bands=bandsRaw.split('\n').map(l=>l.trim()).filter(Boolean).map(line=>{
    const parts=line.split(',');
    const upToRaw=(parts[0]||'').trim();
    const rateRaw=(parts[1]||'0').trim();
    const upTo=(!upToRaw||upToRaw.toLowerCase()==='infinity')?Infinity:parseFloat(upToRaw);
    const rate=(parseFloat(rateRaw)||0)/100;
    return{upTo,rate};
  }).filter(b=>!isNaN(b.upTo));
  const newSettings={
    incomeTaxName:(document.getElementById('payrollIncomeTaxName')||{}).value||'Income Tax',
    incomeTaxBands:bands,
    employeeContribName:(document.getElementById('payrollEmployeeContribName')||{}).value||'Employee Social Security',
    employeeContribRate:(parseFloat((document.getElementById('payrollEmployeeContribRate')||{}).value)||0)/100,
    employerContribName:(document.getElementById('payrollEmployerContribName')||{}).value||'Employer Social Security',
    employerContribRate:(parseFloat((document.getElementById('payrollEmployerContribRate')||{}).value)||0)/100
  };
  try{
    await dbApi({action:'save',companyId:SESSION.companyId,key:'payrollSettings',value:newSettings});
    window.PAYROLL_SETTINGS=newSettings;PAYROLL_SETTINGS=newSettings;
    if(st)st.innerHTML='<span style="color:var(--green3)">✅ Payroll settings saved</span>';
    showToast('✅ Payroll settings saved');
  }catch(e){
    if(st)st.innerHTML=`<span style="color:var(--red3)">❌ ${e.message}</span>`;
  }
  setTimeout(()=>{if(st)st.innerHTML='';},4000);
}
window.savePayrollSettingsUI=savePayrollSettingsUI;

function bandsToTextarea(bands){
  if(!bands||!bands.length)return '';
  return bands.map(b=>`${b.upTo===Infinity?'':b.upTo},${(b.rate*100).toFixed(2)}`).join('\n');
}

// Injects a Payroll Tax Settings card into the Settings page, right after the
// existing Tax Settings card if present, otherwise appended to the page.
function injectPayrollSettingsCard(){
  const page=document.getElementById('pg-settings');if(!page)return;
  if(document.getElementById('payrollSettingsCard'))return; // don't duplicate
  const card=document.createElement('div');
  card.className='card';card.id='payrollSettingsCard';
  card.innerHTML=`
    <div class="card-hdr">🧑‍💼 Payroll Tax Settings</div>
    <div class="alert al-info"><span class="alert-ico">ℹ️</span><div class="alert-body">This app doesn't assume any specific country's payroll tax rules. Configure your own income tax bands and statutory contribution rates here — leave them blank/zero if you don't need payroll tax calculated yet.</div></div>
    <div class="fgrid">
      <div class="fg"><label>Income Tax Name</label><input id="payrollIncomeTaxName" type="text" placeholder="Income Tax / PAYE / etc." value="${(PAYROLL_SETTINGS.incomeTaxName||'').replace(/"/g,'&quot;')}"/></div>
    </div>
    <div class="fg">
      <label>Income Tax Bands — one per line as "upper limit,rate %" (leave upper limit blank on the last line for "and above")</label>
      <textarea id="payrollBandsInput" rows="4" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:9px 11px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none" placeholder="500,0&#10;1000,10&#10;,20">${bandsToTextarea(PAYROLL_SETTINGS.incomeTaxBands)}</textarea>
    </div>
    <div class="fgrid">
      <div class="fg"><label>Employee Contribution Name</label><input id="payrollEmployeeContribName" type="text" placeholder="e.g. Social Security" value="${(PAYROLL_SETTINGS.employeeContribName||'').replace(/"/g,'&quot;')}"/></div>
      <div class="fg"><label>Employee Contribution Rate %</label><input id="payrollEmployeeContribRate" type="number" step="0.01" value="${(PAYROLL_SETTINGS.employeeContribRate*100)||0}"/></div>
      <div class="fg"><label>Employer Contribution Name</label><input id="payrollEmployerContribName" type="text" placeholder="e.g. Employer Social Security" value="${(PAYROLL_SETTINGS.employerContribName||'').replace(/"/g,'&quot;')}"/></div>
      <div class="fg"><label>Employer Contribution Rate %</label><input id="payrollEmployerContribRate" type="number" step="0.01" value="${(PAYROLL_SETTINGS.employerContribRate*100)||0}"/></div>
    </div>
    <div class="btn-row"><button class="btn btn-gold" onclick="savePayrollSettingsUI()">💾 Save Payroll Settings</button></div>
    <div id="payrollSettingsSt" style="font-size:11px;margin-top:7px"></div>
  `;
  page.appendChild(card);
}
window.injectPayrollSettingsCard=injectPayrollSettingsCard;

// ── Replace the hardcoded calculators with configurable ones ────────────────
function calcPAYE(gross){
  const bands=PAYROLL_SETTINGS.incomeTaxBands;
  if(!bands||!bands.length)return 0;
  let tax=0,prev=0;
  for(const b of bands){
    if(gross>prev){tax+=(Math.min(gross,b.upTo)-prev)*b.rate;prev=b.upTo;}
    else break;
  }
  return Math.round(tax*100)/100;
}
window.calcPAYE=calcPAYE;

function calcNSSF(gross){
  const empRate=PAYROLL_SETTINGS.employeeContribRate||0;
  const erRate=PAYROLL_SETTINGS.employerContribRate||0;
  return{employee:Math.round(gross*empRate*100)/100,employer:Math.round(gross*erRate*100)/100};
}
window.calcNSSF=calcNSSF;

// Load payroll settings whenever a company is entered, and inject the
// settings card whenever the Settings page is shown.
const _origEnterCompany=window.enterCompany;
if(typeof _origEnterCompany==='function'){
  window.enterCompany=async function(c){
    const result=await _origEnterCompany(c);
    await loadPayrollSettings();
    return result;
  };
}
const _origNavForPayroll=window.nav;
if(typeof _origNavForPayroll==='function'){
  window.nav=async function(page,el){
    const result=await _origNavForPayroll(page,el);
    if(page==='settings')injectPayrollSettingsCard();
    return result;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 2. ENGLISH-ONLY SIDEBAR NAVIGATION + HOME-PAGE CHIPS
// ═══════════════════════════════════════════════════════════════════════
const CONSTRUCTION_NAV_EN=[
  {section:'Daily',items:[{ico:'🎙️',en:'Record',page:'home'},{ico:'💵',en:'Petty Cash',page:'petty'},{ico:'📱',en:'Mobile Money',page:'mobilemoney'},{ico:'🧱',en:'Materials',page:'materials'},{ico:'🚚',en:'Deliveries',page:'deliveries'},{ico:'📑',en:'Purchase Orders',page:'materialpo'},{ico:'👷',en:'Workers',page:'workers'}]},
  {section:'Projects',items:[{ico:'🏗️',en:'Projects',page:'projects',badge:'projBadge'},{ico:'🧾',en:'Invoice',page:'invoice'},{ico:'🔒',en:'Retention',page:'retention'}]},
  {section:'Accounting',items:[{ico:'📋',en:'Chart of Accounts',page:'coa'},{ico:'👤',en:'Customers',page:'customers'},{ico:'🚚',en:'Suppliers',page:'suppliers'},{ico:'📒',en:'Journal',page:'journal',badge:'jBadge'},{ico:'📗',en:'Ledger',page:'ledger'},{ico:'⚖️',en:'Trial Balance',page:'trial'},{ico:'💰',en:'Income Statement',page:'income'},{ico:'🏛️',en:'Balance Sheet',page:'balance'},{ico:'📈',en:'Cash Forecast',page:'cashflow'},{ico:'🔢',en:'Job Costing',page:'jobcost'}]},
  {section:'Admin',items:[{ico:'📅',en:'Periods',page:'periods'},{ico:'🧾',en:'Tax Report',page:'taxreport'},{ico:'🤖',en:'AI Advisor',page:'advisor'},{ico:'🔍',en:'Audit',page:'audit',badge:'auditBadge'},{ico:'📉',en:'Depreciation',page:'depreciation'},{ico:'⚙️',en:'Settings',page:'settings'}]}
];
const RETAIL_NAV_EN=[
  {section:'Daily',items:[{ico:'🎙️',en:'Record',page:'home'}]},
  {section:'Retail',items:[{ico:'🖥️',en:'POS Register',page:'pos'},{ico:'📦',en:'Products',page:'products'},{ico:'📲',en:'Receive Stock',page:'stockin'},{ico:'🚚',en:'Purchase Orders',page:'purchaseorders'},{ico:'👷',en:'Workers',page:'workers'}]},
  {section:'Reports',items:[{ico:'💰',en:'Sales Report',page:'retailsales'},{ico:'📦',en:'Stock Valuation',page:'stockval'},{ico:'📒',en:'Journal',page:'journal',badge:'jBadge'},{ico:'⚖️',en:'Trial Balance',page:'trial'},{ico:'💰',en:'Income Statement',page:'income'},{ico:'🏛️',en:'Balance Sheet',page:'balance'}]},
  {section:'Admin',items:[{ico:'📋',en:'Chart of Accounts',page:'coa'},{ico:'👤',en:'Customers',page:'customers'},{ico:'🚚',en:'Suppliers',page:'suppliers'},{ico:'📅',en:'Periods',page:'periods'},{ico:'🧾',en:'Tax Report',page:'taxreport'},{ico:'🤖',en:'AI Advisor',page:'advisor'},{ico:'🔍',en:'Audit',page:'audit',badge:'auditBadge'},{ico:'📉',en:'Depreciation',page:'depreciation'},{ico:'⚙️',en:'Settings',page:'settings'}]}
];
window.CONSTRUCTION_NAV_EN=CONSTRUCTION_NAV_EN;
window.RETAIL_NAV_EN=RETAIL_NAV_EN;

function renderSidebar(mode){
  const sidebar=document.querySelector('.sidebar');if(!sidebar)return;
  const navDef=mode==='retail'?RETAIL_NAV_EN:CONSTRUCTION_NAV_EN;
  sidebar.innerHTML=navDef.map(section=>`<div class="sb-section"><div class="sb-label">${section.section}</div>${section.items.map(item=>`<div class="sb-item" id="sb-${item.page}" onclick="nav('${item.page}',this)"><span class="sb-ico">${item.ico}</span>${item.en}${item.badge?`<span class="sb-badge gold" id="${item.badge}">0</span>`:''}</div>`).join('')}</div>`).join('');
}
window.renderSidebar=renderSidebar;

// English-only home-page chip suggestions (wraps renderAll rather than
// reproducing it, so all of renderAll's other behavior stays exactly as-is).
const _origRenderAllForChips=window.renderAll;
if(typeof _origRenderAllForChips==='function'){
  window.renderAll=function(){
    const result=_origRenderAllForChips();
    const chips=document.querySelector('.chips');
    if(chips){
      chips.innerHTML=(typeof APP_MODE!=='undefined'&&APP_MODE==='retail')?
        `<div class="chip" onclick="useChip(this)">Received 50 bags sugar from supplier</div><div class="chip" onclick="useChip(this)">Paid rent 500 USD</div><div class="chip" onclick="useChip(this)">Paid staff wages 300 USD</div><div class="chip" onclick="useChip(this)">Owner deposited 1000 capital</div><div class="chip" onclick="useChip(this)">Paid electricity 80 USD</div>`:
        `<div class="chip" onclick="useChip(this)">Paid wages 500 USD</div><div class="chip" onclick="useChip(this)">Bought cement</div><div class="chip" onclick="useChip(this)">Bought fuel</div><div class="chip" onclick="useChip(this)">Client paid advance</div><div class="chip" onclick="useChip(this)">Paid rent 6 months advance</div>`;
    }
    return result;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 3. STATIC TEXT FIXES (login screen, company screen, topbar, AI greeting)
// ═══════════════════════════════════════════════════════════════════════
function fixStaticText(){
  // Login screen brand + labels
  const brandH1=document.querySelector('#loginScreen .login-brand h1');if(brandH1)brandH1.textContent='Hisabi Hensi';
  const brandSub=document.querySelector('#loginScreen .login-brand .sub');if(brandSub)brandSub.textContent='Business Accounting AI';
  const loginTitle=document.getElementById('loginTitle');if(loginTitle&&!loginTitle.dataset.userEdited)loginTitle.textContent='Login';
  const luLabel=document.querySelector('#lu')?.closest('.lf')?.querySelector('label');if(luLabel)luLabel.textContent='Username';
  const lpLabel=document.querySelector('#lp')?.closest('.lf')?.querySelector('label');if(lpLabel)lpLabel.textContent='Password';
  const lbLabel=document.querySelector('#lb')?.closest('.lf')?.querySelector('label');if(lbLabel)lbLabel.textContent='Company Name';
  const loginBtn=document.getElementById('loginBtn');if(loginBtn&&!loginBtn.dataset.userEdited)loginBtn.textContent='🔓 Login';
  const loginSwitch=document.querySelector('#loginScreen .login-switch');if(loginSwitch)loginSwitch.innerHTML=`New account? <a onclick="toggleReg()">Register</a>`;

  // Company selection screen
  const coBrandH1=document.querySelector('#companyScreen .login-brand h1');if(coBrandH1)coBrandH1.textContent='Hisabi Hensi';
  const coHeader=document.querySelector('#companyScreen .login-card h2');if(coHeader)coHeader.textContent='Choose Company';

  // Topbar brand
  document.querySelectorAll('.tb-brand').forEach(el=>{el.textContent='🏗️ Hisabi Hensi';});

  // AI Advisor initial greeting (only the very first static message, not any conversation history)
  const chatMsgs=document.getElementById('chatMsgs');
  if(chatMsgs&&chatMsgs.children.length===1){
    const firstMsg=chatMsgs.children[0];
    if(firstMsg&&firstMsg.classList.contains('ai')){
      firstMsg.textContent="Hello! I'm your AI accounting assistant. If I suggest a journal entry, an Apply button will appear.";
    }
  }
}
window.fixStaticText=fixStaticText;

// Run once at load, and again whenever the toggleReg/showCompanyScreen render new content.
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',fixStaticText);
}else{
  fixStaticText();
}
const _origToggleReg=window.toggleReg;
if(typeof _origToggleReg==='function'){
  window.toggleReg=function(){const r=_origToggleReg();fixStaticText();return r;};
}
const _origShowCompanyScreen=window.showCompanyScreen;
if(typeof _origShowCompanyScreen==='function'){
  window.showCompanyScreen=function(){const r=_origShowCompanyScreen();fixStaticText();return r;};
}
const _origEnterCompanyForText=window.enterCompany;
if(typeof _origEnterCompanyForText==='function'){
  window.enterCompany=async function(c){const r=await _origEnterCompanyForText(c);fixStaticText();return r;};
}

// ═══════════════════════════════════════════════════════════════════════
// 4. KEYBOARD ACCESSIBILITY — make every clickable element Tab-reachable
// ═══════════════════════════════════════════════════════════════════════
// Many buttons in this app are <div onclick=...> or <span onclick=...>
// instead of real <button> elements. Divs/spans are not in the natural Tab
// order and cannot be activated with Enter/Space by default — a
// keyboard-only user could never reach them. This makes every such element
// focusable and operable with Enter/Space, and adds a visible focus ring.
const NATURALLY_FOCUSABLE=new Set(['BUTTON','A','INPUT','SELECT','TEXTAREA']);

function makeKeyboardAccessible(el){
  if(!el||el.dataset.kbFixed)return;
  if(NATURALLY_FOCUSABLE.has(el.tagName))return;
  if(!el.hasAttribute('onclick'))return;
  el.dataset.kbFixed='1';
  if(!el.hasAttribute('tabindex'))el.setAttribute('tabindex','0');
  if(!el.hasAttribute('role'))el.setAttribute('role','button');
  el.addEventListener('keydown',function(e){
    if(e.key==='Enter'||e.key===' '||e.key==='Spacebar'){
      e.preventDefault();
      el.click();
    }
  });
}

function sweepForKeyboardAccessibility(root){
  (root||document).querySelectorAll('[onclick]').forEach(makeKeyboardAccessible);
}

// Initial sweep
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',()=>sweepForKeyboardAccessibility(document));
}else{
  sweepForKeyboardAccessibility(document);
}

// Keep sweeping as the app dynamically creates new content (sidebar re-render,
// page navigation, modals, POS grid, receipt review rows, etc.) — this means
// every current AND future onclick element gets fixed automatically, with no
// need to hunt down and patch each render function individually.
const _kbObserver=new MutationObserver((mutations)=>{
  for(const m of mutations){
    m.addedNodes.forEach(node=>{
      if(node.nodeType!==1)return; // only element nodes
      if(node.hasAttribute&&node.hasAttribute('onclick'))makeKeyboardAccessible(node);
      if(node.querySelectorAll)sweepForKeyboardAccessibility(node);
    });
  }
});
_kbObserver.observe(document.body,{childList:true,subtree:true});

// Visible focus ring — dark theme + custom components can make the browser's
// default focus outline hard to see; make it clearly visible and on-brand.
const focusStyle=document.createElement('style');
focusStyle.textContent=`
  [tabindex]:focus-visible, button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--gold2, #e0b84a) !important;
    outline-offset: 2px !important;
  }
`;
document.head.appendChild(focusStyle);

console.log('✅ Hisabi Hensi patch v7 loaded — payroll tax is now configurable (Settings → Payroll Tax Settings) instead of hardcoded to Uganda, sidebar/chips are English-only, static Tigrinya text is replaced, and every clickable element is now keyboard-accessible (Tab + Enter/Space).');
})();
