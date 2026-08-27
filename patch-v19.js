// ═══════════════════════════════════════════════════════════
// PATCH v19 — Forex Adjustments, Stage 1: Open-Item Settlement Tracking
// ═══════════════════════════════════════════════════════════
// Before this patch, Accounts Payable was only ever tracked as one running
// net balance per supplier — there was no way to know which specific unpaid
// invoice a payment was actually settling, and no dedicated "pay a supplier"
// flow existed at all (the only way to record a payment was typing it into
// the freeform AI Record box, which doesn't even tag a supplier).
//
// This patch adds a proper "Pay Supplier" flow: click 💳 Pay next to a
// supplier, see their actual open invoices (oldest first) with how much is
// still owed on each, choose how much this payment applies to each one, and
// post it. The resulting payment entry is tagged with `settlements`, an
// array linking it to the specific invoice(s) it paid down and by how much.
//
// This is the foundation the actual forex revaluation report (coming next)
// needs: with this in place, "is this tagged invoice still open" becomes an
// exact answer instead of a supplier-level approximation.
//
// Payments are recorded in the company's base currency, same as everywhere
// else money changes hands in this app today — matching how Cash/Bank/Mobile
// Money entries already work.
// ═══════════════════════════════════════════════════════════

// ── Data helpers ─────────────────────────────────────────────────────────
// Sums every payment's settlement against a specific invoice entry, across
// the whole ledger — this is what "how much of invoice #57 has been paid"
// actually means now.
function getSettledAmountForInvoice(invoiceId){
  let total=0;
  (DB.entries||[]).forEach(e=>{
    if(!e.settlements)return;
    e.settlements.forEach(s=>{if(String(s.invoiceId)===String(invoiceId))total+=(+s.amount||0);});
  });
  return +total.toFixed(2);
}

// Every still-open (not fully settled) Accounts Payable entry for a supplier,
// oldest first — this is the actual open-items list, replacing the old
// "just look at the net balance" approximation.
function getOpenAPInvoices(supplierId){
  return (DB.entries||[])
    .filter(e=>e.party&&e.party.type==='supplier'&&String(e.party.id)===String(supplierId))
    .map(e=>{
      const apLine=(e.credits||[]).find(l=>l.acct==='Accounts Payable');
      if(!apLine)return null;
      const settled=getSettledAmountForInvoice(e.id);
      const remaining=+(apLine.amt-settled).toFixed(2);
      return{id:e.id,date:e.date,desc:e.desc,original:apLine.amt,settled,remaining,fx:e.fx||null};
    })
    .filter(x=>x&&x.remaining>0.01)
    .sort((a,b)=>a.date.localeCompare(b.date));
}

// ── Modal (created once, on first use — no index.html changes needed) ──────
function ensurePaySupplierModal(){
  if(document.getElementById('paySupplierModal'))return;
  const div=document.createElement('div');
  div.id='paySupplierModal';
  div.style.cssText='display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:5000;align-items:center;justify-content:center;padding:20px';
  div.innerHTML=`
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:20px;width:100%;max-width:520px;max-height:85vh;overflow-y:auto;box-shadow:var(--shadow)">
      <div id="ps-title" style="font-family:'Noto Sans Ethiopic',sans-serif;font-size:15px;font-weight:700;color:var(--text);margin-bottom:14px">💳 Pay Supplier</div>
      <div id="ps-invoices" style="margin-bottom:14px"></div>
      <div class="fg"><label>Total Payment Amount</label><input id="ps-total" type="text" readonly style="background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:9px 11px;font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--gold3);width:100%"/></div>
      <div class="fg"><label>Payment Method</label>
        <select id="ps-method" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:9px 11px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);outline:none">
          <option value="cash">Cash</option><option value="mobile">Mobile Money</option><option value="bank">Bank Account</option>
        </select>
      </div>
      <div class="fg"><label>Date</label><input id="ps-date" type="date"/></div>
      <div id="ps-st" style="font-size:11px;margin:4px 0 8px"></div>
      <div class="btn-row" style="margin-top:0">
        <button class="btn btn-gold" onclick="recordSupplierPayment()">✅ Record Payment</button>
        <button class="btn btn-outline" onclick="closePaySupplierModal()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(div);
}

let PS_SUPPLIER_ID=null;

function openPaySupplierModal(supplierId){
  ensurePaySupplierModal();
  PS_SUPPLIER_ID=supplierId;
  const supplier=(typeof SUPPLIERS!=='undefined'?SUPPLIERS:[]).find(s=>String(s.id)===String(supplierId));
  document.getElementById('ps-title').textContent=`💳 Pay ${supplier?supplier.name:'Supplier'}`;
  const open=getOpenAPInvoices(supplierId);
  const wrap=document.getElementById('ps-invoices');
  if(!open.length){
    wrap.innerHTML='<div style="text-align:center;padding:14px;color:var(--text3)">No open invoices for this supplier — nothing to pay.</div>';
  }else{
    wrap.innerHTML=`<table><thead><tr><th>Date</th><th>Description</th><th>Remaining</th><th>Apply</th></tr></thead><tbody>${
      open.map(inv=>`<tr>
        <td style="font-size:11px">${inv.date}</td>
        <td style="font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${inv.desc}">${inv.desc}${inv.fx?` <span class="tag t-blue" style="font-size:9px">${inv.fx.currency}</span>`:''}</td>
        <td style="font-family:'JetBrains Mono',monospace;color:var(--orange3)">${fc(inv.remaining)}</td>
        <td><input class="ps-apply-amt" data-invoice-id="${inv.id}" data-remaining="${inv.remaining}" type="number" step="0.01" value="${inv.remaining}" oninput="recalcPaySupplierTotal()" style="width:100px;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text)"/></td>
      </tr>`).join('')
    }</tbody></table>`;
  }
  document.getElementById('ps-date').value=today();
  document.getElementById('ps-st').textContent='';
  recalcPaySupplierTotal();
  document.getElementById('paySupplierModal').style.display='flex';
}

function closePaySupplierModal(){
  const m=document.getElementById('paySupplierModal');
  if(m)m.style.display='none';
  PS_SUPPLIER_ID=null;
}

function recalcPaySupplierTotal(){
  const inputs=Array.from(document.querySelectorAll('.ps-apply-amt'));
  const total=inputs.reduce((s,el)=>s+(parseFloat(el.value)||0),0);
  const totalEl=document.getElementById('ps-total');
  if(totalEl)totalEl.value=(typeof fc==='function'?fc(total):total.toFixed(2));
}

async function recordSupplierPayment(){
  const st=document.getElementById('ps-st');
  const supplierId=PS_SUPPLIER_ID;
  const supplier=(typeof SUPPLIERS!=='undefined'?SUPPLIERS:[]).find(s=>String(s.id)===String(supplierId));
  if(!supplier){st.innerHTML='<span style="color:var(--red3)">No supplier selected</span>';return;}
  const inputs=Array.from(document.querySelectorAll('.ps-apply-amt'));
  const settlements=[];
  let total=0;
  for(const el of inputs){
    const amt=parseFloat(el.value)||0;
    const remaining=parseFloat(el.dataset.remaining)||0;
    if(amt<=0)continue;
    if(amt>remaining+0.01){
      st.innerHTML=`<span style="color:var(--red3)">One invoice's applied amount (${fc(amt)}) is more than what's remaining (${fc(remaining)}).</span>`;
      return;
    }
    settlements.push({invoiceId:parseInt(el.dataset.invoiceId),amount:amt});
    total+=amt;
  }
  if(!settlements.length){st.innerHTML='<span style="color:var(--red3)">Enter at least one amount to apply</span>';return;}
  const method=(document.getElementById('ps-method')||{}).value||'cash';
  const date=(document.getElementById('ps-date')||{}).value||today();
  const payAcctMap={cash:'Cash',mobile:'Mobile Money',bank:'Bank Account'};
  const payAcct=payAcctMap[method]||'Cash';
  total=+total.toFixed(2);
  const entry={
    id:DB.nextId++,date,
    desc:`Payment to supplier: ${supplier.name}`,
    type:'Supplier Payment',amount:total,project:'',
    debits:[{acct:'Accounts Payable',amt:total,atype:'liability'}],
    credits:[{acct:payAcct,amt:total,atype:'asset'}],
    party:{type:'supplier',id:supplier.id,name:supplier.name},
    settlements
  };
  DB.entries.push(entry);
  await saveData();
  renderAll();
  if(typeof renderSupplierList==='function')renderSupplierList();
  closePaySupplierModal();
  if(typeof showToast==='function')showToast(`✅ Payment of ${fc(total)} recorded to ${supplier.name}`);
}

// ── Wire up the 💳 Pay button next to each supplier ─────────────────────
const _origRenderSupplierListV19=window.renderSupplierList;
if(typeof _origRenderSupplierListV19==='function'){
  window.renderSupplierList=function(){
    const result=_origRenderSupplierListV19();
    document.querySelectorAll('#supplierList [onclick^="togglePartyLedger(\'supplier\'"]').forEach(btn=>{
      if(btn.dataset.payBtnAdded)return;
      btn.dataset.payBtnAdded='1';
      const match=btn.getAttribute('onclick').match(/togglePartyLedger\('supplier',(\d+)\)/);
      if(!match)return;
      const supplierId=match[1];
      const payBtn=document.createElement('button');
      payBtn.className='btn btn-gold';
      payBtn.style.cssText='font-size:10px;padding:3px 7px;margin-right:4px';
      payBtn.textContent='💳 Pay';
      payBtn.onclick=()=>openPaySupplierModal(supplierId);
      btn.parentNode.insertBefore(payBtn,btn);
    });
    return result;
  };
}

console.log('✅ patch-v19.js loaded — Pay Supplier now links payments to specific open invoices');
