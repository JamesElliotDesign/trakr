// src/fastExecutor.js
import pino from 'pino';
import { cfg } from './config.js';
import { getSpotPriceUsd } from './price.js';
import { ensureSigner } from './keypair.js';
import { swapExactIn } from './jupiterClient.js';
import { PublicKey, Connection } from '@solana/web3.js';
import { sendExitNotice } from './telegram.js';
import { sellViaPumpTradeLocal } from './pumpPortalClient.js';

const log = pino({ transport: { target: 'pino-pretty' }});

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const isLive = () => (cfg.tradeMode || 'paper').toLowerCase() === 'live';

function toLamports(sol) {
  return BigInt(Math.floor(Number(sol) * 1_000_000_000));
}

/** Resolve wallet token balance (atoms) for a mint. Retries briefly if not yet indexed. */
async function resolveSellQtyAtoms({ rpcUrl, ownerPubkey, mint }) {
  const conn = new Connection(rpcUrl, 'confirmed');
  const owner = new PublicKey(ownerPubkey);
  const mintPk = new PublicKey(mint);

  async function getBestBalance() {
    const resp = await conn.getParsedTokenAccountsByOwner(owner, { mint: mintPk }).catch(() => null);
    const list = resp?.value || [];
    if (!list.length) return 0n;
    // Choose the largest parsed balance (some wallets have multiple accounts)
    let best = 0n;
    for (const it of list) {
      const ui = it.account.data?.parsed?.info?.tokenAmount;
      const amt = ui?.amount ? BigInt(ui.amount) : 0n;
      if (amt > best) best = amt;
    }
    return best;
  }

  // Try a few times at confirmed, then finalized
  const tiers = [
    { attempts: 3, backoffMs: 150, commitment: 'confirmed' },
    { attempts: 3, backoffMs: 250, commitment: 'finalized' }
  ];
  for (const t of tiers) {
    for (let i = 0; i < t.attempts; i++) {
      const qty = await getBestBalance();
      if (qty > 0n) return qty;
      await new Promise(r => setTimeout(r, t.backoffMs * (i + 1)));
    }
  }
  return 0n;
}

/**
 * BUY: spend cfg.buySolAmount SOL to acquire `mint`.
 * Returns:
 *   { ok, txid, entryPriceUsd, qtyAtoms, decimals, strategy }
 */
export async function executeBuy({ mint }) {
  if (!isLive()) {
    log.info({ mint, sol: cfg.buySolAmount }, '[paper] Skipping live buy (paper mode)');
    return { ok: true, mode: 'paper', txid: null, entryPriceUsd: null, qtyAtoms: null, decimals: null };
  }

  ensureSigner();
  const amountLamports = toLamports(cfg.buySolAmount);

  const { signature, priceUsd, received, routeSummary } = await swapExactIn({
    side: 'buy',
    inputMint: SOL_MINT,
    outputMint: mint,
    amount: amountLamports,
    slippageBps: cfg.jupSlippageBps ?? 150
  });

  // Prefer precise entry price from swap; otherwise use spot.
  let entryPriceUsd = null;
  if (typeof priceUsd === 'number' && Number.isFinite(priceUsd)) {
    entryPriceUsd = priceUsd;
  } else {
    const spot = await getSpotPriceUsd(mint).catch(() => null);
    if (spot && typeof spot.priceUsd === 'number' && Number.isFinite(spot.priceUsd)) {
      entryPriceUsd = spot.priceUsd;
    }
  }

  const qtyAtoms = typeof received === 'bigint' ? received : null;

  log.info(
    { mint, signature, route: routeSummary || {}, qtyAtoms: qtyAtoms ? String(qtyAtoms) : null, entryPriceUsd },
    'BUY filled'
  );

  return {
    ok: true,
    txid: signature,
    entryPriceUsd,
    qtyAtoms,
    decimals: null,
    strategy: routeSummary?.strategy
  };
}

/**
 * SELL: sell tokens of `mint` to SOL.
 * If `qty` is missing, auto-resolve from wallet. For pump tokens (or when PUMP_FALLBACK=true)
 * we use Pump Portal trade-local (action: "sell") with "100%" by default to avoid decimals math.
 * Returns: { ok: true, txid }
 */
export async function executeSell({ mint, qty, sellAll = true, percent } = {}) {
  if (!isLive()) {
    log.info(
      { mint, qty: qty == null ? '(auto-resolve)' : String(qty) },
      '[paper] Skipping live sell (paper mode)'
    );
    return { ok: true, mode: 'paper', txid: null };
  }

  const kp = ensureSigner();

  // Decide routing: use Pump Portal for pump mints or when PUMP_FALLBACK=true
  const isPumpMint = typeof mint === 'string' && mint.endsWith('pump');
  const pumpFallback = String(process.env.PUMP_FALLBACK || '').toLowerCase() === 'true';
  const shouldUsePump = isPumpMint || pumpFallback;

  if (shouldUsePump) {
    try {
      // Prefer selling 100% by default; avoids needing token decimals/qtyAtoms.
      const pct = sellAll ? '100%' : (percent || '100%');
      const filled = await sellViaPumpTradeLocal({
        mint,
        percent: pct,
        slippageBps: Number(process.env.PUMP_SLIPPAGE_BPS || '200'),
        priorityFeeSol: Number(process.env.PUMP_PRIORITY_FEE_SOL || '0.00001'),
        pool: (process.env.PUMP_POOL || 'auto').trim()
      });

      log.info(
        { mint, signature: filled.signature, route: filled.routeSummary || {}, sellAll: true },
        'SELL filled (pump-portal)'
      );

      await sendExitNotice({
        mint,
        entry: null, // P&L module fills from stored position
        exit: filled.exitPriceUsd ?? null, // may be null; watcher/close uses spot fallback
        pnlPct: null,
        reason: 'TP/SL or manual',
        txid: filled.signature,
        mode: 'live'
      }).catch(() => { /* best effort */ });

      return { ok: true, txid: filled.signature };
    } catch (e) {
      log.warn({ mint, err: e?.message }, 'pump sell failed; will try Jupiter as fallback');
      // fall through to Jupiter
    }
  }

  // Jupiter fallback (may have no route on fresh pump tokens)
  let sellQty = qty;
  if (sellQty == null) {
    sellQty = await resolveSellQtyAtoms({
      rpcUrl: process.env.RPC_URL || process.env.RPC_URLS?.split(',')[0]?.trim() || cfg.rpcUrl,
      ownerPubkey: kp.publicKey.toBase58(),
      mint
    });
    if (sellQty === 0n) {
      log.warn({ mint }, 'No tokens found to sell');
      throw new Error('no tokens available to sell (balance 0)');
    }
  }

  const amountAtoms = typeof sellQty === 'bigint' ? sellQty : BigInt(sellQty);

  const { signature, priceUsd, routeSummary } = await swapExactIn({
    side: 'sell',
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: amountAtoms,
    slippageBps: cfg.jupSlippageBps ?? 150
  });

  await sendExitNotice({
    mint,
    entry: null, // filled by positions on close
    exit: priceUsd ?? null,
    pnlPct: null,
    reason: 'TP/SL or manual',
    txid: signature,
    mode: 'live'
  }).catch(() => { /* best effort */ });

  log.info({ mint, signature, route: routeSummary || {}, sellAll: false, hasQtyAtoms: true }, 'SELL filled (jupiter)');
  return { ok: true, txid: signature };
}
