// src/watcher.js
import pino from 'pino';
import { cfg } from './config.js';
import { getSpotPriceUsd } from './price.js';
import { closePosition, getOpenPosition } from './positions.js';
import { executeSell } from './executor.js';
import { sendExitNotice } from './telegram.js';

const log = pino({ transport: { target: 'pino-pretty' }});

const watchers = new Map(); // mint -> intervalId
const exiting = new Set();  // mints currently attempting to exit

function pctChange(entry, current) {
  return ((current - entry) / entry) * 100;
}

export function startWatcher(mint) {
  if (watchers.has(mint)) return;

  const iv = setInterval(async () => {
    const pos = getOpenPosition(mint);
    if (!pos) { stopWatcher(mint); return; }

    try {
      const p = await getSpotPriceUsd(mint);
      if (!Number.isFinite(p?.priceUsd) || p.priceUsd <= 0) return;

      const change = pctChange(pos.entryPriceUsd, p.priceUsd);
      const hitTP = change >= cfg.takeProfitPercent;
      const hitSL = change <= -Math.abs(cfg.stopLossPercent);

      if (!hitTP && !hitSL) return;
      if (exiting.has(mint)) return; // already trying to exit

      exiting.add(mint);

      // small internal retry loop for live sells
      let filled = null;
      let lastErr = null;
      for (let i = 0; i < 4; i++) {
        try {
          filled = await executeSell({ mint, qty: pos.qty });
          break;
        } catch (e) {
          lastErr = e;
          const ms = 600 + i * 500;
          log.warn({ mint, try: i + 1, err: e?.message }, 'exit sell failed, retrying');
          await new Promise(r => setTimeout(r, ms));
        }
      }

      if (!filled) {
        // Could not sell now; keep position open and keep trying in later ticks
        exiting.delete(mint);
        log.warn({ mint, err: lastErr?.message }, 'exit sell permanently failed for now; will retry on next tick');
        return;
      }

      const closed = closePosition(mint, {
        exitPriceUsd: filled.exitPriceUsd ?? p.priceUsd,
        reason: hitTP ? `take_profit_${cfg.takeProfitPercent}%` : `stop_loss_${cfg.stopLossPercent}%`,
        exitTx: filled.txid || null
      });

      exiting.delete(mint);
      stopWatcher(mint);

      await sendExitNotice({
        mint,
        entry: pos.entryPriceUsd,
        exit: closed.exitPriceUsd,
        pnlPct: closed.pnlPct,
        reason: closed.reason,
        txid: closed.exitTx,
        mode: pos.mode
      });

      log.info({ mint, pnlPct: closed.pnlPct, reason: closed.reason }, 'Position closed');
    } catch (e) {
      exiting.delete(mint);
      log.warn({ mint, err: e?.message }, 'watcher tick failed');
    }
  }, Math.max(500, cfg.pricePollMs));

  watchers.set(mint, iv);
}

export function stopWatcher(mint) {
  const iv = watchers.get(mint);
  if (iv) clearInterval(iv);
  watchers.delete(mint);
}
