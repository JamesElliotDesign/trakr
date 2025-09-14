// src/index.js
import express from 'express';
import pino from 'pino';
import { cfg } from './config.js';
import { getTopWallets } from './tracker.js';
import { upsertHeliusWebhook, verifyHeliusRequest } from './helius.js';
import { detectBuys } from './buyDetector.js';
import { getSpotPriceUsd } from './price.js';
import { sendSignal, sendTrackingSummary, sendEntryNotice } from './telegram.js';
import { preloadSeen, flushSeenSync, seenCache } from './storage.js';
import { hasOpenPosition, openPosition } from './positions.js';
import { executeBuy } from './executor.js';
import { startWatcher } from './watcher.js';

const log = pino({ transport: { target: 'pino-pretty' }});

async function bootstrap() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const trackedSet = new Set();
  let latestSelection = [];
  const buyingLocks = new Set(); // prevent double-buy racing on same mint

  app.get('/health', (_, res) => res.json({ ok: true }));

  app.post('/helius-webhook', async (req, res) => {
    try {
      if (!verifyHeliusRequest(req)) return res.status(401).send('bad sig');

      const events = Array.isArray(req.body) ? req.body : [req.body];
      for (const enhancedTx of events) {
        const buys = detectBuys(enhancedTx, trackedSet, seenCache);
        for (const b of buys) {
          // 1) Send raw signal as before
          const p = await getSpotPriceUsd(b.mint, { amount: b.amount, solSpent: b.solSpent ?? undefined });
          await sendSignal({
            wallet: b.wallet,
            mint: b.mint,
            amount: b.amount,
            priceUsd: p?.priceUsd ?? null,
            provider: p?.source ?? null,
            sourceTx: b.signature
          });

          // 2) QUALIFY & FOLLOW: buy once per token
          if (hasOpenPosition(b.mint)) {
            log.debug({ mint: b.mint }, 'Position already open — skip buy');
            continue;
          }
          if (buyingLocks.has(b.mint)) {
            log.debug({ mint: b.mint }, 'Buy in-flight — skip duplicate');
            continue;
          }

          buyingLocks.add(b.mint);
          (async () => {
            try {
              const fill = await executeBuy({ mint: b.mint });
              openPosition({
                mint: b.mint,
                wallet: b.wallet,            // originating signal wallet for reference
                entryPriceUsd: fill.entryPriceUsd,
                qty: fill.qty,
                solSpent: fill.solSpent ?? null,
                sourceTx: b.signature,
                mode: fill.mode
              });
              await sendEntryNotice({
                mint: b.mint,
                entryPriceUsd: fill.entryPriceUsd,
                qty: fill.qty,
                solSpent: fill.solSpent ?? null,
                mode: fill.mode,
                txid: fill.txid || null
              });

              startWatcher(b.mint);
              log.info({ mint: b.mint, entry: fill.entryPriceUsd, qty: fill.qty }, 'Opened position & started watcher');
            } catch (e) {
              log.warn({ mint: b.mint, err: e?.message }, 'executeBuy failed');
            } finally {
              buyingLocks.delete(b.mint);
            }
          })();
        }
      }

      res.json({ ok: true });
    } catch (e) {
      log.error(e, 'webhook error');
      res.status(500).json({ ok: false });
    }
  });

  // Admin: manually refresh wallets (force) and push TG summary
  app.post('/admin/refresh-wallets', async (_req, res) => {
    await refreshTracked(true);
    res.json({ ok: true, tracked: latestSelection.map(x => x.address) });
  });

  async function refreshTracked(sendTg = false) {
    try {
      const selection = await getTopWallets(); // [{address, winRatePercent, lastActiveMsAgo}]
      latestSelection = selection;

      trackedSet.clear();
      const addresses = selection.map(s => s.address);
      addresses.forEach(w => trackedSet.add(w));
      log.info({ count: trackedSet.size }, 'Tracking wallets');

      if (addresses.length === 0) {
        if (sendTg) await sendTrackingSummary([]);
        log.warn('No active wallets found within window; skipping Helius upsert');
        return;
      }

      const id = await upsertHeliusWebhook(addresses);
      log.info({ webhookId: id }, 'Helius webhook upserted');

      if (sendTg) await sendTrackingSummary(selection);
    } catch (err) {
      log.error({ err }, 'Initial refresh failed');
    }
  }

  function shutdown() {
    try { flushSeenSync(); } catch {}
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await preloadSeen();
  app.listen(cfg.port, async () => {
    log.info(`Signals service listening on :${cfg.port}`);
    await refreshTracked(true);
    setInterval(async () => {
      try { await refreshTracked(false); } catch {}
    }, 60 * 60 * 1000);
  });
}

bootstrap().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
