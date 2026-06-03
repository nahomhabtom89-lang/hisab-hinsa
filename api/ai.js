export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { prompt, mode, context } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const GEMINI_KEY = process.env.GEMINI_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_KEY not set" });

    let systemText = "";
    if (mode === "advisor") {
      systemText = `You are an expert construction accounting advisor for a company in Juba, South Sudan. You speak both Tigrinya and English fluently. Always reply in the same language the user writes in. Here is the current company financial data:\n${context || ""}\nGive clear, practical, specific accounting advice. Be concise and helpful.`;
    } else {
      systemText = `You are an expert construction accounting AI for a company in Juba, South Sudan. You understand Tigrinya and English perfectly.

Your job: parse ANY financial transaction and return PERFECTLY correct double-entry bookkeeping JSON.

Return ONLY this JSON, no markdown, no explanation, no extra text:
{
  "type": "transaction type",
  "date": "YYYY-MM-DD",
  "amount": number_in_USD,
  "currency": "USD or SSP",
  "description": "clear description in Tigrinya and English",
  "entries": [
    {"account": "Account Name", "type": "asset|liability|equity|revenue|expense", "debit": number_or_0, "credit": number_or_0}
  ]
}

CRITICAL ACCOUNTING RULES:
1. Debits MUST always equal Credits exactly
2. PAYING cash = Credit Cash, Debit what you got
3. RECEIVING cash = Debit Cash, Credit Revenue or Liability
4. Prepaid rent/insurance (advance payment) = Debit Prepaid Rent (asset), Credit Cash
5. Buy materials cash = Debit Construction Materials (asset), Credit Cash
6. Buy materials credit = Debit Construction Materials (asset), Credit Accounts Payable
7. Pay salary = Debit Salary Expense, Credit Cash
8. Client pays us = Debit Cash, Credit Contract Revenue
9. We bill client = Debit Accounts Receivable, Credit Contract Revenue
10. Buy equipment cash = Debit Equipment (asset), Credit Cash
11. Loan received = Debit Cash, Credit Loan Payable
12. Loan repayment = Debit Loan Payable, Credit Cash
13. Pay subcontractor = Debit Subcontractor Expense, Credit Cash
14. Buy fuel = Debit Fuel Expense, Credit Cash
15. Owner invests = Debit Cash, Credit Owner Capital
16. SSP currency: divide by 1300 for USD
17. "paid for X months in advance" = Prepaid asset not expense

Today: ${new Date().toISOString().split('T')[0]}`;
    }

    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: systemText + "\n\nUser: " + prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
    });

    const models = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash", "gemini-pro"];

    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      
      // Try all 3 auth methods
      const attempts = [
        { headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY } },
        { url: url + `?key=${GEMINI_KEY}`, headers: { "Content-Type": "application/json" } },
        { headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GEMINI_KEY}` } },
      ];

      for (const attempt of attempts) {
        try {
          const r = await fetch(attempt.url || url, {
            method: "POST",
            headers: attempt.headers,
            body
          });
          if (r.ok) {
            const d = await r.json();
            const text = d?.candidates?.[0]?.content?.parts?.[0]?.text || "";
            console.log(`Success: model=${model}`);
            return res.status(200).json({ result: text });
          }
          const errText = await r.text();
          console.error(`Failed model=${model} status=${r.status}:`, errText.substring(0, 150));
        } catch (e) {
          console.error(`Exception model=${model}:`, e.message);
        }
      }
    }

    return res.status(500).json({ error: "ኩሉ ፈተነ ጌጋ — All attempts failed. Check logs." });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
}
