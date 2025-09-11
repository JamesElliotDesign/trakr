import fetch from 'node-fetch';
import { cfg } from './config.js';
import pino from 'pino';
const log = pino({ transport: { target: 'pino-pretty' }});

/**
 * Try GMGN price endpoint for a mint (see their docs).
 * NOTE: Fill the exact route/params once you confirm the API.
 */
async function getPriceFromGMGN(mint) {
  try {
    // Example placeholder; replace with correct GMGN route:
    // const url = `https://api.gmgn.ai/sol/v1/price?mint=${mint}`;
    const url = `https://example-gmgn/price?mint=${mint}`; // placeholder
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GMGN ${res.status}`);
    const data = await res.json();
    // Normalize to { priceUsd, ts }
    return { priceUsd: data?.price || null, ts: Date.now(), source: 'gmgn' };
  } catch (e) {
    log.warn({ mint, err: e.message }, 'GMGN price failed');
    return null;
  }
}

/**
 * PumpPortal real-time price endpoint (see their docs).
 */
async function getPriceFromPumpPortal(mint) {
  try {
    // Example placeholder; replace with correct PumpPortal route:
    // const url = `https://pumpportal.fun/api/v2/price?mint=${mint}`;
    const url = `https://example-pumpportal/price?mint=${mint}`; // placeholder
    const res = await fetch(url);
    if (!res.ok) throw new Error(`PumpPortal ${res.status}`);
    const data = await res.json();
    return { priceUsd: data?.price || null, ts: Date.now(), source: 'pumpportal' };
  } catch (e) {
    log.warn({ mint, err: e.message }, 'PumpPortal price failed');
    return null;
  }
}

export async function getSpotPriceUsd(mint) {
  const primary = cfg.priceProviderPref === 'gmgn' ? getPriceFromGMGN : getPriceFromPumpPortal;
  const fallback = cfg.priceProviderPref === 'gmgn' ? getPriceFromPumpPortal : getPriceFromGMGN;

  let p = await primary(mint);
  if (!p || !p.priceUsd) p = await fallback(mint);
  return p; // can be null; caller should handle
}
