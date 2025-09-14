// src/txSender.js
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { cfg } from './config.js';
import pino from 'pino';

const log = pino({ transport: { target: 'pino-pretty' }});

function unique(arr) { return Array.from(new Set(arr)); }

function pickRpcs() {
  // Allow multiple RPCs separated by commas in RPC_URL; otherwise reuse cfg.rpcUrl
  const env = process.env.RPC_URLS || process.env.RPC_URL || cfg.rpcUrl;
  if (!env) throw new Error('RPC_URL(S) missing');
  return unique(env.split(',').map(s => s.trim()).filter(Boolean));
}

export async function broadcastAndConfirm(txBytes, { maxWaitMs = 12_000 } = {}) {
  const rpcs = pickRpcs();
  const conns = rpcs.map(u => new Connection(u, 'confirmed'));

  const tx = VersionedTransaction.deserialize(txBytes);

  const sendPromises = conns.map(async (c) => {
    try {
      const sig = await c.sendRawTransaction(tx.serialize(), {
        maxRetries: 3,
        skipPreflight: true
      });
      // Race on confirmation (any wins)
      await c.confirmTransaction({ signature: sig, ...(await c.getLatestBlockhash()) }, 'confirmed');
      return sig;
    } catch (e) {
      log.debug({ rpc: c.rpcEndpoint, err: e?.message }, 'sendRawTransaction failed');
      throw e;
    }
  });

  let first;
  try {
    first = await Promise.any(sendPromises);
  } catch (e) {
    // If they all failed, surface one
    throw e?.errors?.[0] || e;
  }
  return first;
}
