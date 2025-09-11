// src/index.js
import express from 'express';
import pino from 'pino';

import { cfg } from './config.js';
import { getTopWallets } from './tracker.js';
import { upsertHeliusWebhook, verifyHeliusRequest } from './helius.js';
import { detectBuys } from './buyDetector.js';
import { getSpotPriceUsd } from './price.js';
import { sendSignal } from './telegram.js';
import { seenCache, preloadSeen, flushSeenSync } from './storage.js';

const log = pino({ transport: { target: 'pino-pretty' }});

async function bootstrap() {
  // Hydrate JSON-backed dedupe cache before handling any webhooks
  await preloadSeen();

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // In-memory set of currently tracked wallets
  const trackedSet = new Set();

  app.get('/health', (_req, res) => res.json({ ok: true }));

  /**
   * Helius Enhanced Transaction webhook receiver.
   * Configure Helius to POST to: ${WEBHOOK_PUBLIC_URL}/helius-webhook
   */
  app.post('/helius-webhook', async (req, res) => {
    try {
      if (!verifyHeliusRequest(req)) {
        return res.status(401).send('unauthorized');
      }

      const payload = Array.isArray(req.body) ? req.body : [req.body];

      for (const enhancedTx of payload) {
        const buys = detectBuys(enhancedTx, trackedSet, seenCache);
        for (const b of buys) {
          // Fetch spot price for the mint (GMGN preferred, fallback PumpPortal)
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
            { wallet: b.wallet, mint: b.mint, tx: b.signature, price: price?.priceUsd ?? null },
            'Signal sent'
          );
        }
      }

      return res.json({ ok: true });
    } catch (e) {
      log.error(e, 'Webhook handler error');
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  /**
   * Admin endpoint to refresh tracked wallets on demand.
   * Useful after tweaking MIN_WIN_RATE / TOP_WALLETS / TRACK_TOP_N.
   */
  app.post('/admin/refresh-wallets', async (_req, res) => {
    try {
      const tracked = await refreshTracked(trackedSet);
      return res.json({ ok: true, tracked: [...tracked] });
    } catch (e) {
      log.error(e, 'Failed to refresh wallets');
      return res.status(500).json({ ok: false });
    }
  });

  // Start server
  const server = app.listen(cfg.port, async () => {
    log.info(`Signals service listening on :${cfg.port}`);
    try {
      await refreshTracked(trackedSet);
    } catch (e) {
      log.error(e, 'Initial refresh failed');
    }
  });

  // Periodic refresh of tracked wallets (hourly)
  const refreshTimer = setInterval(async () => {
    try {
      await refreshTracked(trackedSet);
    } catch (e) {
      log.warn(e, 'Periodic refresh failed');
    }
  }, 60 * 60 * 1000);

  // Graceful shutdown
  function shutdown(label) {
    return () => {
      log.info({ signal: label }, 'Shutting down...');
      try { flushSeenSync(); } catch {}
      try { clearInterval(refreshTimer); } catch {}
      server.close(() => {
        process.exit(0);
      });
      // Force-exit if close hangs
      setTimeout(() => process.exit(0), 3000).unref();
    };
  }
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

/**
 * Fetch top wallets (via tracker adapter), filter + slice, and upsert Helius webhook.
 * Mutates the provided trackedSet.
 */
async function refreshTracked(trackedSet) {
  const wallets = await getTopWallets();
  trackedSet.clear();
  wallets.forEach(w => trackedSet.add(w));

  log.info({ count: trackedSet.size }, 'Tracking wallets');

  if (trackedSet.size > 0) {
    const webhookId = await upsertHeliusWebhook([...trackedSet]);
    log.info({ webhookId }, 'Helius webhook upserted');
  } else {
    log.warn('No wallets to track — webhook not updated');
  }

  return trackedSet;
}

bootstrap().catch(err => {
  // eslint-disable-next-line no-console
  console.error('Fatal boot error:', err);
  try { flushSeenSync(); } catch {}
  process.exit(1);
});
