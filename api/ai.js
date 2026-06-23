module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { prompt, mode, context, systemPrompt, materials } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const GROQ_KEY = process.env.GROQ_KEY;
    if (!GROQ_KEY) return res.status(500).json({ error: "GROQ_KEY not set" });

    let systemText = "";

    if (mode === "advisor") {
      systemText = `You are an expert construction accounting advisor for a company operating in East Africa (Juba, South Sudan and Asmara, Eritrea).

LANGUAGE RULES — follow these exactly:
- If the user writes in Tigrinya, reply in Tigrinya using the ERITREAN (Asmara) dialect specifically — NOT the Tigray/Ethiopian dialect.
- Key Eritrean Tigrinya distinctions to follow:
  * Use "ኣነ" not "አነ" for "I"
  * Use "ይኹን" not "ይሁን" for "let it be / okay"
  * Use "ሕሳብ" for accounting/account (not "ሂሳብ" which is the Amharic/Tigray form)
  * Use "ስራሕ" for work (not "ስራ")
  * Use "ዋጋ" for price/cost
  * Use "ክፍሊት" for payment
  * Use "ገንዘብ" for money
  * Use "ሕቶ" for question
  * Formal polite address: use "ኣንቱ" not "አንተ"
  * Use Eritrean business terminology as used in Asmara commercial context
- If the user writes in English, reply in English
- Never mix Tigray dialect words into your Tigrinya responses
- Keep accounting terms clear — if a Tigrinya accounting term might be unfamiliar, you may add the English term in brackets e.g. "ሓሳብ ደፍተር (journal entry)"

Company data:
${context || ""}

Give clear, practical accounting advice. Be concise and direct.`;

    } else if (systemPrompt) {
      systemText = systemPrompt;

    } else {
      const matContext = materials && materials.length > 0
        ? `\nCURRENT INVENTORY:\n${materials.map(m => `- ${m.name}: ${m.qty} ${m.unit} @ $${m.cost}/unit`).join('\n')}`
        : '';

      systemText = `You are an expert construction accounting AI for a company in Juba, South Sudan and Asmara, Eritrea. You understand Eritrean Tigrinya (Asmara dialect) and English.
${matContext}

CRITICAL NUMBER RULES:
- Read the EXACT number the user typed. "4500" = 4500, not 3, not 45, not 4.5.
- Numbers with commas: 7,500 = 7500. Remove commas before using.
- NEVER use SSP prices as USD amounts.
- The "amount" field in JSON must equal the number the user stated.
- SELF-CHECK before returning: does your "amount" match what the user said? If not, fix it.

CRITICAL BALANCE RULE — THIS IS THE MOST IMPORTANT RULE:
- Total of all "debit" values MUST equal total of all "credit" values EXACTLY.
- Every single entry must have: sum(debits) == sum(credits) == amount.
- SELF-CHECK: add up all debit values, add up all credit values. They must be equal. If not, fix before returning.
- Example: amount=4500 → one entry debit=4500, one entry credit=4500. NOT debit=3, credit=4500.

CRITICAL JSON RULES:
- Return ONLY the JSON object, nothing else
- No markdown fences, no explanatory text
- All strings use straight double quotes "
- No trailing commas
- The "type" field at the top level must be a transaction category like "Payroll", "Purchase", "Invoice" etc — NEVER the word "string"

Return this exact structure:
{"type":"Payroll","date":"YYYY-MM-DD","amount":4500,"currency":"USD","description":"Daily laborers salary","prepaidMonths":null,"materialUsage":null,"entries":[{"account":"Salary Expense","type":"expense","debit":4500,"credit":0},{"account":"Cash","type":"asset","debit":0,"credit":4500}]}

ACCOUNTING RULES:
1. Debits = Credits ALWAYS — amount must appear in BOTH a debit and a credit
2. Pay cash → Cr Cash (credit=amount), Dr expense/asset (debit=amount)
3. Receive cash → Dr Cash (debit=amount), Cr Revenue (credit=amount)
4. Salary/ደሞዝ/laborers/wages → Dr Salary Expense (debit=amount), Cr Cash (credit=amount). Type="Payroll"
5. Rent ADVANCE "for X months" → Dr Prepaid Rent (debit=amount), Cr Cash (credit=amount), prepaidMonths=X, Type="Prepaid Rent"
6. Consume prepaid rent → Dr Rent Expense (debit=amount), Cr Prepaid Rent (credit=amount), Type="Rent Expense"
7. Buy materials cash → Dr Construction Materials (debit=amount), Cr Cash (credit=amount)
8. Buy materials credit → Dr Construction Materials (debit=amount), Cr Accounts Payable (credit=amount)
9. USE materials on site → Dr Work in Progress (debit=amount), Cr Construction Materials (credit=amount)
10. Client pays → Dr Cash (debit=amount), Cr Contract Revenue (credit=amount)
11. Invoice to client → Dr Accounts Receivable (debit=amount), Cr Contract Revenue (credit=amount)
12. Equipment purchase cash → Dr Equipment (debit=amount), Cr Cash (credit=amount)
13. Loan received → Dr Cash (debit=amount), Cr Loan Payable (credit=amount)
14. Fuel → Dr Fuel Expense (debit=amount), Cr Cash (credit=amount)
15. Owner capital → Dr Cash (debit=amount), Cr Owner Capital (credit=amount)
16. Depreciation → Dr Depreciation Expense (debit=amount, type=expense), Cr Accumulated Depreciation (credit=amount, type=contra-asset)
17. Subcontractor → Dr Subcontractor Expense (debit=amount), Cr Cash (credit=amount)

Today: ${new Date().toISOString().split('T')[0]}

FINAL SELF-CHECK before responding:
1. Is "amount" the exact number the user stated? ✓
2. Do all debits sum to equal all credits? ✓
3. Does each individual debit/credit equal the amount (for simple single transactions)? ✓
4. Is "type" a real transaction category, not the word "string"? ✓`;
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemText },
          { role: "user", content: prompt }
        ],
        temperature: 0.05,
        max_tokens: 1024
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Groq error:", err);
      return res.status(500).json({ error: "AI service error", details: err });
    }

    const data = await response.json();
    let text = data?.choices?.[0]?.message?.content || "";

    // SERVER-SIDE VALIDATION AND AUTO-CORRECTION
    // Parse, validate, and fix common AI mistakes before sending to browser
    if (mode !== "advisor") {
      text = validateAndFixEntry(text);
    }

    return res.status(200).json({ result: text });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
}

// Server-side correction: parses AI JSON, fixes unbalanced entries, wrong amounts, wrong type field,
// and depreciation inversions before the response ever reaches the browser.
function validateAndFixEntry(rawText) {
  try {
    let cleaned = rawText.trim()
      .replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return rawText;

    let parsed;
    try { parsed = JSON.parse(match[0]); }
    catch (e) {
      // Try fixing trailing commas and smart quotes
      try {
        const fixed = match[0]
          .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
          .replace(/,\s*([}\]])/g, '$1');
        parsed = JSON.parse(fixed);
      } catch { return rawText; }
    }

    if (!parsed || !Array.isArray(parsed.entries)) return rawText;

    // Fix 1: "type" field is literally "string" — replace with a proper category
    if (!parsed.type || parsed.type.toLowerCase() === 'string') {
      const desc = (parsed.description || '').toLowerCase();
      if (desc.includes('salary') || desc.includes('wage') || desc.includes('labor')) parsed.type = 'Payroll';
      else if (desc.includes('rent')) parsed.type = 'Rent';
      else if (desc.includes('material') || desc.includes('cement') || desc.includes('steel')) parsed.type = 'Material Purchase';
      else if (desc.includes('fuel')) parsed.type = 'Fuel';
      else if (desc.includes('invoice')) parsed.type = 'Invoice';
      else if (desc.includes('depreciation')) parsed.type = 'Depreciation';
      else parsed.type = 'General';
    }

    // Fix 2: entries where debit or credit values are wrong (e.g. debit=3 when amount=4500)
    const amount = parsed.amount || 0;
    if (amount > 0 && parsed.entries.length >= 2) {
      const totalDr = parsed.entries.reduce((s, e) => s + (parseFloat(e.debit) || 0), 0);
      const totalCr = parsed.entries.reduce((s, e) => s + (parseFloat(e.credit) || 0), 0);
      const isUnbalanced = Math.abs(totalDr - totalCr) > 0.01;
      const isWrongAmount = Math.abs(totalDr - amount) > 0.01 && Math.abs(totalCr - amount) > 0.01;

      if (isUnbalanced || isWrongAmount) {
        // For simple 2-entry transactions, just force the amount onto both sides correctly
        if (parsed.entries.length === 2) {
          const drEntry = parsed.entries.find(e => (parseFloat(e.debit) || 0) > 0 || (parseFloat(e.credit) || 0) === 0);
          const crEntry = parsed.entries.find(e => (parseFloat(e.credit) || 0) > 0 || (parseFloat(e.debit) || 0) === 0);
          if (drEntry && crEntry) {
            drEntry.debit = amount; drEntry.credit = 0;
            crEntry.credit = amount; crEntry.debit = 0;
          }
        }
      }
    }

    // Fix 3: depreciation inversion
    parsed.entries = parsed.entries.map(line => {
      const acct = (line.account || "").toLowerCase();
      if (acct.includes("depreciation expense") && (parseFloat(line.credit) || 0) > 0 && (parseFloat(line.debit) || 0) === 0) {
        return { ...line, debit: line.credit, credit: 0, type: "expense" };
      }
      if (acct.includes("accumulated depreciation") && (parseFloat(line.debit) || 0) > 0 && (parseFloat(line.credit) || 0) === 0) {
        return { ...line, credit: line.debit, debit: 0, type: "contra-asset" };
      }
      return line;
    });

    return JSON.stringify(parsed);
  } catch {
    return rawText;
  }
}


    if (mode === "advisor") {
      systemText = `You are an expert construction accounting advisor for a company operating in East Africa (Juba, South Sudan and Asmara, Eritrea).

LANGUAGE RULES — follow these exactly:
- If the user writes in Tigrinya, reply in Tigrinya using the ERITREAN (Asmara) dialect specifically — NOT the Tigray/Ethiopian dialect.
- Key Eritrean Tigrinya distinctions to follow:
  * Use "ኣነ" not "አነ" for "I"
  * Use "ይኹን" not "ይሁን" for "let it be / okay"
  * Use "ሕሳብ" for accounting/account (not "ሂሳብ" which is the Amharic/Tigray form)
  * Use "ስራሕ" for work (not "ስራ")
  * Use "ዋጋ" for price/cost
  * Use "ክፍሊት" for payment
  * Use "ገንዘብ" for money
  * Use "ሕቶ" for question
  * Formal polite address: use "ኣንቱ" not "አንተ"
  * Use Eritrean business terminology as used in Asmara commercial context
- If the user writes in English, reply in English
- Never mix Tigray dialect words into your Tigrinya responses
- Keep accounting terms clear — if a Tigrinya accounting term might be unfamiliar, you may add the English term in brackets e.g. "ሓሳብ ደፍተር (journal entry)"

Company data:
${context || ""}

Give clear, practical accounting advice. Be concise and direct.`;

    } else if (systemPrompt) {
      systemText = systemPrompt;

    } else {
      // Build materials context for AI
      const matContext = materials && materials.length > 0
        ? `\nCURRENT INVENTORY (use these unit costs for material usage):\n${materials.map(m => `- ${m.name}: ${m.qty} ${m.unit} @ $${m.cost}/unit`).join('\n')}`
        : '';

      systemText = `You are an expert construction accounting AI for a company in Juba, South Sudan and Asmara, Eritrea. You understand both Eritrean Tigrinya (Asmara dialect) and English. When the user writes in Tigrinya, recognize it as Eritrean dialect.

CRITICAL NUMBER RULE: Numbers like 7,500,000 = 7500000. NEVER use SSP prices as USD. Remove commas first.

NOTE ON INPUT SOURCE: the prompt may be a clean typed sentence OR raw OCR/scanned text extracted from a photographed receipt or PDF invoice. OCR text is often messy: broken line breaks, misread characters (0/O, 1/l/I, 5/S), repeated headers/footers, store boilerplate ("THANK YOU", "VAT REG NO"), and prices scattered across the page rather than in one sentence. When the input looks like a receipt dump rather than a sentence:
- Identify the vendor/supplier name (usually top of receipt)
- Identify the TOTAL or GRAND TOTAL line specifically — not subtotal, not a per-line item price, unless only one item is listed
- Identify the date if present (any common date format)
- Ignore tax registration numbers, phone numbers, and barcode/SKU numbers when picking the amount
- If multiple plausible totals exist and it's ambiguous, prefer the largest clearly-labeled total over a subtotal
${matContext}

CRITICAL JSON RULES — your response will be parsed by JSON.parse() directly:
- Return ONLY the JSON object, nothing else before or after it
- All string values must use straight double quotes " not smart/curly quotes
- Escape any apostrophes or quotes inside string values with a backslash: \"
- Never use newlines inside string values — use a space instead
- No trailing commas after the last item in arrays or objects
- The "description" field must be a single clean string with no special characters

Return ONLY valid JSON — no markdown, no text outside JSON:
{"type":"string","date":"YYYY-MM-DD","amount":number_USD,"currency":"USD","description":"description","prepaidMonths":null,"materialUsage":null,"entries":[{"account":"name","type":"asset|liability|equity|revenue|expense|contra-asset","debit":0,"credit":0}]}

MATERIAL USAGE (when someone says "used X bags/units of [material] on project"):
- Look up the unit cost from CURRENT INVENTORY above
- amount = quantity x unit_cost
- Set "materialUsage": {"name": "cement", "qty": 15}  <- so frontend can deduct stock
- Entry: Dr Work in Progress (asset), Cr Construction Materials (asset)
- currency is always "USD" for material usage

ACCOUNTING RULES (Dr = increase, Cr = decrease, for the account's normal side — follow EXACTLY, do not invert):
1. Debits = Credits ALWAYS
2. Pay cash → Cr Cash, Dr received
3. Receive cash → Dr Cash, Cr Revenue/Liability
4. Rent ADVANCE / "for X months" → Dr Prepaid Rent (asset), Cr Cash, prepaidMonths=X
5. Buy materials cash → Dr Construction Materials, Cr Cash
6. Buy materials credit → Dr Construction Materials, Cr Accounts Payable
7. USE materials on site → Dr Work in Progress, Cr Construction Materials. Use inventory cost.
8. Salary/ደሞዝ → Dr Salary Expense, Cr Cash
9. Client pays → Dr Cash, Cr Contract Revenue
10. Invoice to client → Dr Accounts Receivable, Cr Contract Revenue
11. Equipment → Dr Equipment, Cr Cash or Accounts Payable
12. Loan in → Dr Cash, Cr Loan Payable
13. Loan out → Dr Loan Payable, Cr Cash
14. Subcontractor → Dr Subcontractor Expense, Cr Cash
15. Fuel → Dr Fuel Expense, Cr Cash
16. Owner capital → Dr Cash, Cr Owner Capital
17. SSP ÷ 1300 = USD (only for SSP transactions, not for material usage)
18. Accrue/un-invoiced → Dr Project Expense, Cr Accrued Liabilities
19. Accrue salary unpaid → Dr Salary Expense, Cr Accrued Salaries Payable
20. DEPRECIATION (monthly or asset depreciation) → Dr Depreciation Expense (type "expense"), Cr Accumulated Depreciation (type "contra-asset"). NEVER reverse this. Accumulated Depreciation is NOT equity and is NEVER debited in a routine depreciation entry — it only grows on the credit side. Depreciation Expense is NEVER credited in a routine depreciation entry — it only grows on the debit side.

Today: ${new Date().toISOString().split('T')[0]}

Before returning, verify rule 20 specifically if the transaction involves depreciation: Depreciation Expense MUST be in "debit", Accumulated Depreciation MUST be in "credit", and Accumulated Depreciation's type MUST be "contra-asset" — never "equity" or "asset".

ALWAYS return valid JSON. NEVER return an error. If unsure about amount, use best estimate.`;
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemText },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 1024
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Groq error:", err);
      return res.status(500).json({ error: "AI service error", details: err });
    }

    const data = await response.json();
    let text = data?.choices?.[0]?.message?.content || "";

    // SERVER-SIDE SAFETY NET for Fix #4: guarantee depreciation entries can never be inverted,
    // even if the model ignores the prompt instructions. This runs after generation, before the
    // response reaches the frontend, so the preview card the user sees is always correct.
    text = correctDepreciationInversion(text);

    return res.status(200).json({ result: text });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
}

