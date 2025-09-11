// src/price.js
import fetch from 'node-fetch';
import pino from 'pino';
const log = pino({ transport: { target: 'pino-pretty' }});

/**
 * Primary: Jupiter Price API V3 (Lite/Pro)
 *  - Docs: https://dev.jup.ag/docs/price-api/v3  (overview)
 *  - Endpoint: Lite  https://lite-api.jup.ag/price/v3
 *               Pro  https://api.jup.ag/price/v3  (set JUP_API_KEY to use)
 *
 * Fallback: Birdeye Public Price
 *  - Endpoint: https://public-api.birdeye.so/defi/price?address=<mint>
 *  - Optional key: set BIRDEYE_API_KEY to raise rate limits
 */

const JUP_LITE_URL = 'https://lite-api.jup.ag/price/v3';
const JUP_PRO_URL  = 'https://api.jup.ag/price/v3'; // requires x-api-key
const JUP_API_KEY = process.env.JUP_API_KEY || '';

const BIRDEYE_URL = 'https://public-api.birdeye.so/defi/price';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';

/**
 * Try Jupiter v3 (Lite/Pro). V3 schema returns an object keyed by mint.
 * Historically (v2) it returned { data: { <mint>: { price } } }.
 * We'll support both just in case.
 */
async function getFromJupiter(mint) {
  const base = JUP_API_KEY ? JUP_PRO_URL : JUP_LITE_URL;
  const url = new URL(base);
  // V3 expects "ids" (comma-separated mints)
  url.searchParams.set('ids', mint);

  try {
    const res = await fetch(url.toString(), {
      headers: JUP_API_KEY ? { 'x-api-key': JUP_API_KEY } : undefined,
      // reasonable timeout
      timeout: 12_000
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Jupiter ${res.status}: ${t || res.statusText}`);
    }

    const j = await res.json();

    // Normalize — try V3 shape first, then V2-like shape
    // V3: { data: { [mint]: { price: number, ... } }, timeMs?: ... } OR sometimes top-level mapping
    const data = j?.data && typeof j.data === 'object' ? j.data : j;
    const rec = data?.[mint];
    const price = Number(rec?.price);
    if (Number.isFinite(price)) {
      return { priceUsd: price, ts: Date.now(), source: JUP_API_KEY ? 'jupiter-pro' : 'jupiter-lite' };
    }

    // Some cases might nest differently; attempt a generic scan
    const maybe = findFirstPriceNumber(data);
    if (maybe != null) {
      return { priceUsd: maybe, ts: Date.now(), source: JUP_API_KEY ? 'jupiter-pro' : 'jupiter-lite' };
    }

    return null;
  } catch (e) {
    log.warn({ mint, err: e.message }, 'Jupiter price failed');
    return null;
  }
}

/**
 * Fallback: Birdeye public price
 *  Response: { data: { value: number, price?: number, updateUnixTime?: number } }
 */
async function getFromBirdeye(mint) {
  try {
    const u = new URL(BIRDEYE_URL);
    u.searchParams.set('address', mint);

    const headers = {};
    if (BIRDEYE_API_KEY) headers['X-API-KEY'] = BIRDEYE_API_KEY;

    const res = await fetch(u.toString(), { headers, timeout: 10_000 });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Birdeye ${res.status}: ${t || res.statusText}`);
    }

    const j = await res.json();
    const v = j?.data?.value ?? j?.data?.price;
    const price = Number(v);
    if (Number.isFinite(price)) {
      const ts = Number(j?.data?.updateUnixTime) * 1000 || Date.now();
      return { priceUsd: price, ts, source: 'birdeye' };
    }

    return null;
  } catch (e) {
    log.warn({ mint, err: e.message }, 'Birdeye price failed');
    return null;
  }
}

/** Utility: scan an object for a numeric `price` field */
function findFirstPriceNumber(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Number.isFinite(obj.price)) return Number(obj.price);
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const nested = findFirstPriceNumber(v);
      if (nested != null) return nested;
    }
  }
  return null;
}

/**
 * Public API
 *  - Returns { priceUsd, ts, source } or null
 */
export async function getSpotPriceUsd(mint) {
  // 1) Jupiter v3 (Lite/Pro)
  let p = await getFromJupiter(mint);
  if (p) return p;

  // 2) Birdeye fallback
  p = await getFromBirdeye(mint);
  if (p) return p;

  return null;
}
