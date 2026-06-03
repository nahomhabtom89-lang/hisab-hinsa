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
      systemText = `You are an expert construction accounting advisor for a company in Juba, South Sudan. You speak both Tigrinya and English. Reply in the same language the user uses. Here is the current company financial data:\n${context || ""}. Give clear, practical accounting advice. Be concise.`;
    } else {
      systemText = `You are a construction accounting AI for a company in Juba, South Sudan. You understand Tigrinya and English. Parse the user's description of a financial transaction and return ONLY a JSON object:
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
Rules: Total debits MUST equal total credits. Use proper double-entry bookkeeping. Common accounts: Cash, Accounts Receivable, Accounts Payable, Contract Revenue, Salary Expense, Construction Materials, Work in Progress, Petty Cash, Fuel Expense, Equipment, Subcontractor Expense. If currency is SSP convert to USD at 1300 SSP = 1 USD. Return ONLY the JSON, no markdown, no explanation.`;
    }

    // Try Gemini first, then fallback to groq (free)
    let result = await tryGemini(GEMINI_KEY, systemText, prompt);
    if (!result) result = await tryGroq(systemText, prompt);
    if (!result) return res.status(500).json({ error: "ኩሉ AI ጌጋ ኣሎ — All AI services failed. Please try again." });

    return res.status(200).json({ result });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
}

async function tryGemini(key, system, prompt) {
  const models = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-pro"];
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: system + "\n\nUser: " + prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
  });

  for (const model of models) {
    try {
      // Try API key style
      if (!key.startsWith("AQ.")) {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body }
        );
        if (r.ok) {
          const d = await r.json();
          return d?.candidates?.[0]?.content?.parts?.[0]?.text || null;
        }
      }
      // Try Bearer style
      const r2 = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` }, body }
      );
      if (r2.ok) {
        const d = await r2.json();
        return d?.candidates?.[0]?.content?.parts?.[0]?.text || null;
      }
      const err = await r2.text(); console.error(`Gemini ${model} failed:`, err.substring(0, 200));
    } catch (e) { console.error(`Gemini ${model} error:`, e.message); }
  }
  return null;
}

async function tryGroq(system, prompt) {
  // Groq is free - no key needed for basic usage via their public endpoint
  // Using Groq free tier with llama
  try {
    const GROQ_KEY = process.env.GROQ_KEY;
    if (!GROQ_KEY) { console.log("No GROQ_KEY set, skipping groq"); return null; }
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        temperature: 0.3, max_tokens: 1024
      })
    });
    if (r.ok) {
      const d = await r.json();
      return d?.choices?.[0]?.message?.content || null;
    }
    const err = await r.text(); console.error("Groq failed:", err.substring(0, 200));
  } catch (e) { console.error("Groq error:", e.message); }
  return null;
}
