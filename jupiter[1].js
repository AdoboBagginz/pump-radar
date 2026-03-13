// ─── JUPITER SWAP ENGINE ──────────────────────────────────────────────────────
// Handles quote → swap → confirmation via Jupiter Ultra API

import fetch from "node-fetch";
import { CONFIG } from "./config.js";

const log = (level, ...args) => console.log(`[jupiter][${level}]`, ...args);

// ── Get a swap quote from Jupiter ─────────────────────────────────────────────
export async function getQuote({ inputMint, outputMint, amountLamports }) {
  const url = new URL(`${CONFIG.JUPITER_API_URL}/ultra/v1/order`);
  url.searchParams.set("inputMint",   inputMint);
  url.searchParams.set("outputMint",  outputMint);
  url.searchParams.set("amount",      amountLamports.toString());
  url.searchParams.set("slippageBps", CONFIG.SLIPPAGE_BPS.toString());

  const res = await fetch(url.toString(), {
    headers: {
      "Accept":        "application/json",
      "x-api-key":     process.env.JUPITER_API_KEY || "",
    },
    timeout: 10000,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Quote failed: HTTP ${res.status} — ${body}`);
  }

  const data = await res.json();
  if (!data.transaction) throw new Error("No transaction in quote response");
  return data;
}

// ── Execute a swap ────────────────────────────────────────────────────────────
export async function executeSwap({ requestId, signature, apiKey }) {
  const res = await fetch(`${CONFIG.JUPITER_API_URL}/ultra/v1/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key":    apiKey || process.env.JUPITER_API_KEY || "",
    },
    body: JSON.stringify({ requestId, signature }),
    timeout: 30000,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Execute failed: HTTP ${res.status} — ${body}`);
  }

  return res.json();
}

// ── Sign + send a swap transaction ───────────────────────────────────────────
// Uses @solana/web3.js to sign with the wallet private key
export async function signAndSend({ transaction, wallet, connection }) {
  const { Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");

  const tx = Transaction.from(Buffer.from(transaction, "base64"));
  tx.sign(wallet);

  const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment:           "confirmed",
    preflightCommitment:  "confirmed",
  });

  return sig;
}

// ── Full buy flow: SOL → token ────────────────────────────────────────────────
export async function buyToken({ tokenMint, solAmountLamports, wallet, connection, dryRun }) {
  log("info", `BUY ${tokenMint} | ${solAmountLamports/1e9} SOL${dryRun?" [DRY RUN]":""}`);

  const quote = await getQuote({
    inputMint:      CONFIG.SOL_MINT,
    outputMint:     tokenMint,
    amountLamports: solAmountLamports,
  });

  log("debug", "Quote:", JSON.stringify({
    inAmount:  quote.inAmount,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
  }));

  if (dryRun) {
    log("info", "[DRY RUN] Skipping actual transaction");
    return {
      success:   true,
      dryRun:    true,
      signature: "DRY_RUN_" + Date.now(),
      inAmount:  quote.inAmount,
      outAmount: quote.outAmount,
      requestId: quote.requestId,
    };
  }

  // Sign the transaction
  const { Transaction } = await import("@solana/web3.js");
  const tx = Transaction.from(Buffer.from(quote.transaction, "base64"));
  tx.sign(wallet);
  const signedB64 = tx.serialize().toString("base64");

  // Execute via Jupiter
  const result = await executeSwap({
    requestId: quote.requestId,
    signature: signedB64,
  });

  if (result.status !== "Success") {
    throw new Error(`Swap failed: ${result.error || result.status}`);
  }

  log("info", `✅ BUY confirmed | sig: ${result.signature}`);
  return {
    success:   true,
    signature: result.signature,
    inAmount:  quote.inAmount,
    outAmount: quote.outAmount,
    requestId: quote.requestId,
  };
}

// ── Full sell flow: token → SOL ───────────────────────────────────────────────
export async function sellToken({ tokenMint, tokenAmountRaw, wallet, connection, dryRun }) {
  log("info", `SELL ${tokenMint} | ${tokenAmountRaw} raw${dryRun?" [DRY RUN]":""}`);

  const quote = await getQuote({
    inputMint:      tokenMint,
    outputMint:     CONFIG.SOL_MINT,
    amountLamports: tokenAmountRaw,
  });

  log("debug", "Quote:", JSON.stringify({
    inAmount:  quote.inAmount,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
  }));

  if (dryRun) {
    log("info", "[DRY RUN] Skipping actual transaction");
    return {
      success:   true,
      dryRun:    true,
      signature: "DRY_RUN_" + Date.now(),
      inAmount:  quote.inAmount,
      outAmount: quote.outAmount,
    };
  }

  const { Transaction } = await import("@solana/web3.js");
  const tx = Transaction.from(Buffer.from(quote.transaction, "base64"));
  tx.sign(wallet);
  const signedB64 = tx.serialize().toString("base64");

  const result = await executeSwap({
    requestId: quote.requestId,
    signature: signedB64,
  });

  if (result.status !== "Success") {
    throw new Error(`Swap failed: ${result.error || result.status}`);
  }

  log("info", `✅ SELL confirmed | sig: ${result.signature}`);
  return {
    success:   true,
    signature: result.signature,
    inAmount:  quote.inAmount,
    outAmount: quote.outAmount,
  };
}

// ── Get SOL balance of wallet ─────────────────────────────────────────────────
export async function getSolBalance(connection, publicKey) {
  const lamports = await connection.getBalance(publicKey);
  return lamports / 1e9;
}

// ── Get token balance ─────────────────────────────────────────────────────────
export async function getTokenBalance(connection, publicKey, tokenMint) {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = await import("@solana/spl-token");

    const ata = await getAssociatedTokenAddress(
      new PublicKey(tokenMint),
      publicKey
    );
    const info = await connection.getTokenAccountBalance(ata);
    return {
      raw:      BigInt(info.value.amount),
      decimals: info.value.decimals,
      uiAmount: info.value.uiAmount || 0,
    };
  } catch {
    return { raw: BigInt(0), decimals: 0, uiAmount: 0 };
  }
}
