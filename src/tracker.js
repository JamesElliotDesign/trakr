import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import pino from 'pino';
import { cfg } from './config.js';

const log = pino({ transport: { target: 'pino-pretty' }});

// Ensure data dir exists (persists for life of instance)
try { fs.mkdirSync(cfg.dataDir, { recursive: true }); } catch {}

const CACHE_PATH = path.join(cfg.dataDir, cfg.topWalletsCacheFile);
const ACTIVE_WINDOW_MS = (cfg.activeWithinHours || 24) * 60 * 60 * 1000;
const PNL_TIMEOUT = 12000;
const TRADES_TIMEOUT = 10000;
const ENRICH_CONCURRENCY = 5;

/**
 * Fetch TOP PAGE ONLY from SolanaTracker sorted by winPercentage.
 * Normalize to { address, winRatePercent } and return raw list.
 *
 * Endpoint: GET /top-traders/all?sortBy=winPercentage&expandPnl=false
 */
async function fetchTopTradersTopPageST() {
  if (!cfg.stApiKey) throw new Error('ST_API_KEY missing – set your SolanaTracker API key.');

  const url = new URL(`${cfg.stBaseUrl}/top-traders/all`);
  url.searchParams.set('sortBy', 'winPercentage');
  url.searchParams.set('expandPnl', 'false');

  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': cfg.stApiKey },
    timeout: 15000
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
 * PnL endpoint with 1d historic:
 *   GET /wallet/{owner}/pnl?showHistoricPnL=true&hideDetails=true
 * We infer "active in last 24h" if the 1d bucket shows non-zero *invested* or *trades/tx count*,
 * or any signal that something changed in last day.
 * Because schema varies, we defensively look for common shapes:
 *   j.historic?.['1d'] / j.summary?.historic?.['1d'] / j.summary?.oneDay / j.historicPnL?.['1d']
 * and check fields like totalInvested, invested, trades, txCount, realized/unrealized/total deltas.
 *
 * Returns: { activeWithin1d: boolean } and optionally a synthetic lastActiveMsAgo = 0 if active; else null.
 */
async function getPnL1dActivity(owner) {
  try {
    const u = new URL(`${cfg.stBaseUrl}/wallet/${owner}/pnl`);
    u.searchParams.set('showHistoricPnL', 'true');
    u.searchParams.set('hideDetails', 'true');

    const res = await fetch(u.toString(), {
      headers: { 'x-api-key': cfg.stApiKey },
      timeout: PNL_TIMEOUT
    });
    if (!res.ok) return { activeWithin1d: false, lastActiveMsAgo: null };

    const j = await res.json();

    // Try to locate a 1d bucket
    const buckets = [
      j?.historic,
      j?.historicPnL,
      j?.summary?.historic,
      j?.summary?.history,
      j?.summary?.oneDay ? { '1d': j?.summary?.oneDay } : null
    ].filter(Boolean);

    let oneDay = null;
    for (const b of buckets) {
      // keys might be '1d' or 'oneDay'
      if (b['1d']) { oneDay = b['1d']; break; }
      if (b.oneDay) { oneDay = b.oneDay; break; }
      if (b['24h']) { oneDay = b['24h']; break; }
    }

    if (!oneDay || typeof oneDay !== 'object') {
      return { activeWithin1d: false, lastActiveMsAgo: null };
    }

    // Probe common fields that indicate activity: invested/totalInvested, trades, txCount, realized/unrealized/total
    const maybeNums = [
      oneDay.invested, oneDay.totalInvested, oneDay.buyAmount, oneDay.sold, oneDay.realized,
      oneDay.unrealized, oneDay.total, oneDay.volume, oneDay.pnl, oneDay.netPnL
    ].map(x => Number(x)).filter(x => Number.isFinite(x));

    const counts = [
      oneDay.trades, oneDay.txCount, oneDay.buys, oneDay.sells, oneDay.positions
    ].map(x => Number(x)).filter(x => Number.isFinite(x));

    const hasValue = maybeNums.some(v => Math.abs(v) > 0);
    const hasCount = counts.some(c => c > 0);

    const activeWithin1d = Boolean(hasValue || hasCount);
    // PnL 1d doesn't give an exact timestamp — if "active", treat as 0 ms ago (we'll display "0–24h")
    return { activeWithin1d, lastActiveMsAgo: activeWithin1d ? 0 : null };
  } catch {
    return { activeWithin1d: false, lastActiveMsAgo: null };
  }
}

/**
 * Fallback last trade time via trades endpoint:
 *   GET /wallet/{owner}/trades  -> trades: [{ time: 1722759119596 }, ...]
 * Returns msAgo or null.
 */
async function getLastTradeMsAgo(owner) {
  try {
    const url = `${cfg.stBaseUrl}/wallet/${owner}/trades`;
    const res = await fetch(url, {
      headers: { 'x-api-key': cfg.stApiKey },
      timeout: TRADES_TIMEOUT
    });
    if (!res.ok) return null;
    const j = await res.json();
    const trades = Array.isArray(j?.trades) ? j.trades : [];
    if (!trades.length) return null;

    let latest = 0;
    for (const t of trades) {
      const ms = Number(t?.time);
      if (Number.isFinite(ms) && ms > latest) latest = ms;
    }
    if (!latest) return null;
    const msAgo = Date.now() - latest;
    return msAgo >= 0 ? msAgo : 0;
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
 * Enrich each wallet with lastActiveMsAgo using:
 *   1) PnL 1d (activity yes/no) => if active, msAgo=0
 *   2) else, trades.latest => msAgo from timestamp
 * Then filter by:
 *   - activeWithinHours (msAgo <= ACTIVE_WINDOW_MS OR msAgo === 0 from 1d PnL)
 *   - winRatePercent >= threshold
 * Sort by win% desc, limit to trackTopN.
 *
 * Returns [{ address, winRatePercent, lastActiveMsAgo }]
 */
async function filterPickActive(topPageRaw) {
  const slice = topPageRaw.slice(0, cfg.topWallets);

  const enriched = [];
  for (let i = 0; i < slice.length; i += ENRICH_CONCURRENCY) {
    const batch = slice.slice(i, i + ENRICH_CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(
      batch.map(async (w) => {
        // First try PnL 1d
        const pnl = await getPnL1dActivity(w.address);
        if (pnl.activeWithin1d) {
          return { ...w, lastActiveMsAgo: 0 };
        }
        // Fallback to trades timestamp
        const msAgo = await getLastTradeMsAgo(w.address);
        return { ...w, lastActiveMsAgo: Number.isFinite(msAgo) ? msAgo : null };
      })
    );
    enriched.push(...results);
  }

  const active = enriched
    .filter(w => Number.isFinite(w.winRatePercent) && w.winRatePercent >= cfg.minWinRatePercent)
    .filter(w => {
      if (w.lastActiveMsAgo === 0) return true; // active within 1d by PnL
      if (w.lastActiveMsAgo == null) return false;
      return w.lastActiveMsAgo <= ACTIVE_WINDOW_MS;
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
 * Returns: [{ address, winRatePercent, lastActiveMsAgo }]
 */
export async function getTopWallets() {
  const cached = readCache();
  if (cached?.length) {
    return filterPickActive(cached);
  }

  let rawTop = [];
  try {
    rawTop = await fetchTopTradersTopPageST();
  } catch (e) {
    log.error(e, 'Failed to fetch from SolanaTracker');
    return [];
  }

  writeCache(rawTop);
  return await filterPickActive(rawTop);
}
