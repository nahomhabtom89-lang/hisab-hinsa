// ═══════════════════════════════════════════════════════════
// PATCH v12 — Settings currency not applying to topbar, remaining home-page
// Tigrinya text, hardcoded USD in suggestion chips
// ═══════════════════════════════════════════════════════════
// Three separate leftover issues found from one screenshot:
//
// 1. THE MAIN BUG: saveSettings() updates the LOCAL_CURRENCY variable and saves
//    it to the backend, but never calls setCur() — so the topbar view (the CUR
//    variable, and the "USD $" / dropdown highlight) never actually switches to
//    match. This is why picking KES in Settings and hitting Save left "USD $"
//    still highlighted in the topbar: the dropdown option was updated, but the
//    active view wasn't. This bug pre-dates patch-v9 — it's not something the
//    base-currency change introduced, just something that became a lot more
//    noticeable now that currency is central to this app. Fixed by calling
//    setCur(LOCAL_CURRENCY) right after Settings saves.
//
// 2. The home page's voice/quick-entry box (the big input under "Record") still
//    had its original Tigrinya label and placeholder text — patch-v7's
//    fixStaticText() covered the login screen, company screen, topbar, and AI
//    Advisor greeting, but missed this one, which is arguably the highest-
//    visibility spot in the whole app since it's the first thing you see.
//
// 3. The example chips ("Paid rent 500 USD" etc, already fixed to English by
//    patch-v7) still hardcode the word USD inside the example amounts. Now that
//    a company's ledger may not be USD at all, these are corrected to name the
//    company's actual base currency instead.
// ═══════════════════════════════════════════════════════════

// ── Fix 1: Settings currency now actually switches the topbar view ─────────
const _origSaveSettingsV12=window.saveSettings;
if(typeof _origSaveSettingsV12==='function'){
  window.saveSettings=async function(){
    const result=await _origSaveSettingsV12();
    if(typeof LOCAL_CURRENCY!=='undefined'&&LOCAL_CURRENCY&&typeof setCur==='function'){
      setCur(LOCAL_CURRENCY);
    }
    return result;
  };
}

// ── Fix 2: remaining Tigrinya text on the home page's quick-entry box ──────
function fixHomeHeroText(){
  const lbl=document.querySelector('.hero-lbl');
  if(lbl){
    lbl.innerHTML='🎙️ What did you do today? <span style="font-size:10px;color:var(--text3)">(voice or text)</span>';
  }
  const inp=document.getElementById('mainInp');
  if(inp){
    const cur=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
    inp.placeholder=`Paid rent 500 ${cur} · used 15 bags cement · rent 1000 for 6 months...`;
  }
}
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',fixHomeHeroText);
}else{
  fixHomeHeroText();
}
const _origEnterCompanyV12=window.enterCompany;
if(typeof _origEnterCompanyV12==='function'){
  window.enterCompany=async function(c){
    const result=await _origEnterCompanyV12(c);
    fixHomeHeroText();
    return result;
  };
}

// ── Fix 3: suggestion chips name the company's real currency, not always USD ─
const _origRenderAllV12=window.renderAll;
if(typeof _origRenderAllV12==='function'){
  window.renderAll=function(){
    const result=_origRenderAllV12();
    const chips=document.querySelector('.chips');
    if(chips&&chips.innerHTML.includes('USD')){
      const cur=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
      if(cur!=='USD')chips.innerHTML=chips.innerHTML.split('USD').join(cur);
    }
    return result;
  };
}

console.log('✅ patch-v12.js loaded — Settings currency now applies to the topbar view');
