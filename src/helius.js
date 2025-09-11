// src/helius.js
import fetch from 'node-fetch';
import { cfg } from './config.js';
import pino from 'pino';

const log = pino({ transport: { target: 'pino-pretty' }});
const HELIUS_BASE = 'https://api.helius.xyz';
const DEFAULT_NAME = 'solana-signals-bot';

function normalizeWebhookUrl() {
  let url = (cfg.webhookPublicUrl || '').trim();

  const domain =
    process.env.WEB_URL ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    process.env.RAILWAY_STATIC_URL ||
    null;

  if (!url && domain) {
    const base = domain.startsWith('http') ? domain : `https://${domain}`;
    url = `${base.replace(/\/+$/, '')}/helius-webhook`;
  }

  if (!url) {
    throw new Error(
      'WEBHOOK_PUBLIC_URL is not set and could not be derived. ' +
      'Set WEBHOOK_PUBLIC_URL to your public HTTPS endpoint, e.g. ' +
      'https://<your-app>.up.railway.app/helius-webhook'
    );
  }

  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const u = new URL(url);
  if (!u.pathname || u.pathname === '/' || u.pathname === '') {
    u.pathname = '/helius-webhook';
  }
  return u.toString();
}

function buildBody(webhookURL, wallets) {
  return {
    name: DEFAULT_NAME,
    webhookURL,
    accountAddresses: wallets,           // <-- ALL wallets in one webhook
    transactionTypes: ['ANY'],
    webhookType: 'enhanced',
    authHeader: '',                      // set a secret and verify if desired
    txnStatus: 'finalized'
  };
}

async function listWebhooks() {
  const res = await fetch(`${HELIUS_BASE}/v0/webhooks?api-key=${cfg.heliusApiKey}`);
  const data = await res.json().catch(() => []);
  if (!res.ok) {
    throw new Error(`Helius list failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return Array.isArray(data) ? data : [];
}

async function createWebhook(body) {
  const res = await fetch(`${HELIUS_BASE}/v0/webhooks?api-key=${cfg.heliusApiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = `Helius create failed: ${res.status} ${JSON.stringify(data)}`;
    const textErr = (data && (data.error || data.message)) || '';
    const e = new Error(msg);
    e._heliusData = data;
    e._heliusText = textErr;
    throw e;
  }
  return data;
}

async function updateWebhook(webhookId, body) {
  const res = await fetch(`${HELIUS_BASE}/v0/webhooks/${webhookId}?api-key=${cfg.heliusApiKey}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Helius update failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function deleteWebhook(webhookId) {
  const res = await fetch(`${HELIUS_BASE}/v0/webhooks/${webhookId}?api-key=${cfg.heliusApiKey}`, {
    method: 'DELETE'
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Helius delete failed: ${res.status} ${t || res.statusText}`);
  }
}

function pickReusableWebhook(existing, webhookURL) {
  if (!existing.length) return null;

  // 1) Prefer one that already points to our URL
  const byUrl = existing.find(w => (w.webhookURL || '').trim() === webhookURL);
  if (byUrl) return byUrl;

  // 2) Prefer one named like our bot
  const byName = existing.find(w => (w.name || '').toLowerCase() === DEFAULT_NAME);
  if (byName) return byName;

  // 3) Prefer an enhanced webhook (since we want enhanced)
  const enhanced = existing.filter(w => (w.webhookType || '').toLowerCase() === 'enhanced');
  if (enhanced.length) {
    // Oldest enhanced (by created or updated time if present)
    enhanced.sort((a, b) => {
      const at = Number(new Date(a.updatedAt || a.createdAt || 0));
      const bt = Number(new Date(b.updatedAt || b.createdAt || 0));
      return at - bt;
    });
    return enhanced[0];
  }

  // 4) Fall back to the oldest webhook overall
  const sorted = [...existing].sort((a, b) => {
    const at = Number(new Date(a.updatedAt || a.createdAt || 0));
    const bt = Number(new Date(b.updatedAt || b.createdAt || 0));
    return at - bt;
  });
  return sorted[0];
}

export async function upsertHeliusWebhook(wallets) {
  if (!cfg.heliusApiKey) throw new Error('HELIUS_API_KEY missing');
  if (!Array.isArray(wallets) || wallets.length === 0) {
    throw new Error('No wallets provided to upsertHeliusWebhook');
  }

  const webhookURL = normalizeWebhookUrl();
  const body = buildBody(webhookURL, wallets);

  // If user provided an explicit webhook ID — just update it
  if (cfg.heliusWebhookId) {
    await updateWebhook(cfg.heliusWebhookId, body);
    log.info({ id: cfg.heliusWebhookId, webhookURL, wallets: wallets.length }, 'Updated Helius webhook');
    return cfg.heliusWebhookId;
  }

  // Try create first
  try {
    const created = await createWebhook(body);
    const id = created.webhookID || created.id;
    log.info({ id, webhookURL, wallets: wallets.length }, 'Created Helius webhook');
    return id;
  } catch (e) {
    const limitHit =
      e._heliusText?.toLowerCase().includes('reached webhook limit') ||
      e.message?.toLowerCase().includes('reached webhook limit');

    if (!limitHit) throw e;

    // Limit hit — list existing and reuse one
    const existing = await listWebhooks();
    const reuse = pickReusableWebhook(existing, webhookURL);
    if (!reuse) {
      // Nothing to reuse; pick the oldest and delete, then create
      if (existing.length) {
        const oldest = existing.sort((a, b) => {
          const at = Number(new Date(a.updatedAt || a.createdAt || 0));
          const bt = Number(new Date(b.updatedAt || b.createdAt || 0));
          return at - bt;
        })[0];
        log.warn({ id: oldest.webhookID || oldest.id }, 'Deleting oldest webhook to free slot');
        await deleteWebhook(oldest.webhookID || oldest.id);
        const created2 = await createWebhook(body);
        const id2 = created2.webhookID || created2.id;
        log.info({ id: id2, webhookURL, wallets: wallets.length }, 'Created Helius webhook (after delete)');
        return id2;
      }
      // Should not happen, but bail safely
      throw new Error('Reached webhook limit, and no existing webhooks found to reuse.');
    }

    // Update the chosen webhook in-place
    const reuseId = reuse.webhookID || reuse.id;
    await updateWebhook(reuseId, body);
    log.info({ id: reuseId, webhookURL, wallets: wallets.length }, 'Reused & updated existing Helius webhook');
    return reuseId;
  }
}

export function verifyHeliusRequest(/* req */) {
  // If you set body.authHeader above (e.g., 'X-HEL-SECRET: ...'), verify here.
  return true;
}
