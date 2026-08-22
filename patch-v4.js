/* ============================================================================
   HISABI HENSI — PURCHASING & STOCK-RECEIVE LOGIC PATCH v4
   Fixes: payment method was silently defaulting to "Credit (Accounts Payable)"
   even for a receipt explicitly titled "CASH RECEIPT" with "PAYMENT METHOD:
   Cash / Mobile Money" printed on it.

   ROOT CAUSE: v2/v3 asked the AI to report a `paymentStatus` field in its JSON
   response and trusted that field directly. LLMs don't reliably populate every
   field in a large JSON schema every single time, even when instructed to —
   so when the AI's response omitted or didn't clearly set that field, the
   dropdown silently fell back to its first listed option ("Credit").

   FIX: detect payment method directly from the receipt's own extracted text,
   in your own code — not by trusting the AI's JSON. This is deterministic and
   can never silently default wrong. This runs as a client-side cross-check
   on top of (and now instead of relying solely on) the AI's own field.

   Loads AFTER patch-v2.js and patch-v3.js. Only re-overrides parseReceiptWithAI.
============================================================================ */
(function(){
'use strict';

// ── Deterministic payment-method detector, checked directly against the
// receipt's own OCR'd text. Priority order matters: the most explicit/specific
// signals are checked first, so an ambiguous combined line like
// "PAYMENT METHOD: Cash / Mobile Money" still resolves correctly when the
// document is clearly titled "CASH RECEIPT". ──────────────────────────────
function detectPaymentFromText(rawText){
  const t=(rawText||'');
  if(/\bon\s*account\b|\bcredit\b|\bnet\s*30\b|\binvoice\s*due\b|\bbalance\s*due\b|\bunpaid\b/i.test(t))return 'credit';
  if(/cash\s*receipt|paid\s*in\s*full|received\s*in\s*full|paid\s*by\s*card/i.test(t))return 'cash';
  if(/mobile\s*money|m[\s-]?pesa|mtn\s*money|airtel\s*money/i.test(t))return 'mobile';
  if(/bank\s*transfer|\beft\b|\bwire\s*transfer\b/i.test(t))return 'bank';
  if(/\bpaid\b|\bcash\b|\bcard\b/i.test(t))return 'cash';
  return null; // genuinely nothing found on the receipt — leave AI's guess or the safe "credit" default
}
window.detectPaymentFromText=detectPaymentFromText;

// ── Re-override parseReceiptWithAI: after getting the AI's JSON back, run
// the deterministic text-based detector and let it WIN over the AI's field
// whenever it finds a clear signal. This is the single insertion point —
// populateSingleIntakeForm, renderReceiptReviewTable, and confirmReceiptIntake
// (already fixed in v2/v3) all just read parsed.paymentStatus, so fixing it
// here is enough to fix both the single-item and multi-item screens. ───────
async function parseReceiptWithAI(rawText){
  try{
    const countryLabel=(TAX_COUNTRY_OPTIONS.find(c=>c.code===TAX_SETTINGS.country)||{}).label;
    const contextualPrompt=TAX_SETTINGS.is_vat_registered&&countryLabel
      ?RECEIPT_PARSE_PROMPT_V2+`\n\nContext: this business operates in ${countryLabel} and is VAT/GST-registered there. Classify each item's taxCategory using that country's typical exemption conventions where you're aware of them.`
      :RECEIPT_PARSE_PROMPT_V2;
    const res=await fetch('/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:rawText,systemPrompt:contextualPrompt})});
    const data=await res.json();
    const parsed=safeParseReceiptJson(data.result||'');
    if(!parsed||!Array.isArray(parsed.items)||!parsed.items.length){
      setRSReceiptStatus('⚠️ Could not find line items in that document — try manual entry instead.',true);
      return;
    }
    // Deterministic text-based detection wins whenever it finds a clear signal.
    const textDetected=detectPaymentFromText(rawText);
    if(textDetected)parsed.paymentStatus=textDetected;
    showReceiptReview(parsed);
  }catch(e){
    setRSReceiptStatus('❌ AI parsing failed: '+e.message,true);
  }
}
window.parseReceiptWithAI=parseReceiptWithAI;

console.log('✅ Hisabi Hensi patch v4 loaded — payment method is now detected directly from the receipt\'s own text instead of depending on the AI to reliably fill in a JSON field.');
})();
