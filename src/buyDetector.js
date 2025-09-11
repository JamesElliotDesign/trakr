// src/buyDetector.js
import { cfg } from './config.js';
import pino from 'pino';

const log = pino({ transport: { target: 'pino-pretty' }});

/**
 * Improved Buy Detection
 *
 * Priority order:
 *  1) Use Helius enhanced `events.swap` to detect explicit swaps where a tracked wallet bought SPL tokens.
 *     - Prefer destinationMint/outAmount (tokens received).
 *     - Validate that the "user" of the swap (or signer) is one of our tracked wallets.
 *  2) Fallback: Inspect `tokenTransfers` to detect net incoming SPL tokens to a tracked wallet.
 *
 * Debounce:
 *  - Per (wallet:mint) pair for cfg.buyDebounceMinutes to avoid duplicates on multi-instruction txns or MEV retries.
 *
 * Filters:
 *  - Exclude mints in cfg.excludedMints (USDC/USDT/WSOL etc.)
 *  - Ignore zero/negative amounts and obvious dust (cfg.minTokenAmount).
 *
 * Output:
 *  - Array of { wallet, mint, amount, signature }
 */

function nowMs() { return Date.now(); }
function debounced(seenCache, key, windowMs) {
  const last = Number(seenCache.get(key) || 0);
  if (nowMs() - last < windowMs) return true;
  seenCache.set(key, nowMs());
  return false;
}

// Try to resolve the primary user (trader) from swap event or tx signers
function resolveSwapUser(tx, swapEvt) {
  // Common fields Helius may include on swap events
  const candidates = [
    swapEvt?.user,
    swapEvt?.owner,
    swapEvt?.trader,
    swapEvt?.wallet,
    swapEvt?.authority
  ].filter(Boolean);

  // If not present, fall back to tx signers/feePayer
  const signers = new Set([
    ...(tx?.accountData?.signers || []),
    tx?.feePayer
  ].filter(Boolean));

  for (const c of candidates) {
    if (c) return c;
  }
  // as a last resort pick the first signer (usually the trader)
  if (signers.size) return [...signers][0];
  return null;
}

// Extract destination mint & amount from a swap event
function resolveBoughtMintAndAmount(swapEvt) {
  // Helius swap event typically has sourceMint/destinationMint and inAmount/outAmount (as strings)
  // We treat destinationMint/outAmount as "what the user received"
  const destMint = swapEvt?.destinationMint || swapEvt?.mintOut || swapEvt?.toMint;
  const outRaw = swapEvt?.outAmount ?? swapEvt?.amountOut ?? swapEvt?.toAmount;
  const amount = outRaw != null ? Number(outRaw) : NaN;

  if (!destMint || !Number.isFinite(amount)) return null;
  return { mint: destMint, amount };
}

// Build a map from token account -> owner (Helius provides this in accountData sometimes)
function buildTokenAccountOwnerMap(tx) {
  const m = Object.create(null);
  const owners = tx?.accountData?.tokenAccountOwners || {};
  for (const [acct, owner] of Object.entries(owners)) {
    if (owner) m[acct] = owner;
  }
  return m;
}

// Fallback detector using tokenTransfers directed to tracked owners
function detectByTokenTransfers(tx, trackedSet, seenCache) {
  const out = [];
  const tokenAccOwner = buildTokenAccountOwnerMap(tx);
  const transfers = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
  const sig = tx?.signature;

  for (const t of transfers) {
    const mint = t?.mint;
    if (!mint || cfg.excludedMints.has(mint)) continue;

    const amt = Number(t?.tokenAmount || 0);
    if (!Number.isFinite(amt) || amt <= 0) continue;

    // Resolve destination owner (toUserAccount is ideal; else map token account -> owner)
    const toOwner = t?.toUserAccount || tokenAccOwner[t?.toTokenAccount];
    if (!toOwner || !trackedSet.has(toOwner)) continue;

    // Optional: skip obvious dust
    if (amt < cfg.minTokenAmount) continue;

    const key = `${toOwner}:${mint}`;
    if (debounced(seenCache, key, cfg.buyDebounceMinutes * 60 * 1000)) continue;

    out.push({ wallet: toOwner, mint, amount: amt, signature: sig });
  }
  return out;
}

// Main entry
export function detectBuys(tx, trackedSet, seenCache) {
  const buys = [];
  const sig = tx?.signature;

  // 1) Prefer parsed swap events
  const swaps = Array.isArray(tx?.events?.swap) ? tx.events.swap : [];
  for (const s of swaps) {
    const user = resolveSwapUser(tx, s);
    if (!user || !trackedSet.has(user)) continue;

    const res = resolveBoughtMintAndAmount(s);
    if (!res) continue;

    const { mint, amount } = res;
    if (!mint || cfg.excludedMints.has(mint)) continue;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (amount < cfg.minTokenAmount) continue;

    const key = `${user}:${mint}`;
    if (debounced(seenCache, key, cfg.buyDebounceMinutes * 60 * 1000)) continue;

    buys.push({ wallet: user, mint, amount: Number(amount), signature: sig });
  }

  // 2) If no swaps matched, fall back to tokenTransfers
  if (!buys.length) {
    const tfBuys = detectByTokenTransfers(tx, trackedSet, seenCache);
    if (tfBuys.length) buys.push(...tfBuys);
  }

  if (!buys.length) {
    // Be verbose in debug, quiet in info to avoid noisy logs
    log.debug({ sig }, 'No buys detected');
  } else {
    log.info({ sig, buys }, 'Detected buy(s)');
  }

  return buys;
}
