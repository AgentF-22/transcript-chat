require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || 'YOUR_GROQ_KEY_HERE';
const USERNAME = process.env.APP_USERNAME || 'DasaultRafale';
const PASSWORD = process.env.APP_PASSWORD || '654321';

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for deliverables (survives until server restart)
// For production persistence you'd use a DB, but this works great for now
const deliverables = new Map();
// key = id (random hex), value = { id, code, sources, createdAt, title }

// ── Auth helpers ───────────────────────────────────────────────────────────
function makeToken(u, p) {
  return Buffer.from(`${u}:${p}`).toString('base64');
}
function checkToken(auth) {
  try {
    const [u, p] = Buffer.from(auth, 'base64').toString('utf8').split(':');
    return u === USERNAME && p === PASSWORD;
  } catch { return false; }
}
function requireAuth(req, res, next) {
  const auth = req.headers['x-auth-token'];
  if (!auth || !checkToken(auth)) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ── Login ──────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === USERNAME && password === PASSWORD) {
    res.json({ ok: true, token: makeToken(username, password) });
  } else {
    res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }
});

// ── Chat (main app) ────────────────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, system } = req.body;
  if (!messages || !system) return res.status(400).json({ error: 'Missing fields' });
  await callGroq(system, messages, res);
});

// ── Create deliverable ─────────────────────────────────────────────────────
app.post('/api/deliverable/create', requireAuth, (req, res) => {
  const { sources, title } = req.body;
  if (!sources || !sources.length) return res.status(400).json({ error: 'No sources provided' });

  const id   = crypto.randomBytes(12).toString('hex');       // unique URL id
  const code = Math.random().toString(36).slice(2,8).toUpperCase(); // 6-char access code

  deliverables.set(id, {
    id,
    code,
    sources,
    title: title || 'Candidate Chat',
    createdAt: new Date().toISOString(),
  });

  const url = `${req.protocol}://${req.get('host')}/d/${id}`;
  res.json({ ok: true, url, code, id });
});

// ── Deliverable access ─────────────────────────────────────────────────────
app.post('/api/deliverable/access', (req, res) => {
  const { id, code } = req.body;
  const d = deliverables.get(id);
  if (!d) return res.status(404).json({ error: 'Deliverable not found or expired' });
  if (d.code !== code.toUpperCase().trim()) return res.status(401).json({ error: 'Wrong access code' });
  // Return sources and title but not the code
  res.json({ ok: true, title: d.title, sources: d.sources });
});

// ── Deliverable chat (no main auth needed — uses deliverable id) ───────────
app.post('/api/deliverable/chat', async (req, res) => {
  const { id, code, messages, system } = req.body;
  const d = deliverables.get(id);
  if (!d) return res.status(404).json({ error: 'Deliverable not found' });
  if (d.code !== code.toUpperCase().trim()) return res.status(401).json({ error: 'Invalid code' });
  if (!messages || !system) return res.status(400).json({ error: 'Missing fields' });
  await callGroq(system, messages, res);
});

// ── List deliverables (for main app) ──────────────────────────────────────
app.get('/api/deliverable/list', requireAuth, (req, res) => {
  const list = [...deliverables.values()].map(d => ({
    id: d.id, code: d.code, title: d.title, createdAt: d.createdAt,
    url: `${req.protocol}://${req.get('host')}/d/${d.id}`
  })).reverse();
  res.json({ list });
});

// ── Delete deliverable ─────────────────────────────────────────────────────
app.delete('/api/deliverable/:id', requireAuth, (req, res) => {
  deliverables.delete(req.params.id);
  res.json({ ok: true });
});

// ── Serve deliverable page ─────────────────────────────────────────────────
app.get('/d/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'deliverable.html'));
});

// ── Groq helper ────────────────────────────────────────────────────────────
async function callGroq(system, messages, res) {
  try {
    const fetch = globalThis.fetch || require('node-fetch');
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: 512,
        temperature: 0.4,
      }),
    });
    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      return res.status(groqRes.status).json({ error: err?.error?.message || 'Groq error' });
    }
    const data = await groqRes.json();
    res.json({ reply: data.choices?.[0]?.message?.content || 'No response.' });
  } catch (e) {
    console.error('Groq error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
}

app.listen(PORT, () => {
  console.log(`✅ Transcript Chat running at http://localhost:${PORT}`);
});
