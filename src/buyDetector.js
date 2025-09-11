// src/buyDetector.js
import pino from 'pino';
import { cfg } from './config.js';

const log = pino({ transport: { target: 'pino-pretty' }});
const LAMPORTS_PER_SOL = 1_000_000_000n;

/* --------------------------- cache helpers --------------------------- */
// Works with Set, Map, or plain object.
// Stores a timestamp so we can debounce within cfg.buyDebounceMinutes.

function cacheHas(cache, key) {
  if (!cache) return false;
  if (typeof cache.has === 'function') return cache.has(key);
  if (typeof cache.get === 'function') return cache.get(key) != null;
  return Object.prototype.hasOwnProperty.call(cache, key);
}

function cacheGet(cache, key) {
  if (!cache) return undefined;
  if (typeof cache.get === 'function') return cache.get(key);
  if (cacheHas(cache, key)) return cache[key];
  return undefined;
}

function cacheSet(cache, key, value) {
  if (!cache) return;
  if (typeof cache.set === 'function') { cache.set(key, value); return; }
  if (typeof cache.add === 'function') { cache.add(key); return; } // Set without TTL (fallback)
  cache[key] = value;
}

function debounced(cache, key, windowMs) {
  const now = Date.now();
  const last = Number(cacheGet(cache, key) || 0);
  if (now - last < windowMs) return true;
  cacheSet(cache, key, now);
  return false;
}

/* --------------------------- small utilities ------------------------ */

function isExcludedMint(mint) {
  return cfg.excludedMints.has(mint);
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sum outgoing SOL from the tracked wallet in this enhanced transaction.
 * Uses enhancedTx.nativeTransfers[].amount (lamports) where fromUserAccount===wallet.
 */
function extractSolSpentSOL(enhancedTx, wallet) {
  try {
    const nt = Array.isArray(enhancedTx?.nativeTransfers) ? enhancedTx.nativeTransfers : [];
    let lamports = 0n;
    for (const t of nt) {
      if (t?.fromUserAccount === wallet) {
        // amount can be number or string
        const raw = typeof t.amount === 'string' ? BigInt(t.amount)
                  : typeof t.amount === 'number' ? BigInt(Math.max(0, t.amount))
                  : 0n;
        if (raw > 0n) lamports += raw;
      }
    }
    if (lamports === 0n) return null;
    const sol = Number(lamports) / Number(LAMPORTS_PER_SOL);
    return Number.isFinite(sol) ? sol : null;
  } catch {
    return null;
  }
}

/* --------------------------- main detector -------------------------- */
/**
 * Detect buys for tracked wallets from a Helius enhanced tx.
 * Priority: tokenTransfers where the tracked wallet is the receiver of non-excluded SPL tokens.
 * Debounce key: (wallet|mint) across cfg.buyDebounceMinutes to avoid duplicate signals from the same tx.
 *
 * Returns array of:
 *   { wallet, mint, amount, signature, solSpent, txType }
 */
export function detectBuys(enhancedTx, trackedSet, seenCache) {
  const out = [];
  const sig = enhancedTx?.signature || enhancedTx?.transactionSignature || '';
  const type = (enhancedTx?.type || '').toUpperCase();

  try {
    const transfers = Array.isArray(enhancedTx?.tokenTransfers) ? enhancedTx.tokenTransfers : [];
    if (!transfers.length) return out;

    // Only SPL token incoming to tracked wallet
    for (const t of transfers) {
      const mint = t?.mint;
      if (!mint || isExcludedMint(mint)) continue;

      const toOwner =
        t?.toUserAccount ||
        t?.toUserAccountOwner ||
        t?.toUser?.owner ||
        t?.tokenAccountToOwner ||
        null;

      if (!toOwner || !trackedSet.has(toOwner)) continue;

      // Prefer precise fields in order
      const amount =
        safeNum(t?.uiTokenAmount) ??
        safeNum(t?.tokenAmount) ??
        safeNum(t?.amount) ??
        safeNum(t?.tokenAmountSent) ??
        null;

      if (!amount || amount <= 0 || amount < (cfg.minTokenAmount || 0)) continue;

      // Debounce per (wallet:mint) across a time window
      const key = `buy:${toOwner}:${mint}`;
      const windowMs = (cfg.buyDebounceMinutes || 30) * 60 * 1000;
      if (debounced(seenCache, key, windowMs)) continue;

      const solSpent = extractSolSpentSOL(enhancedTx, toOwner);

      out.push({
        wallet: toOwner,
        mint,
        amount,
        signature: sig,
        solSpent: solSpent ?? null,
        txType: type || 'UNKNOWN'
      });
    }

    if (out.length) {
      log.info({ sig, buys: out }, 'Detected buy(s)');
    } else {
      log.debug({ sig }, 'No buys detected');
    }
  } catch (e) {
    log.warn({ err: e?.message }, 'buyDetector failed softly');
  }

  return out;
}
