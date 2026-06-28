// api/ai.js — Hisabi Hensi · AI handler (Groq llama-3.3-70b)
// Unchanged core logic, compatible with new multi-tenant schema

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
      systemText =
        "You are an expert construction accounting advisor for a company in Juba, South Sudan and Asmara, Eritrea.\n\n" +
        "LANGUAGE: If the user writes in Tigrinya, reply in ERITREAN (Asmara) dialect. " +
        "Key words: use 'hisab' not 'hisabi' for account, 'srah' for work, 'kifliti' for payment, 'genzeb' for money. " +
        "Never use Tigray/Ethiopian dialect. If English, reply English.\n\n" +
        "Company data:\n" + (context || "") + "\n\nGive clear practical advice.";

    } else if (systemPrompt) {
      systemText = systemPrompt;

    } else {
      const matContext = (materials && materials.length > 0)
        ? "\nCURRENT INVENTORY:\n" + materials.map(m =>
            "- " + m.name + ": " + m.qty + " " + m.unit + " @ $" + m.cost + "/unit"
          ).join("\n")
        : "";

      systemText =
        "You are a construction accounting AI for a company in Juba, South Sudan. You understand Tigrinya and English.\n" +
        matContext + "\n\n" +
        "CRITICAL NUMBER RULE: Read the EXACT number the user typed. 4500 = 4500. Never use a different number.\n\n" +
        "CRITICAL BALANCE RULE: sum of all debit values MUST equal sum of all credit values MUST equal the amount.\n" +
        "Example: amount=4500 means debit=4500 AND credit=4500. Not debit=3 and credit=4500.\n\n" +
        "CRITICAL JSON RULE: Return ONLY valid JSON. No markdown. No text outside JSON. No trailing commas.\n" +
        "The top-level 'type' field must be a category like Payroll, Purchase, Invoice, Rent, Fuel, General. NEVER the word 'string'.\n\n" +
        "Return this exact structure:\n" +
        '{"type":"Payroll","date":"YYYY-MM-DD","amount":4500,"currency":"USD","description":"Daily laborers salary","prepaidMonths":null,"materialUsage":null,"entries":[{"account":"Salary Expense","type":"expense","debit":4500,"credit":0},{"account":"Cash","type":"asset","debit":0,"credit":4500}]}\n\n' +
        "ACCOUNTING RULES:\n" +
        "1. Debits = Credits ALWAYS. amount appears in both a debit line and a credit line.\n" +
        "2. Pay cash: Dr expense/asset (debit=amount), Cr Cash (credit=amount)\n" +
        "3. Receive cash: Dr Cash (debit=amount), Cr Revenue (credit=amount)\n" +
        "4. Salary/laborers/wages: Dr Salary Expense (debit=amount), Cr Cash (credit=amount). type=Payroll\n" +
        "5. Rent advance 'for X months': Dr Prepaid Rent (debit=amount), Cr Cash (credit=amount), prepaidMonths=X\n" +
        "6. Consume prepaid rent: Dr Rent Expense (debit=amount), Cr Prepaid Rent (credit=amount)\n" +
        "7. Buy materials cash: Dr Construction Materials (debit=amount), Cr Cash (credit=amount)\n" +
        "8. Buy materials credit: Dr Construction Materials (debit=amount), Cr Accounts Payable (credit=amount)\n" +
        "9. Use materials on site: Dr Work in Progress (debit=amount), Cr Construction Materials (credit=amount)\n" +
        "10. Client pays: Dr Cash (debit=amount), Cr Contract Revenue (credit=amount)\n" +
        "11. Invoice to client: Dr Accounts Receivable (debit=amount), Cr Contract Revenue (credit=amount)\n" +
        "12. Equipment: Dr Equipment (debit=amount), Cr Cash (credit=amount)\n" +
        "13. Loan received: Dr Cash (debit=amount), Cr Loan Payable (credit=amount)\n" +
        "14. Fuel: Dr Fuel Expense (debit=amount), Cr Cash (credit=amount)\n" +
        "15. Owner capital: Dr Cash (debit=amount), Cr Owner Capital (credit=amount)\n" +
        "16. Depreciation: Dr Depreciation Expense type=expense (debit=amount), Cr Accumulated Depreciation type=contra-asset (credit=amount)\n" +
        "17. Subcontractor: Dr Subcontractor Expense (debit=amount), Cr Cash (credit=amount)\n" +
        "18. Accrue unpaid: Dr expense (debit=amount), Cr Accrued Liabilities (credit=amount)\n" +
        "19. SSP: divide by 1300 to get USD\n" +
        "20. Material usage: set materialUsage field. Use inventory cost from CURRENT INVENTORY above.\n\n" +
        "Today: " + new Date().toISOString().split("T")[0] + "\n\n" +
        "SELF-CHECK before responding:\n" +
        "1. Is amount the exact number the user stated?\n" +
        "2. Do all debits sum equal all credits sum equal the amount?\n" +
        "3. Is type a real category not the word string?";
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + GROQ_KEY
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

    if (mode !== "advisor") {
      text = validateAndFixEntry(text);
    }

    return res.status(200).json({ result: text });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
};

function validateAndFixEntry(rawText) {
  try {
    let cleaned = rawText.trim()
      .replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return rawText;
    let parsed;
    try { parsed = JSON.parse(match[0]); }
    catch {
      try {
        const fixed = match[0]
          .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
          .replace(/,\s*([}\]])/g, "$1");
        parsed = JSON.parse(fixed);
      } catch { return rawText; }
    }
    if (!parsed || !Array.isArray(parsed.entries)) return rawText;

    // Fix type = "string"
    if (!parsed.type || parsed.type.toLowerCase() === "string") {
      const desc = (parsed.description || "").toLowerCase();
      if (desc.includes("salary") || desc.includes("wage") || desc.includes("labor") || desc.includes("payroll")) parsed.type = "Payroll";
      else if (desc.includes("rent")) parsed.type = "Rent";
      else if (desc.includes("material") || desc.includes("cement") || desc.includes("steel") || desc.includes("gravel")) parsed.type = "Material Purchase";
      else if (desc.includes("fuel")) parsed.type = "Fuel";
      else if (desc.includes("invoice")) parsed.type = "Invoice";
      else if (desc.includes("depreciation")) parsed.type = "Depreciation";
      else if (desc.includes("delivery")) parsed.type = "Delivery";
      else parsed.type = "General";
    }

    // Fix unbalanced entries
    const amount = parsed.amount || 0;
    if (amount > 0 && parsed.entries.length >= 2) {
      const totalDr = parsed.entries.reduce((s, e) => s + (parseFloat(e.debit) || 0), 0);
      const totalCr = parsed.entries.reduce((s, e) => s + (parseFloat(e.credit) || 0), 0);
      const isUnbalanced = Math.abs(totalDr - totalCr) > 0.01;
      const isWrongAmount = Math.abs(totalDr - amount) > 0.01 && Math.abs(totalCr - amount) > 0.01;
      if ((isUnbalanced || isWrongAmount) && parsed.entries.length === 2) {
        const drEntry = parsed.entries.find(e => (parseFloat(e.debit) || 0) > 0 || (parseFloat(e.credit) || 0) === 0);
        const crEntry = parsed.entries.find(e => (parseFloat(e.credit) || 0) > 0 || (parseFloat(e.debit) || 0) === 0);
        if (drEntry && crEntry) {
          drEntry.debit = amount; drEntry.credit = 0;
          crEntry.credit = amount; crEntry.debit = 0;
        }
      }
    }

    // Fix depreciation inversion
    parsed.entries = parsed.entries.map(line => {
      const acct = (line.account || "").toLowerCase();
      if (acct.includes("depreciation expense") && (parseFloat(line.credit) || 0) > 0 && (parseFloat(line.debit) || 0) === 0)
        return { ...line, debit: line.credit, credit: 0, type: "expense" };
      if (acct.includes("accumulated depreciation") && (parseFloat(line.debit) || 0) > 0 && (parseFloat(line.credit) || 0) === 0)
        return { ...line, credit: line.debit, debit: 0, type: "contra-asset" };
      return line;
    });

    return JSON.stringify(parsed);
  } catch { return rawText; }
}
