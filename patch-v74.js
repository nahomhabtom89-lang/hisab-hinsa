// ═══════════════════════════════════════════════════════════
// PATCH v74 — Register page: fix overflow, Company Type as a real dropdown
// ═══════════════════════════════════════════════════════════
// Three fixes, all cosmetic/UX only — no change to registration logic:
//
// 1. #loginScreen/#companyScreen never allowed scrolling, so on a normal
//    laptop screen the Register/Back buttons on the (now bigger) register
//    form were literally clipped off — unreachable, not just off-screen.
//    Adds overflow-y:auto as a permanent safety net, and trims some of
//    v70's padding/sizing so the register form fits comfortably without
//    needing to scroll at all in most cases.
//
// 2. Replaces patch-v70's 5-card Company Type grid with a native <select>.
//    A native <select> already does exactly what was asked for: click to
//    open a vertical list, Up/Down arrow keys to move through it, Enter or
//    click to choose, and the closed box then shows only the chosen option.
//    Same underlying mapping as before — every option still calls the
//    ORIGINAL selectRegMode('retail'|'construction'), so REG_APP_MODE and
//    the register() payload are exactly as unchanged as they were in v70.
//    (v70's own applyRegRedesign() is a private closure function, never
//    exposed on window, so per Lesson 3 this rebuilds the same small piece
//    itself rather than reaching into v70 — it runs later in the toggleReg
//    chain, so its version of #regModePicker's content is what actually
//    persists.)
//
// 3. Company Name field's placeholder example "Riji Construction" is
//    replaced with a generic "Your Company Name" hint, and the field is
//    left genuinely empty for the user to type their own name into, like
//    every other field on the form.
// ═══════════════════════════════════════════════════════════
(function () {

  // ---- 1. Layout fixes ----
  const css = document.createElement('style');
  css.textContent = `
#loginScreen, #companyScreen{overflow-y:auto}
#loginScreen .login-card{padding:32px 36px}
#loginScreen .login-wrap{margin:24px auto}
`;
  document.head.appendChild(css);

  // ---- 2. Company Type as a native select ----
  const TYPE_MAP = { retail: 'retail', ecommerce: 'retail', bar: 'retail', restaurant: 'retail', construction: 'construction' };
  const TYPE_OPTIONS = [
    { type: 'retail', label: '🛒 Retail Shop' },
    { type: 'ecommerce', label: '🛍️ E-commerce' },
    { type: 'bar', label: '🍹 Bar' },
    { type: 'restaurant', label: '🍽️ Restaurant' },
    { type: 'construction', label: '🏗️ Construction Company' },
  ];

  function selectRegBusinessType(type) {
    const mode = TYPE_MAP[type] || 'retail';
    if (typeof selectRegMode === 'function') selectRegMode(mode); // ORIGINAL function — unchanged
  }
  window.selectRegBusinessType = selectRegBusinessType;

  function buildTypeSelect() {
    return '<select id="regCompanyTypeSelect" onchange="selectRegBusinessType(this.value)" ' +
      'style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:11px;font-family:\'Inter\',sans-serif;font-size:14px;color:var(--text);outline:none">' +
      TYPE_OPTIONS.map(function (o) {
        return '<option value="' + o.type + '"' + (o.type === 'construction' ? ' selected' : '') + '>' + o.label + '</option>';
      }).join('') + '</select>';
  }

  function applyRegRedesignV74() {
    const picker = document.getElementById('regModePicker');
    if (picker && !document.getElementById('regCompanyTypeSelect')) {
      picker.innerHTML = '<label style="display:block;font-size:13px;font-weight:700;color:var(--text);font-family:\'Inter\',sans-serif;margin-bottom:8px">Company Type</label>' + buildTypeSelect();
      selectRegBusinessType('construction'); // same default the app already had pre-selected
    }
    const lb = document.getElementById('lb');
    if (lb) lb.placeholder = 'Your Company Name';
  }

  const _origToggleRegV74 = window.toggleReg;
  if (typeof _origToggleRegV74 === 'function') {
    window.toggleReg = function () {
      const r = _origToggleRegV74();
      applyRegRedesignV74();
      return r;
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyRegRedesignV74);
  } else {
    applyRegRedesignV74();
  }

  console.log('✅ patch-v74.js loaded — register page fits on screen, Company Type is now a keyboard-friendly dropdown');
})();
