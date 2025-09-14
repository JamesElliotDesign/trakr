// src/pumpFallback.js
// Lightweight fallback for very fresh pump tokens before aggregators see a route.
// Uses Pump Portal trade API. Enable with PUMP_FALLBACK=true in env.
// NOTE: This trades SOL->token. Use at your own risk.
import fetch from 'node-fetch';
import { ensureSigner } from './keypair.js';
import { broadcastAndConfirm } from './txSender.js';
import { VersionedTransaction } from '@solana/web3.js';

const PUMP_TRADE = 'https://pumpportal.fun/api/trade'; // public endpoint

export async function swapViaPumpPortalIfEnabled({ inputMint, outputMint, amountLamports }) {
  if (process.env.PUMP_FALLBACK !== 'true') {
    throw new Error('pump fallback disabled');
  }
  // Only handle SOL -> token buys as a safety constraint
  const SOL = 'So11111111111111111111111111111111111111112';
  if (inputMint !== SOL) throw new Error('pump fallback only supports SOL->token');

  const user = ensureSigner();

  // Minimal request; portal builds a v0 swap tx on their router
  const body = {
    publicKey: user.publicKey.toBase58(),
    action: 'buy',
    mint: outputMint,
    amount: String(amountLamports), // lamports exact-in
    slippageBps: Number(process.env.PUMP_SLIPPAGE_BPS || '200'), // default 2%
    priorityFee: Number(process.env.PUMP_PRIORITY_LAMPORTS || '5000') // per-CU micro-lamports or lamports? API accepts lamports fee; keep conservative
  };

  const res = await fetch(PUMP_TRADE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`pump portal build failed: ${res.status} ${t}`);
  }

  const j = await res.json();
  const b64 = j?.tx;
  if (!b64) throw new Error('pump portal returned no transaction');

  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  tx.sign([user]);
  const sig = await broadcastAndConfirm(tx.serialize());
  return { signature: sig, received: null, routeSummary: { strategy: 'pump-portal' }, priceUsd: null };
}
