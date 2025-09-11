import { cfg } from './config.js';
import pino from 'pino';

const log = pino({ transport: { target: 'pino-pretty' }});

/**
 * Very practical buy detection from a Helius Enhanced Tx payload:
 * - tokenTransfers: array with { mint, tokenAmount, fromUserAccount, toUserAccount, ... }
 * - We look for transfers *to* a tracked wallet and ignore excluded mints.
 * - We optionally require preBalance=0 (if present) or dedupe per wallet+mint.
 */
export function detectBuys(enhancedTx, trackedSet, seenCache) {
  const out = [];
  const wallet = enhancedTx?.accountData?.signers?.[0] || null; // primary signer
  const sig = enhancedTx?.signature || null;

  const transfers = enhancedTx?.tokenTransfers || [];
  for (const t of transfers) {
    const { mint, tokenAmount, toUserAccount, toTokenAccount } = t;
    if (!mint || cfg.excludedMints.has(mint)) continue;
    if (!tokenAmount || tokenAmount <= 0) continue;

    // Helius includes owner fields; sometimes we need to resolve owner from token account map
    const destOwner = t.toUserAccount || enhancedTx?.accountData?.tokenAccountOwners?.[toTokenAccount];
    if (!destOwner) continue;
    if (!trackedSet.has(destOwner)) continue;

    const key = `${destOwner}:${mint}`;
    const lastSeen = seenCache.get(key) || 0;
    const now = Date.now();
    if (now - lastSeen < cfg.buyDebounceMinutes * 60 * 1000) {
      // skip duplicate signal
      continue;
    }

    // Simple “first acquire” heuristic:
    // If Helius provides pre/post balances, prefer those. Otherwise allow the first hit and then debounce.
    // (Add stricter checks later with balance lookups if needed.)
    out.push({
      wallet: destOwner,
      mint,
      amount: tokenAmount,
      signature: sig
    });
    seenCache.set(key, now);
  }

  if (!out.length) log.debug({ sig }, 'No buys detected');
  return out;
}
