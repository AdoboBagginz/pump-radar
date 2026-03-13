// ─── PUMP RADAR BOT CONFIG ────────────────────────────────────────────────────
// All trading parameters in one place. Edit these values, redeploy.

export const CONFIG = {

  // ── Risk management ─────────────────────────────────────────────────────────
  TRADE_SIZE_PCT:      0.05,   // 5% of available SOL balance per trade
  MAX_POSITIONS:       5,      // max open positions at once
  STOP_LOSS_PCT:       -20,    // exit if down -20%
  TAKE_PROFIT_PCT:     100,    // exit if up +100% (2x)

  // ── Entry filters ────────────────────────────────────────────────────────────
  MIN_SAFETY_SCORE:    50,     // minimum safety score (0-100) to allow buy
  MIN_SIGNAL_SCORE:    72,     // minimum signal score = STRONG BUY only
  MIN_LIQUIDITY:       10000,  // minimum pool liquidity in USD
  MIN_VOL_5M:          500,    // minimum 5m volume in USD
  MAX_AGE_HOURS:       24,     // only buy tokens under 24h old (set 9999 to disable)
  MIN_BUY_RATIO_5M:    0.60,   // minimum buy ratio in last 5m (60% buys)

  // ── Jupiter swap settings ────────────────────────────────────────────────────
  SLIPPAGE_BPS:        300,    // 3% slippage tolerance (300 basis points)
  PRIORITY_FEE_LAMPORTS: 100000, // priority fee to get txn through quickly (~0.0001 SOL)

  // ── Position monitoring ──────────────────────────────────────────────────────
  MONITOR_INTERVAL_MS: 10000, // check open positions every 10s
  SCAN_INTERVAL_MS:    10000, // scan for new tokens every 10s

  // ── Safety ──────────────────────────────────────────────────────────────────
  DRY_RUN: true,              // ⚠ SET TO false TO EXECUTE REAL TRADES
                              // Start with true to test without spending SOL

  // ── Jupiter API ──────────────────────────────────────────────────────────────
  JUPITER_API_URL: "https://api.jup.ag",
  SOL_MINT: "So11111111111111111111111111111111111111112",

  // ── Logging ──────────────────────────────────────────────────────────────────
  LOG_LEVEL: "info",          // "debug" | "info" | "warn" | "error"
};
