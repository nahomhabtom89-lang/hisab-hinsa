// ═══════════════════════════════════════════════════════════
// PATCH v66 — Fix: a cash-paid foreign-currency purchase never got its
// rate recorded at all (only credit/AP purchases did)
// ═══════════════════════════════════════════════════════════
// patch-v15's tagLastEntryWithFx(currency) is the one function that
// stamps entry.fx = {currency, rate, originalAmount} onto a just-posted
// purchase entry — used by Receipt Intake (AI review), Construction
// Deliveries, AND patch-v40's fix for manual Receive Stock. All three
// call it the same way, so it's the single right place to fix this.
//
// Its own logic (unchanged since patch-v15) explicitly requires an
// 'Accounts Payable' line to exist on the entry before it will tag
// anything:
//     const apLine = (entry.credits||[]).find(l=>l.acct==='Accounts Payable') || ...
//     if (!apLine) return; // this entry didn't create an open AP balance
// That's correct for its original purpose (AP revaluation needs an AP
// balance to revalue) — but it means a purchase invoiced in a foreign
// currency and paid with plain Cash (Invoice Currency ≠ base, Payment =
// "Cash", not a registered foreign account) gets NO fx tag at all: the
// rate is used once, inline, to convert the entered cost into base
// currency for the journal amount, and then it's gone — nothing on the
// entry records what the original foreign amount or rate actually was.
//
// That's exactly what surfaced in Purchase Returns: a return referencing
// such a purchase has no rate to fall back on, so the refund's FX
// gain/loss fields (added for exactly this scenario) never appear —
// they can't, there's nothing to compute them from.
//
// FIX: redefine tagLastEntryWithFx so it also accepts a plain 'Cash'
// credit line as something worth tagging, not just 'Accounts Payable'.
// Every other part of it — the base-currency check, the "already
// tagged" guard, the live-rate lookup — stays identical. This benefits
// all three callers at once, since they all just call the same function
// by name. Entries already posted before this patch still have nothing
// to tag (the data really is gone) — for those, patch-v64.js now offers
// a manual "I know the original rate" override right on the Purchase
// Return confirm panel.
// ═══════════════════════════════════════════════════════════

(function () {
  // Superset redefinition (assignment-style — safe to override per this
  // project's established rules, since tagLastEntryWithFx has no
  // internal bare self-reference to itself; every caller reaches it via
  // a dynamic bare lookup at call time, so they all pick this version up
  // automatically without needing any change on their end).
  window.tagLastEntryWithFx = function (currency) {
    const base = (typeof BASE_CURRENCY !== 'undefined' && BASE_CURRENCY) ? BASE_CURRENCY : 'USD';
    if (!currency || currency === base) return;
    if (!DB || !DB.entries || !DB.entries.length) return;
    const entry = DB.entries[DB.entries.length - 1];
    if (!entry || entry.fx) return; // nothing to tag, or already tagged
    const payLine = (entry.credits || []).find(function (l) { return l.acct === 'Accounts Payable' || l.acct === 'Cash' || l.acct === 'Mobile Money' || l.acct === 'Bank Account'; })
      || (entry.debits || []).find(function (l) { return l.acct === 'Accounts Payable'; });
    if (!payLine) return; // still nothing recognizable to tag (e.g. a registered foreign account, which already tags itself)
    const rate = (typeof fxCrossRate === 'function') ? fxCrossRate(currency) : null;
    if (!rate) return; // unknown rate — can't tag reliably, same as before
    entry.fx = { currency: currency, rate: rate, originalAmount: +(payLine.amt / rate).toFixed(4) };
    if (typeof saveData === 'function') saveData();
  };

  console.log('✅ patch-v66.js loaded — cash-paid foreign-currency purchases (Receive Stock, Receipt Intake, Construction Deliveries) now get their original rate recorded too, not just credit/AP ones');
})();
