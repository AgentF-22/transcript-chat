require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY   = process.env.GROQ_API_KEY || '';
const ADMIN_USERNAME = process.env.APP_USERNAME || 'DasaultRafale';
const ADMIN_PASSWORD = process.env.APP_PASSWORD || '654321';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL   = process.env.NOTIFY_EMAIL || '';

// users: username -> { password, blocked, createdAt, isAdmin }
const users = new Map();
users.set(ADMIN_USERNAME, {
  password: ADMIN_PASSWORD,
  blocked: false,
  createdAt: new Date().toISOString(),
  isAdmin: true
});

// pendingRequests: id -> { id, username, password, requestedAt }
const pendingRequests = new Map();

// deliverables: id -> { id, code, sources, title, createdAt }
const deliverables = new Map();

const mammoth = require('mammoth');

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Extract docx text ──────────────────────────────────────────────────────
app.post('/api/extract-docx', async (req, res) => {
  try {
    const buffer = req.body; // raw bytes
    if(!buffer || !buffer.length) return res.status(400).json({ error: 'No file data' });
    const result = await mammoth.extractRawText({ buffer });
    if(!result.value) return res.status(400).json({ error: 'No text found in document' });
    res.json({ ok: true, text: result.value });
  } catch(e) {
    console.error('Docx extract error:', e.message);
    res.status(500).json({ error: 'Failed to read docx: ' + e.message });
  }
});

// ── Auth helpers ───────────────────────────────────────────────────────────
function getUsername(auth){
  try {
    const decoded = Buffer.from(auth, 'base64').toString('utf8');
    return decoded.slice(0, decoded.indexOf(':'));
  } catch { return null; }
}

function checkToken(auth){
  try {
    const decoded = Buffer.from(auth, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const u = decoded.slice(0, i);
    const p = decoded.slice(i + 1);
    const user = users.get(u);
    return user && user.password === p && !user.blocked;
  } catch { return false; }
}

function requireAuth(req, res, next){
  const auth = req.headers['x-auth-token'];
  if(!auth || !checkToken(auth)) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next){
  const auth = req.headers['x-auth-token'];
  if(!auth || !checkToken(auth)) return res.status(401).json({ error: 'Not authenticated' });
  const u = getUsername(auth);
  if(!users.get(u)?.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── Login ──────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);
  if(!user || user.password !== password)
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  if(user.blocked)
    return res.status(403).json({ ok: false, error: 'This account has been suspended.' });
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  res.json({ ok: true, token, isAdmin: !!user.isAdmin });
});

// ── Chat ───────────────────────────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, system } = req.body;
  if(!messages || !system) return res.status(400).json({ error: 'Missing fields' });
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
app.post('/api/request-account', (req, res) => {
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).json({ error: 'All fields required' });
  if(users.has(username)) return res.status(400).json({ error: 'Username already taken.' });
  // Check if already pending
  for(const r of pendingRequests.values()){
    if(r.username === username) return res.status(400).json({ error: 'Request already pending for this username.' });
  }
  const id = crypto.randomBytes(8).toString('hex');
  pendingRequests.set(id, { id, username, password, requestedAt: new Date().toISOString() });
  console.log(`[Account request] ${username}`);
  res.json({ ok: true });
});

// ── Admin: list pending requests ───────────────────────────────────────────
app.get('/api/admin/requests', requireAdmin, (req, res) => {
  res.json({ requests: [...pendingRequests.values()].map(r => ({ id: r.id, username: r.username, requestedAt: r.requestedAt })) });
});

// ── Admin: approve request ─────────────────────────────────────────────────
app.post('/api/admin/approve/:id', requireAdmin, (req, res) => {
  const r = pendingRequests.get(req.params.id);
  if(!r) return res.status(404).json({ error: 'Request not found' });
  users.set(r.username, { password: r.password, blocked: false, createdAt: new Date().toISOString(), isAdmin: false });
  pendingRequests.delete(req.params.id);
  console.log(`[Approved] ${r.username}`);
  res.json({ ok: true, username: r.username });
});

// ── Admin: decline request ─────────────────────────────────────────────────
app.delete('/api/admin/decline/:id', requireAdmin, (req, res) => {
  const r = pendingRequests.get(req.params.id);
  if(!r) return res.status(404).json({ error: 'Request not found' });
  pendingRequests.delete(req.params.id);
  console.log(`[Declined] ${r.username}`);
  res.json({ ok: true });
});

// ── Admin: list users ──────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const list = [...users.entries()]
    .filter(([u]) => u !== ADMIN_USERNAME)
    .map(([username, data]) => ({ username, blocked: data.blocked, createdAt: data.createdAt }));
  res.json({ users: list });
});

// ── Admin: block user ──────────────────────────────────────────────────────
app.post('/api/admin/block/:username', requireAdmin, (req, res) => {
  const user = users.get(req.params.username);
  if(!user) return res.status(404).json({ error: 'User not found' });
  if(user.isAdmin) return res.status(400).json({ error: 'Cannot block admin' });
  user.blocked = true;
  res.json({ ok: true });
});

// ── Admin: unblock user ────────────────────────────────────────────────────
app.post('/api/admin/unblock/:username', requireAdmin, (req, res) => {
  const user = users.get(req.params.username);
  if(!user) return res.status(404).json({ error: 'User not found' });
  user.blocked = false;
  res.json({ ok: true });
});

// ── Admin: delete user ─────────────────────────────────────────────────────
app.delete('/api/admin/delete/:username', requireAdmin, (req, res) => {
  const user = users.get(req.params.username);
  if(!user) return res.status(404).json({ error: 'User not found' });
  if(user.isAdmin) return res.status(400).json({ error: 'Cannot delete admin' });
  users.delete(req.params.username);
  res.json({ ok: true });
});

// ── Groq ───────────────────────────────────────────────────────────────────
async function callGroq(system, messages, res){
  try {
    const fetch = globalThis.fetch || require('node-fetch');
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
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
