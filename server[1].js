import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import fetch from "node-fetch";
import cors from "cors";
import { initBot, processScanData, emergencyStop, getBotStatus, getBotEvents } from "./bot.js";

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server, path: "/ws" });

app.use(cors());
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const POLL_MS        = 10000;   // poll DexScreener every 10s
const SIGNAL_WINDOW  = 60;      // seconds of price history for signals
const MAX_HISTORY    = 12;      // data points to keep per token (2 min)

// ─── STATE ───────────────────────────────────────────────────────────────────
let tokenMap    = new Map();    // address → token state
let lastScanAt  = null;
let scanCount   = 0;

// ─── DEXSCREENER FETCH HELPERS ───────────────────────────────────────────────
const DEX_HEADERS = {
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; PumpRadar/1.0)",
};

async function dexFetch(url) {
  const res = await fetch(url, { headers: DEX_HEADERS, timeout: 8000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Fetch latest token profiles (newest Solana tokens)
async function fetchNewProfiles() {
  try {
    const data = await dexFetch("https://api.dexscreener.com/token-profiles/latest/v1");
    return (Array.isArray(data) ? data : [])
      .filter(t => t.chainId === "solana")
      .slice(0, 30)
      .map(t => t.tokenAddress)
      .filter(Boolean);
  } catch (e) {
    console.error("[profiles]", e.message);
    return [];
  }
}

// Fetch top boosted tokens
async function fetchBoosted() {
  try {
    const data = await dexFetch("https://api.dexscreener.com/token-boosts/top/v1");
    return (Array.isArray(data) ? data : [])
      .filter(t => t.chainId === "solana")
      .slice(0, 20)
      .map(t => t.tokenAddress)
      .filter(Boolean);
  } catch (e) {
    console.error("[boosted]", e.message);
    return [];
  }
}

// Fetch pairs by token addresses (batch up to 30)
async function fetchPairsByTokens(addresses) {
  if (!addresses.length) return [];
  const chunks = [];
  for (let i = 0; i < addresses.length; i += 30)
    chunks.push(addresses.slice(i, i + 30));

  const results = [];
  for (const chunk of chunks) {
    try {
      const data = await dexFetch(
        `https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`
      );
      const pairs = Array.isArray(data) ? data : (data.pairs || []);
      results.push(...pairs);
    } catch (e) {
      console.error("[pairs]", e.message);
    }
  }
  return results;
}

// Fetch trending search results
async function fetchSearch(query) {
  try {
    const data = await dexFetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`
    );
    return (data.pairs || []).filter(p => p.chainId === "solana");
  } catch (e) {
    console.error(`[search:${query}]`, e.message);
    return [];
  }
}

// ─── NORMALIZE PAIR → TOKEN ───────────────────────────────────────────────────
function normalizePair(pair) {
  if (!pair?.baseToken?.symbol) return null;
  const addr = pair.baseToken.address || pair.pairAddress;
  if (!addr) return null;

  return {
    address:    addr,
    pairAddr:   pair.pairAddress || addr,
    symbol:     pair.baseToken.symbol.toUpperCase(),
    name:       pair.baseToken.name || pair.baseToken.symbol,
    dex:        pair.dexId || "unknown",
    chainId:    pair.chainId || "solana",
    priceUsd:   parseFloat(pair.priceUsd) || 0,
    liquidity:  pair.liquidity?.usd || 0,
    vol5m:      pair.volume?.m5   || 0,
    vol1h:      pair.volume?.h1   || 0,
    vol6h:      pair.volume?.h6   || 0,
    vol24h:     pair.volume?.h24  || 0,
    c5m:        pair.priceChange?.m5  || 0,
    c1h:        pair.priceChange?.h1  || 0,
    c6h:        pair.priceChange?.h6  || 0,
    c24h:       pair.priceChange?.h24 || 0,
    buys5m:     pair.txns?.m5?.buys   || 0,
    sells5m:    pair.txns?.m5?.sells  || 0,
    buys1h:     pair.txns?.h1?.buys   || 0,
    sells1h:    pair.txns?.h1?.sells  || 0,
    buys24h:    pair.txns?.h24?.buys  || 0,
    sells24h:   pair.txns?.h24?.sells || 0,
    pairCreatedAt: pair.pairCreatedAt || Date.now(),
    fdv:        pair.fdv || 0,
    marketCap:  pair.marketCap || 0,
    url:        pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
    updatedAt:  Date.now(),
  };
}

// ─── SIGNAL ENGINE ────────────────────────────────────────────────────────────
const MEME_KW = [
  "pepe","doge","shib","cat","dog","frog","wojak","chad","based","moon","pump",
  "ape","bonk","wif","popcat","mew","trump","elon","sigma","gigachad","skibidi",
  "wagmi","ngmi","rekt","stonk","wen","pnut","goat","moodeng","chillguy","baby",
  "inu","rocket","banana","corn","tendies","cope","seethe","fart","pengu","useless",
];

function computeSignals(token, history) {
  const signals = [];

  // ── Buy/sell pressure (5m window) ────────────────────────────────────────
  const total5m  = token.buys5m + token.sells5m;
  const buyR5m   = total5m > 0 ? token.buys5m / total5m : 0.5;
  const total1h  = token.buys1h + token.sells1h;
  const buyR1h   = total1h > 0 ? token.buys1h / total1h : 0.5;

  if (buyR5m > 0.72 && total5m >= 5)
    signals.push({ type:"BUY",  strength:"STRONG", label:"🟢 Buy wall 5m",   detail:`${token.buys5m}B / ${token.sells5m}S (${(buyR5m*100).toFixed(0)}% buys)` });
  else if (buyR5m > 0.60 && total5m >= 3)
    signals.push({ type:"BUY",  strength:"WEAK",   label:"🟡 Buy pressure 5m", detail:`${token.buys5m}B / ${token.sells5m}S` });
  else if (buyR5m < 0.30 && total5m >= 5)
    signals.push({ type:"SELL", strength:"STRONG", label:"🔴 Sell pressure 5m", detail:`${token.sells5m}S / ${token.buys5m}B (${((1-buyR5m)*100).toFixed(0)}% sells)` });
  else if (buyR5m < 0.42 && total5m >= 3)
    signals.push({ type:"SELL", strength:"WEAK",   label:"🟠 Sell pressure 5m", detail:`${token.sells5m}S / ${token.buys5m}B` });

  // ── Price momentum ────────────────────────────────────────────────────────
  if (token.c5m > 15)
    signals.push({ type:"BUY",  strength:"STRONG", label:"🚀 5m pump",  detail:`+${token.c5m.toFixed(1)}%` });
  else if (token.c5m > 6)
    signals.push({ type:"BUY",  strength:"WEAK",   label:"📈 5m up",    detail:`+${token.c5m.toFixed(1)}%` });
  else if (token.c5m < -12)
    signals.push({ type:"SELL", strength:"STRONG", label:"💥 5m dump",  detail:`${token.c5m.toFixed(1)}%` });
  else if (token.c5m < -5)
    signals.push({ type:"SELL", strength:"WEAK",   label:"📉 5m down",  detail:`${token.c5m.toFixed(1)}%` });

  if (token.c1h > 40)
    signals.push({ type:"BUY",  strength:"STRONG", label:"🔥 1h breakout", detail:`+${token.c1h.toFixed(1)}%` });
  else if (token.c1h < -30)
    signals.push({ type:"SELL", strength:"STRONG", label:"⚠ 1h bleed",    detail:`${token.c1h.toFixed(1)}%` });

  // ── Volume spike detection ────────────────────────────────────────────────
  if (history.length >= 3) {
    const prevVols = history.slice(0, -1).map(h => h.vol5m || 0);
    const avgPrevVol = prevVols.reduce((a,b) => a+b, 0) / prevVols.length;
    if (avgPrevVol > 0 && token.vol5m > avgPrevVol * 2.5)
      signals.push({ type:"BUY", strength:"STRONG", label:"⚡ Vol spike",
        detail:`${fmtN(token.vol5m)} vs avg ${fmtN(avgPrevVol)}` });
  }

  // ── New token age bonus ───────────────────────────────────────────────────
  const ageH = (Date.now() - token.pairCreatedAt) / 3600000;
  if (ageH < 1)
    signals.push({ type:"INFO", strength:"INFO", label:"🆕 <1H old",  detail:`${(ageH*60).toFixed(0)}m ago` });
  else if (ageH < 6)
    signals.push({ type:"INFO", strength:"INFO", label:"🆕 <6H old",  detail:`${ageH.toFixed(1)}h ago` });

  // ── Rug / safety flags ────────────────────────────────────────────────────
  if (token.liquidity < 5000)
    signals.push({ type:"WARN", strength:"DANGER", label:"🚨 Low liquidity", detail:`$${fmtN(token.liquidity)}` });
  const vlr = token.liquidity > 0 ? token.vol24h / token.liquidity : 0;
  if (vlr > 50)
    signals.push({ type:"WARN", strength:"DANGER", label:"🧹 Wash trade?",  detail:`Vol/Liq ${vlr.toFixed(0)}x` });
  if (token.c24h > 400)
    signals.push({ type:"WARN", strength:"WARN",   label:"⚠ Extreme pump", detail:`+${token.c24h.toFixed(0)}% 24h` });

  // ── Meme keyword score ────────────────────────────────────────────────────
  const combo = (token.symbol+" "+token.name).toLowerCase();
  const kws = MEME_KW.filter(k => combo.includes(k));
  if (kws.length >= 2)
    signals.push({ type:"INFO", strength:"INFO", label:"🧠 Meme keywords", detail:kws.slice(0,3).join(", ") });

  // ── Composite buy/sell score ──────────────────────────────────────────────
  let score = 50;
  for (const s of signals) {
    if      (s.type==="BUY"  && s.strength==="STRONG") score += 18;
    else if (s.type==="BUY"  && s.strength==="WEAK")   score += 8;
    else if (s.type==="SELL" && s.strength==="STRONG") score -= 18;
    else if (s.type==="SELL" && s.strength==="WEAK")   score -= 8;
    else if (s.type==="WARN" && s.strength==="DANGER") score -= 15;
  }
  score = Math.max(0, Math.min(100, score));

  const verdict = score >= 72 ? "STRONG BUY"
                : score >= 58 ? "BUY"
                : score <= 28 ? "STRONG SELL"
                : score <= 42 ? "SELL"
                : "NEUTRAL";

  return { signals, score, verdict };
}

// ─── SAFETY SCORE ─────────────────────────────────────────────────────────────
function computeSafety(token) {
  let score = 100;
  const flags = [];
  if (token.liquidity < 5000)   { score -= 35; flags.push("LOW LIQ"); }
  else if (token.liquidity < 25000) score -= 12;
  const vlr = token.liquidity > 0 ? token.vol24h/token.liquidity : 0;
  if (vlr > 50) { score -= 20; flags.push("WASH"); }
  if (Math.abs(token.c24h) > 300) { score -= 20; flags.push("EXTREME"); }
  const tot = token.buys24h + token.sells24h;
  if (tot > 0 && token.sells24h/tot > 0.75) { score -= 15; flags.push("DUMP"); }
  if (tot < 20) { score -= 15; flags.push("GHOST"); }
  const ageH = (Date.now() - token.pairCreatedAt) / 3600000;
  if (ageH < 1) score -= 10;
  return { score: Math.max(0, Math.min(100, Math.round(score))), flags };
}

// ─── MERGE TOKEN INTO STATE ───────────────────────────────────────────────────
function mergeToken(fresh) {
  const key = fresh.address;
  const prev = tokenMap.get(key);

  // Build history
  const history = prev?.history || [];
  history.push({
    ts:    Date.now(),
    price: fresh.priceUsd,
    vol5m: fresh.vol5m,
    buys5m:fresh.buys5m,
    sells5m:fresh.sells5m,
  });
  if (history.length > MAX_HISTORY) history.shift();

  const { signals, score, verdict } = computeSignals(fresh, history);
  const safety = computeSafety(fresh);

  // Price delta from last seen
  const priceDelta = prev ? ((fresh.priceUsd - prev.priceUsd) / (prev.priceUsd || 1)) * 100 : 0;
  const isNew = !prev;

  const token = {
    ...fresh,
    history,
    signals,
    score,
    verdict,
    safety,
    priceDelta,
    isNew,
    firstSeen: prev?.firstSeen || Date.now(),
  };

  tokenMap.set(key, token);
  return token;
}

// ─── MAIN SCAN LOOP ───────────────────────────────────────────────────────────
async function runScan() {
  console.log(`[scan #${++scanCount}] starting...`);
  const t0 = Date.now();

  try {
    // Parallel fetch all sources
    const [profileAddrs, boostedAddrs, trendPairs, memeSearchPairs, newSearchPairs] =
      await Promise.allSettled([
        fetchNewProfiles(),
        fetchBoosted(),
        fetchSearch("solana meme trending"),
        fetchSearch("solana pump meme cat dog pepe"),
        fetchSearch("pump fun new solana"),
      ]).then(r => r.map(x => x.status === "fulfilled" ? x.value : []));

    // Fetch pairs for profile + boosted addresses
    const allAddrs = [...new Set([...profileAddrs, ...boostedAddrs])];
    const addrPairs = allAddrs.length > 0 ? await fetchPairsByTokens(allAddrs) : [];

    // Combine all pairs, dedup by pairAddress
    const allPairs = [...addrPairs, ...trendPairs, ...memeSearchPairs, ...newSearchPairs];
    const seenPairs = new Set();
    const uniquePairs = allPairs.filter(p => {
      const k = p.pairAddress;
      if (!k || seenPairs.has(k)) return false;
      seenPairs.add(k); return true;
    });

    console.log(`[scan #${scanCount}] ${uniquePairs.length} unique pairs from ${allPairs.length} raw`);

    // Normalize + merge
    const updated = [];
    for (const pair of uniquePairs) {
      const fresh = normalizePair(pair);
      if (!fresh) continue;
      const token = mergeToken(fresh);
      updated.push(token);
    }

    // Clean stale tokens (not seen in last 3 scans = 30s)
    const staleThreshold = Date.now() - 35000;
    for (const [k, t] of tokenMap) {
      if (t.updatedAt < staleThreshold) tokenMap.delete(k);
    }

    lastScanAt = Date.now();
    const elapsed = lastScanAt - t0;
    console.log(`[scan #${scanCount}] done in ${elapsed}ms, ${tokenMap.size} tokens in state`);

    // ── Feed tokens to trading bot ────────────────────────────────────────────
    processScanData(updated).catch(e => console.error("[bot scan]", e.message));

    // Broadcast to all connected clients
    broadcast({
      type:      "scan",
      scanCount,
      elapsed,
      ts:        lastScanAt,
      tokenCount: tokenMap.size,
      tokens:    updated,
      bot:       getBotStatus(),
    });

    // Also send strong signals as alert events
    for (const token of updated) {
      const strong = token.signals.filter(s =>
        (s.type === "BUY" || s.type === "SELL") && s.strength === "STRONG"
      );
      if (strong.length >= 2 || token.verdict === "STRONG BUY" || token.verdict === "STRONG SELL") {
        broadcast({
          type:    "alert",
          token:   stripHistory(token),
          signals: strong,
          verdict: token.verdict,
          score:   token.score,
        });
      }
    }

  } catch (e) {
    console.error("[scan error]", e.message);
    broadcast({ type: "error", message: e.message });
  }
}

function stripHistory(t) {
  const { history, ...rest } = t;
  return rest;
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[ws] client connected from ${ip}, total: ${wss.clients.size}`);

  // Send current state immediately on connect
  ws.send(JSON.stringify({
    type: "init",
    scanCount,
    ts: lastScanAt,
    tokenCount: tokenMap.size,
    tokens: [...tokenMap.values()].map(stripHistory),
  }));

  ws.on("message", (msg) => {
    try {
      const cmd = JSON.parse(msg);
      if (cmd.type === "ping") ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
    } catch {}
  });

  ws.on("close", () => {
    console.log(`[ws] client disconnected, total: ${wss.clients.size}`);
  });

  ws.on("error", (e) => console.error("[ws error]", e.message));
});

// ─── HTTP ROUTES ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status: "ok",
  scanCount,
  tokenCount: tokenMap.size,
  lastScanAt,
  clients: wss.clients.size,
  uptime: process.uptime(),
  bot: getBotStatus(),
}));

app.get("/bot", (_, res) => res.json(getBotStatus()));
app.get("/bot/events", (_, res) => res.json(getBotEvents()));
app.post("/bot/emergency-stop", async (_, res) => {
  await emergencyStop();
  res.json({ ok: true, message: "Emergency stop executed" });
});

app.get("/tokens", (_, res) => {
  res.json([...tokenMap.values()].map(stripHistory));
});

// Serve the frontend HTML
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

app.get("/", (_, res) => {
  try {
    res.sendFile(join(__dirname, "public", "index.html"));
  } catch {
    res.send("Pump Radar server running. Connect via WebSocket.");
  }
});

app.use(express.static(join(__dirname, "public")));

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Pump Radar server running on port ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   Health:    http://localhost:${PORT}/health`);

  // Initialize trading bot
  initBot().catch(e => console.error("[bot init]", e.message));

  // Run first scan immediately, then every POLL_MS
  runScan();
  setInterval(runScan, POLL_MS);
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function fmtN(n) {
  if (!n) return "0";
  if (n >= 1e6) return (n/1e6).toFixed(1)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(1)+"K";
  return Number(n).toFixed(0);
}
