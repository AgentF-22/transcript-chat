require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');
const { Pool } = require('pg');
const mammoth  = require('mammoth');

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY   = process.env.GROQ_API_KEY || '';
const ADMIN_USERNAME = process.env.APP_USERNAME || 'DasaultRafale';
const ADMIN_PASSWORD = process.env.APP_PASSWORD || '654321';

// ── Plans ──────────────────────────────────────────────────────────────────
const PLANS = {
  free:  { label: 'Free',  daily: 20  },
  plus:  { label: 'Plus',  daily: 100 },
  pro:   { label: 'Pro',   daily: 400 },
};

// ── PostgreSQL ─────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      blocked  BOOLEAN DEFAULT FALSE,
      plan     TEXT DEFAULT 'free',
      usage_count INT DEFAULT 0,
      usage_reset TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add plan columns to existing tables if they don't exist yet
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_count INT DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_reset TIMESTAMPTZ DEFAULT NOW()`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_requests (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      requested_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_user TEXT NOT NULL,
      to_user   TEXT NOT NULL,
      text      TEXT NOT NULL,
      read      BOOLEAN DEFAULT FALSE,
      is_sent_copy BOOLEAN DEFAULT FALSE,
      sent_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    INSERT INTO users (username, password, is_admin, blocked, plan)
    VALUES ($1, $2, TRUE, FALSE, 'free')
    ON CONFLICT (username) DO UPDATE SET password = $2
  `, [ADMIN_USERNAME, ADMIN_PASSWORD]);
  console.log('✅ Database ready');
}

initDB().catch(e => console.error('DB init error:', e.message));

const deliverables = new Map();

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

// ── Auth helpers ───────────────────────────────────────────────────────────
function decodeToken(auth){
  try {
    const decoded = Buffer.from(auth, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    return { username: decoded.slice(0,i), password: decoded.slice(i+1) };
  } catch { return null; }
}

async function checkToken(auth){
  const t = decodeToken(auth);
  if(!t) return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [t.username]);
  const user = rows[0];
  if(!user || user.password !== t.password || user.blocked) return null;
  return user;
}

async function requireAuth(req, res, next){
  const user = await checkToken(req.headers['x-auth-token']);
  if(!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

async function requireAdmin(req, res, next){
  const user = await checkToken(req.headers['x-auth-token']);
  if(!user) return res.status(401).json({ error: 'Not authenticated' });
  if(!user.is_admin) return res.status(403).json({ error: 'Admin only' });
  req.user = user;
  next();
}

// ── Usage check helper ─────────────────────────────────────────────────────
async function checkAndIncrementUsage(user){
  if(user.is_admin) return { ok: true };

  const plan = PLANS[user.plan] || PLANS.free;
  const now  = new Date();
  const reset = new Date(user.usage_reset);

  // Reset counter if last reset was more than 24h ago
  if((now - reset) > 24 * 60 * 60 * 1000){
    await pool.query(
      'UPDATE users SET usage_count=1, usage_reset=$1 WHERE username=$2',
      [now.toISOString(), user.username]
    );
    return { ok: true, used: 1, limit: plan.daily };
  }

  if(user.usage_count >= plan.daily){
    const msLeft = 24*60*60*1000 - (now - reset);
    const hLeft  = Math.ceil(msLeft / (60*60*1000));
    return { ok: false, used: user.usage_count, limit: plan.daily, hoursLeft: hLeft };
  }

  await pool.query(
    'UPDATE users SET usage_count=usage_count+1 WHERE username=$1',
    [user.username]
  );
  return { ok: true, used: user.usage_count + 1, limit: plan.daily };
}

// ── Login ──────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  const user = rows[0];
  if(!user || user.password !== password)
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  if(user.blocked)
    return res.status(403).json({ ok: false, error: 'This account has been suspended.' });
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  const plan  = user.plan || 'free';
  res.json({ ok: true, token, isAdmin: !!user.is_admin, plan });
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

// ── Deliverables ───────────────────────────────────────────────────────────
app.post('/api/deliverable/create', requireAuth, (req, res) => {
  const { sources, title } = req.body;
  if(!sources || !sources.length) return res.status(400).json({ error: 'No sources' });
  const id   = crypto.randomBytes(12).toString('hex');
  const code = Math.random().toString(36).slice(2,8).toUpperCase();
  deliverables.set(id, { id, code, sources, title: title || 'Expert Interview', createdAt: new Date().toISOString() });
  res.json({ ok: true, url: `${req.protocol}://${req.get('host')}/d/${id}`, code, id });
});

app.post('/api/deliverable/access', (req, res) => {
  const { id, code } = req.body;
  const d = deliverables.get(id);
  if(!d) return res.status(404).json({ error: 'Not found or expired' });
  if(d.code !== code.toUpperCase().trim()) return res.status(401).json({ error: 'Wrong access code' });
  res.json({ ok: true, title: d.title, sources: d.sources });
});

app.post('/api/deliverable/chat', async (req, res) => {
  const { id, code, messages, system } = req.body;
  const d = deliverables.get(id);
  if(!d) return res.status(404).json({ error: 'Not found' });
  if(d.code !== code.toUpperCase().trim()) return res.status(401).json({ error: 'Invalid code' });
  await callGroq(system, messages, res);
});

app.get('/d/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'deliverable.html'));
});

// ── Account requests ───────────────────────────────────────────────────────
app.post('/api/request-account', async (req, res) => {
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).json({ error: 'All fields required' });
  const existing = await pool.query('SELECT username FROM users WHERE username=$1', [username]);
  if(existing.rows.length) return res.status(400).json({ error: 'Username already taken.' });
  const pending = await pool.query('SELECT id FROM pending_requests WHERE username=$1', [username]);
  if(pending.rows.length) return res.status(400).json({ error: 'Request already pending.' });
  const id = crypto.randomBytes(8).toString('hex');
  await pool.query('INSERT INTO pending_requests (id,username,password) VALUES ($1,$2,$3)', [id, username, password]);
  res.json({ ok: true });
});

// ── Admin: list pending requests ───────────────────────────────────────────
app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, requested_at FROM pending_requests ORDER BY requested_at ASC');
  res.json({ requests: rows.map(r => ({ id: r.id, username: r.username, requestedAt: r.requested_at })) });
});

// ── Admin: approve ─────────────────────────────────────────────────────────
app.post('/api/admin/approve/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pending_requests WHERE id=$1', [req.params.id]);
  if(!rows.length) return res.status(404).json({ error: 'Request not found' });
  const r = rows[0];
  await pool.query('INSERT INTO users (username,password,is_admin,blocked,plan) VALUES ($1,$2,FALSE,FALSE,\'free\') ON CONFLICT (username) DO NOTHING', [r.username, r.password]);
  await pool.query('DELETE FROM pending_requests WHERE id=$1', [req.params.id]);
  res.json({ ok: true, username: r.username });
});

// ── Admin: decline ─────────────────────────────────────────────────────────
app.delete('/api/admin/decline/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM pending_requests WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Admin: list users ──────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT username, blocked, plan, usage_count, usage_reset, created_at FROM users WHERE is_admin=FALSE ORDER BY created_at ASC');
  res.json({ users: rows.map(r => ({
    username: r.username,
    blocked: r.blocked,
    plan: r.plan || 'free',
    usageCount: r.usage_count || 0,
    usageReset: r.usage_reset,
    createdAt: r.created_at
  })) });
});

// ── Admin: set plan ────────────────────────────────────────────────────────
app.post('/api/admin/setplan/:username', requireAdmin, async (req, res) => {
  const { plan } = req.body;
  if(!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  await pool.query('UPDATE users SET plan=$1 WHERE username=$2 AND is_admin=FALSE', [plan, req.params.username]);
  res.json({ ok: true });
});

// ── Admin: block ───────────────────────────────────────────────────────────
app.post('/api/admin/block/:username', requireAdmin, async (req, res) => {
  await pool.query('UPDATE users SET blocked=TRUE WHERE username=$1 AND is_admin=FALSE', [req.params.username]);
  res.json({ ok: true });
});

// ── Admin: unblock ─────────────────────────────────────────────────────────
app.post('/api/admin/unblock/:username', requireAdmin, async (req, res) => {
  await pool.query('UPDATE users SET blocked=FALSE WHERE username=$1', [req.params.username]);
  res.json({ ok: true });
});

// ── Admin: delete ──────────────────────────────────────────────────────────
app.delete('/api/admin/delete/:username', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM users WHERE username=$1 AND is_admin=FALSE', [req.params.username]);
  res.json({ ok: true });
});

// ── Messages: send (admin only) ────────────────────────────────────────────
app.post('/api/messages/send', requireAdmin, async (req, res) => {
  const { to, text } = req.body;
  const from = req.user.username;
  if(!to || !text) return res.status(400).json({ error: 'Missing fields' });
  const toUser = await pool.query('SELECT username FROM users WHERE username=$1', [to]);
  if(!toUser.rows.length) return res.status(404).json({ error: 'User not found' });
  const id = crypto.randomBytes(6).toString('hex');
  await pool.query('INSERT INTO messages (id,from_user,to_user,text,read,is_sent_copy) VALUES ($1,$2,$3,$4,FALSE,FALSE)',
    [id, from, to, text]);
  await pool.query('INSERT INTO messages (id,from_user,to_user,text,read,is_sent_copy) VALUES ($1,$2,$3,$4,TRUE,TRUE)',
    [id+'_s', from, to, text]);
  res.json({ ok: true });
});

// ── Messages: reply (user to admin) ───────────────────────────────────────
app.post('/api/messages/reply', requireAuth, async (req, res) => {
  const { text } = req.body;
  const from = req.user.username;
  if(!text) return res.status(400).json({ error: 'Missing text' });
  const id = crypto.randomBytes(6).toString('hex');
  await pool.query('INSERT INTO messages (id,from_user,to_user,text,read,is_sent_copy) VALUES ($1,$2,$3,$4,FALSE,FALSE)',
    [id, from, ADMIN_USERNAME, text]);
  res.json({ ok: true });
});

// ── Messages: inbox ────────────────────────────────────────────────────────
app.get('/api/messages/inbox', requireAuth, async (req, res) => {
  const username = req.user.username;
  const { rows } = await pool.query(
    'SELECT * FROM messages WHERE to_user=$1 AND is_sent_copy=FALSE ORDER BY sent_at DESC',
    [username]
  );
  await pool.query('UPDATE messages SET read=TRUE WHERE to_user=$1 AND is_sent_copy=FALSE', [username]);
  res.json({ messages: rows.map(r => ({ id: r.id, from: r.from_user, text: r.text, sentAt: r.sent_at, read: r.read })) });
});

// ── Messages: unread count ─────────────────────────────────────────────────
app.get('/api/messages/unread', requireAuth, async (req, res) => {
  const username = req.user.username;
  const { rows } = await pool.query(
    'SELECT COUNT(*) as count FROM messages WHERE to_user=$1 AND read=FALSE AND is_sent_copy=FALSE',
    [username]
  );
  res.json({ count: parseInt(rows[0].count) });
});

// ── Admin: all conversations ───────────────────────────────────────────────
app.get('/api/admin/conversations', requireAdmin, async (req, res) => {
  const { rows: userRows } = await pool.query('SELECT username FROM users WHERE is_admin=FALSE');
  const convos = await Promise.all(userRows.map(async u => {
    const { rows: msgs } = await pool.query(
      `SELECT * FROM messages WHERE (from_user=$1 AND to_user=$2) OR (from_user=$2 AND to_user=$1 AND is_sent_copy=FALSE) ORDER BY sent_at ASC`,
      [ADMIN_USERNAME, u.username]
    );
    const { rows: unreadRows } = await pool.query(
      'SELECT COUNT(*) as count FROM messages WHERE from_user=$1 AND to_user=$2 AND read=FALSE AND is_sent_copy=FALSE',
      [u.username, ADMIN_USERNAME]
    );
    return {
      username: u.username,
      messages: msgs.map(m => ({ ...m, dir: m.from_user === ADMIN_USERNAME ? 'to_user' : 'from_user' })),
      unread: parseInt(unreadRows[0].count),
      hasMessages: msgs.length > 0
    };
  }));
  await pool.query('UPDATE messages SET read=TRUE WHERE to_user=$1 AND is_sent_copy=FALSE', [ADMIN_USERNAME]);
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

app.listen(PORT, () => console.log(`✅ Finger Post Echo running at http://localhost:${PORT}`));
