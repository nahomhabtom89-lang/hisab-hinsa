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

    // openrouter/free automatically uses free models - no payment needed
    const MODEL = 'openrouter/free';

    // ADVISOR MODE
    if (mode === 'advisor') {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://hisab-hinsa.vercel.app',
          'X-Title': 'Hisabi Hensi'
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: 'You are a senior construction accountant advisor for a company in Juba, South Sudan. Answer in the same language the user writes in (English or Tigrinya). Be specific and practical.' },
            { role: 'user', content: `Business Data:\n${context || 'No data yet'}\n\nQuestion: ${prompt}` }
          ],
          max_tokens: 500
        })
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d.error?.message || 'API error' });
      return res.status(200).json({ result: d.choices?.[0]?.message?.content || '' });
    }

    // ACCOUNTING MODE
    const sys = `You are a senior construction accountant. Understand Tigrinya (Eritrean/Asmara dialect), English, Arabic.

Return ONLY valid JSON. No markdown. No explanation. No extra text before or after.

FORMAT:
{"type":"Label","description":"English description","date":"YYYY-MM-DD","entries":[{"account":"Account Name","type":"asset","debit":300,"credit":0},{"account":"Account Name","type":"equity","debit":0,"credit":300}],"amount":300,"currency":"USD"}

STRICT RULES:
- type field must be EXACTLY one of: asset, liability, equity, revenue, expense (all lowercase)
- debit total MUST equal credit total
- Use only ASCII English in all JSON values
- Numbers must be plain numbers not strings

ACCOUNTS:
asset: Cash, Petty Cash, Accounts Receivable, Retention Receivable, Construction Materials, Work in Progress, Equipment, Vehicles, Accumulated Depreciation - Equipment, Accumulated Depreciation - Vehicles
liability: Accounts Payable, Bank Loan Payable, Advance from Client, Retention Payable, Salaries Payable, Unearned Revenue
equity: Owner Capital, Owner Drawing
revenue: Contract Revenue, Service Revenue, Sales Revenue, Miscellaneous Revenue
expense: Salary Expense, Direct Labor Expense, Subcontractor Expense, Materials Expense, Fuel Expense, Rent Expense, Utilities Expense, Depreciation Expense - Equipment, Depreciation Expense - Vehicles, Repairs and Maintenance Expense, Cost of Goods Sold, Miscellaneous Expense

COMMON TRANSACTIONS:
- Owner invests money / kapital / ካፒታል: Dr Cash(asset) Cr Owner Capital(equity) "Owner Investment"
- Pay salary / demoz / ደሞዝ: Dr Salary Expense(expense) Cr Cash(asset) "Salary Payment"
- Buy cement/steel/materials / siminto / ሲሚንቶ cash: Dr Construction Materials(asset) Cr Cash(asset) "Materials Purchase - Cash"
- Buy materials credit / ዕዳ: Dr Construction Materials(asset) Cr Accounts Payable(liability) "Materials Purchase - Credit"
- Pay fuel / nedadi / ነዳዲ: Dr Fuel Expense(expense) Cr Cash(asset) "Fuel Expense"
- Pay subcontractor / ሰብ ስርሒት: Dr Subcontractor Expense(expense) Cr Cash(asset) "Subcontractor Payment"
- Pay rent / karta / ካርታ: Dr Rent Expense(expense) Cr Cash(asset) "Rent Payment"
- Client advance / ቅድሚ ክፍሊት: Dr Cash(asset) Cr Advance from Client(liability) "Client Advance"
- Progress billing to client: Dr Accounts Receivable(asset) Cr Contract Revenue(revenue) "Progress Billing"
- Client paid invoice: Dr Cash(asset) Cr Accounts Receivable(asset) "Client Payment"
- Bank loan: Dr Cash(asset) Cr Bank Loan Payable(liability) "Loan Received"
- Buy equipment / ማሽን: Dr Equipment(asset) Cr Cash(asset) "Equipment Purchase"
- Buy vehicle / ሎሚ: Dr Vehicles(asset) Cr Cash(asset) "Vehicle Purchase"
- Depreciation: Dr Depreciation Expense - Equipment(expense) Cr Accumulated Depreciation - Equipment(asset) "Equipment Depreciation"

If cannot identify: {"error":"Cannot identify. Please rephrase."}`;

    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://hisab-hinsa.vercel.app',
        'X-Title': 'Hisabi Hensi'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `Transaction: "${prompt}". Today: ${new Date().toISOString().split('T')[0]}. Return ONLY the JSON object, nothing else.` }
        ],
        max_tokens: 600
      })
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'API error ' + r.status });

    let result = (data.choices?.[0]?.message?.content || '').trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

    const match = result.match(/\{[\s\S]*\}/);
    if (!match) return res.status(200).json({ result: '{"error": "AI did not return valid JSON. Please try again."}' });

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
