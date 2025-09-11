import express from 'express';
import pino from 'pino';
import { cfg } from './config.js';
import { getTopWallets } from './tracker.js';
import { upsertHeliusWebhook, verifyHeliusRequest } from './helius.js';
import { detectBuys } from './buyDetector.js';
import { getSpotPriceUsd } from './price.js';
import { sendSignal, sendTrackingSummary } from './telegram.js';
import { preloadSeen, flushSeenSync, seenCache } from './storage.js';

const log = pino({ transport: { target: 'pino-pretty' }});

async function bootstrap() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const trackedSet = new Set();
  let latestSelection = [];

  app.get('/health', (_, res) => res.json({ ok: true }));

  app.post('/helius-webhook', async (req, res) => {
    try {
      if (!verifyHeliusRequest(req)) return res.status(401).send('bad sig');
      const events = Array.isArray(req.body) ? req.body : [req.body];
      for (const enhancedTx of events) {
        const buys = detectBuys(enhancedTx, trackedSet, seenCache);
        for (const b of buys) {
          const p = await getSpotPriceUsd(b.mint);
          await sendSignal({
            wallet: b.wallet,
            mint: b.mint,
            amount: b.amount,
            priceUsd: p?.priceUsd ?? null,
            provider: p?.source ?? null,
            sourceTx: b.signature
          });
          log.info({ ...b, price: p?.priceUsd ?? null }, 'Signal sent');
        }
      }
      res.json({ ok: true });
    } catch (e) {
      log.error(e, 'webhook error');
      res.status(500).json({ ok: false });
    }
  });

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
        if (sendTg) {
          await sendTrackingSummary([]); // will show 0 tracked
        }
        log.warn('No active wallets found within window; skipping Helius upsert');
        return;
      }

      const id = await upsertHeliusWebhook(addresses);
      log.info({ webhookId: id }, 'Helius webhook upserted');

      if (sendTg) {
        await sendTrackingSummary(selection);
      }
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
  console.error(err);
  process.exit(1);
});
