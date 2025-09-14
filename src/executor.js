// src/fastExecutor.js
import pino from 'pino';
import { cfg } from './config.js';
import { getSpotPriceUsd } from './price.js';
import { ensureSigner } from './keypair.js';
import { swapExactIn } from './jupiterClient.js';
import { sendEntryNotice, sendExitNotice } from './telegram.js';

const log = pino({ transport: { target: 'pino-pretty' }});

/**
 * BUY: spend cfg.buySolAmount SOL to acquire `mint`
 */
export async function executeBuy({ mint }) {
  if ((cfg.tradeMode || 'paper') !== 'live') {
    log.info({ mint, sol: cfg.buySolAmount }, '[paper] Skipping live buy (paper mode)');
    return { ok: true, mode: 'paper', txid: null };
  }

  const kp = ensureSigner();
  const amountLamports = BigInt(Math.floor(cfg.buySolAmount * 1_000_000_000));

  const { signature, priceUsd, received, routeSummary } = await swapExactIn({
    side: 'buy',
    inputMint: 'So11111111111111111111111111111111111111112', // SOL
    outputMint: mint,
    amount: amountLamports,
    slippageBps: cfg.jupSlippageBps ?? 150
  });

  const usd = (await getSpotPriceUsd(mint)).priceUsd;
  await sendEntryNotice({
    mint,
    price: usd ?? priceUsd ?? null,
    solSpent: Number(amountLamports) / 1e9,
    txid: signature,
    mode: 'live',
  }).catch(() => {});

  log.info({ mint, signature, received, route: routeSummary }, 'BUY filled');
  return { ok: true, txid: signature };
}

/**
 * SELL: sell `qty` (token atoms) of `mint` to SOL
 * The caller should pass the raw token units (not decimals-adjusted).
 */
export async function executeSell({ mint, qty }) {
  if ((cfg.tradeMode || 'paper') !== 'live') {
    log.info({ mint, qty: String(qty) }, '[paper] Skipping live sell (paper mode)');
    return { ok: true, mode: 'paper', txid: null };
  }

  ensureSigner();

  const { signature, priceUsd, received, routeSummary } = await swapExactIn({
    side: 'sell',
    inputMint: mint,
    outputMint: 'So11111111111111111111111111111111111111112',
    amount: BigInt(qty),
    slippageBps: cfg.jupSlippageBps ?? 150
  });

  await sendExitNotice({
    mint,
    entry: null,
    exit: priceUsd ?? null,
    pnlPct: null,
    reason: 'TP/SL or manual',
    txid: signature,
    mode: 'live',
  }).catch(() => {});

  log.info({ mint, signature, received, route: routeSummary }, 'SELL filled');
  return { ok: true, txid: signature };
}
