// src/jupiterClient.js
import fetch from 'node-fetch';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { cfg } from './config.js';
import { ensureSigner } from './keypair.js';
import { estimatePriorityFeeMicroLamports } from './priorityFees.js';
import { broadcastAndConfirm } from './txSender.js';
import { swapViaPumpPortalIfEnabled } from './pumpFallback.js'; // harmless if file not present

const JUP_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUP_SWAP  = 'https://quote-api.jup.ag/v6/swap';

// Common mints
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Robust route fetch with tiered strategies.
 * Returns { route, strategy } or throws.
 */
async function getRoute({ inputMint, outputMint, amount, slippageBps }) {
  const base = new URL(JUP_QUOTE);
  base.searchParams.set('inputMint', inputMint);
  base.searchParams.set('outputMint', outputMint);
  base.searchParams.set('amount', String(amount));
  base.searchParams.set('slippageBps', String(slippageBps));
  base.searchParams.set('asLegacyTransaction', 'false');
  base.searchParams.set('swapMode', 'ExactIn');

  const strategies = [
    // Tier 1: fastest path—prefer single hop
    { name: 'direct-preferred', params: { preferDirectRoutes: 'true', onlyDirectRoutes: 'false' } },
    // Tier 2: allow multi-hop freely
    { name: 'any-route', params: { preferDirectRoutes: 'false', onlyDirectRoutes: 'false' } },
    // Tier 3: encourage SOL/USDC as bridges (helps early liquidity)
    { name: 'bridge-sol-usdc', params: { preferDirectRoutes: 'false', onlyDirectRoutes: 'false', restrictIntermediateTokens: `${SOL},${USDC}` } },
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

/**
 * Builds, signs, broadcasts swap; auto-priority fee; dynamic slippage; token ledger.
 */
export async function swapExactIn({ side, inputMint, outputMint, amount, slippageBps }) {
  const user = ensureSigner();

  // 1) Try Jupiter (tiered)
  let route, strategy;
  try {
    ({ route, strategy } = await getRoute({
      inputMint, outputMint, amount,
      slippageBps: slippageBps ?? (cfg.jupSlippageBps ?? 150)
    }));
  } catch (e) {
    // 2) Optional Pump Portal fallback for brand-new pump tokens (buy side only)
    if (process.env.PUMP_FALLBACK === 'true' && side === 'buy' && outputMint.endsWith('pump')) {
      return await swapViaPumpPortalIfEnabled({ inputMint, outputMint, amountLamports: amount });
    }
    throw e;
  }

  // 3) Compute priority fee (or honor explicit override)
  const feeOverride = cfg.jupPriorityFeeLamports && cfg.jupPriorityFeeLamports !== 'auto'
    ? Number(cfg.jupPriorityFeeLamports)
    : null;
  const computeUnitPriceMicroLamports = feeOverride ?? await estimatePriorityFeeMicroLamports();

  // 4) Ask Jupiter for ready-to-sign v0 TX
  const swapReq = {
    route,
    userPublicKey: new PublicKey(user.publicKey).toBase58(),
    wrapAndUnwrapSol: true,
    asLegacyTransaction: false,
    dynamicSlippage: true,        // let Jup widen a touch if needed during build
    allowOptimizedRoutes: true,
    useTokenLedger: true,         // prevents min-out mismatch across hops
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

  // 5) Sign & send (multi-RPC race to first confirmed)
  tx.sign([user]);
  const signature = await broadcastAndConfirm(tx.serialize());

  const received = route?.outAmount ? BigInt(route.outAmount) : null;
  return {
    signature,
    received,
    routeSummary: {
      inAmount: route.inAmount,
      outAmount: route.outAmount,
      priceImpactPct: route.priceImpactPct,
      contextSlot: route.contextSlot,
      strategy
    },
    priceUsd: null
  };
}
