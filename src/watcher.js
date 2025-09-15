// src/watcher.js
import pino from 'pino';
import { cfg } from './config.js';
import { getSpotPriceUsd } from './price.js';
import { closePosition, getOpenPosition } from './positions.js';
import { executeSell, resolveSellQtyAtoms } from './executor.js';
import { sendExitNotice } from './telegram.js';
import { ensureSigner } from './keypair.js';

const log = pino({ transport: { target: 'pino-pretty' }});

const watchers = new Map(); // mint -> intervalId
const exiting = new Set();  // mints currently attempting to exit

// Per-mint cooldowns & backoff
const sellCooldownUntil = new Map(); // mint -> timestamp ms
const sellBackoffLevel = new Map();  // mint -> n (exponential)

const MAX_BACKOFF_MS = Number(process.env.WATCHER_MAX_BACKOFF_MS || 60_000);
const BASE_BACKOFF_MS = Number(process.env.WATCHER_BASE_BACKOFF_MS || 1_500);

// If buy never settles into wallet, auto-cancel after this window
const BUY_SETTLE_TIMEOUT_MS = Number(process.env.BUY_SETTLE_TIMEOUT_MS || 45_000);

function pctChange(entry, current) {
  return ((current - entry) / entry) * 100;
}

function now() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function nextBackoffMs(mint) {
  const n = (sellBackoffLevel.get(mint) || 0) + 1;
  sellBackoffLevel.set(mint, n);
  const ms = Math.min(BASE_BACKOFF_MS * 2 ** (n - 1), MAX_BACKOFF_MS);
  return ms + Math.floor(Math.random() * 250); // jitter
}

function resetBackoff(mint) {
  sellBackoffLevel.delete(mint);
  sellCooldownUntil.delete(mint);
}

export function startWatcher(mint) {
  if (watchers.has(mint)) return;

  const iv = setInterval(async () => {
    const pos = getOpenPosition(mint);
    if (!pos) { stopWatcher(mint); return; }

    try {
      // Respect cooldowns if we recently failed to exit
      const until = sellCooldownUntil.get(mint) || 0;
      if (until > now()) return;

      const p = await getSpotPriceUsd(mint);
      if (!Number.isFinite(p?.priceUsd) || p.priceUsd <= 0) return;

      const change = pctChange(pos.entryPriceUsd, p.priceUsd);
      const hitTP = change >= cfg.takeProfitPercent;
      const hitSL = change <= -Math.abs(cfg.stopLossPercent);
      const shouldExit = hitTP || hitSL;

      // Check wallet balance first to avoid death loops.
      const owner = ensureSigner().publicKey.toBase58();
      const rpcUrl = process.env.RPC_URL || process.env.RPC_URLS?.split(',')[0]?.trim() || cfg.rpcUrl;
      const currentQty = await resolveSellQtyAtoms({ rpcUrl, ownerPubkey: owner, mint }).catch(() => 0n);

      // If balance never arrives within timeout window, auto-cancel the position.
      if (currentQty === 0n) {
        const ageMs = now() - (pos.tsOpen || 0);
        if (ageMs >= BUY_SETTLE_TIMEOUT_MS) {
          const closed = closePosition(mint, {
            exitPriceUsd: p.priceUsd, // best info available
            reason: 'buy_failed_no_balance',
            exitTx: null
          });
          stopWatcher(mint);
          resetBackoff(mint);
          await sendExitNotice({
            mint,
            entry: pos.entryPriceUsd,
            exit: closed.exitPriceUsd,
            pnlPct: null,
            reason: closed.reason,
            txid: null,
            mode: pos.mode
          }).catch(() => {});
          log.warn({ mint }, 'Auto-cancelled position: buy never settled into wallet');
          return;
        }
        // Not yet timed out, keep waiting
        const ms = nextBackoffMs(mint);
        sellCooldownUntil.set(mint, now() + ms);
        log.warn({ mint }, 'No tokens found to sell (awaiting balance to settle); backing off');
        return;
      }

      if (!shouldExit) return;
      if (exiting.has(mint)) return; // already trying to exit
      exiting.add(mint);

      // small internal retry loop for live sells
      let filled = null;
      let lastErr = null;
      for (let i = 0; i < 4; i++) {
        try {
          filled = await executeSell({ mint, qty: currentQty, sellAll: true });
          break;
        } catch (e) {
          lastErr = e;
          const msg = String(e?.message || '');
          const code = e?.code || '';
          if (msg.includes('429') || code === 'RATE_LIMIT' || msg.includes('no route')) {
            const ms = nextBackoffMs(mint);
            sellCooldownUntil.set(mint, now() + ms);
          }
          if (msg.includes('balance 0') || code === 'NO_BALANCE') {
            const ms = nextBackoffMs(mint);
            sellCooldownUntil.set(mint, now() + ms);
            log.warn({ mint }, 'Sell aborted: wallet balance 0 during exit; will recheck later');
            break;
          }
          const ms = 600 + i * 500;
          log.warn({ mint, try: i + 1, err: msg, sellAll: true, hasQtyAtoms: true }, 'exit sell failed, retrying');
          await sleep(ms);
        }
      }

      if (!filled) {
        exiting.delete(mint);
        const msg = lastErr?.message || 'unknown';
        const ms = nextBackoffMs(mint);
        sellCooldownUntil.set(mint, now() + ms);
        log.warn({ mint, err: msg }, 'exit sell permanently failed for now; will retry after cooldown');
        return;
      }

      // Success: reset backoff and close
      resetBackoff(mint);

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
      const msg = e?.message || 'unknown';
      const ms = nextBackoffMs(mint);
      sellCooldownUntil.set(mint, now() + ms);
      log.warn({ mint, err: msg }, 'watcher tick failed; backing off');
    }
  }, Math.max(500, cfg.pricePollMs));

  watchers.set(mint, iv);
}

export function stopWatcher(mint) {
  const iv = watchers.get(mint);
  if (iv) clearInterval(iv);
  watchers.delete(mint);
  exiting.delete(mint);
  sellCooldownUntil.delete(mint);
  sellBackoffLevel.delete(mint);
}
