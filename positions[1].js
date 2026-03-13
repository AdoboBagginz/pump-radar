// ─── POSITION MANAGER ────────────────────────────────────────────────────────
// Tracks open positions, evaluates stop-loss / take-profit on each price update

import { CONFIG } from "./config.js";
import { sellToken, getTokenBalance } from "./jupiter.js";

const log = (level, ...args) => console.log(`[positions][${level}]`, ...args);

// ── Position store ────────────────────────────────────────────────────────────
// Map of tokenAddress → Position
const positions = new Map();

// ── Trade log (all completed trades) ─────────────────────────────────────────
const tradeLog = [];

export function getPositions()  { return [...positions.values()]; }
export function getTradeLog()   { return [...tradeLog]; }
export function getPosition(addr) { return positions.get(addr); }
export function hasPosition(addr) { return positions.has(addr); }
export function positionCount()   { return positions.size; }

// ── Open a new position ───────────────────────────────────────────────────────
export function openPosition({
  tokenAddress, symbol, name, dex,
  entryPriceUsd, solSpent, tokenAmountRaw, tokenDecimals,
  buySignature, signalScore, safetyScore, dryRun,
}) {
  const position = {
    tokenAddress,
    symbol,
    name,
    dex,
    entryPriceUsd,
    currentPriceUsd: entryPriceUsd,
    solSpent,
    tokenAmountRaw,   // BigInt string for serialization
    tokenDecimals,
    buySignature,
    signalScore,
    safetyScore,
    dryRun,
    openedAt:  Date.now(),
    updatedAt: Date.now(),
    pnlPct:    0,
    pnlUsd:    0,
    status:    "OPEN",
    highestPrice: entryPriceUsd,
  };

  positions.set(tokenAddress, position);
  log("info", `📂 Opened position: ${symbol} @ $${entryPriceUsd} | ${solSpent.toFixed(4)} SOL${dryRun?" [DRY RUN]":""}`);

  tradeLog.push({
    type:      "BUY",
    ...position,
    ts: Date.now(),
  });

  return position;
}

// ── Update position price + check exit conditions ─────────────────────────────
export async function updatePosition({ tokenAddress, currentPriceUsd, wallet, connection }) {
  const pos = positions.get(tokenAddress);
  if (!pos || pos.status !== "OPEN") return null;

  // Update price tracking
  pos.currentPriceUsd = currentPriceUsd;
  pos.updatedAt = Date.now();
  if (currentPriceUsd > pos.highestPrice) pos.highestPrice = currentPriceUsd;

  // Calculate P&L
  pos.pnlPct = ((currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
  pos.pnlUsd = pos.solSpent * (pos.pnlPct / 100);

  // ── Check exit conditions ─────────────────────────────────────────────────
  let exitReason = null;

  if (pos.pnlPct <= CONFIG.STOP_LOSS_PCT) {
    exitReason = "STOP_LOSS";
  } else if (pos.pnlPct >= CONFIG.TAKE_PROFIT_PCT) {
    exitReason = "TAKE_PROFIT";
  }

  // Also exit if token goes stale (no price update for 5 mins)
  const staleMs = 5 * 60 * 1000;
  if (Date.now() - pos.updatedAt > staleMs) {
    exitReason = "STALE";
  }

  if (exitReason) {
    await closePosition({ tokenAddress, exitReason, wallet, connection });
    return { exited: true, exitReason, position: pos };
  }

  return { exited: false, position: pos };
}

// ── Close a position ──────────────────────────────────────────────────────────
export async function closePosition({ tokenAddress, exitReason, wallet, connection }) {
  const pos = positions.get(tokenAddress);
  if (!pos) return;

  log("info", `📤 Closing ${pos.symbol} | reason: ${exitReason} | PnL: ${pos.pnlPct.toFixed(1)}%`);

  pos.status    = "CLOSING";
  pos.exitReason = exitReason;

  try {
    // Get actual token balance on chain (might differ from recorded)
    let sellAmount = pos.tokenAmountRaw;

    if (!pos.dryRun && wallet && connection) {
      const bal = await getTokenBalance(connection, wallet.publicKey, tokenAddress);
      if (bal.raw > BigInt(0)) {
        sellAmount = bal.raw.toString();
      }
    }

    const result = await sellToken({
      tokenMint:       tokenAddress,
      tokenAmountRaw:  sellAmount,
      wallet,
      connection,
      dryRun: pos.dryRun || CONFIG.DRY_RUN,
    });

    pos.status       = "CLOSED";
    pos.closedAt     = Date.now();
    pos.sellSignature = result.signature;
    pos.solReceived  = result.outAmount ? parseInt(result.outAmount) / 1e9 : 0;
    pos.realizedPnlSol = pos.solReceived - pos.solSpent;

    log("info", `✅ Closed ${pos.symbol} | realized PnL: ${pos.realizedPnlSol?.toFixed(4)} SOL (${pos.pnlPct.toFixed(1)}%)`);

  } catch (err) {
    log("error", `❌ Failed to close ${pos.symbol}: ${err.message}`);
    pos.status = "CLOSE_FAILED";
    pos.closeError = err.message;
  }

  // Move to trade log, remove from active positions
  tradeLog.push({
    type: "SELL",
    ...pos,
    ts: Date.now(),
  });

  positions.delete(tokenAddress);
  return pos;
}

// ── Force close all positions (emergency) ─────────────────────────────────────
export async function closeAllPositions({ wallet, connection, reason = "MANUAL" }) {
  log("warn", `⚠ Closing ALL positions (${reason})`);
  const results = [];
  for (const [addr] of positions) {
    const r = await closePosition({ tokenAddress: addr, exitReason: reason, wallet, connection });
    results.push(r);
  }
  return results;
}

// ── Stats summary ─────────────────────────────────────────────────────────────
export function getStats() {
  const closed  = tradeLog.filter(t => t.type === "SELL");
  const wins    = closed.filter(t => (t.realizedPnlSol || 0) > 0);
  const losses  = closed.filter(t => (t.realizedPnlSol || 0) <= 0);
  const totalPnl = closed.reduce((s, t) => s + (t.realizedPnlSol || 0), 0);
  const winRate  = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(0) : 0;

  return {
    openPositions:  positions.size,
    totalTrades:    closed.length,
    wins:           wins.length,
    losses:         losses.length,
    winRate:        winRate + "%",
    totalPnlSol:    totalPnl.toFixed(4),
    stopLossHits:   closed.filter(t => t.exitReason === "STOP_LOSS").length,
    takeProfitHits: closed.filter(t => t.exitReason === "TAKE_PROFIT").length,
  };
}
