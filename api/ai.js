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
    let userText = prompt;

    if (mode === "advisor") {
      systemText = `You are an expert construction accounting advisor for a company in Juba, South Sudan.
You speak both Tigrinya and English. Reply in the same language the user uses.
Here is the current company financial data:\n${context || ""}
Give clear, practical accounting advice. Be concise.`;
    } else {
      systemText = `You are a construction accounting AI for a company in Juba, South Sudan.
You understand Tigrinya and English. Parse the user's description of a financial transaction and return ONLY a JSON object with this exact structure:
{
  "type": "transaction type",
  "date": "YYYY-MM-DD",
  "amount": number_in_USD,
  "currency": "USD or SSP",
  "description": "short description in Tigrinya and English",
  "entries": [
    {"account": "Account Name", "type": "asset|liability|equity|revenue|expense", "debit": number_or_0, "credit": number_or_0}
  ]
}
Rules:
- Total debits MUST equal total credits
- Use proper double-entry bookkeeping
- Common accounts: Cash, Accounts Receivable, Accounts Payable, Contract Revenue, Salary Expense, Construction Materials, Work in Progress, Petty Cash, Fuel Expense, Equipment, Subcontractor Expense
- If currency is SSP, convert to USD using rate 1300 SSP = 1 USD
- Return ONLY the JSON, no markdown, no explanation`;
    }

    const geminiBody = {
      system_instruction: { parts: [{ text: systemText }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
    };

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(geminiBody) }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini error:", errText);
      return res.status(geminiRes.status).json({ error: `Gemini API error ${geminiRes.status}`, details: errText });
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return res.status(200).json({ result: text });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
}
