import fetch from 'node-fetch';
import { cfg } from './config.js';
import pino from 'pino';

const log = pino({ transport: { target: 'pino-pretty' }});

/**
 * Interface we expect from any source:
 * returns [{address, winRate, roi, pnl, trades, ...}, ...]
 */
async function fetchFromSolanaTracker(top = 20) {
  // TODO: Replace with SolanaTracker’s real API when available.
  // If there’s no public API, you can maintain a curated list or build
  // a tiny scraper behind Cloudflare (be mindful of ToS).
  // For now, return a static/dummy structure to keep the pipeline working.
  log.warn('SolanaTracker adapter is a stub. Replace with real fetch.');
  return [
    // { address: "wallet1...", winRate: 0.72, roi: 2.1, trades: 180 },
    // ...
  ].slice(0, top);
}

export async function getTopWallets() {
  let wallets = [];
  if (cfg.walletSource === 'solanatracker') {
    wallets = await fetchFromSolanaTracker(cfg.topWallets);
  } else {
    throw new Error(`Unknown WALLET_SOURCE=${cfg.walletSource}`);
  }

  // Filter + sort by win rate then some tie-breaker (e.g., trades)
  const filtered = wallets
    .filter(w => typeof w.winRate === 'number' && w.winRate >= cfg.minWinRate)
    .sort((a, b) => (b.winRate - a.winRate) || ((b.trades||0) - (a.trades||0)))
    .slice(0, cfg.trackTopN);

  if (!filtered.length) log.warn('No wallets passed filtering. Using empty list.');
  return filtered.map(w => w.address);
}
