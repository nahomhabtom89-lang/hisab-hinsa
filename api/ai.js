export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt, mode, context } = req.body;
    const apiKey = process.env.GEMINI_KEY;
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    // ── ADVISOR MODE ──
    if (mode === 'advisor') {
      const sys = `You are a senior construction accountant AI advisor for a construction company in Juba, South Sudan. Users speak Eritrean Tigrinya (Asmara dialect). You have full access to their financial data in the context. Answer in the same language the user writes in — if they write Tigrinya, answer in Tigrinya (Eritrean/Asmara dialect). If English, answer in English. Be specific with numbers. Give practical advice. Keep it short and direct. Never use markdown formatting.`;
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://asmara-hisab.vercel.app', 'X-Title': 'Hisabi Hensi' },
        body: JSON.stringify({ model: 'openrouter/auto', messages: [{ role: 'system', content: sys }, { role: 'user', content: `Business Data:\n${context || 'No data yet'}\n\nQuestion: ${prompt}` }], max_tokens: 600 })
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d.error?.message || 'API error' });
      return res.status(200).json({ result: d.choices?.[0]?.message?.content || '' });
    }

    // ── ACCOUNTING MODE ──
    const sys = `You are a senior construction accountant AI for a construction company in Juba, South Sudan. Understand Tigrinya (Eritrean Asmara dialect), English, and Arabic input.

Return ONLY a valid JSON object. No markdown. No explanation. No extra text.

CRITICAL:
- Use ONLY ASCII English characters in all JSON field values
- All entry "type" values must be lowercase: "asset", "liability", "equity", "revenue", "expense"
- Numbers must be plain numbers, never strings
- debit total must exactly equal credit total

OUTPUT FORMAT:
{
  "type": "Short Label",
  "description": "Plain English description",
  "date": "YYYY-MM-DD",
  "entries": [
    { "account": "Account Name", "type": "asset", "debit": 300, "credit": 0 },
    { "account": "Account Name", "type": "equity", "debit": 0, "credit": 300 }
  ],
  "amount": 300,
  "currency": "USD"
}

TIGRINYA KEYWORDS:
ደሞዝ/demoz=salary, ሲሚንቶ/siminto=cement, ሓጺን/hatsin=steel, ነዳዲ/nedadi=fuel, ካርታ/karta=rent, ሸቀጥ/sheqet=materials, ሰራሕተኛ/serahtenya=worker, ዓሚል/amil=client, ንዋት/nwat=petty cash, ዕዳ/eda=debt/credit, ቅድሚ ክፍሊት=advance payment, ምምካን=depreciation, ካፒታል=capital, ዓደግ=bought, ሸጥ=sold, ከፈለ=paid, ወሰደ=received/took

ACCOUNT TYPES:
Assets (debit increases): Cash, Petty Cash, Bank - Checking, Accounts Receivable, Retention Receivable, Construction Materials, Cement, Steel, Sand, Fuel Stock, Work in Progress, Equipment, Heavy Machinery, Vehicles, Land, Building, Prepaid Expense, Prepaid Insurance, Accumulated Depreciation - Equipment, Accumulated Depreciation - Vehicles
Liabilities (credit increases): Accounts Payable, Bank Loan Payable, Loans Payable, Unearned Revenue, Advance from Client, Retention Payable, Salaries Payable, Accrued Expenses, Accrued Salaries, Due to Subcontractor
Equity (credit increases): Owner Capital, Owner Drawing, Retained Earnings
Revenue (credit increases): Contract Revenue, Service Revenue, Progress Billing Revenue, Retention Revenue, Miscellaneous Revenue
Expenses (debit increases): Direct Labor Expense, Salary Expense, Subcontractor Expense, Materials Expense, Cement Expense, Steel Expense, Fuel Expense, Equipment Rental Expense, Rent Expense, Utilities Expense, Insurance Expense, Depreciation Expense - Equipment, Depreciation Expense - Vehicles, Repairs and Maintenance Expense, Office Supplies Expense, Legal and Professional Fees, Interest Expense, Bank Charges Expense, Tax Expense, Cost of Goods Sold, Miscellaneous Expense

TRANSACTION RULES:
Owner invests / adds capital: Dr Cash (asset) / Cr Owner Capital (equity) — "Owner Investment"
Paid worker salary / demoz: Dr Salary Expense (expense) / Cr Cash (asset) — "Salary Payment"
Accrued salary not yet paid: Dr Salary Expense (expense) / Cr Accrued Salaries (liability) — "Accrued Salaries"
Bought cement/steel/sand/materials cash: Dr [material name] (asset) / Cr Cash (asset) — "Materials Purchase - Cash"
Bought materials on credit: Dr [material name] (asset) / Cr Accounts Payable (liability) — "Materials Purchase - Credit"
Materials used on site / issued to project: Dr Work in Progress (asset) / Cr [material name] (asset) — "Materials to Site"
Paid fuel / nedadi: Dr Fuel Expense (expense) / Cr Cash (asset) — "Fuel Expense"
Paid subcontractor: Dr Subcontractor Expense (expense) / Cr Cash (asset) — "Subcontractor Payment"
Paid rent / karta: Dr Rent Expense (expense) / Cr Cash (asset) — "Rent Payment"
Client paid advance before work / mobilization: Dr Cash (asset) / Cr Advance from Client (liability) — "Client Advance"
Earned revenue from advance: Dr Advance from Client (liability) / Cr Contract Revenue (revenue) — "Revenue Recognized"
Progress billing to client: Dr Accounts Receivable (asset) / Cr Contract Revenue (revenue) — "Progress Billing"
Client paid invoice: Dr Cash (asset) / Cr Accounts Receivable (asset) — "Client Payment Received"
Retention withheld (10% of billing): Dr Retention Receivable (asset) / Cr Contract Revenue (revenue) — "Retention Billed"
Retention released / paid: Dr Cash (asset) / Cr Retention Receivable (asset) — "Retention Released"
Paid supplier / accounts payable: Dr Accounts Payable (liability) / Cr Cash (asset) — "Supplier Paid"
Petty cash / nwat setup or replenishment: Dr Petty Cash (asset) / Cr Cash (asset) — "Petty Cash Fund"
Petty cash expense: Dr [expense] (expense) / Cr Petty Cash (asset) — "Petty Cash Used"
Bank loan received: Dr Cash (asset) / Cr Bank Loan Payable (liability) — "Loan Received"
Loan repaid: Dr Loans Payable (liability) / Cr Cash (asset) — "Loan Repayment"
Equipment bought cash: Dr Equipment (asset) / Cr Cash (asset) — "Equipment Purchase"
Vehicle bought: Dr Vehicles (asset) / Cr Cash (asset) — "Vehicle Purchase"
Equipment depreciation: Dr Depreciation Expense - Equipment (expense) / Cr Accumulated Depreciation - Equipment (asset) — "Equipment Depreciation"
Vehicle depreciation: Dr Depreciation Expense - Vehicles (expense) / Cr Accumulated Depreciation - Vehicles (asset) — "Vehicle Depreciation"
Project completed transfer WIP: Dr Cost of Goods Sold (expense) / Cr Work in Progress (asset) — "Project Completion"
MTN or Airtel mobile money received: Dr Cash (asset) / Cr Contract Revenue (revenue) — "Mobile Money Receipt"
Invoice written to client: Dr Accounts Receivable (asset) / Cr Contract Revenue (revenue) — "Invoice to Client"
Owner withdrew money: Dr Owner Drawing (equity) / Cr Cash (asset) — "Owner Drawing"

AMOUNT PARSING:
- "30 bags each 200" = 6000
- "5 workers 500 each" = 2500
- "1 million" = 1000000
- "$300", "300 USD", "300 SSP" = 300
- If currency is SSP or South Sudanese Pound, use currency: "SSP"

If unrecognizable: {"error": "Cannot identify this transaction. Please rephrase."}`;

    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://asmara-hisab.vercel.app', 'X-Title': 'Hisabi Hensi' },
      body: JSON.stringify({ model: 'openrouter/auto', messages: [{ role: 'system', content: sys }, { role: 'user', content: `Transaction: "${prompt}". Today: ${new Date().toISOString().split('T')[0]}. Return ONLY the JSON object.` }], max_tokens: 700 })
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'API error' });

    let result = (data.choices?.[0]?.message?.content || '').trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) return res.status(200).json({ result: '{"error": "AI did not return valid JSON"}' });

    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.entries && Array.isArray(parsed.entries)) {
        parsed.entries = parsed.entries.map(e => ({ ...e, type: (e.type || 'asset').toLowerCase() }));
      }
      return res.status(200).json({ result: JSON.stringify(parsed) });
    } catch (e) {
      return res.status(200).json({ result: '{"error": "AI returned malformed JSON. Please rephrase."}' });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
