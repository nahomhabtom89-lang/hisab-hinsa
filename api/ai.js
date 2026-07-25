// api/ai.js — Hisabi Hensi · AI handler (Groq llama-3.3-70b)
// Unchanged core logic, compatible with new multi-tenant schema

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { prompt, mode, context, systemPrompt, materials, projects, products, appMode, docContext } = req.body;
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

    } else if (mode === "universalDocument") {
      // ── UNIVERSAL DOCUMENT PARSER ──────────────────────────────────────────
      // A general-purpose classifier + poster for ANY uploaded document (sales/purchase
      // invoices, credit/debit notes, payroll slips, bank statements, loan agreements,
      // asset purchases, inventory sheets, journal vouchers, etc.) — not just receipts for
      // stock intake. Recommended debits/credits are constrained to this company's ACTUAL
      // Chart of Accounts (injected below) so the review screen can offer real, selectable
      // accounts instead of the AI inventing new ones.
      const coaList = (docContext && docContext.chartOfAccounts) || [];
      const coaText = coaList.length
        ? coaList.map(a => `- ${a.name} (${a.account_type})`).join("\n")
        : "(no accounts on file — use standard account names)";
      const isVatRegistered = !!(docContext && docContext.isVatRegistered);
      const baseCurrency = (docContext && docContext.baseCurrency) || "USD";
      const customersList = (docContext && docContext.customers) || [];
      const suppliersList = (docContext && docContext.suppliers) || [];

      systemText =
        "You are an autonomous AI Accountant and Document Parser for an advanced ERP application.\n\n" +
        "YOUR OBJECTIVE:\n" +
        "Analyze the provided document (image scan, receipt photo, or raw text input) from the app's \"Record\" page. " +
        "Auto-detect the exact transaction type, extract line items and parties, apply local/foreign currency logic, " +
        "determine dynamic tax handling, and output structured JSON ready for automatic ledger posting.\n\n" +
        "--------------------------------------------------\n" +
        "1. DOCUMENT CLASSIFICATION & TRANSACTION MATCHING\n" +
        "--------------------------------------------------\n" +
        "Identify the document type from this specific list:\n" +
        "- \"SALES_INVOICE\": Billed sales to clients/customers.\n" +
        "- \"PURCHASE_INVOICE\": Inbound vendor bills for goods/materials.\n" +
        "- \"TAX_INVOICE\": Official VAT invoice containing tax breakdown.\n" +
        "- \"CREDIT_NOTE\": Sales returns from customers (Contra-revenue).\n" +
        "- \"DEBIT_NOTE\": Purchase returns to vendors (Inventory reduction).\n" +
        "- \"CASH_RECEIPT\": Proof of cash received.\n" +
        "- \"PAYMENT_VOUCHER\": Cash/Bank disbursement or payment out.\n" +
        "- \"PURCHASE_ORDER\": Operational stock request (Non-posting until fulfilled).\n" +
        "- \"SALES_ORDER\": Customer sales commitment (Non-posting).\n" +
        "- \"DELIVERY_NOTE\": Goods movement / dispatch slip.\n" +
        "- \"EXPENSE_RECEIPT\": General operating expenses or petty cash receipts.\n" +
        "- \"PAYROLL_SLIP\": Employee wages, PAYE tax, NSSF, or allowances.\n" +
        "- \"BANK_STATEMENT\": Bank transaction summaries for reconciliation.\n" +
        "- \"LOAN_AGREEMENT\": Financing, interest, or loan repayment schedule.\n" +
        "- \"ASSET_PURCHASE\": Fixed asset purchases (Capitalized equipment/machinery).\n" +
        "- \"INVENTORY_COUNT_SHEET\": Stock adjustment or physical tally sheet.\n" +
        "- \"JOURNAL_VOUCHER\": Manual accounting adjustments or transfers.\n\n" +
        "--------------------------------------------------\n" +
        "2. DYNAMIC TAX & VAT ABSORPTION RULES\n" +
        "--------------------------------------------------\n" +
        "- Identify the Supplier/Vendor Country (e.g., Uganda, Kenya, South Sudan, Ethiopia) and extract the exact tax rate printed (e.g., 18%, 16%, 0%).\n" +
        "- This company's VAT-registration status (isVatRegistered) is: " + isVatRegistered + ".\n" +
        "  * IF isVatRegistered IS FALSE (Non-VAT Business):\n" +
        "    - The VAT amount CANNOT be reclaimed.\n" +
        "    - Absorb the tax directly into the Inventory or Fixed Asset base cost.\n" +
        "    - Set tax_receivable_amount = 0.\n" +
        "  * IF isVatRegistered IS TRUE (VAT Business):\n" +
        "    - Split tax out into a separate VAT Receivable or VAT Payable account.\n" +
        "    - Keep Inventory / Asset cost at the net raw value.\n\n" +
        "--------------------------------------------------\n" +
        "3. MULTI-CURRENCY EXTRACTION RULES\n" +
        "--------------------------------------------------\n" +
        "- Detect the document currency symbol or code (USD, UGX, KES, SSP, ETB, EUR).\n" +
        "- Extract subtotal, tax total, and grand total in the DOCUMENT currency.\n" +
        "- This company's base currency is: " + baseCurrency + ". If the document currency differs, provide your best-estimate exchange_rate and compute grand_total_in_base_currency; if you cannot estimate a reliable rate, set exchange_rate to 1.0 and note this in tax_handling_note.\n\n" +
        "--------------------------------------------------\n" +
        "4. CHART OF ACCOUNTS CONSTRAINT (CRITICAL)\n" +
        "--------------------------------------------------\n" +
        "recommended_debits and recommended_credits MUST use account names EXACTLY as they appear in this company's Chart of Accounts below. Do not invent new account names. Pick the closest existing match for every line:\n" +
        coaText + "\n\n" +
        "--------------------------------------------------\n" +
        "5. PARTY MATCHING\n" +
        "--------------------------------------------------\n" +
        "Known customers on file: " + (customersList.length ? customersList.map(c => c.name).join(", ") : "(none yet)") + "\n" +
        "Known suppliers on file: " + (suppliersList.length ? suppliersList.map(s => s.name).join(", ") : "(none yet)") + "\n" +
        "If party_name matches one of these (even loosely), use that exact name so the app can link it automatically. Otherwise extract the name as printed on the document.\n\n" +
        "--------------------------------------------------\n" +
        "6. STRICT OUTPUT FORMAT (JSON ONLY)\n" +
        "--------------------------------------------------\n" +
        "Return ONLY a valid JSON response, no markdown, no commentary, no text outside the JSON, using this exact schema:\n\n" +
        "{\n" +
        "  \"document_type\": \"STRING\",\n" +
        "  \"document_number\": \"STRING or null\",\n" +
        "  \"document_date\": \"YYYY-MM-DD or null\",\n" +
        "  \"party_name\": \"STRING (Supplier, Customer, or Employee Name)\",\n" +
        "  \"party_type\": \"vendor | customer | employee | bank | other\",\n" +
        "  \"country_of_origin\": \"STRING\",\n" +
        "  \"currency\": \"STRING (e.g. USD, KES, UGX, SSP)\",\n" +
        "  \"exchange_rate\": 1.0,\n" +
        "  \"detected_tax_rate\": 0.18,\n" +
        "  \"is_tax_inclusive\": false,\n" +
        "  \"line_items\": [\n" +
        "    { \"description\": \"STRING\", \"quantity\": 0.0, \"unit_price\": 0.0, \"total_price\": 0.0 }\n" +
        "  ],\n" +
        "  \"totals\": {\n" +
        "    \"subtotal\": 0.0,\n" +
        "    \"tax_amount\": 0.0,\n" +
        "    \"grand_total\": 0.0,\n" +
        "    \"grand_total_in_base_currency\": 0.0\n" +
        "  },\n" +
        "  \"accounting_action\": {\n" +
        "    \"recommended_debits\": [ { \"account\": \"STRING\", \"amount\": 0.0 } ],\n" +
        "    \"recommended_credits\": [ { \"account\": \"STRING\", \"amount\": 0.0 } ],\n" +
        "    \"tax_handling_note\": \"STRING (e.g., 'Tax absorbed into asset cost' or 'Tax split to VAT Receivable')\"\n" +
        "  }\n" +
        "}";

    } else if (systemPrompt) {
      systemText = systemPrompt;

    } else {
      const matContext = (materials && materials.length > 0)
        ? "\nCURRENT INVENTORY:\n" + materials.map(m =>
            "- " + m.name + ": " + m.qty + " " + m.unit + " @ $" + m.cost + "/unit"
          ).join("\n")
        : "";

      const productContext = (products && products.length > 0)
        ? "\nCURRENT STOCK:\n" + products.map(p =>
            "- " + p.name + " (SKU:" + (p.sku||"—") + "): " + p.qty + " " + p.unit + " · cost $" + p.cost_price + " · sale $" + p.sale_price
          ).join("\n")
        : "";

      // RETAIL MODE — short-circuit with retail-specific prompt
      if (appMode === "retail") {
        systemText =
          "You are a retail shop accounting AI for a business in East Africa. You understand Tigrinya and English.\n" +
          productContext + "\n\n" +
          "CRITICAL NUMBER RULE: Use the EXACT number the user typed.\n" +
          "CRITICAL BALANCE RULE: All debits must equal all credits must equal the amount.\n" +
          "CRITICAL JSON RULE: Return ONLY valid JSON. No markdown. No text outside JSON.\n\n" +
          'Return this exact structure:\n{"type":"Stock Purchase","date":"YYYY-MM-DD","amount":500,"currency":"USD","description":"Received 100 bags sugar","project":null,"prepaidMonths":null,"materialUsage":null,"entries":[{"account":"Inventory (Stock)","type":"asset","debit":500,"credit":0},{"account":"Accounts Payable","type":"liability","debit":0,"credit":500}]}\n\n' +
          "RETAIL ACCOUNTING RULES:\n" +
          "1. Debits = Credits ALWAYS.\n" +
          "2. Buy stock on CREDIT: Dr Inventory (Stock), Cr Accounts Payable. type=Stock Purchase\n" +
          "3. Buy stock CASH: Dr Inventory (Stock), Cr Cash. type=Stock Purchase\n" +
          "4. Pay supplier (settle AP): Dr Accounts Payable, Cr Cash. type=Supplier Payment\n" +
          "5. Cash sale: Dr Cash, Cr Retail Sales Revenue AND Dr Cost of Goods Sold, Cr Inventory (Stock). type=POS Sale\n" +
          "6. Pay staff wages: Dr Wages & Salaries Expense, Cr Cash. type=Payroll\n" +
          "7. Pay rent: Dr Rent Expense, Cr Cash. type=Rent\n" +
          "8. Pay utilities: Dr Utilities Expense, Cr Cash. type=Utilities\n" +
          "9. Owner deposits capital: Dr Cash, Cr Owner Capital. type=Capital\n" +
          "10. Loan received: Dr Cash, Cr Loan Payable. type=Loan\n" +
          "11. Stock write-off (damaged/expired): Dr Stock Write-off, Cr Inventory (Stock). type=Stock Adjustment\n" +
          "12. Depreciation: Dr Depreciation Expense, Cr Accumulated Depreciation - Equipment. type=Depreciation\n" +
          "13. SSP currency: divide by 1300 to get USD.\n\n" +
          "Today: " + new Date().toISOString().split("T")[0];
      }

      // Build project context string so AI can tag entries to the right project
      const projectContext = (projects && projects.length > 0)
        ? "\nACTIVE PROJECTS:\n" + projects.map(p =>
            "- " + p.name + " (contract: $" + p.value + ", client: " + (p.client || "unknown") + ", status: " + p.status + ")"
          ).join("\n")
        : "";

      systemText =
        "You are a construction accounting AI for a company in Juba, South Sudan. You understand Tigrinya and English.\n" +
        matContext + projectContext + "\n\n" +
        "CRITICAL NUMBER RULE: Read the EXACT number the user typed. 50000 = 50000. Never change the number.\n\n" +
        "CRITICAL BALANCE RULE: sum of all debit values MUST equal sum of all credit values MUST equal the amount.\n\n" +
        "CRITICAL JSON RULE: Return ONLY valid JSON. No markdown. No text outside JSON. No trailing commas.\n" +
        "The top-level 'type' field must be a real category. NEVER the word 'string'.\n\n" +
        "CRITICAL PROJECT RULE: If the user mentions a project name (e.g. 'Juba Clinic', 'clinic project'), " +
        "set the 'project' field in the JSON to that exact project name from ACTIVE PROJECTS above. " +
        "If no project is mentioned, set project to null.\n\n" +
        "Return this exact structure:\n" +
        '{"type":"Cash Advance","date":"YYYY-MM-DD","amount":50000,"currency":"USD","description":"Cash advance received from Juba Clinic","project":"Juba Clinic","prepaidMonths":null,"materialUsage":null,"entries":[{"account":"Cash","type":"asset","debit":50000,"credit":0},{"account":"Advance from Client","type":"liability","debit":0,"credit":50000}]}\n\n' +
        "ACCOUNTING RULES — read all carefully:\n" +
        "1. Debits = Credits ALWAYS.\n" +
        "2. Pay cash for expense: Dr expense (debit=amount), Cr Cash (credit=amount)\n" +
        "3. Salary/laborers/wages: Dr Salary Expense, Cr Cash. type=Payroll\n" +
        "4. Rent advance 'for X months': Dr Prepaid Rent, Cr Cash, prepaidMonths=X\n" +
        "5. Buy materials cash: Dr Construction Materials, Cr Cash\n" +
        "6. Buy materials on credit: Dr Construction Materials, Cr Accounts Payable\n" +
        "7. Use materials on site: Dr Work in Progress, Cr Construction Materials. Set materialUsage field.\n" +
        "8. INVOICE to client (we bill them, not yet paid): Dr Accounts Receivable, Cr Contract Revenue. type=Invoice\n" +
        "9. CLIENT PAYS invoice (cash received against AR): Dr Cash, Cr Accounts Receivable. type=Payment Received\n" +
        "10. ADVANCE / MOBILIZATION from client (cash before work, not yet earned — this is a LIABILITY until work is done):\n" +
        "    Dr Cash (debit=amount), Cr Advance from Client (credit=amount, type=liability). type=Cash Advance\n" +
        "    KEY: 'received advance', 'mobilization payment', 'cash advance', 'advance for materials', 'paid us before starting' = rule 10.\n" +
        "    Do NOT use Contract Revenue for advances. Use 'Advance from Client' (liability) until work is completed.\n" +
        "11. When advance is earned (work done on advance): Dr Advance from Client, Cr Contract Revenue\n" +
        "12. Equipment purchase: Dr Equipment, Cr Cash\n" +
        "13. Loan received: Dr Cash, Cr Loan Payable\n" +
        "14. Fuel: Dr Fuel Expense, Cr Cash\n" +
        "15. Owner puts in capital: Dr Cash, Cr Owner Capital\n" +
        "16. Depreciation: Dr Depreciation Expense (type=expense), Cr Accumulated Depreciation (type=contra-asset)\n" +
        "17. Subcontractor paid: Dr Subcontractor Expense, Cr Cash\n" +
        "18. Accrue unpaid expense: Dr expense, Cr Accrued Liabilities\n" +
        "19. SSP currency: divide by 1300 to get USD equivalent\n" +
        "20. Retention withheld on invoice: Dr Accounts Receivable (net), Dr Retention Receivable (retention), Cr Contract Revenue (gross)\n\n" +
        "SIGNAL WORDS for rule 10 (Advance from Client):\n" +
        "'advance', 'mobilization', 'mob payment', 'down payment from client', 'client paid us upfront',\n" +
        "'received cash from [project/client] for buying materials', 'prepayment from client', 'ቅድሚ ምስጋ' (Tigrinya for advance)\n\n" +
        "Today: " + new Date().toISOString().split("T")[0] + "\n\n" +
        "SELF-CHECK before responding:\n" +
        "1. Is amount EXACTLY what the user typed?\n" +
        "2. Do debits = credits = amount?\n" +
        "3. Is this an advance/mobilization? → use 'Advance from Client' liability, NOT Contract Revenue\n" +
        "4. Is type a real category, not the word 'string'?\n" +
        "5. Did I set the 'project' field if a project name was mentioned?";
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
        max_tokens: 1536
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Groq error:", err);
      return res.status(500).json({ error: "AI service error", details: err });
    }

    const data = await response.json();
    let text = data?.choices?.[0]?.message?.content || "";

    // The universal document parser and any systemPrompt-override caller manage their own
    // JSON shape and validation on the client side — only the default construction/retail
    // quick-entry flow uses this repair pass, since validateAndFixEntry assumes that flow's
    // specific {type,amount,entries[...]} schema.
    if (mode !== "advisor" && mode !== "universalDocument" && !systemPrompt) {
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
      else if (desc.includes("advance") || desc.includes("mobilization") || desc.includes("mob payment") || desc.includes("prepayment")) parsed.type = "Cash Advance";
      else if (desc.includes("rent")) parsed.type = "Rent";
      else if (desc.includes("material") || desc.includes("cement") || desc.includes("steel") || desc.includes("gravel")) parsed.type = "Material Purchase";
      else if (desc.includes("fuel")) parsed.type = "Fuel";
      else if (desc.includes("invoice")) parsed.type = "Invoice";
      else if (desc.includes("depreciation")) parsed.type = "Depreciation";
      else if (desc.includes("delivery")) parsed.type = "Delivery";
      else if (desc.includes("payment received") || desc.includes("client paid")) parsed.type = "Payment Received";
      else parsed.type = "General";
    }

    // Fix "Advance from Client" account type — must be liability, not asset
    parsed.entries = parsed.entries.map(line => {
      const acct = (line.account || "").toLowerCase();
      if (acct.includes("advance from client") || acct.includes("client advance") || acct.includes("mobilization")) {
        return { ...line, type: "liability" };
      }
      return line;
    });

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
