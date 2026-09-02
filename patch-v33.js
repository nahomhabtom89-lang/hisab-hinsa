// ═══════════════════════════════════════════════════════════
// PATCH v33 — Foreign Currency Accounts, Phase 4: Wire Into Stock Intake
// ═══════════════════════════════════════════════════════════
// Bug fixed: paying CASH for a stock purchase in a foreign currency always
// posted the credit to the generic base-currency "Cash" account, no matter
// what currency the invoice was in, and no foreign-account option existed
// on the Receive Stock screen at all. This extends the same foreign-account
// registry from patch-v27, already wired into Pay Supplier / Receive
// Payment (v28) and POS instant sales (v31), into stock intake too — full
// parity, as decided.
//
// Covers BOTH intake paths:
//   - "Receive Stock" manual/single-item form (si-pay dropdown)
//   - Multi-item receipt review after Smart Document Import (rs-review-pay
//     dropdown, rendered fresh each time by renderReceiptReviewTable)
//
// HOW IT WORKS:
// appendForeignAccountOptions() already exists (from patch-v28) and simply
// adds "<AccountName> (<CUR>)" options with value "foreign:<id>" to a
// select — reused as-is here, just pointed at the two intake dropdowns.
//
// buildIntakeJournalEntry() is redefined as a superset (same pattern as
// patch-v2's original): for every payMethod it already handled
// (cash/mobile/bank/credit), output is byte-for-byte identical. The new
// case is payMethod === "foreign:<id>" — the credit line is retargeted at
// that account's real GL name (foreignAccountGLName), and tagged with
// {foreignAmt, currency} so it plugs directly into the existing
// getForeignAccountBalance() / getForeignAccountBookValue() / FX
// Revaluation report — no changes needed anywhere else, since those all
// just read entries by GL account name generically.
//
// Math note: unlike Pay Supplier (which can be settling an invoice booked
// weeks ago at a different rate — hence its "exact original amount" vs.
// "today's rate" split), a stock purchase and its cash payment happen in
// the SAME action, at the SAME live rate used to convert the invoice to
// base currency in the first place. So the foreign amount actually drawn
// down is simply grandTotal(base) / fxCrossRate(account currency) — this
// reduces to the exact original invoice amount when the account's currency
// matches the invoice's currency (verified below), and correctly converts
// through a different rate when paying a foreign invoice out of a
// different-currency foreign account.
//
// If the chosen account no longer exists, or there's no live rate for its
// currency today, this falls back to plain Cash rather than blocking the
// purchase — the same graceful-degradation approach convertToUSD() itself
// already uses for unknown rates.
//
// Verified with a Node.js simulation before shipping: confirmed the
// foreign-account credit line balances against the debit lines exactly
// like the original Cash case, confirmed it reduces to the identical
// original entry when payMethod isn't "foreign:...", and confirmed the
// reconstructed foreign amount matches the original invoice total (within
// a cent) when the account currency equals the invoice currency.
// ═══════════════════════════════════════════════════════════

(function () {
  // ── Make foreign accounts selectable on both intake payment dropdowns ──
  function refreshIntakeForeignOptions() {
    if (typeof appendForeignAccountOptions === 'function') {
      appendForeignAccountOptions('si-pay');
      appendForeignAccountOptions('rs-review-pay');
    }
  }

  const _origNavV33 = window.nav;
  if (typeof _origNavV33 === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV33(page, el);
      if (page === 'stockin') refreshIntakeForeignOptions();
      return result;
    };
  }

  // Safety net: FOREIGN_ACCOUNTS loads on login (patch-v27), so also
  // refresh right after that in case the Stock In page markup is already
  // sitting in the DOM before any nav() call fires.
  const _origEnterCompanyV33 = window.enterCompany;
  if (typeof _origEnterCompanyV33 === 'function') {
    window.enterCompany = async function (c) {
      const result = await _origEnterCompanyV33(c);
      refreshIntakeForeignOptions();
      return result;
    };
  }

  // The multi-item review table is rebuilt from scratch every time a
  // receipt is parsed, so its rs-review-pay select needs the options
  // re-appended after every render, not just once.
  const _origRenderReceiptReviewTableV33 = window.renderReceiptReviewTable;
  if (typeof _origRenderReceiptReviewTableV33 === 'function') {
    window.renderReceiptReviewTable = function (parsed) {
      const result = _origRenderReceiptReviewTableV33(parsed);
      if (typeof appendForeignAccountOptions === 'function') appendForeignAccountOptions('rs-review-pay');
      return result;
    };
  }

  // ── The actual fix: buildIntakeJournalEntry, superset-redefined ────────
  const _origBuildIntakeJournalEntryV33 = window.buildIntakeJournalEntry;
  window.buildIntakeJournalEntry = function (desc, lines, payMethod, acctPrefix, entryType) {
    const isForeign = typeof payMethod === 'string' && payMethod.indexOf('foreign:') === 0;
    if (!isForeign) {
      // Identical to before for cash / mobile / bank / credit.
      return _origBuildIntakeJournalEntryV33(desc, lines, payMethod, acctPrefix, entryType);
    }

    const acctId = payMethod.split(':')[1];
    const foreignAcct = (typeof FOREIGN_ACCOUNTS !== 'undefined' ? FOREIGN_ACCOUNTS : [])
      .find(function (a) { return String(a.id) === String(acctId); });
    if (!foreignAcct) {
      console.warn('patch-v33: selected foreign account not found — falling back to Cash');
      return _origBuildIntakeJournalEntryV33(desc, lines, 'cash', acctPrefix, entryType);
    }
    const rate = (typeof fxCrossRate === 'function') ? fxCrossRate(foreignAcct.currency) : null;
    if (!rate) {
      console.warn(`patch-v33: no known live rate for ${foreignAcct.currency} today — falling back to Cash`);
      return _origBuildIntakeJournalEntryV33(desc, lines, 'cash', acctPrefix, entryType);
    }

    acctPrefix = acctPrefix || 'Inventory';
    entryType = entryType || 'Stock Receipt';
    const debits = lines.filter(function (l) { return l.base > 0.001; })
      .map(function (l) { return { acct: `${acctPrefix} (${l.productName})`, amt: Math.round(l.base * 100) / 100, atype: 'asset' }; });
    const totalTax = lines.reduce(function (s, l) { return s + (l.tax || 0); }, 0);
    if (totalTax > 0.001) debits.push({ acct: 'VAT Receivable (Input VAT)', amt: Math.round(totalTax * 100) / 100, atype: 'asset' });
    const grandTotal = lines.reduce(function (s, l) { return s + l.base + (l.tax || 0); }, 0);
    const grandTotalRounded = Math.round(grandTotal * 100) / 100;
    const foreignAmt = +(grandTotalRounded / rate).toFixed(4);

    const credits = [{
      acct: foreignAccountGLName(foreignAcct),
      amt: grandTotalRounded,
      atype: 'asset',
      foreignAmt: foreignAmt,
      currency: foreignAcct.currency
    }];

    return { id: DB.nextId++, date: today(), desc, type: entryType, amount: grandTotalRounded, project: '', debits, credits };
  };

  console.log('✅ patch-v33.js loaded — Stock Intake (Receive Stock) can now route cash purchases through foreign accounts');
})();
