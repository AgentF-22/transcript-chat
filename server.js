require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || 'YOUR_GROQ_KEY_HERE';

// ── Credentials (change these to whatever you want) ────────────────────────
const USERNAME = process.env.APP_USERNAME || 'DasaultRafale';
const PASSWORD = process.env.APP_PASSWORD || '654321';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Login endpoint ─────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === USERNAME && password === PASSWORD) {
    res.json({ ok: true, token: Buffer.from(`${username}:${password}`).toString('base64') });
  } else {
    res.status(401).json({ ok: false, error: 'Invalid username or password' });
  }
});

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers['x-auth-token'];
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = Buffer.from(auth, 'base64').toString('utf8');
    const [u, p]  = decoded.split(':');
    if (u === USERNAME && p === PASSWORD) return next();
    res.status(401).json({ error: 'Invalid token' });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Chat endpoint ──────────────────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, system } = req.body;
  if (!messages || !system) return res.status(400).json({ error: 'Missing fields' });

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

    const data  = await groqRes.json();
    const reply = data.choices?.[0]?.message?.content || 'No response.';
    res.json({ reply });

  } catch (e) {
    console.error('Server error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Transcript Chat running at http://localhost:${PORT}`);
});
