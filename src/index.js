// src/index.js
import express from 'express';
import pino from 'pino';
import { cfg } from './config.js';
import { getTopWallets } from './tracker.js';
import { upsertHeliusWebhook, verifyHeliusRequest } from './helius.js';
import { detectBuys } from './buyDetector.js';
import { getSpotPriceUsd } from './price.js';
import { sendSignal } from './telegram.js';
import { preloadSeen, seenCache } from './storage.js';

const log = pino({ transport: { target: 'pino-pretty' }});

async function bootstrap() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // In-memory set of tracked wallets (hydrated by refreshTracked)
  const trackedSet = new Set();

  // Health endpoint for Railway
  app.get('/health', (_req, res) => res.json({ ok: true }));

  /**
   * Helius Enhanced Transaction Webhook receiver.
   * Configure Helius to POST to:
   *   https://<your-app>.up.railway.app/helius-webhook
   */
  app.post('/helius-webhook', async (req, res) => {
    try {
      if (!verifyHeliusRequest(req)) return res.status(401).send('unauthorized');

      const events = Array.isArray(req.body) ? req.body : [req.body];

      for (const enhancedTx of events) {
        const buys = detectBuys(enhancedTx, trackedSet, seenCache);
        for (const b of buys) {
          const price = await getSpotPriceUsd(b.mint);
          await sendSignal({
            wallet: b.wallet,
            mint: b.mint,
            amount: b.amount,
            priceUsd: price?.priceUsd ?? null,
            provider: price?.source ?? null,
            sourceTx: b.signature
          });
          log.info(
            { wallet: b.wallet, mint: b.mint, amount: b.amount, priceUsd: price?.priceUsd ?? null, sig: b.signature },
            'Signal sent'
          );
        }
      }

      res.json({ ok: true });
    } catch (e) {
      log.error(e, 'Webhook processing error');
      res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  /**
   * Admin: force refresh of tracked wallets + Helius webhook upsert.
   * Use sparingly; the service also refreshes hourly automatically.
   */
  app.post('/admin/refresh-wallets', async (_req, res) => {
    try {
      const list = await refreshTracked(trackedSet);
      res.json({ ok: true, tracked: list });
    } catch (e) {
      log.error(e, 'Manual refresh failed');
      res.status(500).json({ ok: false, error: 'refresh_failed' });
    }
  });

  // ---- Boot sequence ----

  // 1) Preload dedupe cache from Redis if available
  await preloadSeen();
  log.info('Seen cache preloaded');

  // 2) Start HTTP server
  app.listen(cfg.port, async () => {
    log.info(`Signals service listening on :${cfg.port}`);

    // 3) Initial wallet fetch + Helius webhook upsert
    try {
      const list = await refreshTracked(trackedSet);
      log.info({ count: list.length }, 'Initial wallets tracked');
    } catch (e) {
      log.error(e, 'Initial wallet refresh failed');
    }

    // 4) Periodic refresh (hourly)
    setInterval(async () => {
      try {
        const list = await refreshTracked(trackedSet);
        log.info({ count: list.length }, 'Hourly wallet refresh complete');
      } catch (e) {
        log.error(e, 'Hourly wallet refresh failed');
      }
    }, 60 * 60 * 1000);
  });
}

/**
 * Fetch + filter wallets and upsert the Helius webhook to point at Railway.
 * Returns the array of tracked wallet addresses.
 */
async function refreshTracked(trackedSet) {
  const wallets = await getTopWallets(); // adapter decides the source
  trackedSet.clear();
  wallets.forEach((w) => trackedSet.add(w));

  const tracked = [...trackedSet];
  if (tracked.length) {
    const id = await upsertHeliusWebhook(tracked);
    log.info({ heliusWebhookId: id, target: cfg.webhookPublicUrl }, 'Helius webhook upserted');
  } else {
    log.warn('No wallets to track; Helius webhook not updated');
  }
  return tracked;
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
