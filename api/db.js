// api/db.js — Hisabi Hensi · Multi-tenant backend
// Multi-company · Project-scoped staff · Chart of Accounts · Period closing
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function query(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS hh_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_b64 TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS hh_companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      ssp_rate NUMERIC DEFAULT 1300,
      costing_method TEXT DEFAULT 'WAC',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS hh_user_companies (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES hh_users(id),
      company_id INTEGER NOT NULL REFERENCES hh_companies(id),
      role TEXT NOT NULL DEFAULT 'staff',
      project_scope INTEGER[] DEFAULT NULL,
      UNIQUE(user_id, company_id)
    );
    CREATE TABLE IF NOT EXISTS hh_accounting_periods (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES hh_companies(id),
      period_name TEXT NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      is_closed BOOLEAN DEFAULT FALSE,
      closed_by TEXT,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS hh_chart_of_accounts (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES hh_companies(id),
      code TEXT,
      name TEXT NOT NULL,
      parent_group TEXT NOT NULL,
      account_type TEXT NOT NULL,
      is_system BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, name)
    );
    CREATE TABLE IF NOT EXISTS hh_data (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES hh_companies(id),
      data_key TEXT NOT NULL,
      data_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, data_key)
    );
    CREATE TABLE IF NOT EXISTS hh_audit_log (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS hh_closing_entries (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      period_id INTEGER NOT NULL,
      period_name TEXT,
      revenue_total NUMERIC DEFAULT 0,
      expense_total NUMERIC DEFAULT 0,
      net_pnl NUMERIC DEFAULT 0,
      retained_earnings_delta NUMERIC DEFAULT 0,
      posted_by TEXT,
      posted_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ── System chart of accounts seeded on company creation ─────────────────────
const SYSTEM_ACCOUNTS = [
  // Current Assets
  { code:'1000', name:'Cash',                       parent_group:'Current Assets',    account_type:'asset',     is_system:true },
  { code:'1010', name:'Petty Cash',                 parent_group:'Current Assets',    account_type:'asset',     is_system:true },
  { code:'1020', name:'Mobile Money',               parent_group:'Current Assets',    account_type:'asset',     is_system:true },
  { code:'1030', name:'Accounts Receivable',        parent_group:'Current Assets',    account_type:'asset',     is_system:true },
  { code:'1040', name:'Retention Receivable',       parent_group:'Current Assets',    account_type:'asset',     is_system:true },
  { code:'1050', name:'Construction Materials',     parent_group:'Current Assets',    account_type:'asset',     is_system:true },
  { code:'1060', name:'Prepaid Rent',               parent_group:'Current Assets',    account_type:'asset',     is_system:true },
  { code:'1070', name:'Work in Progress',           parent_group:'Current Assets',    account_type:'asset',     is_system:true },
  // Non-current Assets
  { code:'1500', name:'Equipment',                  parent_group:'Non-current Assets',account_type:'asset',     is_system:true },
  { code:'1510', name:'Vehicles',                   parent_group:'Non-current Assets',account_type:'asset',     is_system:true },
  { code:'1520', name:'Heavy Machinery',            parent_group:'Non-current Assets',account_type:'asset',     is_system:true },
  { code:'1530', name:'Accumulated Depreciation - Equipment', parent_group:'Non-current Assets',account_type:'contra-asset',is_system:true },
  { code:'1531', name:'Accumulated Depreciation - Vehicles',  parent_group:'Non-current Assets',account_type:'contra-asset',is_system:true },
  // Liabilities
  { code:'2000', name:'Accounts Payable',           parent_group:'Liabilities',       account_type:'liability', is_system:true },
  { code:'2010', name:'Salaries Payable',           parent_group:'Liabilities',       account_type:'liability', is_system:true },
  { code:'2020', name:'PAYE Payable',               parent_group:'Liabilities',       account_type:'liability', is_system:true },
  { code:'2030', name:'NSSF Payable',               parent_group:'Liabilities',       account_type:'liability', is_system:true },
  { code:'2040', name:'Accrued Liabilities',        parent_group:'Liabilities',       account_type:'liability', is_system:true },
  { code:'2050', name:'Loan Payable',               parent_group:'Liabilities',       account_type:'liability', is_system:true },
  // Equity
  { code:'3000', name:'Owner Capital',              parent_group:'Equity',            account_type:'equity',    is_system:true },
  { code:'3010', name:'Retained Earnings',          parent_group:'Equity',            account_type:'equity',    is_system:true },
  // Revenue
  { code:'4000', name:'Contract Revenue',           parent_group:'Revenue',           account_type:'revenue',   is_system:true },
  // Direct Expenses
  { code:'5000', name:'Salary Expense',             parent_group:'Expense (Direct)',  account_type:'expense',   is_system:true },
  { code:'5010', name:'NSSF Employer Contribution Expense',parent_group:'Expense (Direct)',account_type:'expense',is_system:true },
  { code:'5020', name:'Subcontractor Expense',      parent_group:'Expense (Direct)',  account_type:'expense',   is_system:true },
  { code:'5030', name:'Fuel Expense',               parent_group:'Expense (Direct)',  account_type:'expense',   is_system:true },
  { code:'5040', name:'Depreciation Expense - Equipment',  parent_group:'Expense (Direct)',account_type:'expense',is_system:true },
  { code:'5050', name:'Depreciation Expense - Vehicles',   parent_group:'Expense (Direct)',account_type:'expense',is_system:true },
  // Indirect Expenses
  { code:'6000', name:'Rent Expense',               parent_group:'Expense (Indirect)',account_type:'expense',   is_system:true },
  { code:'6010', name:'Office Supplies Expense',    parent_group:'Expense (Indirect)',account_type:'expense',   is_system:true },
  { code:'6020', name:'Miscellaneous Expense',      parent_group:'Expense (Indirect)',account_type:'expense',   is_system:true },
  { code:'6030', name:'Repairs and Maintenance Expense',parent_group:'Expense (Indirect)',account_type:'expense',is_system:true },
];

async function seedChartOfAccounts(companyId) {
  for (const a of SYSTEM_ACCOUNTS) {
    await query(`
      INSERT INTO hh_chart_of_accounts(company_id,code,name,parent_group,account_type,is_system)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id,name) DO NOTHING
    `, [companyId, a.code, a.name, a.parent_group, a.account_type, a.is_system]);
  }
}

// ── Permission map ───────────────────────────────────────────────────────────
const ROLE_BLOCKED = {
  staff:  ['deleteEntry','releaseRetention','runPayroll','disburse','deleteProject','deleteWorker','deleteAsset','closePeriod','addStaff','deleteAccount'],
  accountant: ['deleteEntry','deleteProject','deleteWorker','deleteAsset','closePeriod','addStaff','deleteAccount'],
  owner:  []
};
function isAllowed(role, action) {
  const blocked = ROLE_BLOCKED[role] || ROLE_BLOCKED['staff'];
  return !blocked.some(b => action.toLowerCase().includes(b.toLowerCase()));
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureTables();
    const body = req.body || {};
    const { action } = body;

    // ── REGISTER ─────────────────────────────────────────────────────────────
    if (action === 'register') {
      const { username, password, bizName } = body;
      if (!username || !password || !bizName) return res.status(400).json({ error: 'Missing fields' });
      const ex = await query('SELECT id FROM hh_users WHERE username=$1', [username]);
      if (ex.rows.length) return res.status(409).json({ error: 'Username taken' });
      const ur = await query('INSERT INTO hh_users(username,password_b64) VALUES($1,$2) RETURNING id', [username, btoa(password)]);
      const uid = ur.rows[0].id;
      const cr = await query('INSERT INTO hh_companies(name) VALUES($1) RETURNING id', [bizName]);
      const cid = cr.rows[0].id;
      await query('INSERT INTO hh_user_companies(user_id,company_id,role) VALUES($1,$2,$3)', [uid, cid, 'owner']);
      await seedChartOfAccounts(cid);
      return res.status(200).json({ ok: true, userId: uid, companyId: cid, role: 'owner', bizName });
    }

    // ── LOGIN ─────────────────────────────────────────────────────────────────
    if (action === 'login') {
      const { username, password } = body;
      if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
      const ur = await query('SELECT * FROM hh_users WHERE username=$1', [username]);
      if (!ur.rows.length || ur.rows[0].password_b64 !== btoa(password))
        return res.status(401).json({ error: 'Wrong username or password' });
      const uid = ur.rows[0].id;
      // Load all companies this user belongs to
      const cr = await query(`
        SELECT uc.company_id, uc.role, uc.project_scope, c.name as biz_name, c.ssp_rate, c.costing_method
        FROM hh_user_companies uc JOIN hh_companies c ON c.id=uc.company_id
        WHERE uc.user_id=$1 ORDER BY c.created_at
      `, [uid]);
      return res.status(200).json({ ok: true, userId: uid, companies: cr.rows });
    }

    // ── CREATE COMPANY (existing user adds a new company) ────────────────────
    if (action === 'createCompany') {
      const { userId, bizName } = body;
      if (!userId || !bizName) return res.status(400).json({ error: 'Missing fields' });
      const cr = await query('INSERT INTO hh_companies(name) VALUES($1) RETURNING id', [bizName]);
      const cid = cr.rows[0].id;
      await query('INSERT INTO hh_user_companies(user_id,company_id,role) VALUES($1,$2,$3)', [parseInt(userId), cid, 'owner']);
      await seedChartOfAccounts(cid);
      return res.status(200).json({ ok: true, companyId: cid, bizName });
    }

    // ── REGISTER STAFF ────────────────────────────────────────────────────────
    if (action === 'registerStaff') {
      const { username, password, companyId, role, projectScope } = body;
      if (!username || !password || !companyId) return res.status(400).json({ error: 'Missing fields' });
      let uid;
      const ex = await query('SELECT id FROM hh_users WHERE username=$1', [username]);
      if (ex.rows.length) {
        uid = ex.rows[0].id;
      } else {
        const ur = await query('INSERT INTO hh_users(username,password_b64) VALUES($1,$2) RETURNING id', [username, btoa(password)]);
        uid = ur.rows[0].id;
      }
      const scope = (Array.isArray(projectScope) && projectScope.length) ? projectScope : null;
      await query(`
        INSERT INTO hh_user_companies(user_id,company_id,role,project_scope)
        VALUES($1,$2,$3,$4) ON CONFLICT(user_id,company_id)
        DO UPDATE SET role=$3, project_scope=$4
      `, [uid, parseInt(companyId), role || 'staff', scope]);
      return res.status(200).json({ ok: true });
    }

    // ── LOAD ──────────────────────────────────────────────────────────────────
    if (action === 'load') {
      const { companyId } = body;
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      const r = await query('SELECT data_key, data_value FROM hh_data WHERE company_id=$1', [parseInt(companyId)]);
      const data = {};
      r.rows.forEach(row => { data[row.data_key] = row.data_value; });
      return res.status(200).json({ ok: true, data });
    }

    // ── SAVE ──────────────────────────────────────────────────────────────────
    if (action === 'save') {
      const { companyId, key, value } = body;
      if (!companyId || !key) return res.status(400).json({ error: 'Missing fields' });
      await query(`
        INSERT INTO hh_data(company_id,data_key,data_value,updated_at) VALUES($1,$2,$3::jsonb,NOW())
        ON CONFLICT(company_id,data_key) DO UPDATE SET data_value=$3::jsonb, updated_at=NOW()
      `, [parseInt(companyId), key, JSON.stringify(value)]);
      return res.status(200).json({ ok: true });
    }

    // ── SAVE SETTINGS ─────────────────────────────────────────────────────────
    if (action === 'saveSettings') {
      const { companyId, name, sspRate, costingMethod } = body;
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      await query('UPDATE hh_companies SET name=$1,ssp_rate=$2,costing_method=$3 WHERE id=$4',
        [name, sspRate || 1300, costingMethod || 'WAC', parseInt(companyId)]);
      return res.status(200).json({ ok: true });
    }

    // ── LIST STAFF ────────────────────────────────────────────────────────────
    if (action === 'listStaff') {
      const { companyId } = body;
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      const r = await query(`
        SELECT u.username, uc.role, uc.project_scope, uc.id as membership_id, u.created_at
        FROM hh_user_companies uc JOIN hh_users u ON u.id=uc.user_id
        WHERE uc.company_id=$1 ORDER BY u.created_at
      `, [parseInt(companyId)]);
      return res.status(200).json({ ok: true, staff: r.rows });
    }

    // ── REMOVE STAFF ──────────────────────────────────────────────────────────
    if (action === 'removeStaff') {
      const { membershipId } = body;
      if (!membershipId) return res.status(400).json({ error: 'Missing membershipId' });
      await query('DELETE FROM hh_user_companies WHERE id=$1', [parseInt(membershipId)]);
      return res.status(200).json({ ok: true });
    }

    // ── CHART OF ACCOUNTS ─────────────────────────────────────────────────────
    if (action === 'listAccounts') {
      const { companyId } = body;
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      const r = await query('SELECT * FROM hh_chart_of_accounts WHERE company_id=$1 ORDER BY code, name', [parseInt(companyId)]);
      return res.status(200).json({ ok: true, accounts: r.rows });
    }
    if (action === 'addAccount') {
      const { companyId, code, name, parent_group, account_type } = body;
      if (!companyId || !name || !parent_group || !account_type) return res.status(400).json({ error: 'Missing fields' });
      await query(`
        INSERT INTO hh_chart_of_accounts(company_id,code,name,parent_group,account_type,is_system)
        VALUES($1,$2,$3,$4,$5,FALSE) ON CONFLICT(company_id,name) DO NOTHING
      `, [parseInt(companyId), code || null, name, parent_group, account_type]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'deleteAccount') {
      const { accountId } = body;
      if (!accountId) return res.status(400).json({ error: 'Missing accountId' });
      const r = await query('SELECT is_system FROM hh_chart_of_accounts WHERE id=$1', [parseInt(accountId)]);
      if (r.rows[0]?.is_system) return res.status(403).json({ error: 'Cannot delete system account' });
      await query('DELETE FROM hh_chart_of_accounts WHERE id=$1 AND is_system=FALSE', [parseInt(accountId)]);
      return res.status(200).json({ ok: true });
    }

    // ── ACCOUNTING PERIODS ────────────────────────────────────────────────────
    if (action === 'listPeriods') {
      const { companyId } = body;
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      const r = await query('SELECT * FROM hh_accounting_periods WHERE company_id=$1 ORDER BY period_start DESC', [parseInt(companyId)]);
      return res.status(200).json({ ok: true, periods: r.rows });
    }
    if (action === 'createPeriod') {
      const { companyId, period_name, period_start, period_end } = body;
      if (!companyId || !period_name || !period_start || !period_end) return res.status(400).json({ error: 'Missing fields' });
      const r = await query(`
        INSERT INTO hh_accounting_periods(company_id,period_name,period_start,period_end)
        VALUES($1,$2,$3,$4) RETURNING id
      `, [parseInt(companyId), period_name, period_start, period_end]);
      return res.status(200).json({ ok: true, periodId: r.rows[0].id });
    }

    // ── CLOSE PERIOD ──────────────────────────────────────────────────────────
    // Executes the full closing routine in memory (app-level), then saves the result.
    // The journal entries array is passed in from the frontend so we can compute
    // the net P&L without a separate hh_journal_entries SQL table.
    if (action === 'closePeriod') {
      const { companyId, periodId, username, periodStart, periodEnd, entries } = body;
      if (!companyId || !periodId) return res.status(400).json({ error: 'Missing fields' });
      // Check period not already closed
      const pr = await query('SELECT * FROM hh_accounting_periods WHERE id=$1 AND company_id=$2', [parseInt(periodId), parseInt(companyId)]);
      if (!pr.rows.length) return res.status(404).json({ error: 'Period not found' });
      if (pr.rows[0].is_closed) return res.status(409).json({ error: 'Period already closed' });

      // Compute revenue + expense totals for entries within the period date range
      const ps = periodStart || pr.rows[0].period_start?.toISOString().split('T')[0];
      const pe = periodEnd || pr.rows[0].period_end?.toISOString().split('T')[0];
      const periodEntries = (entries || []).filter(e => e.date >= ps && e.date <= pe);

      let revenueTotal = 0, expenseTotal = 0;
      periodEntries.forEach(e => {
        (e.credits || []).forEach(c => { if (c.atype === 'revenue') revenueTotal += c.amt; });
        (e.debits  || []).forEach(d => { if (d.atype === 'expense') expenseTotal += d.amt; });
      });
      const netPnl = revenueTotal - expenseTotal;

      // Save closing entry summary
      await query(`
        INSERT INTO hh_closing_entries(company_id,period_id,period_name,revenue_total,expense_total,net_pnl,retained_earnings_delta,posted_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      `, [parseInt(companyId), parseInt(periodId), pr.rows[0].period_name, revenueTotal, expenseTotal, netPnl, netPnl, username || 'system']);

      // Lock the period
      await query('UPDATE hh_accounting_periods SET is_closed=TRUE,closed_by=$1,closed_at=NOW() WHERE id=$2',
        [username || 'system', parseInt(periodId)]);

      // Audit
      await query('INSERT INTO hh_audit_log(company_id,username,action,detail) VALUES($1,$2,$3,$4)',
        [parseInt(companyId), username || 'system', 'closePeriod',
         `Period ${pr.rows[0].period_name}: Rev=${revenueTotal.toFixed(2)} Exp=${expenseTotal.toFixed(2)} Net=${netPnl.toFixed(2)}`]);

      return res.status(200).json({ ok: true, revenueTotal, expenseTotal, netPnl });
    }

    // ── AUDIT LOG ─────────────────────────────────────────────────────────────
    if (action === 'audit') {
      const { companyId, username, auditAction, auditDetail } = body;
      if (!companyId || !username || !auditAction) return res.status(400).json({ error: 'Missing fields' });
      await query('INSERT INTO hh_audit_log(company_id,username,action,detail) VALUES($1,$2,$3,$4)',
        [parseInt(companyId), username, auditAction, auditDetail || '']);
      return res.status(200).json({ ok: true });
    }
    if (action === 'auditLog') {
      const { companyId } = body;
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      const r = await query('SELECT * FROM hh_audit_log WHERE company_id=$1 ORDER BY created_at DESC LIMIT 200', [parseInt(companyId)]);
      return res.status(200).json({ ok: true, log: r.rows });
    }

    // ── PERMISSION CHECK ──────────────────────────────────────────────────────
    if (action === 'checkPermission') {
      const { userRole, actionName } = body;
      return res.status(200).json({ ok: true, allowed: isAllowed(userRole || 'staff', actionName || '') });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('DB handler error:', err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

// ── RETAIL MODE ADDITIONS ────────────────────────────────────────────────────

const RETAIL_ACCOUNTS = [
  // Current Assets
  { code:'1000', name:'Cash',                     parent_group:'Current Assets',    account_type:'asset',    is_system:true },
  { code:'1010', name:'Bank Account',             parent_group:'Current Assets',    account_type:'asset',    is_system:true },
  { code:'1020', name:'Mobile Money',             parent_group:'Current Assets',    account_type:'asset',    is_system:true },
  { code:'1030', name:'Accounts Receivable',      parent_group:'Current Assets',    account_type:'asset',    is_system:true },
  { code:'1050', name:'Inventory (Stock)',         parent_group:'Current Assets',    account_type:'asset',    is_system:true },
  { code:'1060', name:'Prepaid Expenses',         parent_group:'Current Assets',    account_type:'asset',    is_system:true },
  // Non-current Assets
  { code:'1500', name:'Shop Equipment',           parent_group:'Non-current Assets',account_type:'asset',    is_system:true },
  { code:'1510', name:'Furniture & Fixtures',     parent_group:'Non-current Assets',account_type:'asset',    is_system:true },
  { code:'1530', name:'Accumulated Depreciation - Equipment', parent_group:'Non-current Assets',account_type:'contra-asset',is_system:true },
  // Liabilities
  { code:'2000', name:'Accounts Payable',         parent_group:'Liabilities',       account_type:'liability',is_system:true },
  { code:'2010', name:'Salaries Payable',         parent_group:'Liabilities',       account_type:'liability',is_system:true },
  { code:'2020', name:'PAYE Payable',             parent_group:'Liabilities',       account_type:'liability',is_system:true },
  { code:'2030', name:'NSSF Payable',             parent_group:'Liabilities',       account_type:'liability',is_system:true },
  { code:'2040', name:'VAT Payable',              parent_group:'Liabilities',       account_type:'liability',is_system:true },
  // Equity
  { code:'3000', name:'Owner Capital',            parent_group:'Equity',            account_type:'equity',   is_system:true },
  { code:'3010', name:'Retained Earnings',        parent_group:'Equity',            account_type:'equity',   is_system:true },
  // Revenue
  { code:'4000', name:'Retail Sales Revenue',     parent_group:'Revenue',           account_type:'revenue',  is_system:true },
  { code:'4010', name:'Other Income',             parent_group:'Revenue',           account_type:'revenue',  is_system:true },
  // Direct Expenses
  { code:'5000', name:'Cost of Goods Sold',       parent_group:'Expense (Direct)',  account_type:'expense',  is_system:true },
  { code:'5010', name:'Stock Write-off',          parent_group:'Expense (Direct)',  account_type:'expense',  is_system:true },
  { code:'5020', name:'Freight & Delivery In',    parent_group:'Expense (Direct)',  account_type:'expense',  is_system:true },
  // Indirect Expenses
  { code:'6000', name:'Wages & Salaries Expense', parent_group:'Expense (Indirect)',account_type:'expense',  is_system:true },
  { code:'6010', name:'Rent Expense',             parent_group:'Expense (Indirect)',account_type:'expense',  is_system:true },
  { code:'6020', name:'Utilities Expense',        parent_group:'Expense (Indirect)',account_type:'expense',  is_system:true },
  { code:'6030', name:'Repairs & Maintenance',    parent_group:'Expense (Indirect)',account_type:'expense',  is_system:true },
  { code:'6040', name:'Advertising Expense',      parent_group:'Expense (Indirect)',account_type:'expense',  is_system:true },
  { code:'6050', name:'Depreciation Expense',     parent_group:'Expense (Indirect)',account_type:'expense',  is_system:true },
  { code:'6060', name:'Miscellaneous Expense',    parent_group:'Expense (Indirect)',account_type:'expense',  is_system:true },
  { code:'6070', name:'NSSF Employer Contribution',parent_group:'Expense (Indirect)',account_type:'expense', is_system:true },
];

async function seedRetailAccounts(companyId) {
  for (const a of RETAIL_ACCOUNTS) {
    await query(`
      INSERT INTO hh_chart_of_accounts(company_id,code,name,parent_group,account_type,is_system)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id,name) DO NOTHING
    `, [companyId, a.code, a.name, a.parent_group, a.account_type, a.is_system]);
  }
}

async function ensureRetailTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS hh_products (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES hh_companies(id),
      sku TEXT,
      barcode TEXT,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'General',
      sale_price NUMERIC DEFAULT 0,
      cost_price NUMERIC DEFAULT 0,
      qty NUMERIC DEFAULT 0,
      min_qty NUMERIC DEFAULT 0,
      unit TEXT DEFAULT 'unit',
      costing_method TEXT DEFAULT 'WAC',
      layers JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, name)
    );
    CREATE TABLE IF NOT EXISTS hh_pos_sales (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES hh_companies(id),
      sale_date DATE DEFAULT CURRENT_DATE,
      items JSONB NOT NULL DEFAULT '[]',
      subtotal NUMERIC DEFAULT 0,
      discount NUMERIC DEFAULT 0,
      total NUMERIC DEFAULT 0,
      payment_method TEXT DEFAULT 'cash',
      cashier TEXT,
      journal_entry_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS hh_purchase_orders (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES hh_companies(id),
      supplier TEXT NOT NULL,
      po_date DATE DEFAULT CURRENT_DATE,
      items JSONB NOT NULL DEFAULT '[]',
      total NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'pending',
      payment_method TEXT DEFAULT 'credit',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// Patch the main handler to handle retail actions and mode-aware registration
const _originalHandler = module.exports;
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureTables();
    await ensureRetailTables();
    const body = req.body || {};
    const { action } = body;

    // ── REGISTER WITH MODE ────────────────────────────────────────────────────
    if (action === 'register') {
      const { username, password, bizName, appMode } = body;
      if (!username || !password || !bizName) return res.status(400).json({ error: 'Missing fields' });
      const ex = await query('SELECT id FROM hh_users WHERE username=$1', [username]);
      if (ex.rows.length) return res.status(409).json({ error: 'Username taken' });
      const ur = await query('INSERT INTO hh_users(username,password_b64) VALUES($1,$2) RETURNING id', [username, btoa(password)]);
      const uid = ur.rows[0].id;
      const mode = appMode === 'retail' ? 'retail' : 'construction';
      const cr = await query('INSERT INTO hh_companies(name,costing_method) VALUES($1,$2) RETURNING id', [bizName, 'WAC']);
      const cid = cr.rows[0].id;
      // Store mode in company
      await query('ALTER TABLE hh_companies ADD COLUMN IF NOT EXISTS app_mode TEXT DEFAULT \'construction\'');
      await query('UPDATE hh_companies SET app_mode=$1 WHERE id=$2', [mode, cid]);
      await query('INSERT INTO hh_user_companies(user_id,company_id,role) VALUES($1,$2,$3)', [uid, cid, 'owner']);
      if (mode === 'retail') {
        await seedRetailAccounts(cid);
      } else {
        await seedChartOfAccounts(cid);
      }
      return res.status(200).json({ ok: true, userId: uid, companyId: cid, role: 'owner', bizName, appMode: mode });
    }

    // ── LOGIN WITH MODE ───────────────────────────────────────────────────────
    if (action === 'login') {
      const { username, password } = body;
      if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
      const ur = await query('SELECT * FROM hh_users WHERE username=$1', [username]);
      if (!ur.rows.length || ur.rows[0].password_b64 !== btoa(password))
        return res.status(401).json({ error: 'Wrong username or password' });
      const uid = ur.rows[0].id;
      await query('ALTER TABLE hh_companies ADD COLUMN IF NOT EXISTS app_mode TEXT DEFAULT \'construction\'').catch(()=>{});
      const cr = await query(`
        SELECT uc.company_id, uc.role, uc.project_scope, c.name as biz_name, c.ssp_rate, c.costing_method,
               COALESCE(c.app_mode,'construction') as app_mode
        FROM hh_user_companies uc JOIN hh_companies c ON c.id=uc.company_id
        WHERE uc.user_id=$1 ORDER BY c.created_at
      `, [uid]);
      return res.status(200).json({ ok: true, userId: uid, companies: cr.rows });
    }

    // ── SWITCH MODE ───────────────────────────────────────────────────────────
    if (action === 'switchMode') {
      const { companyId, appMode } = body;
      if (!companyId || !appMode) return res.status(400).json({ error: 'Missing fields' });
      const mode = appMode === 'retail' ? 'retail' : 'construction';
      await query('ALTER TABLE hh_companies ADD COLUMN IF NOT EXISTS app_mode TEXT DEFAULT \'construction\'').catch(()=>{});
      await query('UPDATE hh_companies SET app_mode=$1 WHERE id=$2', [mode, parseInt(companyId)]);
      // Seed the new mode's accounts (ON CONFLICT DO NOTHING so no duplicates)
      if (mode === 'retail') await seedRetailAccounts(parseInt(companyId));
      else await seedChartOfAccounts(parseInt(companyId));
      return res.status(200).json({ ok: true, appMode: mode });
    }

    // ── PRODUCTS (RETAIL) ─────────────────────────────────────────────────────
    if (action === 'listProducts') {
      const { companyId } = body;
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      const r = await query('SELECT * FROM hh_products WHERE company_id=$1 ORDER BY name', [parseInt(companyId)]);
      return res.status(200).json({ ok: true, products: r.rows });
    }
    if (action === 'saveProduct') {
      const { companyId, id, sku, barcode, name, category, sale_price, cost_price, qty, min_qty, unit } = body;
      if (!companyId || !name) return res.status(400).json({ error: 'Missing fields' });
      if (id) {
        await query(`UPDATE hh_products SET sku=$1,barcode=$2,name=$3,category=$4,sale_price=$5,
          cost_price=$6,qty=$7,min_qty=$8,unit=$9 WHERE id=$10 AND company_id=$11`,
          [sku,barcode,name,category||'General',sale_price||0,cost_price||0,qty||0,min_qty||0,unit||'unit',parseInt(id),parseInt(companyId)]);
      } else {
        const r = await query(`INSERT INTO hh_products(company_id,sku,barcode,name,category,sale_price,cost_price,qty,min_qty,unit,layers)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'[]') ON CONFLICT(company_id,name)
          DO UPDATE SET sku=$2,barcode=$3,sale_price=$6,cost_price=$7,qty=$8,min_qty=$9,unit=$10 RETURNING id`,
          [parseInt(companyId),sku||null,barcode||null,name,category||'General',sale_price||0,cost_price||0,qty||0,min_qty||0,unit||'unit']);
        return res.status(200).json({ ok: true, productId: r.rows[0]?.id });
      }
      return res.status(200).json({ ok: true });
    }
    if (action === 'deleteProduct') {
      const { productId } = body;
      if (!productId) return res.status(400).json({ error: 'Missing productId' });
      await query('DELETE FROM hh_products WHERE id=$1', [parseInt(productId)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'lookupBarcode') {
      const { companyId, barcode } = body;
      if (!companyId || !barcode) return res.status(400).json({ error: 'Missing fields' });
      const r = await query('SELECT * FROM hh_products WHERE company_id=$1 AND (barcode=$2 OR sku=$2)', [parseInt(companyId), barcode]);
      if (!r.rows.length) return res.status(404).json({ error: 'Product not found' });
      return res.status(200).json({ ok: true, product: r.rows[0] });
    }
    if (action === 'receiveStock') {
      // Receive supplier delivery — add cost layer to product
      const { companyId, productId, qty, unitCost, supplier, paymentMethod } = body;
      if (!companyId || !productId || !qty || !unitCost) return res.status(400).json({ error: 'Missing fields' });
      const r = await query('SELECT * FROM hh_products WHERE id=$1 AND company_id=$2', [parseInt(productId), parseInt(companyId)]);
      if (!r.rows.length) return res.status(404).json({ error: 'Product not found' });
      const product = r.rows[0];
      const layers = Array.isArray(product.layers) ? product.layers : JSON.parse(product.layers || '[]');
      layers.push({ qty: parseFloat(qty), unitCost: parseFloat(unitCost), date: new Date().toISOString().split('T')[0] });
      const newQty = (parseFloat(product.qty) || 0) + parseFloat(qty);
      await query('UPDATE hh_products SET qty=$1, layers=$2::jsonb WHERE id=$3',
        [newQty, JSON.stringify(layers), parseInt(productId)]);
      return res.status(200).json({ ok: true, newQty });
    }

    // ── POS SALES (RETAIL) ────────────────────────────────────────────────────
    if (action === 'savePOSSale') {
      const { companyId, items, subtotal, discount, total, paymentMethod, cashier, journalEntryId } = body;
      if (!companyId || !items) return res.status(400).json({ error: 'Missing fields' });
      const r = await query(`INSERT INTO hh_pos_sales(company_id,items,subtotal,discount,total,payment_method,cashier,journal_entry_id)
        VALUES($1,$2::jsonb,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [parseInt(companyId), JSON.stringify(items), subtotal||0, discount||0, total||0, paymentMethod||'cash', cashier||'', journalEntryId||null]);
      return res.status(200).json({ ok: true, saleId: r.rows[0].id });
    }
    if (action === 'listPOSSales') {
      const { companyId, limit } = body;
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      const r = await query('SELECT * FROM hh_pos_sales WHERE company_id=$1 ORDER BY created_at DESC LIMIT $2',
        [parseInt(companyId), parseInt(limit)||100]);
      return res.status(200).json({ ok: true, sales: r.rows });
    }

    // ── PURCHASE ORDERS (RETAIL) ──────────────────────────────────────────────
    if (action === 'savePurchaseOrder') {
      const { companyId, supplier, po_date, items, total, paymentMethod, notes } = body;
      if (!companyId || !supplier) return res.status(400).json({ error: 'Missing fields' });
      const r = await query(`INSERT INTO hh_purchase_orders(company_id,supplier,po_date,items,total,payment_method,notes)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING id`,
        [parseInt(companyId), supplier, po_date||new Date().toISOString().split('T')[0],
         JSON.stringify(items||[]), total||0, paymentMethod||'credit', notes||'']);
      return res.status(200).json({ ok: true, poId: r.rows[0].id });
    }
    if (action === 'listPurchaseOrders') {
      const { companyId } = body;
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      const r = await query('SELECT * FROM hh_purchase_orders WHERE company_id=$1 ORDER BY created_at DESC LIMIT 100', [parseInt(companyId)]);
      return res.status(200).json({ ok: true, orders: r.rows });
    }

    // ── PASS THROUGH to original handler for all other actions ────────────────
    return await _originalHandler(req, res);

  } catch (err) {
    console.error('Retail handler error:', err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
