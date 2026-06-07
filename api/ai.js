export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { prompt, mode, context, systemPrompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const GROQ_KEY = process.env.GROQ_KEY;
    if (!GROQ_KEY) return res.status(500).json({ error: "GROQ_KEY not set" });

    let systemText = "";

    if (mode === "advisor") {
      systemText = `You are an expert construction accounting advisor for a company in Juba, South Sudan (NOT Ethiopia). You speak Tigrinya and English. Reply in the same language the user uses. Here is the company data:\n${context || ""}\nGive clear, practical advice. Be concise.`;

    } else if (systemPrompt) {
      systemText = systemPrompt;

    } else {
      systemText = `You are an expert construction accounting AI for a company in Juba, South Sudan (NOT Ethiopia, NOT Eritrea). You understand Tigrinya and English perfectly.

CRITICAL NUMBER RULE: 7,500,000 = seven million five hundred thousand. NEVER truncate. Remove commas: 7,500,000 = 7500000.

Return ONLY valid JSON — no markdown, no text outside JSON:
{"type":"string","date":"YYYY-MM-DD","amount":number_USD,"currency":"USD or SSP","description":"Tigrinya + English","prepaidMonths":null,"entries":[{"account":"name","type":"asset|liability|equity|revenue|expense","debit":0,"credit":0}]}

MATERIAL USAGE RULE (very important):
When someone says "used X bags/units of [material] for [project]" — this is consuming inventory, NOT buying.
- If you know the unit cost: Dr Work in Progress (asset), Cr Construction Materials (asset)
- If you do NOT know the unit cost: USE amount=1 as placeholder and STILL return valid JSON with Dr Work in Progress, Cr Construction Materials. NEVER return an error for material usage.
- The amount for material usage = quantity x unit_cost. If unit_cost unknown, use 1 per unit as placeholder.

ACCOUNTING RULES:
1. Sum of debits = sum of credits ALWAYS
2. Pay cash → Cr Cash, Dr received
3. Receive cash → Dr Cash, Cr Revenue/Liability
4. Rent/insurance ADVANCE or "for X months" → Dr Prepaid Rent (asset), Cr Cash. Set prepaidMonths=X. NEVER Rent Expense for advance.
5. Buy materials cash → Dr Construction Materials, Cr Cash
6. Buy materials credit → Dr Construction Materials, Cr Accounts Payable
7. USE/consume materials on site → Dr Work in Progress, Cr Construction Materials
8. Salary/ደሞዝ → Dr Salary Expense, Cr Cash
9. Client pays → Dr Cash, Cr Contract Revenue
10. Invoice to client → Dr Accounts Receivable, Cr Contract Revenue
11. Equipment cash → Dr Equipment, Cr Cash
12. Loan in → Dr Cash, Cr Loan Payable
13. Loan out → Dr Loan Payable, Cr Cash
14. Subcontractor → Dr Subcontractor Expense, Cr Cash
15. Fuel/ነዳዲ → Dr Fuel Expense, Cr Cash
16. Owner capital → Dr Cash, Cr Owner Capital
17. SSP ÷ ${1300} = USD
18. Accrue/un-invoiced/pending → Dr Project Expense, Cr Accrued Liabilities
19. Accrue salary unpaid → Dr Salary Expense, Cr Accrued Salaries Payable
20. Reverse accrual → Dr Accrued Liabilities, Cr Project Expense

ACCOUNTS:
Assets: Cash, Petty Cash, Accounts Receivable, Retention Receivable, Construction Materials, Prepaid Rent, Prepaid Insurance, Equipment, Vehicles, Work in Progress, Costs in Excess of Billings, Accumulated Depreciation - Equipment
Liabilities: Accounts Payable, Loan Payable, Retention Payable, Accrued Liabilities, Accrued Salaries Payable, Billings in Excess of Costs
Equity: Owner Capital, Retained Earnings
Revenue: Contract Revenue, Other Income
Expenses: Salary Expense, Subcontractor Expense, Fuel Expense, Rent Expense, Depreciation Expense - Equipment, Repairs and Maintenance Expense, Office Supplies Expense, Miscellaneous Expense, Project Expense

Today: ${new Date().toISOString().split('T')[0]}

IMPORTANT: You MUST always return valid JSON. NEVER return an error message or plain text. If you are unsure about amounts, use a best estimate. If unit cost is unknown for material usage, use quantity x 1 as the amount placeholder.`;
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
    const text = data?.choices?.[0]?.message?.content || "";
    return res.status(200).json({ result: text });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
}
