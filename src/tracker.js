// src/tracker.js
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import pino from 'pino';
import { cfg } from './config.js';

const log = pino({ transport: { target: 'pino-pretty' }});

// Ensure data dir exists (persists for the life of the instance)
try { fs.mkdirSync(cfg.dataDir, { recursive: true }); } catch {}

const CACHE_PATH = path.join(cfg.dataDir, cfg.topWalletsCacheFile);

/**
 * Fetch top traders from SolanaTracker using the SAME pattern as your
 * working reference:
 *
 *   GET /top-traders/all?window=<stWindow>&sortBy=total&expandPnl=false&page=1
 *
 * We do NOT try to infer activity from other endpoints — the `window`
 * itself gives us “recent profitable wallets”.
 */
async function fetchTopTradersWindowed() {
  if (!cfg.stApiKey) throw new Error('ST_API_KEY missing – set your SolanaTracker API key.');

  const url = new URL(`${cfg.stBaseUrl}/top-traders/all`);
  url.searchParams.set('window', cfg.stWindow);          // e.g., '1d' or '3d'
  url.searchParams.set('sortBy', 'total');               // sort by profit in window
  url.searchParams.set('expandPnl', 'false');
  url.searchParams.set('page', '1');

  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': cfg.stApiKey },
    // keep it snappy but reasonable
    timeout: 5000
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SolanaTracker error ${res.status}: ${text || res.statusText}`);
  }

  const data = await res.json();
  const wallets = Array.isArray(data?.wallets) ? data.wallets : [];

  // Normalize to local shape; winPercentage is 0–100
  const normalized = wallets.map(item => ({
    address: item?.wallet,
    winRatePercent: Number(item?.summary?.winPercentage ?? 0),
    realized: Number(item?.summary?.realized ?? 0),
    total: Number(item?.summary?.total ?? 0)
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
 * Local selection:
 *  - take first cfg.topWallets from the SolanaTracker page
 *  - filter by winPercentage >= cfg.minWinRatePercent
 *  - sort by total (descending) to mirror the endpoint’s intent
 *  - return top cfg.trackTopN
 *
 * We also set lastActiveMsAgo=0 so the TG summary (if showing “active X ago”)
 * renders as “0–24h” for a 1d window (or 0–72h for a 3d window).
 */
function pickTopWallets(raw) {
  const slice = raw.slice(0, cfg.topWallets);

  const filtered = slice
    .filter(i => Number.isFinite(i.winRatePercent))
    .filter(i => i.winRatePercent >= cfg.minWinRatePercent)
    .sort((a, b) => (b.total - a.total))       // highest profit first within the window
    .slice(0, cfg.trackTopN)
    .map(i => ({
      address: i.address,
      winRatePercent: i.winRatePercent,
      lastActiveMsAgo: 0 // implies “active within the chosen window”
    }));

  log.info({
    considered: slice.length,
    selected: filtered.length,
    minWinRatePercent: cfg.minWinRatePercent,
    window: cfg.stWindow
  }, 'SolanaTracker selection (windowed total + win%)');

  return filtered;
}

/**
 * Public: getTopWallets
 *  - Use cache if fresh,
 *  - Else fetch once using windowed query, cache raw,
 *  - Then pick locally and return: [{ address, winRatePercent, lastActiveMsAgo }]
 */
export async function getTopWallets() {
  // 1) Try cache
  const cached = readCache();
  if (cached?.length) {
    return pickTopWallets(cached);
  }

  // 2) Fetch from ST
  let rawTop = [];
  try {
    rawTop = await fetchTopTradersWindowed();
  } catch (e) {
    // If ST fails and there’s no cache, return empty list
    // (index.js already handles “no wallets” gracefully)
    console.error(e);
    return [];
  }

  // 3) Cache & pick
  writeCache(rawTop);
  return pickTopWallets(rawTop);
}
