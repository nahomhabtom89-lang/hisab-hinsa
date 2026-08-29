// ═══════════════════════════════════════════════════════════
// PATCH v22 — FX Exposure KPI card on the home dashboard
// ═══════════════════════════════════════════════════════════
// Adds a quick "FX Exposure" card next to Sales/Cash/Payables/etc on the home
// dashboard, showing the current net unrealized gain/loss across all open
// foreign-currency invoices — reusing computeFxRevaluation() from patch-v20,
// which is a pure read (no side effects, doesn't post or change anything).
// Clicking the card opens the full FX Revaluation report for the breakdown.
//
// Only appears when there's actually at least one open foreign-currency
// invoice being tracked — companies with no foreign-currency exposure don't
// see an extra, empty card cluttering their dashboard.
// ═══════════════════════════════════════════════════════════

const _origRenderHomeKpisV22=window.renderHomeKpis;
if(typeof _origRenderHomeKpisV22==='function'){
  window.renderHomeKpis=function(){
    const result=_origRenderHomeKpisV22();
    try{
      const el=document.getElementById('homeKpis');
      const existing=document.getElementById('fxExposureKpi');
      if(existing)existing.remove();
      if(el&&typeof computeFxRevaluation==='function'){
        const{rows,total}=computeFxRevaluation();
        if(rows.length){
          const isLoss=total>0.01;
          const isGain=total<-0.01;
          const card=document.createElement('div');
          card.className='kpi';
          card.id='fxExposureKpi';
          card.style.cursor='pointer';
          card.title="Click to open the FX Revaluation report";
          card.onclick=function(){if(typeof openFxRevaluationModal==='function')openFxRevaluationModal();};
          const display=(!isLoss&&!isGain)?'—':(isLoss?'-':'+')+fc(Math.abs(total));
          card.innerHTML=`<div class="kpi-lbl">FX Exposure</div><div class="kpi-val ${isLoss?'neg':isGain?'pos':''}">${display}</div>`;
          el.appendChild(card);
        }
      }
    }catch(e){console.error('patch-v22 fx exposure kpi',e);}
    return result;
  };
}

console.log('✅ patch-v22.js loaded — FX Exposure card added to home dashboard');
