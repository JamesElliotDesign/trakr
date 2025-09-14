// src/keypair.js
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { cfg } from './config.js';

let CACHED = null;

/**
 * Accepts base58 string or JSON array via cfg.traderPrivateKey.
 * Returns a Keypair, memoized.
 */
export function ensureSigner() {
  if (CACHED) return CACHED;
  const raw = cfg.traderPrivateKey;
  if (!raw) throw new Error('TRADER_PRIVATE_KEY is not set');

  let secret;
  if (raw.trim().startsWith('[')) {
    const arr = JSON.parse(raw);
    secret = Uint8Array.from(arr);
  } else if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(raw.trim())) {
    secret = bs58.decode(raw.trim());
  } else {
    throw new Error('TRADER_PRIVATE_KEY must be base58 or JSON array');
  }
  CACHED = Keypair.fromSecretKey(secret);
  return CACHED;
}
