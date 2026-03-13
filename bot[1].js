// ─── PUMP RADAR BOT ENGINE ────────────────────────────────────────────────────
// Connects scanner signals → entry filter → Jupiter buy → position monitor → exit

import { CONFIG } from "./config.js";
import { buyToken, getSolBalance } from "./jupiter.js";
import {
  openPosition, updatePosition, closeAllPositions,
  hasPosition, positionCount, getPositions, getStats,
} from "./positions.js";

const log = (level, ...args) => console.log(`[bot][${level}]`, ...args);

// ── Bot state ─────────────────────────────────────────────────────────────────
let wallet     = null;
let connection = null;
let isRunning  = false;
let solBalance = 0;
let botEvents  = [];   // recent bot events for dashboard

function addEvent(type, msg, data = {}) {
  const ev = { type, msg, data, ts: Date.now() };
  botEvents.unshift(ev);
  if (botEvents.length > 200) botEvents.pop();
  log("info", `[${type}] ${msg}`);
  return ev;
}

export function getBotEvents()  { return botEvents; }
export function getBotStatus()  {
  return {
    running:    isRunning,
    dryRun:     CONFIG.DRY_RUN,
    solBalance,
    positions:  getPositions(),
    stats:      getStats(),
    config: {
      tradeSizePct:   CONFIG.TRADE_SIZE_PCT,
      maxPositions:   CONFIG.MAX_POSITIONS,
      stopLossPct:    CONFIG.STOP_LOSS_PCT,
      takeProfitPct:  CONFIG.TAKE_PROFIT_PCT,
      minSafetyScore: CONFIG.MIN_SAFETY_SCORE,
      minSignalScore: CONFIG.MIN_SIGNAL_SCORE,
    },
  };
}

// ── Initialize wallet + connection ────────────────────────────────────────────
export async function initBot() {
  const privateKeyEnv = process.env.WALLET_PRIVATE_KEY;
  if (!privateKeyEnv) {
    log("warn", "⚠ WALLET_PRIVATE_KEY not set — bot running in DRY RUN mode only");
    isRunning = true;
    return;
  }

  try {
    const { Keypair, Connection, clusterApiUrl } = await import("@solana/web3.js");

    // Support both base58 and JSON array private key formats
    let secretKey;
    if (privateKeyEnv.startsWith("[")) {
      secretKey = Uint8Array.from(JSON.parse(privateKeyEnv));
    } else {
      const bs58 = await import("bs58");
      secretKey = bs58.default.decode(privateKeyEnv);
    }

    wallet = Keypair.fromSecretKey(secretKey);

    const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");
    connection = new Connection(rpcUrl, "confirmed");

    solBalance = await getSolBalance(connection, wallet.publicKey);

    log("info", `✅ Wallet loaded: ${wallet.publicKey.toBase58()}`);
    log("info", `💰 SOL balance: ${solBalance.toFixed(4)} SOL`);
    log("info", `🔧 Mode: ${CONFIG.DRY_RUN ? "DRY RUN" : "⚡ LIVE TRADING"}`);

    isRunning = true;
    addEvent("INIT", `Bot started | ${solBalance.toFixed(4)} SOL | ${CONFIG.DRY_RUN?"DRY RUN":"LIVE"}`);

    // Refresh balance every 30s
    setInterval(async () => {
      try {
        solBalance = await getSolBalance(connection, wallet.publicKey);
      } catch {}
    }, 30000);

  } catch (err) {
    log("error", "Failed to init wallet:", err.message);
    log("warn", "Falling back to DRY RUN mode");
    isRunning = true;
  }
}

// ── Entry filter — should we buy this token? ──────────────────────────────────
function shouldBuy(token) {
  const reasons = [];

  if (!isRunning)                                   return { ok: false, reason: "Bot not running" };
  if (positionCount() >= CONFIG.MAX_POSITIONS)       return { ok: false, reason: `Max positions (${CONFIG.MAX_POSITIONS}) reached` };
  if (hasPosition(token.address))                    return { ok: false, reason: "Already in position" };
  if ((token.score || 0) < CONFIG.MIN_SIGNAL_SCORE)  return { ok: false, reason: `Signal score ${token.score} < ${CONFIG.MIN_SIGNAL_SCORE}` };
  if ((token.safety?.score || 0) < CONFIG.MIN_SAFETY_SCORE) return { ok: false, reason: `Safety score ${token.safety?.score} < ${CONFIG.MIN_SAFETY_SCORE}` };
  if ((token.liquidity || 0) < CONFIG.MIN_LIQUIDITY) return { ok: false, reason: `Liquidity $${token.liquidity} < $${CONFIG.MIN_LIQUIDITY}` };
  if ((token.vol5m || 0) < CONFIG.MIN_VOL_5M)        return { ok: false, reason: `Vol5m $${token.vol5m} < $${CONFIG.MIN_VOL_5M}` };

  const ageH = (Date.now() - (token.pairCreatedAt || 0)) / 3600000;
  if (ageH > CONFIG.MAX_AGE_HOURS)                   return { ok: false, reason: `Token too old: ${ageH.toFixed(0)}h` };

  const total5m = (token.buys5m || 0) + (token.sells5m || 0);
  const buyR5m  = total5m > 0 ? token.buys5m / total5m : 0;
  if (buyR5m < CONFIG.MIN_BUY_RATIO_5M)              return { ok: false, reason: `Buy ratio ${(buyR5m*100).toFixed(0)}% < ${CONFIG.MIN_BUY_RATIO_5M*100}%` };

  // Enough SOL to trade?
  const tradeSOL = solBalance * CONFIG.TRADE_SIZE_PCT;
  if (tradeSOL < 0.01)                               return { ok: false, reason: `Insufficient SOL: ${solBalance.toFixed(4)}` };

  return { ok: true, reasons };
}

// ── Execute a buy ─────────────────────────────────────────────────────────────
export async function tryBuy(token) {
  const { ok, reason } = shouldBuy(token);
  if (!ok) {
    if (CONFIG.LOG_LEVEL === "debug")
      log("debug", `Skip ${token.symbol}: ${reason}`);
    return null;
  }

  const tradeSOL      = solBalance * CONFIG.TRADE_SIZE_PCT;
  const solLamports   = Math.floor(tradeSOL * 1e9);

  addEvent("SIGNAL", `🎯 Entry signal: ${token.symbol} | score ${token.score} | safety ${token.safety?.score}`, token);

  try {
    const result = await buyToken({
      tokenMint:        token.address,
      solAmountLamports: solLamports,
      wallet,
      connection,
      dryRun: CONFIG.DRY_RUN || !wallet,
    });

    if (!result.success) throw new Error("Buy returned unsuccessful");

    // Estimate token amount received (for dry run we estimate from price)
    const tokenAmountRaw = result.outAmount || String(Math.floor(
      (tradeSOL / (token.priceUsd || 0.000001)) * Math.pow(10, 6)
    ));

    openPosition({
      tokenAddress:    token.address,
      symbol:          token.symbol,
      name:            token.name,
      dex:             token.dex,
      entryPriceUsd:   token.priceUsd || 0,
      solSpent:        tradeSOL,
      tokenAmountRaw,
      tokenDecimals:   6,
      buySignature:    result.signature,
      signalScore:     token.score,
      safetyScore:     token.safety?.score || 0,
      dryRun:          CONFIG.DRY_RUN || !wallet,
    });

    addEvent("BUY", `✅ Bought ${token.symbol} | ${tradeSOL.toFixed(4)} SOL | sig: ${result.signature?.slice(0,12)}...`, {
      symbol: token.symbol, tradeSOL, signature: result.signature,
    });

    // Refresh balance
    if (connection && wallet) {
      solBalance = await getSolBalance(connection, wallet.publicKey);
    }

    return result;

  } catch (err) {
    log("error", `❌ Buy failed for ${token.symbol}: ${err.message}`);
    addEvent("ERROR", `Buy failed: ${token.symbol} — ${err.message}`);
    return null;
  }
}

// ── Process new scan data from scanner ────────────────────────────────────────
export async function processScanData(tokens) {
  if (!isRunning || !tokens?.length) return;

  // 1. Update open positions with fresh prices
  const positions = getPositions().filter(p => p.status === "OPEN");
  for (const pos of positions) {
    const freshToken = tokens.find(t => t.address === pos.tokenAddress);
    if (freshToken?.priceUsd) {
      const result = await updatePosition({
        tokenAddress:    pos.tokenAddress,
        currentPriceUsd: freshToken.priceUsd,
        wallet,
        connection,
      });
      if (result?.exited) {
        addEvent(
          result.exitReason === "TAKE_PROFIT" ? "TAKE_PROFIT" : "STOP_LOSS",
          `${result.exitReason}: ${pos.symbol} | PnL: ${result.position.pnlPct?.toFixed(1)}%`,
          result.position
        );
      }
    }
  }

  // 2. Look for new entry opportunities
  // Sort by signal score descending, try top candidates
  const candidates = tokens
    .filter(t => t.verdict === "STRONG BUY")
    .sort((a, b) => (b.score||0) - (a.score||0))
    .slice(0, 5);

  for (const token of candidates) {
    await tryBuy(token);
  }
}

// ── Emergency stop ────────────────────────────────────────────────────────────
export async function emergencyStop() {
  log("warn", "🚨 EMERGENCY STOP — closing all positions");
  isRunning = false;
  await closeAllPositions({ wallet, connection, reason: "EMERGENCY_STOP" });
  addEvent("EMERGENCY", "Emergency stop triggered — all positions closed");
}

export { isRunning, solBalance, wallet, connection };
