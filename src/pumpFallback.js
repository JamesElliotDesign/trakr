// src/pumpFallback.js
// Key-aware fallback for fresh pump tokens before aggregators show a route.
// Enable with PUMP_FALLBACK=true.
// REQUIRED if enabled: PUMP_TRADE_URL, PUMP_API_KEY, PUMP_API_AUTH_HEADER (often 'x-api-key' or 'Authorization')
// NOTE: Safety constraint: supports SOL->token buys only.

import fetch from 'node-fetch';
import { ensureSigner } from './keypair.js';
import { broadcastAndConfirm } from './txSender.js';
import { VersionedTransaction } from '@solana/web3.js';

const SOL = 'So11111111111111111111111111111111111111112';

function getEnv(name, { required = false, fallback = undefined } = {}) {
  const v = process.env[name] ?? fallback;
  if (required && (!v || `${v}`.trim() === '')) {
    throw new Error(`${name} is required when PUMP_FALLBACK=true`);
  }
  return `${v}`.trim();
}

export async function swapViaPumpPortalIfEnabled({ inputMint, outputMint, amountLamports }) {
  if (process.env.PUMP_FALLBACK !== 'true') {
    throw new Error('pump fallback disabled');
  }
  if (inputMint !== SOL) {
    throw new Error('pump fallback only supports SOL->token buys');
  }

  const PUMP_TRADE_URL = getEnv('PUMP_TRADE_URL', { required: true });
  const PUMP_API_KEY = getEnv('PUMP_API_KEY', { required: true });
  const PUMP_API_AUTH_HEADER = getEnv('PUMP_API_AUTH_HEADER', { required: true }); // e.g., 'x-api-key' or 'Authorization'

  const slippageBps = Number(process.env.PUMP_SLIPPAGE_BPS || '200');       // default 2%
  const priorityLamports = Number(process.env.PUMP_PRIORITY_LAMPORTS || '5000');

  const user = ensureSigner();

  // Body fields are typical for SOL->token trade builders; your provider docs may differ.
  // Keep names configurable with env if needed later.
  const body = {
    publicKey: user.publicKey.toBase58(),
    action: 'buy',
    mint: outputMint,
    amount: String(amountLamports), // lamports exact-in
    slippageBps,
    priorityFee: priorityLamports
  };

  const headers = { 'content-type': 'application/json' };
  headers[PUMP_API_AUTH_HEADER] = PUMP_API_KEY; // flexible: 'x-api-key': '...', or 'Authorization': 'Bearer ...'

  const res = await fetch(PUMP_TRADE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    // Surface a compact, actionable error so your logs show what's wrong
    throw new Error(`pump portal build failed: ${res.status} ${t || res.statusText}`);
  }

  const j = await res.json().catch(() => ({}));
  const b64 = j?.tx || j?.transaction || j?.swapTransaction;
  if (!b64) throw new Error('pump portal returned no transaction');

  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  tx.sign([user]);
  const sig = await broadcastAndConfirm(tx.serialize());
  return { signature: sig, received: null, routeSummary: { strategy: 'pump-portal' }, priceUsd: null };
}
