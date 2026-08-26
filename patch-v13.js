// ═══════════════════════════════════════════════════════════
// PATCH v13 — Fix Register form showing "Login" instead of "Register"
// ═══════════════════════════════════════════════════════════
// The original toggleReg() correctly sets the login-card title and button to
// "Register" when switching into registration mode (App Mode / Country /
// Company Name fields visible) and "Login" otherwise. But patch-v7's
// fixStaticText() — which runs right after toggleReg() on every call, to
// translate the bilingual Tigrinya/English text to English-only — always sets
// both back to "Login" unconditionally, regardless of which mode you're
// actually in.
//
// Net effect: the Register screen has been showing "Login" as its title and
// button this whole time, even though the fields underneath (App Mode,
// Country, Company Name) are clearly for creating a new account. This is what
// caused the confusion around Kenya/KES not "taking" — the form WAS correctly
// set to Kenya and WAS going to register a brand new company, but because it
// looked like a normal login screen, it's easy to type in a username you've
// already used before, which fails registration with "Username taken" instead
// of doing what a login screen would do.
//
// This patch re-applies the correct label after toggleReg() runs (undoing
// fixStaticText's overwrite), and also fixes doLogout() resetting the labels
// back to the original bilingual text.
// ═══════════════════════════════════════════════════════════

function fixLoginRegisterLabel(){
  const loginTitle=document.getElementById('loginTitle');
  const loginBtn=document.getElementById('loginBtn');
  const reg=typeof _isReg!=='undefined'&&_isReg;
  if(loginTitle)loginTitle.textContent=reg?'Register':'Login';
  if(loginBtn)loginBtn.textContent=reg?'📝 Register':'🔓 Login';
}

const _origToggleRegV13=window.toggleReg;
if(typeof _origToggleRegV13==='function'){
  window.toggleReg=function(){
    const result=_origToggleRegV13();
    fixLoginRegisterLabel();
    return result;
  };
}

const _origDoLogoutV13=window.doLogout;
if(typeof _origDoLogoutV13==='function'){
  window.doLogout=function(){
    const result=_origDoLogoutV13();
    fixLoginRegisterLabel();
    return result;
  };
}

console.log('✅ patch-v13.js loaded — Register form now correctly says "Register", not "Login"');
