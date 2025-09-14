// src/executor.js
import pino from 'pino';
import { cfg } from './config.js';
import { getSpotPriceUsd } from './price.js';

const log = pino({ transport: { target: 'pino-pretty' }});
const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function ensurePrice(mint, tries = 3, delayMs = 600) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const p = await getSpotPriceUsd(mint);
    if (Number.isFinite(p?.priceUsd) && p.priceUsd > 0) return p;
    last = p;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return last;
}

/* --------------------------- PAPER MODE --------------------------- */
async function paperBuy({ mint }) {
  // We spend cfg.buySolAmount SOL at current token price
  const solUsd = await ensurePrice(SOL_MINT);
  const tok = await ensurePrice(mint);

  if (!Number.isFinite(solUsd?.priceUsd) || !Number.isFinite(tok?.priceUsd)) {
    throw new Error(`price not available for buy: solUsd=${solUsd?.priceUsd} tokUsd=${tok?.priceUsd}`);
  }

  const spendSol = cfg.buySolAmount;
  const spendUsd = spendSol * solUsd.priceUsd;
  const qty = spendUsd / tok.priceUsd;

  return {
    mode: 'paper',
    entryPriceUsd: tok.priceUsd,
    qty,
    solSpent: spendSol,
    txid: null,
    provider: tok.source || 'jupiter'
  };
}

async function paperSell({ mint, qty }) {
  const tok = await ensurePrice(mint);
  if (!Number.isFinite(tok?.priceUsd)) {
    throw new Error(`price not available for sell: mint=${mint}`);
  }
  return {
    mode: 'paper',
    exitPriceUsd: tok.priceUsd,
    txid: null,
    provider: tok.source || 'jupiter'
  };
}

/* --------------------------- LIVE MODE (stub) --------------------------- */
// NOTE: For live trading we’ll wire Jupiter quote/swap, sign via your hot wallet.
// Left intentionally stubbed for safety until you provide a trading key + RPC.
async function liveBuy({ mint }) {
  throw new Error('LIVE trading not enabled. Set TRADE_MODE=paper (default).');
}
async function liveSell({ mint, qty }) {
  throw new Error('LIVE trading not enabled. Set TRADE_MODE=paper (default).');
}

/* --------------------------- Public API --------------------------- */
export async function executeBuy({ mint }) {
  if (cfg.tradeMode === 'paper') return paperBuy({ mint });
  return liveBuy({ mint });
}
export async function executeSell({ mint, qty }) {
  if (cfg.tradeMode === 'paper') return paperSell({ mint, qty });
  return liveSell({ mint, qty });
}
