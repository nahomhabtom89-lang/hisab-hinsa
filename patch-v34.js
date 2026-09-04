// ═══════════════════════════════════════════════════════════
// PATCH v34 — Manual FX Rate Override (Live vs Manual, per currency)
// ═══════════════════════════════════════════════════════════
// Everywhere the app converts between currencies — Stock Intake, Deliveries,
// Purchase Orders, Receipt Review, POS credit sales, Pay Supplier, Receive
// Payment, Transfer Funds, FX Revaluation, the dashboard — it all funnels
// through ONE function: getDisplayRate(code), which returns "1 USD = ? code".
// That's the single chokepoint this patch touches, so every one of those
// screens gets manual-rate support automatically, with no changes needed
// to v9/v15/v19–v33 individually.
//
// SCOPE (per explicit decision with the user):
//  - Every one of the ~50 currencies in CURRENCIES gets a Live/Manual choice.
//  - Kept SEPARATE from the existing "Local Currency Rate" (SSP_RATE) field
//    in Settings — that field's behavior is completely untouched. This
//    system only ever applies to currencies OTHER than LOCAL_CURRENCY.
//  - The toggle+input is inline, right where a currency is already being
//    picked, not tucked away in a Settings table:
//      • every "Invoice Currency" dropdown (Stock Intake, Deliveries,
//        Purchase Orders, Material POs, multi-item Receipt Review) — these
//        all share one class (.entry-currency-select) and already funnel
//        through one shared function, onIntakeCurrencyChange(), which is
//        superset-redefined here to also render the widget right under it.
//      • the POS credit-sale "Customer's Currency" picker (from patch-v24).
//      • each row in the Foreign Currency Accounts list in Settings
//        (patch-v27) — since an account's currency is fixed at creation,
//        this is the natural place to see/set its rate.
//
// PERSISTENCE: stored via the same generic key-value save/load mechanism
// as FOREIGN_ACCOUNTS (patch-v27) and FX exposure, under key
// 'manualFxRates' — no new DB table needed. Loaded once on login.
//
// MATH / SAFETY:
//  - getDisplayRate(code) is redefined as a strict superset: for any
//    currency with no manual override set (the default, unchanged state),
//    it returns EXACTLY what the original function would have — falls
//    straight through to the live feed. Only currencies you explicitly
//    flip to Manual and type a rate for behave differently.
//  - The existing LOCAL_CURRENCY/SSP_RATE branch is checked FIRST, exactly
//    as before, so it always wins for the local currency — the manual
//    system below never even runs for that one currency, matching the
//    "keep it separate" decision precisely.
//  - Typing an invalid/blank/zero rate is ignored (keeps whatever was
//    there before) rather than silently breaking every conversion that
//    reads it — same graceful-degradation philosophy as convertToUSD().
//
// Verified with a Node.js simulation before shipping: confirmed
// getDisplayRate returns identical output to the original for every
// currency with no override, confirmed a manual override for one currency
// doesn't affect any other currency's rate, and confirmed flipping a
// currency back to Live immediately reverts to the live feed value.
// ═══════════════════════════════════════════════════════════

(function () {
  window.MANUAL_FX_RATES = window.MANUAL_FX_RATES || {}; // {code: rate} — "1 USD = X code"
  window.FX_RATE_MODE = window.FX_RATE_MODE || {};        // {code: 'live'|'manual'}

  // ── Persistence ──────────────────────────────────────────────────────
  async function loadManualFxRatesV34() {
    try {
      // 'load' always returns the WHOLE company data blob, ignoring which
      // key you ask for — pull our own field out of it, same pattern
      // FOREIGN_ACCOUNTS (v27) and Payment Terms (v35) use.
      const r = await dbApi({ action: 'load', companyId: SESSION.companyId });
      const d = (r && r.data && r.data.manualFxRates) || {};
      MANUAL_FX_RATES = d.rates || {};
      FX_RATE_MODE = d.modes || {};
    } catch (e) {
      MANUAL_FX_RATES = {};
      FX_RATE_MODE = {};
    }
  }
  async function saveManualFxRatesV34() {
    try {
      await dbApi({ action: 'save', companyId: SESSION.companyId, key: 'manualFxRates', value: { rates: MANUAL_FX_RATES, modes: FX_RATE_MODE } });
    } catch (e) { console.error('patch-v34: failed to save manual FX rates', e); }
  }

  // ── The core fix: getDisplayRate, superset-redefined ────────────────
  const _origGetDisplayRateV34 = window.getDisplayRate;
  window.getDisplayRate = function (code) {
    if (!code || code === 'USD') return 1;
    if (code === LOCAL_CURRENCY && SSP_RATE) return SSP_RATE; // unchanged, checked first, exactly as before
    if (FX_RATE_MODE[code] === 'manual' && MANUAL_FX_RATES[code]) return MANUAL_FX_RATES[code];
    return _origGetDisplayRateV34(code);
  };

  // ── Shared inline widget: Live/Manual radio + rate input ────────────
  // anchorEl: the element to insert the widget right after.
  // widgetKey: stable id suffix so repeat calls update in place, not duplicate.
  function renderFxOverrideWidget(code, anchorEl, widgetKey) {
    if (!anchorEl || !code) return;
    const base = (typeof BASE_CURRENCY !== 'undefined' && BASE_CURRENCY) ? BASE_CURRENCY : 'USD';
    const widgetId = 'fxov-' + widgetKey;
    let widget = document.getElementById(widgetId);
    if (!widget) {
      widget = document.createElement('div');
      widget.id = widgetId;
      anchorEl.insertAdjacentElement('afterend', widget);
    }
    if (code === base) { widget.innerHTML = ''; return; }
    if (code === LOCAL_CURRENCY) {
      widget.innerHTML = `<div style="font-size:9px;color:var(--text3);margin-top:2px">Uses your Local Currency Rate (Settings) — not this toggle.</div>`;
      return;
    }
    const mode = FX_RATE_MODE[code] || 'live';
    const manualVal = MANUAL_FX_RATES[code] || '';
    const liveVal = (typeof FX_RATES !== 'undefined') ? FX_RATES[code] : null;
    const radioName = 'fxmode-' + widgetKey;
    widget.innerHTML = `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px;padding:5px 7px;background:var(--bg3);border-radius:5px;font-size:10px;color:var(--text3)">
      <label style="display:flex;align-items:center;gap:3px;cursor:pointer">
        <input type="radio" name="${radioName}" ${mode === 'live' ? 'checked' : ''} onchange="window.__fxv34SetMode('${code}','live','${widgetKey}')"/>
        Live${liveVal ? ` (1 USD = ${(+liveVal).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${code})` : ' — no live rate found'}
      </label>
      <label style="display:flex;align-items:center;gap:3px;cursor:pointer">
        <input type="radio" name="${radioName}" ${mode === 'manual' ? 'checked' : ''} onchange="window.__fxv34SetMode('${code}','manual','${widgetKey}')"/>
        Manual: 1 USD =
        <input type="number" step="0.0001" min="0" value="${manualVal}" placeholder="rate" style="width:72px;background:var(--bg2);border:1px solid var(--border2);border-radius:4px;padding:3px 5px;color:var(--text);font-family:'JetBrains Mono',monospace;font-size:10px" onchange="window.__fxv34SetRate('${code}','${widgetKey}',this.value)"/>
        ${code}
      </label>
    </div>`;
  }
  window.renderFxOverrideWidget = renderFxOverrideWidget;

  window.__fxv34SetMode = async function (code, mode, widgetKey) {
    FX_RATE_MODE[code] = mode;
    await saveManualFxRatesV34();
    refreshAllFxWidgetsV34();
  };
  window.__fxv34SetRate = async function (code, widgetKey, val) {
    const rate = parseFloat(val);
    if (!rate || rate <= 0) { refreshAllFxWidgetsV34(); return; } // ignore invalid, just redraw with old value
    MANUAL_FX_RATES[code] = rate;
    FX_RATE_MODE[code] = 'manual';
    await saveManualFxRatesV34();
    refreshAllFxWidgetsV34();
  };

  // Re-render every currently-visible widget so a change to one currency's
  // rate is reflected everywhere it's shown at once (e.g. same currency
  // picked on two different screens' pickers isn't possible simultaneously
  // in this single-page app, but the hint text + widget both need refreshing
  // in place after a save).
  function refreshAllFxWidgetsV34() {
    document.querySelectorAll('.entry-currency-select').forEach(function (sel) {
      const hintId = sel.id + '-hint';
      if (document.getElementById(hintId) && typeof onIntakeCurrencyChange === 'function') onIntakeCurrencyChange(sel.id, hintId);
    });
    const posCur = document.getElementById('pos-customer-currency');
    if (posCur) renderFxOverrideWidget(posCur.value, posCur, 'pos-customer-currency');
    if (typeof renderForeignAccountsCard === 'function' && document.getElementById('fca-list')) renderForeignAccountsCard();
  }

  // ── Hook 1: every "Invoice Currency" dropdown (.entry-currency-select) ─
  // onIntakeCurrencyChange(selectId, hintId) already runs on every one of
  // these selects' onchange, AND every time one is freshly populated —
  // so wrapping it here gives automatic, complete coverage with no need
  // to touch each individual screen's render code.
  const _origOnIntakeCurrencyChangeV34 = window.onIntakeCurrencyChange;
  if (typeof _origOnIntakeCurrencyChangeV34 === 'function') {
    window.onIntakeCurrencyChange = function (selectId, hintId) {
      const result = _origOnIntakeCurrencyChangeV34(selectId, hintId);
      const sel = document.getElementById(selectId);
      const hint = document.getElementById(hintId);
      if (sel && hint) renderFxOverrideWidget(sel.value, hint, selectId);
      return result;
    };
  }

  // ── Hook 2: POS credit-sale currency picker (patch-v24) ─────────────
  const _origInjectPOSCustomerCurrencyPickerV34 = window.injectPOSCustomerCurrencyPicker;
  if (typeof _origInjectPOSCustomerCurrencyPickerV34 === 'function') {
    window.injectPOSCustomerCurrencyPicker = function () {
      const result = _origInjectPOSCustomerCurrencyPickerV34();
      const sel = document.getElementById('pos-customer-currency');
      if (sel) {
        renderFxOverrideWidget(sel.value, sel, 'pos-customer-currency');
        sel.onchange = function () { renderFxOverrideWidget(sel.value, sel, 'pos-customer-currency'); };
      }
      return result;
    };
  }

  // ── Hook 3: each row in the Foreign Currency Accounts list (v27) ────
  const _origRenderForeignAccountsCardV34 = window.renderForeignAccountsCard;
  if (typeof _origRenderForeignAccountsCardV34 === 'function') {
    window.renderForeignAccountsCard = function () {
      const result = _origRenderForeignAccountsCardV34();
      const list = document.getElementById('fca-list');
      if (list && typeof FOREIGN_ACCOUNTS !== 'undefined') {
        const seen = {};
        Array.from(list.children).forEach(function (row, i) {
          const acct = FOREIGN_ACCOUNTS[i];
          if (!acct || seen[acct.currency]) return; // one rate widget per currency, not per account
          seen[acct.currency] = true;
          renderFxOverrideWidget(acct.currency, row, 'fca-' + acct.currency);
        });
      }
      return result;
    };
  }

  // ── Load on login, same pattern as FOREIGN_ACCOUNTS ──────────────────
  const _origEnterCompanyV34 = window.enterCompany;
  if (typeof _origEnterCompanyV34 === 'function') {
    window.enterCompany = async function (c) {
      const result = await _origEnterCompanyV34(c);
      await loadManualFxRatesV34();
      return result;
    };
  }

  console.log('✅ patch-v34.js loaded — manual FX rate override (Live/Manual) available on every currency picker');
})();
