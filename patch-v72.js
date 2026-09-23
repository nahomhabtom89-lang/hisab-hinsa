// ═══════════════════════════════════════════════════════════
// PATCH v72 — Fix: topbar brand text reverting after login (COSMETIC ONLY)
// ═══════════════════════════════════════════════════════════
// Root cause: patch-v7's fixStaticText() resets .tb-brand to the old
// "🏗️ Hisabi Hensi" text every time it runs — and it runs after every
// toggleReg(), showCompanyScreen(), AND enterCompany() call. No patch after
// v7 ever restores the current brand text, so every time someone actually
// logs into a company, the topbar silently flips back to the old name.
//
// Fix: chain onto fixStaticText() itself (it's a plain top-level function,
// already window-exposed by v7 — safe to override per Lesson 2/10) and
// restore the correct text immediately after it runs, every time.
// No other behavior of fixStaticText() is touched.
// ═══════════════════════════════════════════════════════════
(function () {
  const _origFixStaticTextV72 = window.fixStaticText;
  window.fixStaticText = function () {
    const r = typeof _origFixStaticTextV72 === 'function' ? _origFixStaticTextV72() : undefined;
    document.querySelectorAll('.tb-brand').forEach(function (el) {
      el.textContent = '🏗️ Jenga Ledger';
    });
    return r;
  };
  console.log('✅ patch-v72.js loaded — topbar brand text no longer reverts after login');
})();
