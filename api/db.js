// api/db.js — Central database API for Hisabi Hensi multi-user backend
// Handles: user auth, data read/write, role enforcement
// Uses Neon Postgres via the DATABASE_URL environment variable

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── SQL helpers ────────────────────────────────────────────────────────────
async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// ─── Table bootstrap — runs on every cold start, safe to run repeatedly ────
async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS hh_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_b64 TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',  -- 'owner' or 'staff'
      company_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS hh_companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      ssp_rate NUMERIC DEFAULT 1300,
      costing_method TEXT DEFAULT 'WAC',
      created_at TIMESTAMPTZ DEFAULT NOW()
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
  `);
}

// ─── Role permission check ───────────────────────────────────────────────────
const STAFF_BLOCKED = ['deleteEntry', 'releaseRetention', 'runPayroll', 'disburse', 'deleteProject', 'deleteWorker', 'deleteAsset'];

function isAllowed(role, action) {
  if (role === 'owner') return true;
  return !STAFF_BLOCKED.some(blocked => action.toLowerCase().includes(blocked.toLowerCase()));
}

// ─── Main handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureTables();
    const { action, username, password, bizName, companyId, role, key, value, auditAction, auditDetail } = req.body || {};

    // ── REGISTER new user + create their company ─────────────────────────────
    if (action === 'register') {
      if (!username || !password || !bizName) return res.status(400).json({ error: 'Missing fields' });
      const existing = await query('SELECT id FROM hh_users WHERE username=$1', [username]);
      if (existing.rows.length) return res.status(409).json({ error: 'Username taken' });
      // First registered user for a company becomes owner
      const comp = await query('INSERT INTO hh_companies(name) VALUES($1) RETURNING id', [bizName]);
      const cid = comp.rows[0].id;
      await query('INSERT INTO hh_users(username,password_b64,role,company_id) VALUES($1,$2,$3,$4)',
        [username, btoa(password), 'owner', cid]);
      return res.status(200).json({ ok: true, companyId: cid, role: 'owner', bizName });
    }

    // ── LOGIN ─────────────────────────────────────────────────────────────────
    if (action === 'login') {
      if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
      const r = await query('SELECT u.*, c.name as biz_name, c.ssp_rate, c.costing_method FROM hh_users u JOIN hh_companies c ON c.id=u.company_id WHERE u.username=$1', [username]);
      if (!r.rows.length || r.rows[0].password_b64 !== btoa(password))
        return res.status(401).json({ error: 'Wrong username or password' });
      const u = r.rows[0];
      return res.status(200).json({ ok: true, companyId: u.company_id, role: u.role, bizName: u.biz_name, sspRate: u.ssp_rate, costingMethod: u.costing_method });
    }

    // ── REGISTER STAFF (owner invites someone to their company) ──────────────
    if (action === 'registerStaff') {
      if (!username || !password || !companyId) return res.status(400).json({ error: 'Missing fields' });
      const existing = await query('SELECT id FROM hh_users WHERE username=$1', [username]);
      if (existing.rows.length) return res.status(409).json({ error: 'Username taken' });
      await query('INSERT INTO hh_users(username,password_b64,role,company_id) VALUES($1,$2,$3,$4)',
        [username, btoa(password), role || 'staff', parseInt(companyId)]);
      return res.status(200).json({ ok: true });
    }

    // ── LOAD company data ────────────────────────────────────────────────────
    if (action === 'load') {
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      const r = await query('SELECT data_key, data_value FROM hh_data WHERE company_id=$1', [parseInt(companyId)]);
      const data = {};
      r.rows.forEach(row => { data[row.data_key] = row.data_value; });
      return res.status(200).json({ ok: true, data });
    }

    // ── SAVE company data ────────────────────────────────────────────────────
    if (action === 'save') {
      if (!companyId || !key) return res.status(400).json({ error: 'Missing fields' });
      await query(`
        INSERT INTO hh_data(company_id, data_key, data_value, updated_at)
        VALUES($1,$2,$3::jsonb,NOW())
        ON CONFLICT(company_id, data_key)
        DO UPDATE SET data_value=$3::jsonb, updated_at=NOW()
      `, [parseInt(companyId), key, JSON.stringify(value)]);
      return res.status(200).json({ ok: true });
    }

    // ── UPDATE company settings ──────────────────────────────────────────────
    if (action === 'saveSettings') {
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      const { name, sspRate, costingMethod } = req.body;
      await query('UPDATE hh_companies SET name=$1, ssp_rate=$2, costing_method=$3 WHERE id=$4',
        [name, sspRate || 1300, costingMethod || 'WAC', parseInt(companyId)]);
      return res.status(200).json({ ok: true });
    }

    // ── LIST staff for a company (owner only) ────────────────────────────────
    if (action === 'listStaff') {
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      const r = await query('SELECT username, role, created_at FROM hh_users WHERE company_id=$1 ORDER BY created_at', [parseInt(companyId)]);
      return res.status(200).json({ ok: true, staff: r.rows });
    }

    // ── AUDIT LOG write ──────────────────────────────────────────────────────
    if (action === 'audit') {
      if (!companyId || !username || !auditAction) return res.status(400).json({ error: 'Missing fields' });
      await query('INSERT INTO hh_audit_log(company_id,username,action,detail) VALUES($1,$2,$3,$4)',
        [parseInt(companyId), username, auditAction, auditDetail || '']);
      return res.status(200).json({ ok: true });
    }

    // ── AUDIT LOG read ───────────────────────────────────────────────────────
    if (action === 'auditLog') {
      if (!companyId) return res.status(400).json({ error: 'Missing companyId' });
      const r = await query('SELECT * FROM hh_audit_log WHERE company_id=$1 ORDER BY created_at DESC LIMIT 200', [parseInt(companyId)]);
      return res.status(200).json({ ok: true, log: r.rows });
    }

    // ── PERMISSION CHECK ─────────────────────────────────────────────────────
    if (action === 'checkPermission') {
      const { userRole, actionName } = req.body;
      return res.status(200).json({ ok: true, allowed: isAllowed(userRole || 'staff', actionName || '') });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('DB handler error:', err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}
