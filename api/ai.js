export default async function handler(req, res) {
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
      systemText = `You are an expert construction accounting advisor for a company in Juba, South Sudan. You speak Tigrinya and English. Reply in the same language the user uses.\nCompany data:\n${context || ""}\nGive clear practical advice.`;

    } else if (systemPrompt) {
      systemText = systemPrompt;

    } else {
      // Build materials context for AI
      const matContext = materials && materials.length > 0
        ? `\nCURRENT INVENTORY (use these unit costs for material usage):\n${materials.map(m => `- ${m.name}: ${m.qty} ${m.unit} @ $${m.cost}/unit`).join('\n')}`
        : '';

      systemText = `You are an expert construction accounting AI for a company in Juba, South Sudan. You understand Tigrinya and English.

CRITICAL NUMBER RULE: Numbers like 7,500,000 = 7500000. NEVER use SSP prices as USD. Remove commas first.
${matContext}

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

// Detects a depreciation entry and, if Accumulated Depreciation/Depreciation Expense
// were generated on the wrong side, swaps debit/credit values back to correct double-entry form.
function correctDepreciationInversion(rawText) {
  try {
    let cleaned = rawText.trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/```\s*$/, "")
      .trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return rawText;

    const parsed = JSON.parse(match[0]);
    if (!parsed.entries || !Array.isArray(parsed.entries)) return rawText;

    let touched = false;
    parsed.entries = parsed.entries.map(line => {
      const acct = (line.account || "").toLowerCase();
      const isDepExpense = acct.includes("depreciation expense");
      const isAccumDep = acct.includes("accumulated depreciation");

      if (isDepExpense && (+line.credit || 0) > 0 && (+line.debit || 0) === 0) {
        // Was wrongly credited — flip to debit
        line = { ...line, debit: line.credit, credit: 0, type: "expense" };
        touched = true;
      } else if (isDepExpense) {
        line = { ...line, type: "expense" };
      }

      if (isAccumDep && (+line.debit || 0) > 0 && (+line.credit || 0) === 0) {
        // Was wrongly debited — flip to credit
        line = { ...line, credit: line.debit, debit: 0, type: "contra-asset" };
        touched = true;
      } else if (isAccumDep) {
        line = { ...line, type: "contra-asset" };
      }

      return line;
    });

    if (!touched) return rawText;
    return JSON.stringify(parsed);
  } catch {
    // If parsing fails for any reason, fall back to the original text untouched
    return rawText;
  }
}
