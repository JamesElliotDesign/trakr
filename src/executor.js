// src/fastExecutor.js
import pino from 'pino';
import { cfg } from './config.js';
import { getSpotPriceUsd } from './price.js';
import { ensureSigner } from './keypair.js';
import { swapExactIn } from './jupiterClient.js';
import { sendEntryNotice, sendExitNotice } from './telegram.js';

const log = pino({ transport: { target: 'pino-pretty' }});

// Convenience
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const isLive = () => (cfg.tradeMode || 'paper').toLowerCase() === 'live';

function toLamports(sol) {
  return BigInt(Math.floor(Number(sol) * 1_000_000_000));
}

/**
 * BUY: spend cfg.buySolAmount SOL to acquire `mint`.
 * Returns:
 *   {
 *     ok: true,
 *     txid: <string>,
 *     entryPriceUsd: <number|null>,
 *     qtyAtoms: <bigint|null>,
 *     decimals: <number|null>,
 *     strategy: <string|undefined> // 'pump-trade-local' when fallback used
 *   }
 */
export async function executeBuy({ mint }) {
  if (!isLive()) {
    log.info({ mint, sol: cfg.buySolAmount }, '[paper] Skipping live buy (paper mode)');
    return { ok: true, mode: 'paper', txid: null, entryPriceUsd: null, qtyAtoms: null, decimals: null };
  }

  // Ensure signer exists early to fail fast if key misconfigured
  ensureSigner();

  const amountLamports = toLamports(cfg.buySolAmount);

  // swapExactIn handles Jupiter first, then optional Pump fallback.
  // It should return:
  //  - signature: string
  //  - received: bigint|null (token atoms received)
  //  - priceUsd: number|null (entry usd if derived; esp. in pump fallback)
  //  - routeSummary: { strategy?: string, ... }
  const { signature, priceUsd, received, routeSummary } = await swapExactIn({
    side: 'buy',
    inputMint: SOL_MINT,
    outputMint: mint,
    amount: amountLamports,
    slippageBps: cfg.jupSlippageBps ?? 150
  });

  // Prefer the precise entry price derived by the swap layer (for pump-trade-local),
  // otherwise fall back to current price provider.
  let entryPriceUsd = null;
  if (typeof priceUsd === 'number' && Number.isFinite(priceUsd)) {
    entryPriceUsd = priceUsd;
  } else {
    const spot = await getSpotPriceUsd(mint).catch(() => null);
    if (spot && typeof spot.priceUsd === 'number' && Number.isFinite(spot.priceUsd)) {
      entryPriceUsd = spot.priceUsd;
    }
  }

  // Qty atoms (BigInt) if we received it — used by positions/P&L.
  const qtyAtoms = typeof received === 'bigint' ? received : null;

  // Telegram notice (keep payload shape stable)
  await sendEntryNotice({
    mint,
    price: entryPriceUsd ?? null,
    solSpent: Number(amountLamports) / 1e9,
    txid: signature,
    mode: 'live',
  }).catch(() => { /* best effort */ });

  log.info(
    { mint, signature, route: routeSummary || {}, qtyAtoms: qtyAtoms ? String(qtyAtoms) : null, entryPriceUsd },
    'BUY filled'
  );

  return {
    ok: true,
    txid: signature,
    entryPriceUsd,
    qtyAtoms,
    decimals: null, // if you plumb decimals up from the swap layer, set it here
    strategy: routeSummary?.strategy
  };
}

/**
 * SELL: sell `qty` (token atoms) of `mint` to SOL.
 * Caller passes raw token units (atoms), not decimals-adjusted.
 * Returns: { ok: true, txid: <string> }
 */
export async function executeSell({ mint, qty }) {
  if (!isLive()) {
    log.info({ mint, qty: String(qty) }, '[paper] Skipping live sell (paper mode)');
    return { ok: true, mode: 'paper', txid: null };
  }

  ensureSigner();

  const { signature, priceUsd, routeSummary } = await swapExactIn({
    side: 'sell',
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: BigInt(qty),
    slippageBps: cfg.jupSlippageBps ?? 150
  });

  await sendExitNotice({
    mint,
    entry: null,           // your P&L module should fill this from stored position
    exit: priceUsd ?? null,
    pnlPct: null,
    reason: 'TP/SL or manual',
    txid: signature,
    mode: 'live',
  }).catch(() => { /* best effort */ });

  log.info({ mint, signature, route: routeSummary || {} }, 'SELL filled');
  return { ok: true, txid: signature };
}
