// src/jupiterClient.js
import fetch from 'node-fetch';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { cfg } from './config.js';
import { ensureSigner } from './keypair.js';
import { estimatePriorityFeeMicroLamports } from './priorityFees.js';
import { broadcastAndConfirm } from './txSender.js';

const JUP_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUP_SWAP  = 'https://quote-api.jup.ag/v6/swap';

/**
 * side: 'buy' => SOL -> token ; 'sell' => token -> SOL
 * amount: lamports (for SOL) or raw token units (atoms) to swap exact-in
 */
export async function swapExactIn({ side, inputMint, outputMint, amount, slippageBps }) {
  const user = ensureSigner();

  // 1) Quote
  const quoteUrl = new URL(JUP_QUOTE);
  quoteUrl.searchParams.set('inputMint', inputMint);
  quoteUrl.searchParams.set('outputMint', outputMint);
  quoteUrl.searchParams.set('amount', String(amount));
  quoteUrl.searchParams.set('slippageBps', String(slippageBps ?? (cfg.jupSlippageBps ?? 150)));
  // Reduce path drift & CU: prefer single-hop/direct when possible
  quoteUrl.searchParams.set('onlyDirectRoutes', 'true');
  quoteUrl.searchParams.set('asLegacyTransaction', 'false');

  const qRes = await fetch(quoteUrl.toString());
  if (!qRes.ok) throw new Error(`quote failed: ${qRes.status}`);
  const quote = await qRes.json();
  if (!quote?.data?.length) throw new Error('no route from Jupiter');
  const route = quote.data[0];

  // 2) Compute priority fee (or honor explicit override)
  const feeOverride = cfg.jupPriorityFeeLamports && cfg.jupPriorityFeeLamports !== 'auto'
    ? Number(cfg.jupPriorityFeeLamports)
    : null;
  const computeUnitPriceMicroLamports = feeOverride ?? await estimatePriorityFeeMicroLamports();

  // 3) Ask Jupiter for a ready-to-sign v0 tx
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

  // 4) Sign & send (multi-RPC race to first confirmed)
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
      contextSlot: route.contextSlot
    },
    priceUsd: null
  };
}
