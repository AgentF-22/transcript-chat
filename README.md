# Transcript Chat

AI-powered interview transcript chatbot. Users just open the app — no sign-in, no API key needed on their end.

---

## How it works

- **You** run a small server that holds your Groq API key
- **Users** just open the webpage — they see nothing except the chat UI
- All AI calls go through your server, key is never exposed

---

## Setup (5 minutes)

### 1. Get a free Groq API key
- Go to https://console.groq.com
- Sign up (free, no credit card needed)
- Click **API Keys** → **Create API Key**
- Copy the key (starts with `gsk_`)

### 2. Add your key
Open `.env` and replace `your_groq_key_here` with your actual key:
```
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
```

### 3. Install and run
```bash
npm install
npm start
```

### 4. Open in browser
Go to http://localhost:3000

---

## Deploy online (so anyone can use it)

The easiest free option is **Railway**:

1. Push this folder to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Add environment variable: `GROQ_API_KEY=your_key`
4. Railway gives you a public URL — share that with your users

Other options: Render, Fly.io, Heroku — all work the same way.

---

## Groq pricing

Groq has a very generous free tier:
- **30 requests/minute** on the free plan
- Paid plans start at ~$0.59 per million tokens (extremely cheap)

For a small business using this internally, the free tier is likely enough.
