// ═══════════════════════════════════════════════════════════
// PATCH v15 — Forex Adjustments, Phase 1a: tag AP entries with original
// currency + rate (Receipt Intake & Deliveries)
// ═══════════════════════════════════════════════════════════
// This is groundwork for period-end forex revaluation. Right now, when a
// purchase is entered in a foreign currency, convertToUSD() converts it to
// the company's base currency once, at entry, and only the converted number
// is stored — the original currency and the rate used are thrown away
// immediately. Without that memory, there's no way to later ask "how much do
// we actually owe today, at today's rate, for this still-unpaid invoice?"
//
// This patch tags any journal entry that creates an Accounts Payable balance
// (i.e. the purchase was on credit, not paid immediately) with:
//   entry.fx = { currency, rate, originalAmount }
// where `rate` is "1 unit of that currency = ? units of the base currency"
// (the same cross-rate convertToUSD() computes internally), and
// `originalAmount` is the foreign-currency amount recovered from the stored
// base-currency amount. This lets a later revaluation report re-price the
// balance at today's rate and compare it to what was originally recorded.
//
// COVERS: Receive Stock (single/multi-item receipt intake) and Deliveries —
// both pick their currency in the same screen that posts the entry.
// DOES NOT YET COVER: Purchase Order receiving (retail or construction
// material POs). Those pick currency back at PO creation time, and that
// currency currently isn't saved with the PO at all — a separate, slightly
// bigger fix, coming in the next patch.
//
// If a purchase was paid immediately (Cash/Mobile Money/Bank, not credit),
// it's NOT tagged — it was settled at the same rate it was recorded at, so
// there's no open exposure and nothing to revalue.
// ═══════════════════════════════════════════════════════════

// "1 unit of fromCurrency = ? units of BASE_CURRENCY" — same cross-rate math
// convertToUSD() already uses internally, exposed here as its own function so
// both the tagging below and the later revaluation report can reuse it.
function fxCrossRate(fromCurrency){
  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  if(!fromCurrency||fromCurrency===base)return 1;
  const fromRate=getDisplayRate(fromCurrency);
  const baseRate=getDisplayRate(base);
  if(!fromRate||!baseRate)return null;
  return baseRate/fromRate;
}

// Looks at the most recently pushed journal entry; if it created an Accounts
// Payable balance AND was recorded in a currency other than the base
// currency, tags it with the fx info needed for later revaluation.
function tagLastEntryWithFx(currency){
  const base=(typeof BASE_CURRENCY!=='undefined'&&BASE_CURRENCY)?BASE_CURRENCY:'USD';
  if(!currency||currency===base)return; // already native, nothing to tag
  if(!DB||!DB.entries||!DB.entries.length)return;
  const entry=DB.entries[DB.entries.length-1];
  if(!entry||entry.fx)return; // nothing to tag, or already tagged
  const apLine=(entry.credits||[]).find(l=>l.acct==='Accounts Payable')
             ||(entry.debits||[]).find(l=>l.acct==='Accounts Payable');
  if(!apLine)return; // this entry didn't create an open AP balance — nothing to revalue
  const rate=fxCrossRate(currency);
  if(!rate)return; // unknown rate — same fallback as convertToUSD, can't tag reliably
  entry.fx={currency,rate,originalAmount:+(apLine.amt/rate).toFixed(4)};
  if(typeof saveData==='function')saveData();
}

// ── Receipt Intake (Receive Stock, single & multi-item) ────────────────────
const _origConfirmReceiptIntakeV15=window.confirmReceiptIntake;
if(typeof _origConfirmReceiptIntakeV15==='function'){
  window.confirmReceiptIntake=async function(){
    const cur=(document.getElementById('rs-review-currency')||{}).value
            ||(document.getElementById('si-currency')||{}).value||'USD';
    const result=await _origConfirmReceiptIntakeV15();
    tagLastEntryWithFx(cur);
    return result;
  };
}

// ── Deliveries (construction materials, manual intake) ─────────────────────
const _origConfirmMaterialsDeliveryV15=window.confirmMaterialsDelivery;
if(typeof _origConfirmMaterialsDeliveryV15==='function'){
  window.confirmMaterialsDelivery=async function(){
    const cur=(document.getElementById('del-currency')||{}).value||'USD';
    const result=await _origConfirmMaterialsDeliveryV15();
    tagLastEntryWithFx(cur);
    return result;
  };
}

console.log('✅ patch-v15.js loaded — AP entries from Receipt Intake & Deliveries now tagged with original currency + rate');
