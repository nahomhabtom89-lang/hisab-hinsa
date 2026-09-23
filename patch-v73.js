// ═══════════════════════════════════════════════════════════
// PATCH v73 — Expenses page (OCR + AI receipt reading, flexible payment source)
// ═══════════════════════════════════════════════════════════
// What this adds:
// A new "💸 Expenses" page (both Construction and Retail sidebars) for
// recording day-to-day business expenses — separate from the existing
// small Petty Cash Expense form (untouched, still there for petty cash only).
//
// 1. Optional receipt/invoice photo or PDF upload. Reuses the EXACT SAME
//    OCR pipeline already used elsewhere (extractTextFromImage /
//    extractTextFromPDF — Tesseract + pdf.js, nothing new added there) and
//    the exact same /api/ai systemPrompt call pattern used by
//    RECEIPT_PARSE_PROMPT. A new, separate prompt (EXPENSE_PARSE_PROMPT)
//    is built fresh each time from the company's REAL expense accounts, so
//    the AI can only ever pick a category that actually exists in this
//    company's Chart of Accounts — never an invented one.
// 2. Extracted vendor/date/amount/description/category pre-fill the form —
//    nothing posts automatically. The user reviews/edits, then presses
//    Record Expense, exactly like every other AI-assisted entry in this app.
// 3. Category dropdown is built live from CHART_OF_ACCOUNTS (account_type
//    === 'expense') — not a hardcoded list.
// 4. "Paid From" supports: Cash, Mobile Money, Bank Account, Petty Cash, any
//    foreign account already registered in Settings (via the EXISTING
//    appendForeignAccountOptions() from patch-v28 — no new foreign-account
//    system invented), and On Credit (Accounts Payable to a supplier).
//    - On Credit requires a vendor and posts a normal AP liability with the
//      same {party:{type:'supplier',...}} shape getOpenAPInvoices() already
//      reads — so it shows up for Pay Supplier automatically, no new plumbing.
//    - A foreign-account payment tags foreignAmt/currency using the exact
//      same formula already used by recordSupplierPayment
//      (foreignAmt = amount / fxCrossRate(currency)) — verified against
//      that exact code before writing this.
// ═══════════════════════════════════════════════════════════
(function () {

  // ---- 1. Sidebar entry (push into the SAME arrays renderSidebar() already
  //         reads — never touch sidebar.innerHTML directly, see Lesson 10) ----
  const NAV_ITEM = { ico: '💸', en: 'Expenses', page: 'expenses' };
  function addNavItem(navArr) {
    if (!Array.isArray(navArr)) return;
    const daily = navArr.find(function (s) { return s.section === 'Daily'; });
    if (daily && !daily.items.some(function (i) { return i.page === 'expenses'; })) {
      daily.items.push(NAV_ITEM);
    }
  }
  addNavItem(window.CONSTRUCTION_NAV_EN);
  addNavItem(window.RETAIL_NAV_EN);

  // ---- 2. Page markup (injected once, synchronously, before any nav() call
  //         can run — see Lesson 4) ----
  function ensureExpensesPage() {
    if (document.getElementById('pg-expenses')) return;
    const main = document.querySelector('.main');
    if (!main) return;
    const div = document.createElement('div');
    div.className = 'page';
    div.id = 'pg-expenses';
    div.innerHTML = `
      <div class="ph"><h1>💸 Expenses</h1><p>Record a business expense — snap a receipt for AI to read it, or enter it manually.</p></div>
      <div class="card">
        <div class="card-hdr">📷 Scan a Receipt (optional)</div>
        <input type="file" id="expReceiptFile" accept="image/*,application/pdf" style="display:none" onchange="handleExpenseReceiptUpload(this.files[0])"/>
        <div class="btn-row"><button type="button" class="btn btn-outline" onclick="document.getElementById('expReceiptFile').click()">📎 Upload Receipt / Invoice</button></div>
        <div id="expReceiptStatus" style="font-size:11px;margin-top:6px"></div>
      </div>
      <div class="card">
        <div class="card-hdr">📝 Expense Details</div>
        <div class="fgrid">
          <div class="fg"><label>Date</label><input id="expDate" type="date"/></div>
          <div class="fg"><label>Description</label><input id="expDesc" type="text" placeholder="e.g. Fuel for site generator"/></div>
          <div class="fg"><label>Amount</label><input id="expAmt" type="number" placeholder="0.00"/></div>
          <div class="fg"><label>Category</label><select id="expCategory"></select></div>
          <div class="fg"><label>Vendor (optional)</label><div style="display:flex;gap:6px"><select id="expVendor" class="supplier-select" style="flex:1"></select><button type="button" class="btn btn-outline" style="padding:9px 11px;white-space:nowrap" onclick="openQuickAddParty('supplier','expVendor')">+ New</button></div></div>
          <div class="fg"><label>Paid From</label><select id="expPayFrom" onchange="onExpensePayFromChange()"></select></div>
        </div>
        <div id="expCreditHint" style="display:none;font-size:11px;color:var(--gold3);margin:4px 0 8px">💳 This will be recorded as owed to the selected vendor (Accounts Payable) — pay it off later from the Suppliers page, exactly like a purchase invoice.</div>
        <div id="expSt" style="font-size:11px;margin:4px 0 8px"></div>
        <div class="btn-row"><button type="button" class="btn btn-gold" onclick="postExpense()">✅ Record Expense</button></div>
      </div>
      <div class="card">
        <div class="card-hdr">🕘 Recent Expenses</div>
        <div id="expenseHistory"></div>
      </div>`;
    main.appendChild(div);
  }
  ensureExpensesPage();

  // ---- 3. Category options — live from the real Chart of Accounts ----
  function refreshExpenseCategoryOptions() {
    const sel = document.getElementById('expCategory');
    if (!sel) return;
    const prev = sel.value;
    const accts = (typeof CHART_OF_ACCOUNTS !== 'undefined' ? CHART_OF_ACCOUNTS : [])
      .filter(function (a) { return a.account_type === 'expense'; })
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    sel.innerHTML = accts.map(function (a) {
      return '<option value="' + a.name.replace(/"/g, '&quot;') + '">' + a.name + '</option>';
    }).join('');
    if (prev && accts.some(function (a) { return a.name === prev; })) sel.value = prev;
  }

  // ---- 4. Paid-From options — Cash/Mobile/Bank/Petty Cash + foreign accounts + Credit ----
  function refreshExpensePayFromOptions() {
    const sel = document.getElementById('expPayFrom');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML =
      '<option value="cash">Cash</option>' +
      '<option value="mobile">Mobile Money</option>' +
      '<option value="bank">Bank Account</option>' +
      '<option value="pettycash">Petty Cash</option>' +
      '<option value="credit">On Credit (owe a supplier)</option>';
    if (typeof appendForeignAccountOptions === 'function') appendForeignAccountOptions('expPayFrom');
    if (prev && Array.from(sel.options).some(function (o) { return o.value === prev; })) sel.value = prev;
    onExpensePayFromChange();
  }

  function onExpensePayFromChange() {
    const sel = document.getElementById('expPayFrom');
    const hint = document.getElementById('expCreditHint');
    if (hint) hint.style.display = (sel && sel.value === 'credit') ? 'block' : 'none';
  }
  window.onExpensePayFromChange = onExpensePayFromChange;

  // ---- 5. OCR + AI receipt reading ----
  function buildExpenseParsePrompt() {
    const categories = (typeof CHART_OF_ACCOUNTS !== 'undefined' ? CHART_OF_ACCOUNTS : [])
      .filter(function (a) { return a.account_type === 'expense'; })
      .map(function (a) { return a.name; });
    return 'You are a data-extraction engine for a single business expense receipt (one overall expense — e.g. fuel, a meal, office supplies, a repair bill — NOT an itemized delivery/purchase invoice with multiple line items).\n' +
      'Return ONLY valid JSON. No markdown, no commentary, no text outside the JSON.\n' +
      'Structure exactly:\n' +
      '{"vendor":"Vendor/merchant name exactly as printed, or empty string if not found","date":"YYYY-MM-DD, or empty string if not found","amount":0,"description":"A short 3-8 word description of what this expense was for","category":"Pick the SINGLE closest matching name from this exact list, copied character-for-character — never invent a new name: ' + JSON.stringify(categories) + '"}\n' +
      'Rules:\n' +
      '1. amount is the TOTAL amount paid including any tax shown, as a plain number — never a string, never a currency symbol.\n' +
      '2. date must be YYYY-MM-DD. Best-guess a partial date; use "" if genuinely no date is visible.\n' +
      '3. category MUST be copied exactly from the provided list — if nothing fits well, use the first item in the list rather than inventing a new one.\n' +
      '4. Never fabricate a vendor name — use "" if it is not clearly printed.';
  }

  async function handleExpenseReceiptUpload(file) {
    if (!file) return;
    const st = document.getElementById('expReceiptStatus');
    function report(msg, isErr) { if (st) st.innerHTML = isErr ? '<span style="color:var(--red3)">' + msg + '</span>' : msg; }
    try {
      let text = '';
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        text = await extractTextFromPDF(file, report);
      } else if (file.type.startsWith('image/')) {
        text = await extractTextFromImage(file, report);
      } else {
        report('⚠️ Unsupported file type', true);
        return;
      }
      text = (text || '').trim();
      if (!text) { report('⚠️ No text found on this document', true); return; }
      report('🤖 Reading with AI...');
      const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text, systemPrompt: buildExpenseParsePrompt() }) });
      const data = await res.json();
      const parsed = (typeof safeParseReceiptJson === 'function') ? safeParseReceiptJson(data.result || '') : null;
      if (!parsed) { report('⚠️ Could not read this receipt — please fill in manually', true); return; }
      if (parsed.date) { const d = document.getElementById('expDate'); if (d) d.value = parsed.date; }
      if (parsed.description) { const de = document.getElementById('expDesc'); if (de) de.value = parsed.description; }
      if (parsed.amount) { const am = document.getElementById('expAmt'); if (am) am.value = parsed.amount; }
      if (parsed.category) {
        const catSel = document.getElementById('expCategory');
        if (catSel && Array.from(catSel.options).some(function (o) { return o.value === parsed.category; })) catSel.value = parsed.category;
      }
      if (parsed.vendor) {
        const vendSel = document.getElementById('expVendor');
        const match = (typeof SUPPLIERS !== 'undefined' ? SUPPLIERS : []).find(function (s) { return s.name.toLowerCase() === parsed.vendor.toLowerCase(); });
        if (match && vendSel) vendSel.value = String(match.id);
      }
      report('✅ Filled in from receipt — please check before recording');
    } catch (err) {
      report('❌ ' + err.message, true);
    } finally {
      const f = document.getElementById('expReceiptFile'); if (f) f.value = '';
    }
  }
  window.handleExpenseReceiptUpload = handleExpenseReceiptUpload;

  // ---- 6. Posting ----
  function postExpense() {
    const st = document.getElementById('expSt');
    function fail(msg) { if (st) st.innerHTML = '<span style="color:var(--red3)">' + msg + '</span>'; }

    const desc = (document.getElementById('expDesc').value || '').trim();
    const amt = parseFloat(document.getElementById('expAmt').value);
    const date = document.getElementById('expDate').value || today();
    const category = document.getElementById('expCategory').value;
    const payFromSel = document.getElementById('expPayFrom');
    const payFrom = payFromSel ? payFromSel.value : 'cash';
    const vendSel = document.getElementById('expVendor');
    const vendor = (vendSel && vendSel.value) ? (typeof SUPPLIERS !== 'undefined' ? SUPPLIERS : []).find(function (s) { return String(s.id) === String(vendSel.value); }) : null;

    if (!desc) { fail('Enter a description'); return; }
    if (!amt || amt <= 0) { fail('Enter a valid amount'); return; }
    if (!category) { fail('Choose a category'); return; }
    if (payFrom === 'credit' && !vendor) { fail('On-credit expenses need a vendor \u2014 pick one or add a new one'); return; }

    let credits, entryType = 'Expense';

    if (payFrom === 'credit') {
      credits = [{ acct: 'Accounts Payable', amt: amt, atype: 'liability' }];
      entryType = 'Expense (On Credit)';
    } else if (payFrom && payFrom.indexOf('foreign:') === 0) {
      const acctId = payFrom.split(':')[1];
      const facct = (typeof FOREIGN_ACCOUNTS !== 'undefined' ? FOREIGN_ACCOUNTS : []).find(function (a) { return String(a.id) === String(acctId); });
      if (!facct) { fail('Selected account not found'); return; }
      const rate = (typeof fxCrossRate === 'function') ? fxCrossRate(facct.currency) : null;
      if (!rate) { fail('No known rate for ' + facct.currency + ' today \u2014 cannot record this account\u2019s balance.'); return; }
      const glName = (typeof foreignAccountGLName === 'function') ? foreignAccountGLName(facct) : (facct.baseType + ' (' + facct.currency + ') \u2014 ' + facct.name);
      // Same formula as recordSupplierPayment (patch-v47): foreignAmt = baseAmount / rate
      credits = [{ acct: glName, amt: amt, atype: 'asset', foreignAmt: +(amt / rate).toFixed(4), currency: facct.currency }];
    } else {
      const map = { cash: 'Cash', mobile: 'Mobile Money', bank: 'Bank Account', pettycash: 'Petty Cash' };
      credits = [{ acct: map[payFrom] || 'Cash', amt: amt, atype: 'asset' }];
    }

    const entry = { id: DB.nextId++, date: date, desc: desc, type: entryType, amount: amt, project: '', debits: [{ acct: category, amt: amt, atype: 'expense' }], credits: credits };
    if (vendor) entry.party = { type: 'supplier', id: vendor.id, name: vendor.name };

    DB.entries.push(entry);
    saveData();
    renderAll();
    if (typeof runAudit === 'function') runAudit();
    showToast('✅ ' + desc);

    document.getElementById('expDesc').value = '';
    document.getElementById('expAmt').value = '';
    if (vendSel) vendSel.value = '';
    if (st) st.innerHTML = '';
    renderExpenseHistory();
  }
  window.postExpense = postExpense;

  function renderExpenseHistory() {
    const el = document.getElementById('expenseHistory');
    if (!el) return;
    const items = DB.entries.filter(function (e) { return e.type === 'Expense' || e.type === 'Expense (On Credit)'; }).slice(-20).reverse();
    if (!items.length) { el.innerHTML = '<div style="text-align:center;padding:14px;color:var(--text3)">No expenses yet</div>'; return; }
    el.innerHTML = items.map(function (e) {
      const cat = (e.debits || [])[0] ? (e.debits[0].acct) : '';
      return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px">' +
        '<div><div>' + e.desc + (e.party ? ' \u2014 ' + e.party.name : '') + '</div><div style="font-size:10px;color:var(--text3)">' + e.date + ' \u00b7 ' + cat + (e.type === 'Expense (On Credit)' ? ' \u00b7 on credit' : '') + '</div></div>' +
        '<div style="font-family:\'JetBrains Mono\',monospace;color:var(--red3)">-' + fc(e.amount) + '</div></div>';
    }).join('');
  }
  window.renderExpenseHistory = renderExpenseHistory;

  // ---- 7. Wire into nav() (chain, don't replace \u2014 Lesson 10) ----
  const _origNavV73 = window.nav;
  if (typeof _origNavV73 === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV73(page, el);
      if (page === 'expenses') {
        refreshExpenseCategoryOptions();
        refreshExpensePayFromOptions();
        if (typeof refreshSupplierDropdowns === 'function') refreshSupplierDropdowns();
        const d = document.getElementById('expDate'); if (d && !d.value) d.value = today();
        renderExpenseHistory();
      }
      return result;
    };
  }

  console.log('✅ patch-v73.js loaded \u2014 Expenses page (OCR/AI receipt reading, flexible payment sources)');
})();
