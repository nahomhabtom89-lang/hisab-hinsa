// ═══════════════════════════════════════════════════════════
// PATCH v70 — Login/Register screen redesign (COSMETIC + UX ONLY)
// ═══════════════════════════════════════════════════════════
// What this does:
// 1. Makes the login/register card much bigger and more spacious (was a small
//    centered box on a big empty dark background) — bigger logo, bigger card,
//    bigger text, more generous padding.
// 2. Bolds the field labels (Username, Password, Company Name, Country,
//    Company Type) — scoped ONLY to the login/register/company screens, not
//    changed anywhere else in the app.
// 3. Removes the leftover Tigrinya "ዓይነት ሒሳብ — App Mode" label text and
//    replaces it with a plain bold "Company Type" label.
// 4. Expands the old 2-button Construction/Retail picker into a friendlier
//    5-option "Company Type" grid: Retail Shop, E-commerce, Bar, Restaurant,
//    Construction Company.
//    IMPORTANT — no new accounting engine is added. The app only has two real
//    engines under the hood: Construction (job costing/WIP/retention) and
//    Retail (POS/barcode/inventory). Retail Shop, E-commerce, Bar, and
//    Restaurant all map to the SAME existing Retail engine — only
//    "Construction Company" maps to the Construction engine. Every card calls
//    the exact same original selectRegMode('retail'|'construction') function,
//    so REG_APP_MODE, the register() payload, and the backend are all
//    byte-for-byte unchanged from before this patch.
// 5. Turns "New account? Register" (and the register→login switch) into real
//    buttons instead of text links, per the user's sketch.
//
// Chains onto the existing toggleReg() (already wrapped by v7 and v8) rather
// than replacing it — see Lesson 10. Only touches DOM/CSS after the original
// function has already run.
// ═══════════════════════════════════════════════════════════
(function () {

  // ---- 1. Scoped CSS (login/register/company screens only) ----
  const css = document.createElement('style');
  css.textContent = `
#loginScreen .login-wrap, #companyScreen .login-wrap{max-width:820px}
#loginScreen .login-card{padding:44px 48px}
#loginScreen .login-brand img{width:520px;max-width:95%}
#loginScreen .lf label, #companyScreen .lf label{font-weight:700;font-size:13px;color:var(--text);font-family:'Inter',sans-serif}
#loginScreen .lf input, #companyScreen .lf input{padding:13px 15px;font-size:14px}
#loginScreen h2{font-size:22px}
#loginScreen .login-btn{padding:16px;font-size:16px}
.reg-type-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
@media (max-width:640px){ .reg-type-grid{grid-template-columns:1fr 1fr} #loginScreen .login-card{padding:28px 20px} }
.reg-type-card{padding:14px 8px;border-radius:8px;cursor:pointer;text-align:center;border:1px solid var(--border2);background:var(--bg3);transition:all .15s}
.reg-back-btn{width:100%;padding:13px;background:transparent;border:1px solid var(--border2);border-radius:6px;color:var(--text2);font-size:14px;font-weight:700;cursor:pointer;margin-top:8px;font-family:'Inter',sans-serif}
.reg-back-btn:hover{border-color:var(--gold2);color:var(--gold2)}
`;
  document.head.appendChild(css);

  // ---- 2. Visible options → the two REAL underlying modes ----
  const TYPE_MAP = { retail: 'retail', ecommerce: 'retail', bar: 'retail', restaurant: 'retail', construction: 'construction' };
  const TYPE_CARDS = [
    { type: 'retail', ico: '🛒', label: 'Retail Shop' },
    { type: 'ecommerce', ico: '🛍️', label: 'E-commerce' },
    { type: 'bar', ico: '🍹', label: 'Bar' },
    { type: 'restaurant', ico: '🍽️', label: 'Restaurant' },
    { type: 'construction', ico: '🏗️', label: 'Construction Company' },
  ];

  function selectRegBusinessType(type) {
    const mode = TYPE_MAP[type] || 'retail';
    if (typeof selectRegMode === 'function') selectRegMode(mode); // ORIGINAL function — unchanged
    document.querySelectorAll('.reg-type-card').forEach(function (el) {
      const active = el.getAttribute('data-type') === type;
      el.style.borderColor = active ? 'var(--gold2)' : 'var(--border2)';
      el.style.background = active ? 'rgba(196,154,42,.12)' : 'var(--bg3)';
    });
  }
  window.selectRegBusinessType = selectRegBusinessType;

  function buildTypeGrid() {
    return '<div class="reg-type-grid">' + TYPE_CARDS.map(function (c) {
      return '<div class="reg-type-card" data-type="' + c.type + '" onclick="selectRegBusinessType(\'' + c.type + '\')">' +
        '<div style="font-size:22px;margin-bottom:4px">' + c.ico + '</div>' +
        '<div style="font-size:11px;font-weight:600;color:var(--text)">' + c.label + '</div></div>';
    }).join('') + '</div>';
  }

  // ---- 3. Apply after every toggleReg() run ----
  function applyRegRedesign() {
    const picker = document.getElementById('regModePicker');
    if (picker && !document.getElementById('regTypeGrid')) {
      picker.innerHTML = '<label style="display:block;font-size:13px;font-weight:700;color:var(--text);font-family:\'Inter\',sans-serif;margin-bottom:8px">Company Type</label><div id="regTypeGrid">' + buildTypeGrid() + '</div>';
      selectRegBusinessType('construction'); // same default the original had pre-selected
    }
    const sw = document.querySelector('#loginScreen .login-switch');
    if (sw) {
      if (typeof _isReg !== 'undefined' && _isReg) {
        sw.innerHTML = '<button type="button" class="reg-back-btn" onclick="toggleReg()">← Back to Login</button>';
      } else {
        sw.innerHTML = '<button type="button" class="reg-back-btn" onclick="toggleReg()">📝 New account? Register</button>';
      }
    }
  }

  const _origToggleRegV70 = window.toggleReg;
  if (typeof _origToggleRegV70 === 'function') {
    window.toggleReg = function () {
      const r = _origToggleRegV70();
      applyRegRedesign();
      return r;
    };
  }

  // Apply once immediately too (covers first page load / after logout)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyRegRedesign);
  } else {
    applyRegRedesign();
  }

  console.log('✅ patch-v70.js loaded — login/register redesign (cosmetic + friendlier Company Type picker, same 2 underlying modes)');
})();
