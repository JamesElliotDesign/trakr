// src/helius.js
import fetch from 'node-fetch';
import { cfg } from './config.js';
import pino from 'pino';

const log = pino({ transport: { target: 'pino-pretty' }});
const HELIUS_BASE = 'https://api.helius.xyz';

function normalizeWebhookUrl() {
  // Prefer explicit WEBHOOK_PUBLIC_URL
  let url = (cfg.webhookPublicUrl || '').trim();

  // If missing, try to construct from Railway envs
  // RAILWAY_PUBLIC_DOMAIN usually looks like "<app>.up.railway.app"
  const domain =
    process.env.WEB_URL || // some templates set this
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    process.env.RAILWAY_STATIC_URL || // older env
    null;

  if (!url && domain) {
    const base = domain.startsWith('http') ? domain : `https://${domain}`;
    url = `${base.replace(/\/+$/, '')}/helius-webhook`;
  }

  if (!url) {
    throw new Error(
      'WEBHOOK_PUBLIC_URL is not set and could not be derived from Railway. ' +
      'Set WEBHOOK_PUBLIC_URL to your public HTTPS endpoint, e.g. ' +
      'https://<your-app>.up.railway.app/helius-webhook'
    );
  }

  // Ensure protocol and strip trailing slashes (keep path)
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  // If they provided base without path, append /helius-webhook
  const u = new URL(url);
  if (!u.pathname || u.pathname === '/' || u.pathname === '') {
    u.pathname = '/helius-webhook';
  }
  return u.toString();
}

export async function upsertHeliusWebhook(wallets) {
  if (!cfg.heliusApiKey) throw new Error('HELIUS_API_KEY missing');
  if (!Array.isArray(wallets) || wallets.length === 0) {
    throw new Error('No wallets provided to upsertHeliusWebhook');
  }

  const webhookURL = normalizeWebhookUrl();

  const body = {
    webhookURL,
    accountAddresses: wallets,
    transactionTypes: ['ANY'],
    webhookType: 'enhanced',
    authHeader: '', // optional: set a shared secret and verify in your route
    txnStatus: 'finalized'
  };

  if (cfg.heliusWebhookId) {
    const res = await fetch(
      `${HELIUS_BASE}/v0/webhooks/${cfg.heliusWebhookId}?api-key=${cfg.heliusApiKey}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Helius update failed: ${res.status} ${JSON.stringify(data)}`);
    }
    log.info({ id: cfg.heliusWebhookId, webhookURL }, 'Updated Helius webhook');
    return cfg.heliusWebhookId;
  } else {
    const res = await fetch(
      `${HELIUS_BASE}/v0/webhooks?api-key=${cfg.heliusApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Helius create failed: ${res.status} ${JSON.stringify(data)}`);
    }
    log.info({ id: data.webhookID, webhookURL }, 'Created Helius webhook');
    return data.webhookID;
  }
}

export function verifyHeliusRequest(/* req */) {
  // If you set body.authHeader above (e.g., 'X-HEL-SECRET: ...'), verify here.
  return true;
}
