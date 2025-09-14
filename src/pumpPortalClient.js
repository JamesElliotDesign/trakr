// src/pumpPortalClient.js
// PumpPortal "Local Transaction API" (trade-local) integration.
// We only use this as a BUY fallback when Jupiter has no route.
// Docs: https://pumpportal.fun/local-trading-api/trading-api/
//
// It returns a serialized v0 transaction (binary), which we sign and broadcast
// via your own RPC(s). No API key required for trade-local.

import fetch from 'node-fetch';
import { VersionedTransaction } from '@solana/web3.js';
import { ensureSigner } from './keypair.js';
import { broadcastAndConfirm } from './txSender.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Env knobs (with safe defaults)
const TRADE_LOCAL_URL = process.env.PUMP_TRADE_URL?.trim() || 'https://pumpportal.fun/api/trade-local';
const DEFAULT_SLIPPAGE_BPS = Number(process.env.PUMP_SLIPPAGE_BPS || '200'); // 2%
const DEFAULT_PRIORITY_FEE_SOL = Number(process.env.PUMP_PRIORITY_FEE_SOL || '0.00001'); // 0.00001 SOL
const DEFAULT_POOL = process.env.PUMP_POOL?.trim() || 'auto';

/**
 * Buy via PumpPortal "trade-local".
 * @param {object} args
 * @param {string} args.outputMint - token CA to buy
 * @param {bigint} args.amountLamports - SOL amount in lamports (exact-in)
 * @param {number} [args.slippageBps] - bps (we convert to percent for Pump)
 * @param {number} [args.priorityFeeSol] - SOL amount to use as priority fee
 * @param {string} [args.pool] - 'pump' | 'raydium' | 'pump-amm' | 'launchlab' | 'raydium-cpmm' | 'bonk' | 'auto'
 */
export async function buyViaPumpTradeLocal({
  outputMint,
  amountLamports,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  priorityFeeSol = DEFAULT_PRIORITY_FEE_SOL,
  pool = DEFAULT_POOL
}) {
  const user = ensureSigner();

  // Pump expects: amount in SOL (float), slippage in PERCENT, denominatedInSol: "true"
  const amountSol = Number(amountLamports) / 1_000_000_000;
  const slippagePercent = slippageBps / 100;

  const body = {
    publicKey: user.publicKey.toBase58(),
    action: 'buy',
    mint: outputMint,
    amount: amountSol,                 // SOL amount as number
    denominatedInSol: 'true',          // <-- critical
    slippage: slippagePercent,         // percent
    priorityFee: priorityFeeSol,       // SOL amount
    pool                                    // default 'auto'
  };

  const res = await fetch(TRADE_LOCAL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`pump trade-local failed: ${res.status} ${t || res.statusText}`);
  }

  // trade-local returns raw serialized tx bytes (NOT base64)
  const buf = Buffer.from(await res.arrayBuffer());
  const tx = VersionedTransaction.deserialize(new Uint8Array(buf));
  tx.sign([user]);

  const sig = await broadcastAndConfirm(tx.serialize());
  return { signature: sig, routeSummary: { strategy: 'pump-trade-local' } };
}
