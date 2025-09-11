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
const ST_MAX_PAGES = Math.max(1, parseInt(process.env.ST_MAX_PAGES || '5', 10));
const PNL_TIMEOUT = 12000;
const TRADES_TIMEOUT = 10000;
const ENRICH_CONCURRENCY = 5;

/** Fetch one page of top traders, sorted by winPercentage */
async function fetchTopTradersPage(page = 1) {
  if (!cfg.stApiKey) throw new Error('ST_API_KEY missing – set your SolanaTracker API key.');
  const base =
    page <= 1
      ? `${cfg.stBaseUrl}/top-traders/all`
      : `${cfg.stBaseUrl}/top-traders/all/${page}`;
  const url = new URL(base);
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
  return wallets
    .map(w => ({
      address: w?.wallet,
      winRatePercent: Number(w?.summary?.winPercentage ?? 0)
    }))
    .filter(x => !!x.address);
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
  } catch { /* ignore */ }
}

/** PnL 1d activity probe */
async function getPnL1dActivity(owner) {
  try {
    const u = new URL(`${cfg.stBaseUrl}/wallet/${owner}/pnl`);
    u.searchParams.set('showHistoricPnL', 'true');
    u.searchParams.set('hideDetails', 'true');
    const res = await fetch(u.toString(), {
      headers: { 'x-api-key': cfg.stApiKey },
      timeout: PNL_TIMEOUT
    });
    if (!res.ok) return { activeWithin1d: false };

    const j = await res.json();
    const buckets = [
      j?.historic,
      j?.historicPnL,
      j?.summary?.historic,
      j?.summary?.history,
      j?.summary?.oneDay ? { '1d': j?.summary?.oneDay } : null
    ].filter(Boolean);

    let oneDay = null;
    for (const b of buckets) {
      if (b['1d']) { oneDay = b['1d']; break; }
      if (b.oneDay) { oneDay = b.oneDay; break; }
      if (b['24h']) { oneDay = b['24h']; break; }
    }
    if (!oneDay || typeof oneDay !== 'object') return { activeWithin1d: false };

    const nums = [
      oneDay.invested, oneDay.totalInvested, oneDay.buyAmount, oneDay.sold,
      oneDay.realized, oneDay.unrealized, oneDay.total, oneDay.volume, oneDay.pnl, oneDay.netPnL
    ].map(Number).filter(Number.isFinite);
    const counts = [oneDay.trades, oneDay.txCount, oneDay.buys, oneDay.sells, oneDay.positions]
      .map(Number).filter(Number.isFinite);

    return { activeWithin1d: nums.some(v => Math.abs(v) > 0) || counts.some(c => c > 0) };
  } catch {
    return { activeWithin1d: false };
  }
}

/** Fallback: last trade timestamp */
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

/** Enrich a wallet with lastActiveMsAgo using PnL 1d then trades */
async function enrichActivity(w) {
  const pnl = await getPnL1dActivity(w.address);
  if (pnl.activeWithin1d) return { ...w, lastActiveMsAgo: 0 };
  const msAgo = await getLastTradeMsAgo(w.address);
  return { ...w, lastActiveMsAgo: Number.isFinite(msAgo) ? msAgo : null };
}

/** Paginate + enrich + filter + pick */
async function collectActiveWallets() {
  // 1) get candidates from cache or ST pages
  let raw = readCache();
  if (!raw) {
    raw = [];
    for (let page = 1; page <= ST_MAX_PAGES; page++) {
      // eslint-disable-next-line no-await-in-loop
      const pageData = await fetchTopTradersPage(page);
      raw = raw.concat(pageData);
      // small guardrail: stop once we have a healthy pool
      if (raw.length >= cfg.topWallets * 3) break;
    }
    writeCache(raw);
  }

  // 2) take the first N*X to enrich (avoid rinsing API)
  const cap = Math.max(cfg.topWallets * 3, cfg.trackTopN * 3);
  const pool = raw.slice(0, cap);

  // 3) enrich with activity (bounded concurrency)
  const enriched = [];
  for (let i = 0; i < pool.length; i += ENRICH_CONCURRENCY) {
    const batch = pool.slice(i, i + ENRICH_CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(batch.map(enrichActivity));
    enriched.push(...results);
  }

  // 4) filter by activity window + win%
  const active = enriched
    .filter(w => {
      if (w.lastActiveMsAgo === 0) return true; // 1d active by PnL
      if (w.lastActiveMsAgo == null) return false;
      return w.lastActiveMsAgo <= ACTIVE_WINDOW_MS;
    })
    .filter(w => Number.isFinite(w.winRatePercent) && w.winRatePercent >= cfg.minWinRatePercent)
    .sort((a, b) => b.winRatePercent - a.winRatePercent);

  // 5) pick top N
  return active.slice(0, cfg.trackTopN);
}

/**
 * Public: getTopWallets
 * Returns: [{ address, winRatePercent, lastActiveMsAgo }]
 */
export async function getTopWallets() {
  const picked = await collectActiveWallets();
  log.info({
    considered: Math.min(cfg.topWallets * 3, picked.length),
    activeWithinHours: cfg.activeWithinHours,
    selected: picked.length,
    minWinRatePercent: cfg.minWinRatePercent
  }, 'SolanaTracker selection (active + win%)');
  return picked;
}
