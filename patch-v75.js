// ═══════════════════════════════════════════════════════════
// PATCH v75 — Marketing landing page as the true first screen
// ═══════════════════════════════════════════════════════════
// New flow: Landing page ("Financial Clarity, Simplified.") → Start button
// → Register page → "Already have an account? ← Back to Login" → Login page
// → "New account? Register" → back to Register. The Login/Register pair
// itself is completely unchanged — this patch only adds a new screen in
// FRONT of them and points "Start" at Register instead of Login.
//
// The base app has no session persistence at all (confirmed: the base init
// always forces #loginScreen visible on every page load, unconditionally —
// see index.html's own DOMContentLoaded listener), so there's no "resume
// session, skip the splash" case to worry about breaking. Logging out still
// goes straight back to the Login screen, not the landing page again — a
// returning/registered user shouldn't have to click through the marketing
// pitch every time.
//
// Marketing copy is reproduced verbatim exactly as the business owner wrote
// it — it's their own original text for their own product, not third-party
// content.
// ═══════════════════════════════════════════════════════════
(function () {

  // ---- 1. Landing page markup (created once, synchronously) ----
  if (!document.getElementById('landingScreen')) {
    const div = document.createElement('div');
    div.id = 'landingScreen';
    div.style.cssText = 'display:none;position:fixed;inset:0;z-index:999;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;overflow-y:auto;background:radial-gradient(circle at 50% 30%, rgba(196,154,42,.10), var(--bg) 65%)';
    div.innerHTML = `
      <img src="jenga-ledger-logo.png" alt="Jenga Ledger" style="width:380px;max-width:80%;margin-bottom:18px"/>
      <h1 style="font-family:'Inter',sans-serif;font-size:clamp(20px,3vw,28px);font-weight:800;color:var(--gold3);margin-bottom:14px;letter-spacing:.01em">Financial Clarity, Simplified.</h1>
      <p style="max-width:640px;font-size:14px;line-height:1.65;color:var(--text2);margin-bottom:18px;font-family:'Inter',sans-serif">Welcome to Jenga Ledger—the all-in-one financial platform built to give your business total precision and effortless control. From seamless double-entry bookkeeping and multi-currency accounting to AI-powered OCR receipt scanning and real-time inventory management, Jenga Ledger handles the complexity so you can focus on growth.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-bottom:28px">
        <span style="background:var(--bg3);border:1px solid var(--border2);border-radius:20px;padding:6px 16px;font-size:12px;color:var(--gold3);font-weight:600;font-family:'Inter',sans-serif">Smart ledgers</span>
        <span style="background:var(--bg3);border:1px solid var(--border2);border-radius:20px;padding:6px 16px;font-size:12px;color:var(--gold3);font-weight:600;font-family:'Inter',sans-serif">Automated data capture</span>
        <span style="background:var(--bg3);border:1px solid var(--border2);border-radius:20px;padding:6px 16px;font-size:12px;color:var(--gold3);font-weight:600;font-family:'Inter',sans-serif">Endless scalability</span>
      </div>
      <button type="button" onclick="startFromLanding()" style="padding:16px 64px;background:linear-gradient(135deg,var(--gold),var(--gold2));color:#0a0e17;border:none;border-radius:8px;font-family:'Inter',sans-serif;font-size:17px;font-weight:800;cursor:pointer;letter-spacing:.03em;box-shadow:0 8px 24px rgba(196,154,42,.25)">🚀 Start</button>
    `;
    document.body.appendChild(div);
  }

  const css = document.createElement('style');
  css.textContent = `@media (max-width:640px){ #landingScreen img{width:280px} #landingScreen p{font-size:13px} #landingScreen button{padding:14px 44px;font-size:15px} }`;
  document.head.appendChild(css);

  // ---- 2. Start button → Register page ----
  function startFromLanding() {
    const landing = document.getElementById('landingScreen');
    const login = document.getElementById('loginScreen');
    if (landing) landing.style.display = 'none';
    if (login) login.style.display = 'flex';
    if (typeof _isReg !== 'undefined' && !_isReg && typeof toggleReg === 'function') toggleReg();
  }
  window.startFromLanding = startFromLanding;

  // ---- 3. Show the landing page first, instead of the login screen ----
  // Registered AFTER the base script's own DOMContentLoaded listener (which
  // always runs first, since it was added earlier in document order), so
  // this correctly overrides it rather than racing it.
  function showLandingFirst() {
    const landing = document.getElementById('landingScreen');
    const login = document.getElementById('loginScreen');
    if (login) login.style.display = 'none';
    if (landing) landing.style.display = 'flex';
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showLandingFirst);
  } else {
    showLandingFirst();
  }

  console.log('✅ patch-v75.js loaded — marketing landing page is now the first screen, Start leads to Register');
})();
