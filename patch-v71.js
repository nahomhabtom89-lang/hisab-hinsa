// ═══════════════════════════════════════════════════════════
// PATCH v71 — Keyboard-only login flow (COSMETIC/UX ONLY)
// ═══════════════════════════════════════════════════════════
// What this does:
// 1. Auto-focuses the Username field whenever the login screen is shown
//    (on first load, and again after logout).
// 2. Enter in Username → moves focus to Password (no mouse needed).
// 3. Enter in Password → if registering and a Company Name field is present,
//    moves to it next; otherwise calls the SAME doLogin() the Login/Register
//    button already calls — no new login/register logic, just triggers the
//    existing function via keyboard instead of a click.
// 4. Enter in Company Name (register flow) → also calls doLogin().
// Company Type (card grid) and Country (native <select>) are not part of this
// Enter-chain — cards aren't sequential text inputs, and the Country <select>
// already supports its own native keyboard navigation (arrow keys/typing).
//
// Chains onto doLogout() and toggleReg() (already wrapped by earlier patches)
// rather than replacing them — see Lesson 10. Uses addEventListener, so it
// never overwrites any existing handler on these inputs.
// ═══════════════════════════════════════════════════════════
(function () {

  function wireEnterChain() {
    const lu = document.getElementById('lu');
    const lp = document.getElementById('lp');
    const lb = document.getElementById('lb');

    if (lu && !lu.dataset.v71Wired) {
      lu.dataset.v71Wired = '1';
      lu.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          const pw = document.getElementById('lp');
          if (pw) pw.focus();
        }
      });
    }

    if (lp && !lp.dataset.v71Wired) {
      lp.dataset.v71Wired = '1';
      lp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          const regFields = document.getElementById('regFields');
          const nameField = document.getElementById('lb');
          if (regFields && regFields.style.display !== 'none' && nameField) {
            nameField.focus();
          } else if (typeof doLogin === 'function') {
            doLogin();
          }
        }
      });
    }

    if (lb && !lb.dataset.v71Wired) {
      lb.dataset.v71Wired = '1';
      lb.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (typeof doLogin === 'function') doLogin();
        }
      });
    }
  }

  function focusUsername() {
    const screen = document.getElementById('loginScreen');
    const lu = document.getElementById('lu');
    if (lu && screen && getComputedStyle(screen).display !== 'none') {
      lu.focus();
    }
  }

  function setupAll() {
    wireEnterChain();
    focusUsername();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAll);
  } else {
    setupAll();
  }

  const _origDoLogoutV71 = window.doLogout;
  if (typeof _origDoLogoutV71 === 'function') {
    window.doLogout = function () {
      const r = _origDoLogoutV71();
      setupAll();
      return r;
    };
  }

  const _origToggleRegV71 = window.toggleReg;
  if (typeof _origToggleRegV71 === 'function') {
    window.toggleReg = function () {
      const r = _origToggleRegV71();
      setupAll();
      return r;
    };
  }

  console.log('✅ patch-v71.js loaded — keyboard-only login (Username → Enter → Password → Enter → submits)');
})();
