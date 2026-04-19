require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');
const { Pool } = require('pg');
const mammoth  = require('mammoth');

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY    = process.env.GROQ_API_KEY || '';
const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://fprgzafskzurjlqdouei.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET || ''; // service_role key — set in Railway
const ADMIN_EMAIL     = process.env.ADMIN_EMAIL     || ''; // your email — set in Railway

// ── Plans ──────────────────────────────────────────────────────────────────
const PLANS = {
  free: { label: 'Free',  daily: 20  },
  plus: { label: 'Plus',  daily: 100 },
  pro:  { label: 'Pro',   daily: 400 },
};

// ── PostgreSQL ─────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB(){
  // User profiles keyed by Supabase user ID (uuid)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      is_admin    BOOLEAN DEFAULT FALSE,
      blocked     BOOLEAN DEFAULT FALSE,
      plan        TEXT DEFAULT 'free',
      usage_count INT DEFAULT 0,
      usage_reset TIMESTAMPTZ DEFAULT NOW(),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free'`);
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS usage_count INT DEFAULT 0`);
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS usage_reset TIMESTAMPTZ DEFAULT NOW()`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT PRIMARY KEY,
      from_id      TEXT NOT NULL,
      from_email   TEXT NOT NULL,
      to_id        TEXT NOT NULL,
      to_email     TEXT NOT NULL,
      text         TEXT NOT NULL,
      read         BOOLEAN DEFAULT FALSE,
      is_sent_copy BOOLEAN DEFAULT FALSE,
      sent_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migrate old messages table columns if they exist
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_email TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS to_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS to_email TEXT NOT NULL DEFAULT ''`);
  console.log('✅ Database ready');
}

initDB().catch(e => console.error('DB init error:', e.message));

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Verify Supabase JWT ────────────────────────────────────────────────────
async function verifySupabaseToken(token){
  try {
    const fetch = globalThis.fetch || require('node-fetch');
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_SECRET,
        'Content-Type': 'application/json'
      }
    });
    if(!r.ok){
      const err = await r.text();
      console.error('Supabase auth error:', r.status, err);
      return null;
    }
    const data = await r.json();
    if(!data.id) return null;
    return data;
  } catch(e){
    console.error('verifySupabaseToken error:', e.message);
    return null;
  }
}

// ── Get or create profile ──────────────────────────────────────────────────
async function getOrCreateProfile(supaUser){
  const { rows } = await pool.query('SELECT * FROM profiles WHERE id=$1', [supaUser.id]);
  if(rows[0]) return rows[0];
  // First time user — create profile
  const isAdmin = supaUser.email === ADMIN_EMAIL;
  await pool.query(
    'INSERT INTO profiles (id,email,is_admin,blocked,plan) VALUES ($1,$2,$3,FALSE,\'free\') ON CONFLICT (id) DO NOTHING',
    [supaUser.id, supaUser.email, isAdmin]
  );
  const { rows: newRows } = await pool.query('SELECT * FROM profiles WHERE id=$1', [supaUser.id]);
  return newRows[0];
}

// ── Auth middleware ────────────────────────────────────────────────────────
async function requireAuth(req, res, next){
  const token = req.headers['x-auth-token'];
  if(!token) return res.status(401).json({ error: 'Not authenticated' });
  const supaUser = await verifySupabaseToken(token);
  if(!supaUser) return res.status(401).json({ error: 'Invalid or expired session' });
  const profile = await getOrCreateProfile(supaUser);
  if(profile.blocked) return res.status(403).json({ error: 'Account suspended' });
  req.user = { ...profile, supaId: supaUser.id, email: supaUser.email };
  next();
}

async function requireAdmin(req, res, next){
  const token = req.headers['x-auth-token'];
  if(!token) return res.status(401).json({ error: 'Not authenticated' });
  const supaUser = await verifySupabaseToken(token);
  if(!supaUser) return res.status(401).json({ error: 'Invalid or expired session' });
  const profile = await getOrCreateProfile(supaUser);
  if(!profile.is_admin) return res.status(403).json({ error: 'Admin only' });
  req.user = { ...profile, supaId: supaUser.id, email: supaUser.email };
  next();
}

// ── Usage check ────────────────────────────────────────────────────────────
async function checkAndIncrementUsage(user){
  if(user.is_admin) return { ok: true };
  const plan  = PLANS[user.plan] || PLANS.free;
  const now   = new Date();
  const reset = new Date(user.usage_reset);
  if((now - reset) > 24 * 60 * 60 * 1000){
    await pool.query('UPDATE profiles SET usage_count=1, usage_reset=$1 WHERE id=$2', [now.toISOString(), user.id]);
    return { ok: true, used: 1, limit: plan.daily };
  }
  if(user.usage_count >= plan.daily){
    const msLeft = 24*60*60*1000 - (now - reset);
    const hLeft  = Math.ceil(msLeft / (60*60*1000));
    return { ok: false, used: user.usage_count, limit: plan.daily, hoursLeft: hLeft };
  }
  await pool.query('UPDATE profiles SET usage_count=usage_count+1 WHERE id=$1', [user.id]);
  return { ok: true, used: user.usage_count + 1, limit: plan.daily };
}

// ── Extract docx ───────────────────────────────────────────────────────────
app.post('/api/extract-docx', async (req, res) => {
  try {
    const buffer = req.body;
    if(!buffer || !buffer.length) return res.status(400).json({ error: 'No file data' });
    const result = await mammoth.extractRawText({ buffer });
    if(!result.value) return res.status(400).json({ error: 'No text found' });
    res.json({ ok: true, text: result.value });
  } catch(e) {
    res.status(500).json({ error: 'Failed to read docx: ' + e.message });
  }
});

// ── Session check (called after login to get profile) ─────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    ok: true,
    email: req.user.email,
    isAdmin: !!req.user.is_admin,
    plan: req.user.plan || 'free'
  });
});

// ── Usage status ───────────────────────────────────────────────────────────
app.get('/api/usage', requireAuth, async (req, res) => {
  const user = req.user;
  if(user.is_admin) return res.json({ ok: true, admin: true });
  const plan  = PLANS[user.plan] || PLANS.free;
  const now   = new Date();
  const reset = new Date(user.usage_reset);
  let used = user.usage_count;
  if((now - reset) > 24 * 60 * 60 * 1000) used = 0;
  const msLeft = Math.max(0, 24*60*60*1000 - (now - reset));
  const hLeft  = Math.ceil(msLeft / (60*60*1000));
  res.json({
    ok: true,
    plan: user.plan || 'free',
    planLabel: plan.label,
    used,
    limit: plan.daily,
    remaining: Math.max(0, plan.daily - used),
    hoursUntilReset: hLeft
  });
});

// ── Chat ───────────────────────────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, system } = req.body;
  if(!messages || !system) return res.status(400).json({ error: 'Missing fields' });
  const usage = await checkAndIncrementUsage(req.user);
  if(!usage.ok){
    return res.status(429).json({
      error: `Daily limit reached (${usage.limit} messages). Resets in ${usage.hoursLeft}h.`,
      limitReached: true,
      hoursLeft: usage.hoursLeft,
      limit: usage.limit,
      plan: req.user.plan || 'free'
    });
  }
  await callGroq(system, messages, res);
});

// ── Admin: list users ──────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, blocked, plan, usage_count, usage_reset, created_at FROM profiles WHERE is_admin=FALSE ORDER BY created_at ASC'
  );
  res.json({ users: rows.map(r => ({
    id: r.id,
    email: r.email,
    blocked: r.blocked,
    plan: r.plan || 'free',
    usageCount: r.usage_count || 0,
    usageReset: r.usage_reset,
    createdAt: r.created_at
  })) });
});

// ── Admin: set plan ────────────────────────────────────────────────────────
app.post('/api/admin/setplan/:id', requireAdmin, async (req, res) => {
  const { plan } = req.body;
  if(!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  await pool.query('UPDATE profiles SET plan=$1 WHERE id=$2 AND is_admin=FALSE', [plan, req.params.id]);
  res.json({ ok: true });
});

// ── Admin: block ───────────────────────────────────────────────────────────
app.post('/api/admin/block/:id', requireAdmin, async (req, res) => {
  await pool.query('UPDATE profiles SET blocked=TRUE WHERE id=$1 AND is_admin=FALSE', [req.params.id]);
  res.json({ ok: true });
});

// ── Admin: unblock ─────────────────────────────────────────────────────────
app.post('/api/admin/unblock/:id', requireAdmin, async (req, res) => {
  await pool.query('UPDATE profiles SET blocked=FALSE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Admin: delete ──────────────────────────────────────────────────────────
app.delete('/api/admin/delete/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM profiles WHERE id=$1 AND is_admin=FALSE', [req.params.id]);
  res.json({ ok: true });
});

// ── Messages: send (admin only) ────────────────────────────────────────────
app.post('/api/messages/send', requireAdmin, async (req, res) => {
  const { toId, toEmail, text } = req.body;
  if(!toId || !text) return res.status(400).json({ error: 'Missing fields' });
  const id = crypto.randomBytes(6).toString('hex');
  await pool.query(
    'INSERT INTO messages (id,from_id,from_email,to_id,to_email,text,read,is_sent_copy) VALUES ($1,$2,$3,$4,$5,$6,FALSE,FALSE)',
    [id, req.user.id, req.user.email, toId, toEmail, text]
  );
  await pool.query(
    'INSERT INTO messages (id,from_id,from_email,to_id,to_email,text,read,is_sent_copy) VALUES ($1,$2,$3,$4,$5,$6,TRUE,TRUE)',
    [id+'_s', req.user.id, req.user.email, toId, toEmail, text]
  );
  res.json({ ok: true });
});

// ── Messages: reply (user to admin) ───────────────────────────────────────
app.post('/api/messages/reply', requireAuth, async (req, res) => {
  const { text } = req.body;
  if(!text) return res.status(400).json({ error: 'Missing text' });
  // Get admin profile
  const { rows } = await pool.query('SELECT id, email FROM profiles WHERE is_admin=TRUE LIMIT 1');
  if(!rows.length) return res.status(500).json({ error: 'No admin found' });
  const admin = rows[0];
  const id = crypto.randomBytes(6).toString('hex');
  await pool.query(
    'INSERT INTO messages (id,from_id,from_email,to_id,to_email,text,read,is_sent_copy) VALUES ($1,$2,$3,$4,$5,$6,FALSE,FALSE)',
    [id, req.user.id, req.user.email, admin.id, admin.email, text]
  );
  res.json({ ok: true });
});

// ── Messages: inbox ────────────────────────────────────────────────────────
app.get('/api/messages/inbox', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM messages WHERE to_id=$1 AND is_sent_copy=FALSE ORDER BY sent_at DESC',
    [req.user.id]
  );
  await pool.query('UPDATE messages SET read=TRUE WHERE to_id=$1 AND is_sent_copy=FALSE', [req.user.id]);
  res.json({ messages: rows.map(r => ({ id: r.id, from: r.from_email, text: r.text, sentAt: r.sent_at, read: r.read })) });
});

// ── Messages: unread count ─────────────────────────────────────────────────
app.get('/api/messages/unread', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT COUNT(*) as count FROM messages WHERE to_id=$1 AND read=FALSE AND is_sent_copy=FALSE',
    [req.user.id]
  );
  res.json({ count: parseInt(rows[0].count) });
});

// ── Admin: all conversations ───────────────────────────────────────────────
app.get('/api/admin/conversations', requireAdmin, async (req, res) => {
  const { rows: userRows } = await pool.query('SELECT id, email FROM profiles WHERE is_admin=FALSE');
  const convos = await Promise.all(userRows.map(async u => {
    const { rows: msgs } = await pool.query(
      `SELECT * FROM messages WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1 AND is_sent_copy=FALSE) ORDER BY sent_at ASC`,
      [req.user.id, u.id]
    );
    const { rows: unreadRows } = await pool.query(
      'SELECT COUNT(*) as count FROM messages WHERE from_id=$1 AND to_id=$2 AND read=FALSE AND is_sent_copy=FALSE',
      [u.id, req.user.id]
    );
    return {
      id: u.id,
      email: u.email,
      messages: msgs.map(m => ({ ...m, dir: m.from_id === req.user.id ? 'to_user' : 'from_user' })),
      unread: parseInt(unreadRows[0].count),
      hasMessages: msgs.length > 0
    };
  }));
  await pool.query('UPDATE messages SET read=TRUE WHERE to_id=$1 AND is_sent_copy=FALSE', [req.user.id]);
  res.json({ conversations: convos });
});

// ── Groq ───────────────────────────────────────────────────────────────────
async function callGroq(system, messages, res){
  try {
    const fetch = globalThis.fetch || require('node-fetch');
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: 512,
        temperature: 0.4,
      }),
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); return res.status(r.status).json({ error: e?.error?.message || 'Groq error' }); }
    const data = await r.json();
    res.json({ reply: data.choices?.[0]?.message?.content || 'No response.' });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
}

app.listen(PORT, () => console.log(`✅ Noted running at http://localhost:${PORT}`));
