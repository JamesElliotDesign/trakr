import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import pino from 'pino';
import { cfg } from './config.js';

const log = pino({ transport: { target: 'pino-pretty' }});

// Ensure data dir exists (persists for life of instance)
try { fs.mkdirSync(cfg.dataDir, { recursive: true }); } catch {}

const CACHE_PATH = path.join(cfg.dataDir, cfg.topWalletsCacheFile);
const ACTIVE_WINDOW_MS = cfg.activeWithinHours * 60 * 60 * 1000;

/**
 * Fetch TOP PAGE ONLY from SolanaTracker sorted by winPercentage.
 * We normalize to { address, winRatePercent } and return raw list.
 *
 * Docs: GET /top-traders/all?sortBy=winPercentage
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

  // Normalize; ST winPercentage is 0–100
  const normalized = wallets.map(w => ({
    address: w?.wallet,
    winRatePercent: Number(w?.summary?.winPercentage ?? 0)
  })).filter(x => !!x.address);

  return normalized;
}

/**
 * For a given wallet, fetch recent trades and return the most recent trade time (ms).
 *
 * Docs: GET /wallet/{owner}/trades  -> returns { trades: [{ time: 1722759119596, ... }], ... }
 */
async function getLastTradeTimeMs(owner) {
  try {
    const url = `${cfg.stBaseUrl}/wallet/${owner}/trades`;
    const res = await fetch(url, {
      headers: { 'x-api-key': cfg.stApiKey },
      timeout: 12_000
    });
    if (!res.ok) return null;
    const j = await res.json();
    const trades = Array.isArray(j?.trades) ? j.trades : [];
    if (!trades.length) return null;

    // Trades are typically returned newest-first; take max just in case
    let latest = 0;
    for (const t of trades) {
      const ms = Number(t?.time);
      if (Number.isFinite(ms) && ms > latest) latest = ms;
    }
    return latest || null;
  } catch {
    return null;
  }
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
 * Take the first cfg.topWallets from the raw top page,
 * enrich with lastTradeTime (ms), then:
 *   - keep only wallets with lastTradeTime within ACTIVE_WINDOW_MS
 *   - filter by winPercentage >= cfg.minWinRatePercent
 *   - sort by win% desc
 *   - take cfg.trackTopN
 *
 * Returns [{ address, winRatePercent, lastTradeTime }]
 */
async function filterPickActive(topPageRaw) {
  const slice = topPageRaw.slice(0, cfg.topWallets);

  // Enrich with last trade time (bounded concurrency: 5 at a time)
  const enriched = [];
  const concurrency = 5;
  for (let i = 0; i < slice.length; i += concurrency) {
    const batch = slice.slice(i, i + concurrency);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(
      batch.map(async (w) => {
        const lastTradeTime = await getLastTradeTimeMs(w.address);
        return { ...w, lastTradeTime };
      })
    );
    enriched.push(...results);
  }

  const now = Date.now();
  const active = enriched
    .filter(w => Number.isFinite(w.winRatePercent))
    .filter(w => w.winRatePercent >= cfg.minWinRatePercent)
    .filter(w => {
      if (!w.lastTradeTime) return false;
      return (now - w.lastTradeTime) <= ACTIVE_WINDOW_MS;
    })
    .sort((a, b) => b.winRatePercent - a.winRatePercent)
    .slice(0, cfg.trackTopN);

  log.info({
    considered: slice.length,
    activeWithinHours: cfg.activeWithinHours,
    selected: active.length,
    minWinRatePercent: cfg.minWinRatePercent
  }, 'SolanaTracker selection (active + win%)');

  return active;
}

/**
 * Public: getTopWallets
 *  - Use cache if fresh (raw top page),
 *  - Else fetch once and cache raw result,
 *  - Then filter for activity + win% and return objects.
 *
 * Returns: [{ address, winRatePercent, lastTradeTime }]
 */
export async function getTopWallets() {
  // 1) Try cache
  const cached = readCache();
  if (cached?.length) {
    return filterPickActive(cached);
  }

  // 2) Fetch from ST (top page only)
  let rawTop = [];
  try {
    rawTop = await fetchTopTradersTopPageST();
  } catch (e) {
    log.error(e, 'Failed to fetch from SolanaTracker');
    return [];
  }

  // 3) Cache raw result to avoid rinsing the API
  writeCache(rawTop);

  // 4) Filter for activity + win%
  return await filterPickActive(rawTop);
}
