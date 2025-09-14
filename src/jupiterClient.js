// src/jupiterClient.js
// Jupiter v6 client with robust routing + Pump trade-local fallback.
// - Primary: Jupiter (direct-preferred → any-route → SOL/USDC bridge)
// - Fallback (optional): Pump "trade-local" for brand-new ...pump tokens
//
// Return shape of swapExactIn:
//   {
//     signature: string,
//     received: bigint|null,     // token atoms received (Pump: derived from tx meta; Jup: route.outAmount)
//     priceUsd: number|null,     // entry price in USD if known (Pump derived); otherwise null
//     routeSummary: { strategy?: string, ... }
//   }

import fetch from 'node-fetch';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { cfg } from './config.js';
import { ensureSigner } from './keypair.js';
import { estimatePriorityFeeMicroLamports } from './priorityFees.js';
import { broadcastAndConfirm } from './txSender.js';
import { buyViaPumpTradeLocal } from './pumpPortalClient.js';

const JUP_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUP_SWAP  = 'https://quote-api.jup.ag/v6/swap';

const SOL  = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ---------- Route helpers ----------
async function getRoute({ inputMint, outputMint, amount, slippageBps }) {
  const base = new URL(JUP_QUOTE);
  base.searchParams.set('inputMint', inputMint);
  base.searchParams.set('outputMint', outputMint);
  base.searchParams.set('amount', String(amount));
  base.searchParams.set('slippageBps', String(slippageBps));
  base.searchParams.set('asLegacyTransaction', 'false');
  base.searchParams.set('swapMode', 'ExactIn');

  const strategies = [
    { name: 'direct-preferred', params: { preferDirectRoutes: 'true',  onlyDirectRoutes: 'false' } },
    { name: 'any-route',        params: { preferDirectRoutes: 'false', onlyDirectRoutes: 'false' } },
    { name: 'bridge-sol-usdc',  params: { preferDirectRoutes: 'false', onlyDirectRoutes: 'false', restrictIntermediateTokens: `${SOL},${USDC}` } },
  ];

  for (const s of strategies) {
    const url = new URL(base.toString());
    for (const [k, v] of Object.entries(s.params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString());
    if (!res.ok) continue;
    const j = await res.json().catch(() => null);
    const route = j?.data?.[0];
    if (route) return { route, strategy: s.name };
  }
  throw new Error('no route from Jupiter');
}

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
async function getRouteWithShortRetry(args, { tries = 3, backoffMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await getRoute(args); } catch (e) { lastErr = e; }
    await sleep(backoffMs * (i + 1));
  }
  throw lastErr || new Error('no route from Jupiter');
}

// ---------- Main swap ----------
export async function swapExactIn({ side, inputMint, outputMint, amount, slippageBps }) {
  const user = ensureSigner();

  // 1) Try Jupiter (with a short retry to let new pools index)
  let route, strategy;
  try {
    ({ route, strategy } = await getRouteWithShortRetry({
      inputMint, outputMint, amount,
      slippageBps: slippageBps ?? (cfg.jupSlippageBps ?? 150)
    }));
  } catch (e) {
    // 2) Optional Pump fallback for SOL->…pump BUYs when no Jupiter route yet
    const wantPumpFallback =
      process.env.PUMP_FALLBACK === 'true' &&
      side === 'buy' &&
      outputMint.endsWith('pump');

    if (wantPumpFallback) {
      const res = await buyViaPumpTradeLocal({
        outputMint,
        amountLamports: amount,
        slippageBps: slippageBps ?? (cfg.jupSlippageBps ?? 150),
        // Pump expects SOL amount for priority fee, handled inside client via env
        // PUMP_PRIORITY_FEE_SOL / PUMP_POOL read there
      });
      // ---- CRITICAL: forward qtyAtoms & entryPriceUsd to caller ----
      return {
        signature: res.signature,
        received: res.qtyAtoms ?? null,          // bigint
        priceUsd: res.entryPriceUsd ?? null,     // number
        routeSummary: res.routeSummary           // includes { strategy: 'pump-trade-local' }
      };
    }
    // If no fallback, surface the original error
    throw e;
  }

  // 3) Priority fee (auto p75 CU price unless override provided)
  const feeOverride =
    cfg.jupPriorityFeeLamports && cfg.jupPriorityFeeLamports !== 'auto'
      ? Number(cfg.jupPriorityFeeLamports)
      : null;
  const computeUnitPriceMicroLamports = feeOverride ?? await estimatePriorityFeeMicroLamports();

  // 4) Request ready-to-sign v0 tx from Jupiter
  const swapReq = {
    route,
    userPublicKey: new PublicKey(user.publicKey).toBase58(),
    wrapAndUnwrapSol: true,
    asLegacyTransaction: false,
    dynamicSlippage: true,
    allowOptimizedRoutes: true,
    useTokenLedger: true,
    computeUnitPriceMicroLamports
  };

  const sRes = await fetch(JUP_SWAP, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(swapReq)
  });

  if (!sRes.ok) {
    const t = await sRes.text();
    throw new Error(`swap build failed: ${sRes.status} ${t}`);
  }

  const { swapTransaction } = await sRes.json();
  const txBytes = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBytes);

  // 5) Sign & multi-RPC broadcast (first-confirmed wins)
  tx.sign([user]);
  const signature = await broadcastAndConfirm(tx.serialize());

  // For Jupiter, we can pass outAmount (atoms) as a heuristic "received"
  const received = route?.outAmount ? BigInt(route.outAmount) : null;

  return {
    signature,
    received,
    priceUsd: null,  // caller may fetch spot or derive from meta if desired
    routeSummary: {
      inAmount: route.inAmount,
      outAmount: route.outAmount,
      priceImpactPct: route.priceImpactPct,
      contextSlot: route.contextSlot,
      strategy
    }
  };
}
