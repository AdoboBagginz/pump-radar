# 🚀 PUMP RADAR PRO — Real-Time Solana Meme Screener

Live buy/sell signal screener for Solana tokens across all tiers:
- **pump.fun micro-caps** (seconds/minutes old)
- **Mid-tier DEX tokens** ($50K–$500K liquidity)
- **Established meme coins** (BONK/WIF/POPCAT tier)

Data source: **DexScreener API** (free, no key needed)  
Backend: **Node.js + WebSocket** hosted on Railway  
Frontend: **Single HTML file** — open in any browser

---

## Deploy in 5 minutes

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "initial pump radar"
gh repo create pump-radar --public --push
# or: git remote add origin https://github.com/YOURNAME/pump-radar.git && git push -u origin main
```

### Step 2 — Deploy to Railway

1. Go to [railway.app](https://railway.app) → **New Project**
2. Click **Deploy from GitHub repo**
3. Select your `pump-radar` repo
4. Railway auto-detects Node.js and deploys

That's it. Railway will give you a URL like:
```
https://pump-radar-production-xxxx.up.railway.app
```

### Step 3 — Open the screener

Option A — **Use the hosted frontend** (easiest):  
Just open your Railway URL in a browser. The frontend is served automatically.

Option B — **Open locally**:  
Open `public/index.html` in your browser, then paste your Railway URL into the **WS URL** box:
```
wss://pump-radar-production-xxxx.up.railway.app
```
Click **CONNECT**.

---

## How it works

```
DexScreener API  ──→  Railway server  ──→  WebSocket  ──→  Your browser
  (every 10s)        (scores tokens)      (real-time)      (live table)
```

**Data sources polled each scan:**
- `/token-profiles/latest/v1` — newest Solana token launches
- `/token-boosts/top/v1` — boosted/trending tokens
- Search: "solana meme trending"
- Search: "solana pump meme cat dog pepe"
- Search: "pump fun new solana"

**Signal engine scores each token 0–100:**

| Signal | Direction | Points |
|--------|-----------|--------|
| Buy ratio 5m > 72% (5+ txns) | BUY STRONG | +18 |
| Buy ratio 5m > 60% | BUY WEAK | +8 |
| Sell ratio 5m > 70% | SELL STRONG | −18 |
| 5m price > +15% | BUY STRONG | +18 |
| 5m price > +6% | BUY WEAK | +8 |
| 5m price < −12% | SELL STRONG | −18 |
| 1h price > +40% | BUY STRONG | +18 |
| Volume spike > 2.5× avg | BUY STRONG | +18 |
| Low liquidity < $5K | DANGER | −15 |
| Vol/Liq > 50× | DANGER | −15 |

**Verdicts:**
- **STRONG BUY** = score ≥ 72
- **BUY** = score ≥ 58
- **NEUTRAL** = 42–57
- **SELL** = score ≤ 42
- **STRONG SELL** = score ≤ 28

---

## Filters

| Filter | What it shows |
|--------|---------------|
| ALL | Everything passing min thresholds |
| 🟢 STRONG BUY | Score ≥ 72 only |
| BUY | Any buy verdict |
| 🔴 STRONG SELL | Potential dumps |
| ⚡ <1H | Brand new pairs |
| 🆕 <6H | Fresh pairs |

Min thresholds (adjustable): Liquidity, Vol 5m, Score

---

## Local development

```bash
npm install
npm run dev
# Open http://localhost:3000
```

---

## ⚠️ Disclaimer

This tool is for **informational purposes only**.  
Solana meme coins carry extreme risk — rug pulls, wash trading, and manipulation are common.  
Always verify on [RugCheck.xyz](https://rugcheck.xyz) before trading.  
**NOT financial advice.**
