// src/watcher.js
import pino from 'pino';
import { cfg } from './config.js';
import { getSpotPriceUsd } from './price.js';
import { closePosition, getOpenPosition } from './positions.js';
import { executeSell } from './executor.js';
import { sendExitNotice } from './telegram.js';

const log = pino({ transport: { target: 'pino-pretty' }});

const watchers = new Map(); // mint -> intervalId

function pctChange(entry, current) {
  return ((current - entry) / entry) * 100;
}

export function startWatcher(mint) {
  if (watchers.has(mint)) return; // already watching

  const iv = setInterval(async () => {
    try {
      const pos = getOpenPosition(mint);
      if (!pos) {
        stopWatcher(mint);
        return;
      }

      const p = await getSpotPriceUsd(mint);
      if (!Number.isFinite(p?.priceUsd) || p.priceUsd <= 0) return;

      const change = pctChange(pos.entryPriceUsd, p.priceUsd);
      const hitTP = change >= cfg.takeProfitPercent;
      const hitSL = change <= -Math.abs(cfg.stopLossPercent);

      if (!hitTP && !hitSL) return;

      // Execute exit (paper or live)
      const fill = await executeSell({ mint, qty: pos.qty });
      const closed = closePosition(mint, {
        exitPriceUsd: fill.exitPriceUsd ?? p.priceUsd,
        reason: hitTP ? `take_profit_${cfg.takeProfitPercent}%` : `stop_loss_${cfg.stopLossPercent}%`,
        exitTx: fill.txid || null
      });

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
