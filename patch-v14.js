// ═══════════════════════════════════════════════════════════
// PATCH v14 — THE root cause: registration currency was never applied
// ═══════════════════════════════════════════════════════════
// Every previous currency patch (v8, v9, v12, v13) was working correctly. The
// backend has always correctly resolved Kenya -> KES, stored it, and returned
// it in the register API response (`localCurrency`, `country`). But the
// original doLogin() function, right after a successful registration, builds
// its own local company object to hand to enterCompany() — and that object
// only ever copied over `bizName` and `appMode` from the server's response. It
// never had `local_currency`, `country`, or `base_currency` fields at all, and
// hardcoded `ssp_rate:1300` instead of leaving it unset.
//
// Since enterCompany() falls back to `c.local_currency||'SSP'` whenever that
// field is missing — and it was ALWAYS missing, for every country, every
// time — every single new registration landed on SSP no matter what country
// was actually picked. This is why Kenya, and every other country, kept
// showing up as SSP: the backend was right, the frontend just threw the
// answer away immediately after receiving it.
//
// The hardcoded ssp_rate:1300 was a second, related bug: it made patch-v8's
// "prefill from live rate" logic think a manual rate had already been set (since
// 1300 is a truthy, positive number), so it never fetched a real live rate for
// the new company's actual currency either.
//
// This patch fully redefines doLogin() (a plain function, safe to override)
// with the exact same logic as the original, except the register-path company
// object now correctly copies local_currency, country, and base_currency from
// the server's response, and leaves ssp_rate unset so the live rate can fill
// in properly — exactly matching what's already stored in the database.
// ═══════════════════════════════════════════════════════════

async function doLogin(){
  const u=document.getElementById('lu').value.trim(),p=document.getElementById('lp').value;
  const err=document.getElementById('lerr'),btn=document.getElementById('loginBtn');
  if(!u||!p){err.style.display='block';err.textContent='Fill all fields';return;}
  btn.textContent='...';btn.disabled=true;
  try{
    if(_isReg){
      const biz=document.getElementById('lb').value.trim()||u+' Business';
      const r=await dbApi({action:'register',username:u,password:p,bizName:biz,appMode:REG_APP_MODE});
      SESSION={userId:r.userId,username:u,companyId:r.companyId,role:'owner',projectScope:null,
        companies:[{
          company_id:r.companyId,role:'owner',project_scope:null,biz_name:r.bizName||biz,
          ssp_rate:null,costing_method:'WAC',app_mode:r.appMode||REG_APP_MODE,
          local_currency:r.localCurrency||'USD',country:r.country||'OTHER',base_currency:r.localCurrency||'USD'
        }]};
      await enterCompany(SESSION.companies[0]);
    }else{
      const r=await dbApi({action:'login',username:u,password:p});
      SESSION.userId=r.userId;SESSION.username=u;SESSION.companies=r.companies||[];
      if(!SESSION.companies.length){err.style.display='block';err.textContent='No company access — ask your owner';return;}
      if(SESSION.companies.length===1)await enterCompany(SESSION.companies[0]);
      else showCompanyScreen();
    }
  }catch(e){err.style.display='block';err.textContent=e.message||'Login failed';}
  finally{btn.textContent=_isReg?'📝 Register':'🔓 ኣቱ — Login';btn.disabled=false;}
}

console.log('✅ patch-v14.js loaded — registration currency now actually applies');
