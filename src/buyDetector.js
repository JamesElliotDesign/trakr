// src/buyDetector.js
import pino from 'pino';
import { cfg } from './config.js';

const log = pino({ transport: { target: 'pino-pretty' }});

const LAMPORTS_PER_SOL = 1_000_000_000n;

function isExcludedMint(mint) {
  return cfg.excludedMints.has(mint);
}

/**
 * Extract total SOL spent by `wallet` in this enhanced transaction.
 * Uses enhancedTx.nativeTransfers[].amount (lamports) where fromUserAccount===wallet.
 */
function extractSolSpentSOL(enhancedTx, wallet) {
  try {
    const nt = Array.isArray(enhancedTx?.nativeTransfers) ? enhancedTx.nativeTransfers : [];
    let lamports = 0n;
    for (const t of nt) {
      if (t?.fromUserAccount === wallet && typeof t.amount === 'number') {
        lamports += BigInt(Math.max(0, t.amount));
      } else if (t?.fromUserAccount === wallet && typeof t.amount === 'string') {
        const v = BigInt(t.amount);
        lamports += v > 0n ? v : 0n;
      }
    }
    if (lamports === 0n) return null;
    // convert to SOL with decimal precision
    const sol = Number(lamports) / Number(LAMPORTS_PER_SOL);
    return Number.isFinite(sol) ? sol : null;
  } catch {
    return null;
  }
}

/**
 * Detect buys for tracked wallets from a Helius enhanced tx.
 * Returns array of { wallet, mint, amount, signature, solSpent? }.
 */
export function detectBuys(enhancedTx, trackedSet /* Set<string> */, seenCache) {
  const out = [];

  try {
    const sig = enhancedTx?.signature || enhancedTx?.transactionSignature || '';
    const tt = Array.isArray(enhancedTx?.tokenTransfers) ? enhancedTx.tokenTransfers : [];
    const type = (enhancedTx?.type || '').toUpperCase();

    // Skip stables
    const filtered = tt.filter(x => x?.mint && !isExcludedMint(x.mint));

    // Heuristic: treat as buy when wallet receives tokens (toUserAccount owner is in trackedSet)
    for (const t of filtered) {
      const toOwner = t?.toUserAccount || t?.toUserAccountOwner || t?.toUser?.owner;
      const fromOwner = t?.fromUserAccount || t?.fromUserAccountOwner || t?.fromUser?.owner;

      // token amount is usually in raw units; prefer uiAmount if present
      const amount =
        Number.isFinite(t?.tokenAmount) ? Number(t.tokenAmount)
        : Number.isFinite(t?.amount) ? Number(t.amount)
        : Number.isFinite(t?.uiTokenAmount) ? Number(t.uiTokenAmount)
        : Number.isFinite(t?.tokenAmountSent) ? Number(t.tokenAmountSent)
        : null;

      const wallet =
        trackedSet.has(toOwner) ? toOwner :
        trackedSet.has(fromOwner) ? fromOwner :
        null;

      if (!wallet || !amount || amount <= 0) continue;

      // if the tracked wallet is the receiver of tokens => "buy"
      const isReceiver = trackedSet.has(toOwner);
      if (!isReceiver) continue;

      const mint = t.mint;
      if (!mint || isExcludedMint(mint)) continue;

      // debounce same (wallet+mint+sig) once
      const key = `${wallet}:${mint}:${sig}`;
      if (seenCache.has(key)) continue;
      seenCache.add(key);

      // derive SOL spent from nativeTransfers
      const solSpent = extractSolSpentSOL(enhancedTx, wallet);

      out.push({
        wallet,
        mint,
        amount,
        signature: sig,
        solSpent: solSpent ?? null,
        txType: type || 'UNKNOWN'
      });
    }

    if (out.length) {
      log.info({ sig, buys: out }, 'Detected buy(s)');
    }
  } catch (e) {
    log.warn({ err: e?.message }, 'buyDetector failed softly');
  }

  return out;
}
