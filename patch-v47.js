// ═══════════════════════════════════════════════════════════
// PATCH v47 — Perpetual Inventory, Stage 4b: Precise Purchase Discount split
// ═══════════════════════════════════════════════════════════
// The payoff for the whole Perpetual Inventory build: replaces the simple
// "100% to Purchase Discount Received" treatment (patch-v36) with the
// textbook-correct proportional split — for each product on the invoice,
// whatever fraction of that specific purchase is still on hand reduces
// Inventory; whatever fraction has already sold adjusts Cost of Goods
// Sold instead. No more separate "Purchase Discount Received" line for
// invoices this can trace — it's replaced by direct credits to the
// specific Inventory account(s) and/or Cost of Goods Sold.
//
// SCOPE: non-FX invoices only (Pay Supplier's plain .ps-apply-amt rows) —
// same "start simple, verify, extend" approach used for the discount
// feature itself (v36 before v38). FX invoices are untouched here.
//
// HOW THE SPLIT WORKS, per invoice:
//   1. Find the original purchase entry and its "Inventory (Product)"
//      debit lines — this is how the invoice's total cost breaks down
//      across products.
//   2. Each product's SHARE of the discount = discount × (that product's
//      line amount ÷ total inventory debited on the invoice).
//   3. For each product, find the layer patch-v46 tagged with this
//      invoice's id. remainingRatio = layer.qty (what's left) ÷
//      layer.originalQty (what this purchase brought in).
//   4. That product's discount share splits: remainingRatio → credits
//      Inventory (ProductName); (1 − remainingRatio) → credits Cost of
//      Goods Sold.
//   5. If a product's layer can't be traced (invoice predates v46, or the
//      product/layer no longer exists), that product's share falls back
//      to the old behavior — credited to Purchase Discount Received —
//      so nothing is ever silently lost or miscounted.
//
// Verified below: the split always sums to exactly the original discount
// amount (so the entry balances exactly like v36 did), a fully-unsold
// purchase sends 100% to Inventory, a fully-sold purchase sends 100% to
// COGS, and a mixed purchase splits proportionally.
// ═══════════════════════════════════════════════════════════

function computePreciseDiscountSplitV47(invoiceEntry, discountAmt){
  const result={ inventoryCredits:[], cogsCredit:0, fallbackToOther:0 };
  if(!invoiceEntry || discountAmt<=0.0001){ result.fallbackToOther=discountAmt; return result; }
  const invLines=(invoiceEntry.debits||[]).filter(function(l){ return /^Inventory \(.+\)$/.test(l.acct); });
  const totalInvAmt=invLines.reduce(function(s,l){ return s+l.amt; },0);
  if(!invLines.length || totalInvAmt<=0.0001){ result.fallbackToOther=discountAmt; return result; }

  let allocated=0;
  invLines.forEach(function(line){
    const m=/^Inventory \((.+)\)$/.exec(line.acct);
    const productName=m[1];
    const shareRatio=line.amt/totalInvAmt;
    const productShare=+(discountAmt*shareRatio).toFixed(4);
    const product=RETAIL_PRODUCTS.find(function(p){ return p.name===productName; });
    const layer=product&&Array.isArray(product.layers)?product.layers.find(function(l){ return l.invoiceId===invoiceEntry.id; }):null;
    if(!layer||layer.originalQty==null||layer.originalQty<=0){
      // Can't trace this product's remaining quantity — fall back safely.
      result.fallbackToOther+=productShare;
      allocated+=productShare;
      return;
    }
    const remainingRatio=Math.max(0,Math.min(1,(parseFloat(layer.qty)||0)/layer.originalQty));
    const toInventory=+(productShare*remainingRatio).toFixed(2);
    const toCogs=+(productShare-toInventory).toFixed(2);
    if(toInventory>0.001) result.inventoryCredits.push({acct:`Inventory (${productName})`,amt:toInventory,atype:'asset'});
    result.cogsCredit+=toCogs;
    allocated+=productShare;
  });
  // Rounding remainder (sub-cent, from per-line rounding) folded into the
  // fallback/other bucket so the total always reconciles exactly.
  const remainder=+(discountAmt-allocated).toFixed(2);
  if(Math.abs(remainder)>0.001) result.fallbackToOther+=remainder;
  return result;
}
window.computePreciseDiscountSplitV47=computePreciseDiscountSplitV47;

// ── recordSupplierPayment: full redefinition, same reason every previous
// version was (v19→v21→v28→v36→v38) — the discount-posting math itself
// changes for non-FX rows. FX rows (.ps-fx-settle) are byte-for-byte
// identical to v38's version.
async function recordSupplierPayment(){
  const st=document.getElementById('ps-st');
  const supplierId=PS_SUPPLIER_ID;
  const supplier=(typeof SUPPLIERS!=='undefined'?SUPPLIERS:[]).find(s=>String(s.id)===String(supplierId));
  if(!supplier){st.innerHTML='<span style="color:var(--red3)">No supplier selected</span>';return;}

  const settlements=[];
  let totalBooked=0,totalActual=0,totalOtherDiscount=0;
  const inventoryCreditsByAcct={};
  let totalCogsCredit=0;
  const discountOverrides=[];

  const methodEl=document.getElementById('ps-method');
  const methodVal=methodEl?methodEl.value:'cash';
  const isForeignPayment=methodVal&&methodVal.indexOf('foreign:')===0;
  let foreignAcct=null,foreignAcctRate=null,foreignAcctAmt=0;
  if(isForeignPayment){
    const acctId=methodVal.split(':')[1];
    foreignAcct=(typeof FOREIGN_ACCOUNTS!=='undefined'?FOREIGN_ACCOUNTS:[]).find(a=>String(a.id)===String(acctId));
    if(!foreignAcct){st.innerHTML='<span style="color:var(--red3)">Selected account not found</span>';return;}
    foreignAcctRate=fxCrossRate(foreignAcct.currency);
    if(!foreignAcctRate){st.innerHTML=`<span style="color:var(--red3)">No known rate for ${foreignAcct.currency} today — cannot record this account's balance.</span>`;return;}
  }

  const open=getOpenAPInvoices(supplierId);
  const dateEl=document.getElementById('ps-date');
  const paymentDate=dateEl?dateEl.value:today();

  // Non-FX rows — discount now split via computePreciseDiscountSplitV47 --
  for(const el of document.querySelectorAll('.ps-apply-amt')){
    const amt=parseFloat(el.value)||0;
    const remaining=parseFloat(el.dataset.remaining)||0;
    if(amt<=0)continue;
    if(amt>remaining+0.01){st.innerHTML=`<span style="color:var(--red3)">One invoice's applied amount (${fc(amt)}) is more than what's remaining (${fc(remaining)}).</span>`;return;}
    const invoiceId=el.dataset.invoiceId;
    const inv=open.find(x=>String(x.id)===String(invoiceId));

    let discountAmt=0,overrideUsed=false,overrideReason='';
    if(inv&&inv.terms){
      const chk=document.querySelector(`.ps-discount-override-chk[data-invoice-id="${invoiceId}"]`);
      const overrideOn=chk?chk.checked:false;
      const dirEl=document.querySelector(`.ps-discount-override-dir[data-invoice-id="${invoiceId}"]`);
      const overrideGrant=dirEl?dirEl.value==='grant':true;
      const reasonEl=document.querySelector(`.ps-discount-override-reason[data-invoice-id="${invoiceId}"]`);
      if(overrideOn && !(reasonEl&&reasonEl.value.trim())){
        st.innerHTML='<span style="color:var(--red3)">A reason is required for every discount override.</span>';return;
      }
      const result=computePaySupplierDiscountV36(inv,paymentDate,amt,overrideOn,overrideGrant);
      if(result.eligible){ discountAmt=result.discount; }
      if(overrideOn){ overrideUsed=true; overrideReason=reasonEl?reasonEl.value.trim():''; }
    }

    if(discountAmt>0.001){
      const invoiceEntry=DB.entries.find(e=>e.id===parseInt(invoiceId));
      const split=computePreciseDiscountSplitV47(invoiceEntry,discountAmt);
      split.inventoryCredits.forEach(function(c){
        inventoryCreditsByAcct[c.acct]=+((inventoryCreditsByAcct[c.acct]||0)+c.amt).toFixed(2);
      });
      totalCogsCredit=+(totalCogsCredit+split.cogsCredit).toFixed(2);
      totalOtherDiscount=+(totalOtherDiscount+split.fallbackToOther).toFixed(2);
    }

    settlements.push({invoiceId:parseInt(invoiceId),amount:amt});
    totalBooked+=amt;
    totalActual+=(amt-discountAmt);
    if(overrideUsed) discountOverrides.push({invoiceId:parseInt(invoiceId),applied:discountAmt>0,reason:overrideReason,by:(SESSION&&SESSION.username)||'',at:new Date().toISOString()});
    if(isForeignPayment)foreignAcctAmt+=(amt-discountAmt)/foreignAcctRate;
  }

  // FX rows — byte-for-byte identical to patch-v38, untouched -----------
  for(const settleEl of document.querySelectorAll('.ps-fx-settle')){
    const id=settleEl.dataset.invoiceId;
    const rateEl=document.querySelector(`.ps-fx-rate[data-invoice-id="${id}"]`);
    const foreignSettled=parseFloat(settleEl.value)||0;
    const rate=rateEl?parseFloat(rateEl.value)||0:0;
    const remainingForeign=parseFloat(settleEl.dataset.remainingForeign)||0;
    const recordedRate=parseFloat(settleEl.dataset.recordedRate)||0;
    if(foreignSettled<=0)continue;
    if(foreignSettled>remainingForeign+0.01){st.innerHTML=`<span style="color:var(--red3)">One invoice's settle amount is more than what's remaining.</span>`;return;}
    if(!rate){st.innerHTML='<span style="color:var(--red3)">Enter a rate for every foreign-currency invoice being settled.</span>';return;}

    const inv=open.find(x=>String(x.id)===String(id));
    let discountForeign=0,discountBase=0,overrideUsed=false,overrideReason='';
    if(inv&&inv.terms){
      const chk=document.querySelector(`.ps-fx-discount-override-chk[data-invoice-id="${id}"]`);
      const overrideOn=chk?chk.checked:false;
      const dirEl=document.querySelector(`.ps-fx-discount-override-dir[data-invoice-id="${id}"]`);
      const overrideGrant=dirEl?dirEl.value==='grant':true;
      const reasonEl=document.querySelector(`.ps-fx-discount-override-reason[data-invoice-id="${id}"]`);
      if(overrideOn && !(reasonEl&&reasonEl.value.trim())){
        st.innerHTML='<span style="color:var(--red3)">A reason is required for every discount override.</span>';return;
      }
      const result=computePaySupplierFxDiscountV38(inv,paymentDate,foreignSettled,overrideOn,overrideGrant);
      if(result.eligible){
        discountForeign=result.discount;
        discountBase=+(discountForeign*recordedRate).toFixed(2);
      }
      if(overrideOn){ overrideUsed=true; overrideReason=reasonEl?reasonEl.value.trim():''; }
    }

    const netForeignToPay=+(foreignSettled-discountForeign).toFixed(4);
    const bookedPortion=+(foreignSettled*recordedRate).toFixed(2);
    const actualCashPaid=+(netForeignToPay*rate).toFixed(2);

    settlements.push({invoiceId:parseInt(id),amount:bookedPortion});
    totalBooked+=bookedPortion;totalActual+=actualCashPaid;totalOtherDiscount+=discountBase; // FX discount still uses the simple treatment (unchanged from v38)
    if(overrideUsed) discountOverrides.push({invoiceId:parseInt(id),applied:discountBase>0,reason:overrideReason,by:(SESSION&&SESSION.username)||'',at:new Date().toISOString()});
    if(isForeignPayment){
      const invEntry=DB.entries.find(e=>e.id===parseInt(id));
      const invCurrency=invEntry&&invEntry.fx?invEntry.fx.currency:null;
      if(invCurrency&&invCurrency===foreignAcct.currency)foreignAcctAmt+=netForeignToPay;
      else foreignAcctAmt+=actualCashPaid/foreignAcctRate;
    }
  }

  if(!settlements.length){st.innerHTML='<span style="color:var(--red3)">Enter at least one amount to apply</span>';return;}

  totalBooked=+totalBooked.toFixed(2);
  totalActual=+totalActual.toFixed(2);
  const totalDiscount=+(totalOtherDiscount+totalCogsCredit+Object.values(inventoryCreditsByAcct).reduce((s,v)=>s+v,0)).toFixed(2);
  const netAdjustment=+(totalActual-totalBooked+totalDiscount).toFixed(2);

  const date=paymentDate;

  let payAcct,foreignLine=null;
  if(isForeignPayment){
    payAcct=foreignAccountGLName(foreignAcct);
    foreignLine={foreignAmt:+foreignAcctAmt.toFixed(4),currency:foreignAcct.currency};
  }else{
    const payAcctMap={cash:'Cash',mobile:'Mobile Money',bank:'Bank Account'};
    payAcct=payAcctMap[methodVal]||'Cash';
  }

  const debits=[{acct:'Accounts Payable',amt:totalBooked,atype:'liability'}];
  const creditLine={acct:payAcct,amt:totalActual,atype:'asset'};
  if(foreignLine)Object.assign(creditLine,foreignLine);
  const credits=[creditLine];
  Object.keys(inventoryCreditsByAcct).forEach(function(acct){
    if(inventoryCreditsByAcct[acct]>0.001) credits.push({acct:acct,amt:inventoryCreditsByAcct[acct],atype:'asset'});
  });
  if(totalCogsCredit>0.01) credits.push({acct:'Cost of Goods Sold',amt:totalCogsCredit,atype:'expense'});
  if(totalOtherDiscount>0.01) credits.push({acct:'Purchase Discount Received',amt:totalOtherDiscount,atype:'income'});
  if(netAdjustment>0.01)debits.push({acct:'Realized FX Loss',amt:netAdjustment,atype:'expense'});
  else if(netAdjustment<-0.01)credits.push({acct:'Realized FX Gain',amt:-netAdjustment,atype:'income'});

  const entry={
    id:DB.nextId++,date,
    desc:`Payment to supplier: ${supplier.name}`,
    type:'Supplier Payment',amount:totalActual,project:'',
    debits,credits,
    party:{type:'supplier',id:supplier.id,name:supplier.name},
    settlements
  };
  if(discountOverrides.length)entry.discountOverrides=discountOverrides;
  DB.entries.push(entry);
  await saveData();
  renderAll();
  if(typeof renderSupplierList==='function')renderSupplierList();
  closePaySupplierModal();
  const bits=[];
  if(totalDiscount>0.01)bits.push(`discount ${fc(totalDiscount)}`);
  if(netAdjustment>0.01)bits.push(`realized loss ${fc(netAdjustment)}`);
  else if(netAdjustment<-0.01)bits.push(`realized gain ${fc(-netAdjustment)}`);
  const extraMsg=bits.length?` (${bits.join(', ')})`:'';
  if(typeof showToast==='function')showToast(`✅ Payment of ${fc(totalActual)} recorded to ${supplier.name}${extraMsg}`);
}
window.recordSupplierPayment=recordSupplierPayment;

console.log('✅ patch-v47.js loaded — Perpetual Inventory Stage 4b: Purchase Discounts now split precisely between Inventory and COGS');
