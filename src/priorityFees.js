// src/priorityFees.js
import { Connection } from '@solana/web3.js';
import { cfg } from './config.js';

const DEFAULT_MICROLAMPORTS = 5_000; // sane low fallback

export async function estimatePriorityFeeMicroLamports(rpcUrl = cfg.rpcUrl) {
  try {
    const conn = new Connection(rpcUrl, 'confirmed');
    // Not every RPC supports this; wrap in try/catch.
    // @ts-ignore
    const arr = await conn.getRecentPrioritizationFees();
    if (Array.isArray(arr) && arr.length) {
      const vals = arr.map(x => Number(x?.prioritizationFee)).filter(Number.isFinite);
      if (vals.length) {
        vals.sort((a,b)=>a-b);
        const idx = Math.floor(0.75 * (vals.length - 1));
        const p75 = vals[idx];
        return Math.max(1, p75);
      }
    }
  } catch {}
  return DEFAULT_MICROLAMPORTS;
}
