// src/tracker.js
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import pino from 'pino';
import { cfg } from './config.js';

const log = pino({ transport: { target: 'pino-pretty' }});

// Ensure data dir exists (persists for life of instance)
try { fs.mkdirSync(cfg.dataDir, { recursive: true }); } catch {}

const CACHE_PATH = path.join(cfg.dataDir, cfg.topWalletsCacheFile);

/**
 * Fetch TOP PAGE ONLY from SolanaTracker sorted by winPercentage.
 * We do NOT filter at fetch time — we normalize, cache, and return raw.
 */
async function fetchTopTradersTopPageST() {
  if (!cfg.stApiKey) throw new Error('ST_API_KEY missing – set your SolanaTracker API key.');

  const url = new URL(`${cfg.stBaseUrl}/top-traders/all`);
  url.searchParams.set('sortBy', 'winPercentage');
  url.searchParams.set('expandPnl', 'false');

  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': cfg.stApiKey },
    timeout: 15_000
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SolanaTracker error ${res.status}: ${text || res.statusText}`);
  }

  const data = await res.json();
  const wallets = Array.isArray(data?.wallets) ? data.wallets : [];

  // Normalize; ST winPercentage is 0–100 (e.g., 36.27)
  const normalized = wallets.map(w => ({
    address: w?.wallet,
    winRatePercent: Number(w?.summary?.winPercentage ?? 0)
  })).filter(x => !!x.address);

  return normalized;
}

/** Try cache if fresh */
function readCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!raw || !raw.ts || !Array.isArray(raw.items)) return null;
    const ageMs = Date.now() - Number(raw.ts);
    if (ageMs > cfg.topWalletsTtlMinutes * 60_000) return null;
    return raw.items;
  } catch {
    return null;
  }
}

/** Write cache (best-effort) */
function writeCache(items) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ ts: Date.now(), items }), 'utf8');
  } catch {
    // ignore fs errors on ephemeral disks
  }
}

/**
 * Local filter & pick:
 *  - Take first cfg.topWallets entries from raw top page,
 *  - Filter by winPercentage >= cfg.minWinRatePercent ONLY,
 *  - Sort by winPercentage desc,
 *  - Take cfg.trackTopN.
 *
 * Returns array of { address, winRatePercent }.
 */
function filterAndPick(topPageRaw) {
  const topSlice = topPageRaw.slice(0, cfg.topWallets);

  const filtered = topSlice
    .filter(i => Number.isFinite(i.winRatePercent))
    .filter(i => i.winRatePercent >= cfg.minWinRatePercent)
    .sort((a, b) => b.winRatePercent - a.winRatePercent)
    .slice(0, cfg.trackTopN);

  log.info({
    considered: topSlice.length,
    selected: filtered.length,
    minWinRatePercent: cfg.minWinRatePercent
  }, 'SolanaTracker selection (filtered by winPercentage)');

  return filtered;
}

/**
 * Public: getTopWallets
 *  - Use cache if fresh,
 *  - Else fetch once, cache raw result,
 *  - Then apply local filtering by winPercentage.
 *
 * Returns: [{ address, winRatePercent }, ...]
 */
export async function getTopWallets() {
  // 1) Try cache
  const cached = readCache();
  if (cached?.length) {
    return filterAndPick(cached);
  }

  // 2) Fetch from ST (top page only)
  let rawTop = [];
  try {
    rawTop = await fetchTopTradersTopPageST();
  } catch (e) {
    // If ST fails and there’s no cache, return empty list
    log.error(e, 'Failed to fetch from SolanaTracker');
    return [];
  }

  // 3) Cache raw result to avoid rinsing the API
  writeCache(rawTop);

  // 4) Filter locally & pick
  return filterAndPick(rawTop);
}
