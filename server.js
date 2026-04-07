require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || 'YOUR_GROQ_KEY_HERE';

// ── Multi-user store ───────────────────────────────────────────────────────
// Start with the hardcoded admin account, approved users get added here
const users = new Map();
users.set(process.env.APP_USERNAME || 'DasaultRafale', process.env.APP_PASSWORD || '654321');

// Pending account requests: token -> { username, password, email }
const pendingRequests = new Map();

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
    const decoded = Buffer.from(auth, 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    const u = decoded.slice(0, colonIdx);
    const p = decoded.slice(colonIdx + 1);
    return users.has(u) && users.get(u) === p;
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
  if (users.has(username) && users.get(username) === password) {
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

// ── Account request ────────────────────────────────────────────────────────
const accountRequests = [];

app.post('/api/request-account', async (req, res) => {
  const { email, username, password } = req.body;
  if(!email || !username || !password){
    return res.status(400).json({ error: 'All fields required' });
  }

  // Generate a unique token for this request
  const token = crypto.randomBytes(16).toString('hex');
  pendingRequests.set(token, { username, password, email });

  const host = `${req.protocol}://${req.get('host')}`;
  const approveUrl = `${host}/api/approve-account/${token}`;
  const declineUrl = `${host}/api/decline-account/${token}`;

  try {
    const fetch = globalThis.fetch || require('node-fetch');
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer re_SmaEXzSk_KVDq66uwDnZPmJuvCMqr3uvG`
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: ['khzsum2019@gmail.com'],
        subject: `Account request: ${username}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2 style="margin-bottom:4px">New Account Request</h2>
            <p style="color:#555;margin-top:0">Someone wants access to Finger Post Echo.</p>
            <p style="font-size:18px;margin:20px 0">👤 <strong>${username}</strong></p>
            <div style="display:flex;gap:12px;margin-top:24px">
              <a href="${approveUrl}" style="background:#10a37f;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">✅ Approve</a>
              <a href="${declineUrl}" style="background:#ef4444;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">❌ Decline</a>
            </div>
          </div>
        `
      })
    });
  } catch(e) {
    console.error('Email failed:', e.message);
  }

  res.json({ ok: true });
});

// ── Approve account ────────────────────────────────────────────────────────
app.get('/api/approve-account/:token', async (req, res) => {
  const data = pendingRequests.get(req.params.token);
  if(!data) return res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>❌ Request not found or already handled.</h2></body></html>`);
  
  users.set(data.username, data.password);
  pendingRequests.delete(req.params.token);
  console.log(`[Approved] User: ${data.username}`);

  // Email the user to tell them their account is ready
  try {
    const fetch = globalThis.fetch || require('node-fetch');
    const appUrl = `${req.protocol}://${req.get('host')}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer re_SmaEXzSk_KVDq66uwDnZPmJuvCMqr3uvG`
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: [data.email],
        subject: 'Your Finger Post Echo account is ready',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2 style="color:#10a37f">Your account is ready ✅</h2>
            <p style="color:#555">Your Finger Post Echo account has been approved. Here are your login details:</p>
            <div style="background:#f9f9f9;border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin:20px 0">
              <p style="margin:6px 0"><strong>Username:</strong> ${data.username}</p>
              <p style="margin:6px 0"><strong>Password:</strong> ${data.password}</p>
            </div>
            <a href="${appUrl}" style="display:inline-block;background:#10a37f;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">Open Finger Post Echo →</a>
            <p style="color:#aaa;font-size:12px;margin-top:24px">Finger Post Echo · Powered by Finger Post</p>
          </div>
        `
      })
    });
  } catch(e) {
    console.error('User email failed:', e.message);
  }

  res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#f0fdf4"><h2 style="color:#10a37f">✅ Account approved!</h2><p><strong>${data.username}</strong> has been notified by email and can now log in.</p></body></html>`);
});

// ── Decline account ────────────────────────────────────────────────────────
app.get('/api/decline-account/:token', (req, res) => {
  const data = pendingRequests.get(req.params.token);
  if(!data) return res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>❌ Request not found or already handled.</h2></body></html>`);
  pendingRequests.delete(req.params.token);
  console.log(`[Declined] User: ${data.username}`);
  res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#fef2f2"><h2 style="color:#ef4444">❌ Request declined.</h2><p>The request from <strong>${data.username}</strong> has been declined.</p></body></html>`);
});
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
