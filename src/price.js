// src/price.js
import fetch from 'node-fetch';
import pino from 'pino';
import { cfg } from './config.js';

const log = pino({ transport: { target: 'pino-pretty' }});

const JUP_LITE = 'https://lite-api.jup.ag/price/v3';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Optional Birdeye fallback if you later provide a key
const BE_BASE = 'https://public-api.birdeye.so/defi/price';

async function jupPriceUsd(mint) {
  try {
    const url = `${JUP_LITE}?ids=${encodeURIComponent(mint)}`;
    const res = await fetch(url, { timeout: 2500 });
    if (!res.ok) return null;
    const j = await res.json();
    const row = j?.[mint];
    const price = Number(row?.usdPrice);
    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

async function jupSolUsd() {
  return jupPriceUsd(SOL_MINT);
}

async function birdeyePriceUsd(mint) {
  try {
    if (!process.env.BIRDEYE_API_KEY) return null;
    const url = `${BE_BASE}?address=${encodeURIComponent(mint)}`;
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'x-api-key': process.env.BIRDEYE_API_KEY
      },
      timeout: 2500
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      log.warn({ mint, err: `Birdeye ${res.status}: ${t}` }, 'Birdeye price failed');
      return null;
    }
    const j = await res.json();
    const price = Number(j?.data?.value);
    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

/**
 * Try to get a spot USD price for a token:
 *  1) Jupiter Price V3
 *  2) If missing and we have trade context: price = (solSpent / amount) * SOL_USD
 *  3) Optional Birdeye fallback (only if key provided)
 *
 * @param {string} mint
 * @param {{ amount?: number, solSpent?: number }} [ctx]
 * @returns {{ priceUsd: number|null, source: string|null }}
 */
export async function getSpotPriceUsd(mint, ctx = {}) {
  // 1) Jupiter direct
  const j = await jupPriceUsd(mint);
  if (Number.isFinite(j)) {
    return { priceUsd: j, source: 'jupiter' };
  }

  // 2) Derive from swap context if possible
  if (Number.isFinite(ctx?.solSpent) && Number.isFinite(ctx?.amount) && ctx.amount > 0) {
    const solUsd = await jupSolUsd();
    if (Number.isFinite(solUsd)) {
      const price = (ctx.solSpent / ctx.amount) * solUsd;
      if (Number.isFinite(price) && price > 0) {
        return { priceUsd: price, source: 'derived(sol*usd/amount)' };
      }
    }
  }

  // 3) Optional Birdeye fallback
  const be = await birdeyePriceUsd(mint);
  if (Number.isFinite(be)) {
    return { priceUsd: be, source: 'birdeye' };
  }

  return { priceUsd: null, source: null };
}
