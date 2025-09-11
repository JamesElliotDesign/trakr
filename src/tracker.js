// src/tracker.js
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import pino from 'pino';
import { cfg } from './config.js';

const log = pino({ transport: { target: 'pino-pretty' }});

// Ensure data dir exists (persists while the instance lives)
try { fs.mkdirSync(cfg.dataDir, { recursive: true }); } catch {}

const CACHE_PATH = path.join(cfg.dataDir, cfg.topWalletsCacheFile);
const ACTIVE_WINDOW_MS = (cfg.activeWithinHours || 24) * 60 * 60 * 1000;

// --- Helpers -------------------------------------------------------------

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

function writeCache(items) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ ts: Date.now(), items }), 'utf8');
  } catch { /* ignore */ }
}

/**
 * ST candidates (matches the reference you pasted):
 * GET /top-traders/all?window=<stWindow>&sortBy=total&expandPnl=false&page=1
 * Returns [{ address, winRatePercent, realized, total }]
 */
async function fetchTopTradersWindowed() {
  if (!cfg.stApiKey) throw new Error('ST_API_KEY missing – set your SolanaTracker API key.');

  const url = new URL(`${cfg.stBaseUrl}/top-traders/all`);
  url.searchParams.set('window', cfg.stWindow);   // '1d', '3d', etc.
  url.searchParams.set('sortBy', 'total');        // follow the working snippet
  url.searchParams.set('expandPnl', 'false');
  url.searchParams.set('page', '1');

  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': cfg.stApiKey },
    timeout: 5000
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SolanaTracker error ${res.status}: ${text || res.statusText}`);
  }

  const data = await res.json();
  const wallets = Array.isArray(data?.wallets) ? data.wallets : [];
  return wallets
    .map(item => ({
      address: item?.wallet,
      winRatePercent: Number(item?.summary?.winPercentage ?? 0),
      realized: Number(item?.summary?.realized ?? 0),
      total: Number(item?.summary?.total ?? 0)
    }))
    .filter(x => !!x.address);
}

/**
 * Helius RPC recency check (definitive on-chain activity):
 * POST https://rpc.helius.xyz/?api-key=... body:
 *   { "jsonrpc":"2.0","id":"1","method":"getSignaturesForAddress","params":[<address>, {"limit": 1}] }
 * If latest signature has blockTime within ACTIVE_WINDOW_MS => considered active.
 */
async function getMsAgoFromHelius(address) {
  const url = `https://rpc.helius.xyz/?api-key=${cfg.heliusApiKey}`;
  const body = {
    jsonrpc: '2.0',
    id: '1',
    method: 'getSignaturesForAddress',
    params: [address, { limit: 1 }]
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 6000
    });
    if (!res.ok) return null;
    const j = await res.json();
    const arr = Array.isArray(j?.result) ? j.result : [];
    if (!arr.length) return null;
    const blockTime = Number(arr[0]?.blockTime); // seconds since epoch
    if (!Number.isFinite(blockTime)) return null;
    const msAgo = Date.now() - (blockTime * 1000);
    return msAgo >= 0 ? msAgo : 0;
  } catch {
    return null;
  }
}

/**
 * Selection pipeline:
 *  1) Get cached ST candidates or fetch fresh (windowed, page=1).
 *  2) Take first cfg.topWallets, filter by win% threshold (cheap prefilter).
 *  3) For those candidates, verify *actual* recent on-chain activity via Helius RPC.
 *  4) Keep only wallets with msAgo <= ACTIVE_WINDOW_MS.
 *  5) Sort by total desc (keeps intent of “hot hands”), take trackTopN.
 *  6) Return [{ address, winRatePercent, lastActiveMsAgo }]
 */
export async function getTopWallets() {
  // 1) candidates
  let raw = readCache();
  if (!raw) {
    raw = await fetchTopTradersWindowed();
    writeCache(raw);
  }

  // 2) cheap prefilter & cap
  const pre = raw
    .slice(0, cfg.topWallets)
    .filter(x => Number.isFinite(x.winRatePercent) && x.winRatePercent >= cfg.minWinRatePercent);

  if (!pre.length) {
    log.warn('No candidates passed win% threshold on the current ST page.');
    return [];
  }

  // 3) verify recency via Helius RPC (bounded concurrency)
  const concurrency = 6;
  const enriched = [];
  for (let i = 0; i < pre.length; i += concurrency) {
    const batch = pre.slice(i, i + concurrency);
    // eslint-disable-next-line no-await-in-loop
    const res = await Promise.all(batch.map(async (w) => {
      const msAgo = await getMsAgoFromHelius(w.address);
      return { ...w, lastActiveMsAgo: Number.isFinite(msAgo) ? msAgo : null };
    }));
    enriched.push(...res);
  }

  // 4) filter by activity window
  const active = enriched
    .filter(w => w.lastActiveMsAgo != null && w.lastActiveMsAgo <= ACTIVE_WINDOW_MS)
    .sort((a, b) => b.total - a.total)
    .slice(0, cfg.trackTopN)
    .map(w => ({
      address: w.address,
      winRatePercent: w.winRatePercent,
      lastActiveMsAgo: w.lastActiveMsAgo
    }));

  log.info({
    considered: pre.length,
    selected: active.length,
    minWinRatePercent: cfg.minWinRatePercent,
    activeWithinHours: cfg.activeWithinHours
  }, 'Final selection (ST windowed + Helius activity)');

  return active;
}
