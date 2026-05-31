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

    // Use free models - these are 100% free on OpenRouter
    const FREE_MODELS = [
      'google/gemini-2.0-flash-exp:free',
      'meta-llama/llama-3.1-8b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'qwen/qwen-2-7b-instruct:free'
    ];

    const model = FREE_MODELS[0]; // Try free Gemini first

    // ADVISOR MODE
    if (mode === 'advisor') {
      const sys = `You are a senior construction accountant AI advisor for a construction company in Juba, South Sudan. Users speak Eritrean Tigrinya (Asmara dialect). Answer in the same language the user writes in. Be specific with numbers. Give practical advice. Keep it short and direct.`;
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://hisab-hinsa.vercel.app',
          'X-Title': 'Hisabi Hensi'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: `Business Data:\n${context || 'No data yet'}\n\nQuestion: ${prompt}` }
          ],
          max_tokens: 500
        })
      });
      const d = await r.json();
      if (!r.ok) {
        // Try backup free model
        const r2 = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://hisab-hinsa.vercel.app', 'X-Title': 'Hisabi Hensi' },
          body: JSON.stringify({ model: FREE_MODELS[1], messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }], max_tokens: 500 })
        });
        const d2 = await r2.json();
        return res.status(200).json({ result: d2.choices?.[0]?.message?.content || 'Could not get response' });
      }
      return res.status(200).json({ result: d.choices?.[0]?.message?.content || '' });
    }

    // ACCOUNTING MODE
    const sys = `You are a senior construction accountant. Understand Tigrinya, English, Arabic.

Return ONLY valid JSON. No markdown. No explanation.

FORMAT:
{"type":"Label","description":"English description","date":"YYYY-MM-DD","entries":[{"account":"Name","type":"asset","debit":0,"credit":0}],"amount":0,"currency":"USD"}

RULES:
- type values: "asset" "liability" "equity" "revenue" "expense" (lowercase only)
- debit total must equal credit total
- ASCII English only in JSON values

ACCOUNTS:
Assets: Cash, Petty Cash, Accounts Receivable, Retention Receivable, Construction Materials, Work in Progress, Equipment, Vehicles, Accumulated Depreciation - Equipment, Accumulated Depreciation - Vehicles
Liabilities: Accounts Payable, Bank Loan Payable, Unearned Revenue, Advance from Client, Retention Payable, Salaries Payable, Accrued Salaries
Equity: Owner Capital, Owner Drawing
Revenue: Contract Revenue, Service Revenue, Sales Revenue
Expenses: Salary Expense, Direct Labor Expense, Subcontractor Expense, Materials Expense, Fuel Expense, Rent Expense, Utilities Expense, Depreciation Expense - Equipment, Depreciation Expense - Vehicles, Repairs and Maintenance Expense, Interest Expense, Miscellaneous Expense, Cost of Goods Sold

RULES:
Owner invests/capital/kapital: Dr Cash(asset) Cr Owner Capital(equity) type:"Owner Investment"
Paid salary/demoz/worker: Dr Salary Expense(expense) Cr Cash(asset) type:"Salary Payment"
Bought materials/cement/steel/siminto cash: Dr Construction Materials(asset) Cr Cash(asset) type:"Materials Purchase - Cash"
Bought materials credit: Dr Construction Materials(asset) Cr Accounts Payable(liability) type:"Materials Purchase - Credit"
Paid fuel/nedadi: Dr Fuel Expense(expense) Cr Cash(asset) type:"Fuel Expense"
Paid subcontractor: Dr Subcontractor Expense(expense) Cr Cash(asset) type:"Subcontractor Payment"
Paid rent/karta: Dr Rent Expense(expense) Cr Cash(asset) type:"Rent Payment"
Client advance: Dr Cash(asset) Cr Advance from Client(liability) type:"Client Advance"
Progress billing: Dr Accounts Receivable(asset) Cr Contract Revenue(revenue) type:"Progress Billing"
Client paid: Dr Cash(asset) Cr Accounts Receivable(asset) type:"Client Payment"
Loan received: Dr Cash(asset) Cr Bank Loan Payable(liability) type:"Loan Received"
Equipment bought: Dr Equipment(asset) Cr Cash(asset) type:"Equipment Purchase"
Vehicle bought: Dr Vehicles(asset) Cr Cash(asset) type:"Vehicle Purchase"
Depreciation equipment: Dr Depreciation Expense - Equipment(expense) Cr Accumulated Depreciation - Equipment(asset) type:"Equipment Depreciation"

If unknown: {"error":"Cannot identify. Please rephrase."}`;

    // Try each free model until one works
    for (const tryModel of FREE_MODELS) {
      try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://hisab-hinsa.vercel.app',
            'X-Title': 'Hisabi Hensi'
          },
          body: JSON.stringify({
            model: tryModel,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: `Transaction: "${prompt}". Date: ${new Date().toISOString().split('T')[0]}. Return ONLY the JSON.` }
            ],
            max_tokens: 600
          })
        });

        const data = await r.json();
        if (!r.ok || data.error) continue; // Try next model

        let result = (data.choices?.[0]?.message?.content || '').trim()
          .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
        const match = result.match(/\{[\s\S]*\}/);
        if (!match) continue;

        const parsed = JSON.parse(match[0]);
        if (parsed.entries && Array.isArray(parsed.entries)) {
          parsed.entries = parsed.entries.map(e => ({ ...e, type: (e.type || 'asset').toLowerCase() }));
        }
        return res.status(200).json({ result: JSON.stringify(parsed) });
      } catch (e) {
        continue; // Try next model
      }
    }

    return res.status(200).json({ result: '{"error": "All free models failed. Please try again."}' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
