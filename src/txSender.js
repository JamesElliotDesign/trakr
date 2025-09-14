// src/txSender.js
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { cfg } from './config.js';
import pino from 'pino';

const log = pino({ transport: { target: 'pino-pretty' }});

function unique(arr) { return Array.from(new Set(arr)); }
function isHttpRpc(u) { return /^https?:\/\//i.test(u); }

function pickRpcs() {
  // Prefer RPC_URLS (comma-separated). Fall back to RPC_URL, else cfg.rpcUrl.
  const raw = process.env.RPC_URLS || process.env.RPC_URL || cfg.rpcUrl || '';
  const list = unique(
    raw.split(',').map(s => s.trim()).filter(Boolean)
  ).filter(isHttpRpc);

  if (!list.length) {
    throw new Error('No valid HTTP RPC endpoints. Set RPC_URLS or RPC_URL (http/https).');
  }
  return list;
}

/** Legacy helper: returns only the signature for existing callers. */
export async function broadcastAndConfirm(txBytes, { maxWaitMs = 12_000 } = {}) {
  const { signature } = await broadcastAndConfirmWithEndpoint(txBytes, { maxWaitMs });
  return signature;
}

/** New helper: returns { signature, endpointUsed } so callers can reuse the same RPC. */
export async function broadcastAndConfirmWithEndpoint(txBytes, { maxWaitMs = 12_000 } = {}) {
  const rpcs = pickRpcs();
  const conns = rpcs.map(u => new Connection(u, 'confirmed'));
  const tx = VersionedTransaction.deserialize(txBytes);

  const sendOne = async (c) => {
    const bh = await c.getLatestBlockhash().catch(() => null);
    const sig = await c.sendRawTransaction(tx.serialize(), {
      maxRetries: 3,
      skipPreflight: true
    });
    if (bh) {
      await c.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    } else {
      await c.confirmTransaction(sig, 'confirmed');
    }
    return { signature: sig, endpointUsed: c.rpcEndpoint };
  };

  const promises = conns.map(c => sendOne(c));
  try {
    const winner = await Promise.any(promises);
    return winner;
  } catch (e) {
    log.error({ err: e?.message }, 'All RPC sends failed');
    throw e?.errors?.[0] || e;
  }
}
