// src/helius.js
import fetch from 'node-fetch';
import { cfg } from './config.js';
import pino from 'pino';

const log = pino({ transport: { target: 'pino-pretty' }});
const HELIUS_BASE = 'https://api.helius.xyz';

function normalizeWebhookUrl() {
  let url = (cfg.webhookPublicUrl || '').trim();

  // Try to derive from Railway if not provided
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
      'Set WEBHOOK_PUBLIC_URL to your HTTPS endpoint, e.g. ' +
      'https://<app>.up.railway.app/helius-webhook'
    );
  }

  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const u = new URL(url);
  if (!u.pathname || u.pathname === '/' || u.pathname === '') {
    u.pathname = '/helius-webhook';
  }
  return u.toString();
}

function buildWebhookBody(webhookURL, wallets) {
  return {
    webhookURL,
    accountAddresses: wallets,          // all tracked wallets in one webhook
    transactionTypes: ['ANY'],
    webhookType: 'enhanced',
    authHeader: '',                     // optional shared secret; verify in your route if you set one
    // encoding: 'json',                // optional; omit unless you need base64
    txnStatus: 'finalized'              // finalized events only
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
    const e = new Error(`Helius create failed: ${res.status} ${JSON.stringify(data)}`);
    e._heliusData = data;
    e._heliusText = (data && (data.error || data.message)) || '';
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

function chooseWebhookToReuse(existing, webhookURL) {
  if (!existing.length) return null;

  // Prefer exact URL match
  const byUrl = existing.find(w => (w.webhookURL || '').trim() === webhookURL);
  if (byUrl) return byUrl;

  // Prefer any enhanced webhook
  const enhanced = existing.filter(
    w => (w.webhookType || '').toLowerCase() === 'enhanced'
  );
  if (enhanced.length) {
    enhanced.sort((a, b) => {
      const at = Number(new Date(a.updatedAt || a.createdAt || 0));
      const bt = Number(new Date(b.updatedAt || b.createdAt || 0));
      return at - bt; // oldest first
    });
    return enhanced[0];
  }

  // Fallback: oldest overall
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
  const body = buildWebhookBody(webhookURL, wallets);

  // If you already saved a webhook ID, just update that one
  if (cfg.heliusWebhookId) {
    await updateWebhook(cfg.heliusWebhookId, body);
    log.info({ id: cfg.heliusWebhookId, webhookURL, wallets: wallets.length }, 'Updated Helius webhook');
    return cfg.heliusWebhookId;
  }

  // Try to create
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

    // Reached limit — list & reuse/update one
    const existing = await listWebhooks();
    const reuse = chooseWebhookToReuse(existing, webhookURL);

    if (reuse) {
      const reuseId = reuse.webhookID || reuse.id;
      await updateWebhook(reuseId, body);
      log.info({ id: reuseId, webhookURL, wallets: wallets.length }, 'Reused & updated existing Helius webhook');
      return reuseId;
    }

    // No candidate to reuse — delete the oldest and create fresh
    if (existing.length) {
      const oldest = existing.sort((a, b) => {
        const at = Number(new Date(a.updatedAt || a.createdAt || 0));
        const bt = Number(new Date(b.updatedAt || b.createdAt || 0));
        return at - bt;
      })[0];
      const oldestId = oldest.webhookID || oldest.id;
      log.warn({ id: oldestId }, 'Deleting oldest webhook to free a slot');
      await deleteWebhook(oldestId);

      const created2 = await createWebhook(body);
      const id2 = created2.webhookID || created2.id;
      log.info({ id: id2, webhookURL, wallets: wallets.length }, 'Created Helius webhook (after delete)');
      return id2;
    }

    throw new Error('Reached webhook limit, and no existing webhooks found to reuse or delete.');
  }
}

export function verifyHeliusRequest(/* req */) {
  // If you set authHeader in buildWebhookBody, verify it here against req.headers
  return true;
}
