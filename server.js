require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY   = process.env.GROQ_API_KEY || '';
const ADMIN_USERNAME = process.env.APP_USERNAME || 'DasaultRafale';
const ADMIN_PASSWORD = process.env.APP_PASSWORD || '654321';

// ── Persistent user storage ────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers(){
  try {
    if(fs.existsSync(USERS_FILE)){
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      return new Map(Object.entries(data));
    }
  } catch(e){ console.error('Failed to load users.json:', e.message); }
  return new Map();
}

function saveUsers(){
  try {
    const obj = Object.fromEntries(users);
    fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2));
  } catch(e){ console.error('Failed to save users.json:', e.message); }
}

// Load saved users, then ensure admin account always exists
const users = loadUsers();
users.set(ADMIN_USERNAME, {
  password: ADMIN_PASSWORD,
  blocked: false,
  createdAt: users.get(ADMIN_USERNAME)?.createdAt || new Date().toISOString(),
  isAdmin: true
});
saveUsers();

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
  saveUsers();
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
  saveUsers();
  res.json({ ok: true });
});

// ── Admin: unblock user ────────────────────────────────────────────────────
app.post('/api/admin/unblock/:username', requireAdmin, (req, res) => {
  const user = users.get(req.params.username);
  if(!user) return res.status(404).json({ error: 'User not found' });
  user.blocked = false;
  saveUsers();
  res.json({ ok: true });
});

// ── Admin: delete user ─────────────────────────────────────────────────────
app.delete('/api/admin/delete/:username', requireAdmin, (req, res) => {
  const user = users.get(req.params.username);
  if(!user) return res.status(404).json({ error: 'User not found' });
  if(user.isAdmin) return res.status(400).json({ error: 'Cannot delete admin' });
  users.delete(req.params.username);
  saveUsers();
  res.json({ ok: true });
});

// ── Persistent messages storage ────────────────────────────────────────────
// messages.json: { "username": [{ id, from, text, sentAt, read }] }
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

function loadMessages(){
  try {
    if(fs.existsSync(MESSAGES_FILE)){
      return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    }
  } catch(e){ console.error('Failed to load messages.json:', e.message); }
  return {};
}

function saveMessages(){
  try {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
  } catch(e){ console.error('Failed to save messages.json:', e.message); }
}

const messages = loadMessages();

// Get or create inbox for a user
function getInbox(username){
  if(!messages[username]) messages[username] = [];
  return messages[username];
}

// ── Send message (admin only) ──────────────────────────────────────────────
app.post('/api/messages/send', requireAdmin, (req, res) => {
  const { to, text } = req.body;
  const from = getUsername(req.headers['x-auth-token']);
  if(!to || !text) return res.status(400).json({ error: 'Missing fields' });
  if(!users.has(to)) return res.status(404).json({ error: 'User not found' });
  const msg = { id: crypto.randomBytes(6).toString('hex'), from, to, text, sentAt: new Date().toISOString(), read: false };
  getInbox(to).push(msg);
  // Also keep a copy in admin's sent view (stored under admin's inbox with type 'sent')
  getInbox(from).push({ ...msg, type: 'sent' });
  saveMessages();
  res.json({ ok: true });
});

// ── Reply (any user, to admin only) ───────────────────────────────────────
app.post('/api/messages/reply', requireAuth, (req, res) => {
  const { text } = req.body;
  const from = getUsername(req.headers['x-auth-token']);
  if(!text) return res.status(400).json({ error: 'Missing text' });
  // Users can only reply to admin
  const msg = { id: crypto.randomBytes(6).toString('hex'), from, to: ADMIN_USERNAME, text, sentAt: new Date().toISOString(), read: false };
  getInbox(ADMIN_USERNAME).push(msg);
  // Copy in sender's outbox
  getInbox(from).push({ ...msg, type: 'sent' });
  saveMessages();
  res.json({ ok: true });
});

// ── Get my inbox ───────────────────────────────────────────────────────────
app.get('/api/messages/inbox', requireAuth, (req, res) => {
  const username = getUsername(req.headers['x-auth-token']);
  const inbox = getInbox(username)
    .filter(m => m.type !== 'sent')
    .sort((a,b) => new Date(b.sentAt) - new Date(a.sentAt));
  // Mark all as read
  getInbox(username).forEach(m => { if(m.type !== 'sent') m.read = true; });
  saveMessages();
  res.json({ messages: inbox });
});

// ── Get unread count ───────────────────────────────────────────────────────
app.get('/api/messages/unread', requireAuth, (req, res) => {
  const username = getUsername(req.headers['x-auth-token']);
  const count = getInbox(username).filter(m => m.type !== 'sent' && !m.read).length;
  res.json({ count });
});

// ── Admin: get all conversations ───────────────────────────────────────────
app.get('/api/admin/conversations', requireAdmin, (req, res) => {
  // Return list of users who have messages with admin
  const convos = [...users.keys()]
    .filter(u => u !== ADMIN_USERNAME)
    .map(username => {
      const theirInbox = getInbox(username).filter(m => m.type !== 'sent');
      const adminInbox = getInbox(ADMIN_USERNAME).filter(m => m.from === username);
      const allMsgs = [...theirInbox.map(m=>({...m, dir:'to_user'})), ...adminInbox.map(m=>({...m, dir:'from_user'}))]
        .sort((a,b) => new Date(a.sentAt) - new Date(b.sentAt));
      const unread = adminInbox.filter(m => !m.read).length;
      return { username, messages: allMsgs, unread, hasMessages: allMsgs.length > 0 };
    });
  // Mark admin's inbox from users as read
  getInbox(ADMIN_USERNAME).forEach(m => { m.read = true; });
  saveMessages();
  res.json({ conversations: convos });
});
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
