import fetch from 'node-fetch';
import { cfg } from './config.js';
import pino from 'pino';
const log = pino({ transport: { target: 'pino-pretty' }});

const HELIUS_BASE = 'https://api.helius.xyz';

export async function upsertHeliusWebhook(wallets) {
  if (!cfg.heliusApiKey) throw new Error('HELIUS_API_KEY missing');
  if (!cfg.webhookPublicUrl) throw new Error('WEBHOOK_PUBLIC_URL missing');

  const body = {
    webhookURL: cfg.webhookPublicUrl,   // in dev we point to webhook.site
    accountAddresses: wallets,          // <= 10 tracked wallets
    transactionTypes: ["ANY"],          // let us filter in code
    webhookType: "enhanced",            // get parsed tokenTransfers/events
    authHeader: "",                     // optional: for your own verification
    txnStatus: "finalized"
  };

  if (cfg.heliusWebhookId) {
    // Update existing webhook
    const res = await fetch(`${HELIUS_BASE}/v0/webhooks/${cfg.heliusWebhookId}?api-key=${cfg.heliusApiKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Helius update failed: ${res.status} ${JSON.stringify(data)}`);
    log.info({ id: cfg.heliusWebhookId }, 'Updated Helius webhook');
    return cfg.heliusWebhookId;
  } else {
    // Create new webhook
    const res = await fetch(`${HELIUS_BASE}/v0/webhooks?api-key=${cfg.heliusApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Helius create failed: ${res.status} ${JSON.stringify(data)}`);
    log.info({ id: data.webhookID }, 'Created Helius webhook');
    return data.webhookID;
  }
}

/**
 * You can add signature verification here if you set authHeader
 * or maintain an allowlist of Helius IPs if needed.
 */
export function verifyHeliusRequest(/* req */) {
  return true;
}
