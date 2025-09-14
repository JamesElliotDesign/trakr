// src/pumpFallback.js
// Auto-detects the auth header if PUMP_API_AUTH_HEADER is not provided.
// Enable with PUMP_FALLBACK=true and set PUMP_TRADE_URL + PUMP_API_KEY.

import fetch from 'node-fetch';
import { ensureSigner } from './keypair.js';
import { broadcastAndConfirm } from './txSender.js';
import { VersionedTransaction } from '@solana/web3.js';

const SOL = 'So11111111111111111111111111111111111111112';

function need(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') throw new Error(`${name} is required when PUMP_FALLBACK=true`);
  return String(v).trim();
}

async function tryBuild(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

export async function swapViaPumpPortalIfEnabled({ inputMint, outputMint, amountLamports }) {
  if (process.env.PUMP_FALLBACK !== 'true') throw new Error('pump fallback disabled');
  if (inputMint !== SOL) throw new Error('pump fallback only supports SOL->token buys');

  const PUMP_TRADE_URL = need('PUMP_TRADE_URL');
  const PUMP_API_KEY = need('PUMP_API_KEY');

  const slippageBps = Number(process.env.PUMP_SLIPPAGE_BPS || '200');        // 2%
  const priorityLamports = Number(process.env.PUMP_PRIORITY_LAMPORTS || '5000');

  const user = ensureSigner();
  const baseBody = {
    publicKey: user.publicKey.toBase58(),
    action: 'buy',
    mint: outputMint,
    amount: String(amountLamports), // lamports exact-in
    slippageBps,
    priorityFee: priorityLamports
  };

  // If caller specifies the header name, use it directly.
  const explicitHeader = process.env.PUMP_API_AUTH_HEADER && String(process.env.PUMP_API_AUTH_HEADER).trim();
  if (explicitHeader) {
    const headers = { [explicitHeader]: PUMP_API_KEY };
    // If they chose Authorization but forgot "Bearer", do it for them:
    if (explicitHeader.toLowerCase() === 'authorization' && !/^bearer /i.test(PUMP_API_KEY)) {
      headers.Authorization = `Bearer ${PUMP_API_KEY}`;
      delete headers[explicitHeader];
    }
    const r = await tryBuild(PUMP_TRADE_URL, headers, baseBody);
    if (!r.ok) throw new Error(`pump portal build failed: ${r.status} ${r.text || ''}`);
    const b64 = r.json?.tx || r.json?.transaction || r.json?.swapTransaction;
    if (!b64) throw new Error('pump portal returned no transaction');
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    tx.sign([user]);
    const sig = await broadcastAndConfirm(tx.serialize());
    return { signature: sig, received: null, routeSummary: { strategy: 'pump-portal' }, priceUsd: null };
  }

  // Auto-detect header by trying the common patterns in order.
  const candidates = [
    { name: 'x-api-key', value: PUMP_API_KEY },
    { name: 'Authorization', value: /^bearer /i.test(PUMP_API_KEY) ? PUMP_API_KEY : `Bearer ${PUMP_API_KEY}` },
    { name: 'api-key', value: PUMP_API_KEY },
  ];

  let last = null;
  for (const h of candidates) {
    const r = await tryBuild(PUMP_TRADE_URL, { [h.name]: h.value }, baseBody);
    last = r;
    if (r.ok) {
      // Success — proceed to sign & send
      const b64 = r.json?.tx || r.json?.transaction || r.json?.swapTransaction;
      if (!b64) throw new Error('pump portal returned no transaction');
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
      tx.sign([user]);
      const sig = await broadcastAndConfirm(tx.serialize());
      // FYI in logs which header worked
      console.log(`[pump-fallback] used header: ${h.name}`);
      return { signature: sig, received: null, routeSummary: { strategy: 'pump-portal' }, priceUsd: null };
    }
    // 401/403 likely means wrong header; try the next one
  }

  // All attempts failed — surface the last response for debugging
  throw new Error(`pump portal build failed: ${last?.status ?? '??'} ${last?.text ?? ''}`);
}
