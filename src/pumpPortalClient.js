// src/pumpPortalClient.js
import fetch from 'node-fetch';
import { VersionedTransaction, Connection, PublicKey } from '@solana/web3.js';
import { ensureSigner } from './keypair.js';
import { broadcastAndConfirm } from './txSender.js';
import { cfg } from './config.js';
import { getSpotPriceUsd } from './price.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const TRADE_LOCAL_URL = (process.env.PUMP_TRADE_URL || 'https://pumpportal.fun/api/trade-local').trim();
const DEFAULT_SLIPPAGE_BPS = Number(process.env.PUMP_SLIPPAGE_BPS || '200'); // 2%
const DEFAULT_PRIORITY_FEE_SOL = Number(process.env.PUMP_PRIORITY_FEE_SOL || '0.00001');
const DEFAULT_POOL = (process.env.PUMP_POOL || 'auto').trim();

/**
 * Buy via PumpPortal "trade-local" and derive fills from tx meta.
 * Returns { signature, qtyAtoms, decimals, entryPriceUsd, routeSummary }
 */
export async function buyViaPumpTradeLocal({
  outputMint,
  amountLamports,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  priorityFeeSol = DEFAULT_PRIORITY_FEE_SOL,
  pool = DEFAULT_POOL
}) {
  const user = ensureSigner();

  // trade-local expects SOL amount (float) + slippage in percent
  const amountSol = Number(amountLamports) / 1_000_000_000;
  const slippagePercent = slippageBps / 100;

  const body = {
    publicKey: user.publicKey.toBase58(),
    action: 'buy',
    mint: outputMint,
    amount: amountSol,            // SOL amount
    denominatedInSol: 'true',
    slippage: slippagePercent,    // %
    priorityFee: priorityFeeSol,  // SOL
    pool
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

  // trade-local returns raw serialized bytes (not base64)
  const buf = Buffer.from(await res.arrayBuffer());
  const tx = VersionedTransaction.deserialize(new Uint8Array(buf));
  tx.sign([user]);

  // send + confirm (race via your multi-RPC)
  const signature = await broadcastAndConfirm(tx.serialize());

  // ------- derive qty & entry price from on-chain meta -------
  const conn = new Connection(cfg.rpcUrl, 'confirmed');

  // Fetch the confirmed transaction with meta (v0 supported)
  const txInfo = await conn.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0
  });

  // Fallbacks in case RPC returns null momentarily
  if (!txInfo || !txInfo.meta) {
    return {
      signature,
      qtyAtoms: null,
      decimals: null,
      entryPriceUsd: null,
      routeSummary: { strategy: 'pump-trade-local' }
    };
  }

  const ownerBase58 = user.publicKey.toBase58();
  const pre = txInfo.meta.preTokenBalances || [];
  const post = txInfo.meta.postTokenBalances || [];

  // Find balances for our owner & the bought mint
  const postEntry = post.find(
    b => b.mint === outputMint && (b.owner === ownerBase58 || b.uiTokenAmount?.owner === ownerBase58)
  );
  const preEntry = pre.find(
    b => b.mint === outputMint && (b.owner === ownerBase58 || b.uiTokenAmount?.owner === ownerBase58)
  );

  // decimals: trust post, else pre, else query mint (rare)
  let decimals =
    Number(postEntry?.uiTokenAmount?.decimals ??
    preEntry?.uiTokenAmount?.decimals ??
    NaN);

  if (!Number.isFinite(decimals)) {
    const mintInfo = await conn.getParsedAccountInfo(new PublicKey(outputMint));
    decimals = mintInfo?.value?.data?.parsed?.info?.decimals ?? 9; // default 9 if truly unavailable
  }

  const preAmtAtoms = preEntry ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
  const postAmtAtoms = postEntry ? BigInt(postEntry.uiTokenAmount.amount) : preAmtAtoms;

  const qtyAtoms = postAmtAtoms > preAmtAtoms ? (postAmtAtoms - preAmtAtoms) : 0n;

  // Entry price in USD:
  // We know exact-in SOL we sent (amountSol). So entry USD = (SOL_USD * amountSol) / tokensReceived
  let entryPriceUsd = null;
  if (qtyAtoms > 0n) {
    const solUsd = (await getSpotPriceUsd(SOL_MINT))?.priceUsd;
    if (typeof solUsd === 'number' && Number.isFinite(solUsd)) {
      const qtyTokens = Number(qtyAtoms) / 10 ** decimals;
      entryPriceUsd = (solUsd * amountSol) / qtyTokens;
    }
  }

  return {
    signature,
    qtyAtoms,
    decimals,
    entryPriceUsd,
    routeSummary: { strategy: 'pump-trade-local' }
  };
}
