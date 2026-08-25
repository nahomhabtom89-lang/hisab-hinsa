// ═══════════════════════════════════════════════════════════
// PATCH v11 — Fix stale "stored in USD internally" text in Settings
// ═══════════════════════════════════════════════════════════
// Same root cause as patch-v10: this text was written back when the ledger was
// ALWAYS USD, and was never updated after patch-v9 made it record in each
// company's own base currency instead. The blue info box under Settings >
// Multi-Currency still says "everything is still stored and posted in USD
// internally" even for a company whose base currency is now KES, UGX, etc.
//
// This patch finds that note (by locating the "Multi-Currency" settings card —
// there's only one, so this is a safe, stable way to target it without needing
// to add an id to index.html) and rewrites its wording to name the company's
// actual base currency, every time the Settings page is opened.
//
// For a company still on BASE_CURRENCY==='USD' (unmigrated / legacy), the note
// still correctly says USD — nothing changes for them.
// ═══════════════════════════════════════════════════════════

function updateMultiCurrencyNote(){
  const cards=document.querySelectorAll('#pg-settings .card');
  for(const card of cards){
    const hdr=card.querySelector('.card-hdr');
    if(hdr&&hdr.textContent.includes('Multi-Currency')){
      const body=card.querySelector('.alert.al-info .alert-body');
      if(body){
        const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
        body.innerHTML=`This is your currency for VIEWING totals in the topbar and for entering amounts elsewhere in your local currency (salaries, project values, etc.) — everything is actually stored and posted in <strong>${base}</strong> internally (this company's base currency, set once at registration and not changed here). Some currencies (notably SSP, and others that trade informally) aren't tracked by any live forex feed — for those, enter the rate manually and it will always be used instead of a live lookup.`;
      }
      break;
    }
  }
}

// Runs the update every time the Settings page is opened, alongside everything
// the original nav() function already does for that page.
const _origNavV11=window.nav;
if(typeof _origNavV11==='function'){
  window.nav=async function(page,el){
    const result=await _origNavV11(page,el);
    if(page==='settings')updateMultiCurrencyNote();
    return result;
  };
}

console.log('✅ patch-v11.js loaded — Settings note now names the real base currency');
