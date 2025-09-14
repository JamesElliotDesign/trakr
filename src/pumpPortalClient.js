// src/pumpPortalClient.js
import fetch from 'node-fetch';
import { VersionedTransaction, Connection, PublicKey } from '@solana/web3.js';
import { ensureSigner } from './keypair.js';
import { broadcastAndConfirmWithEndpoint } from './txSender.js';
import { cfg } from './config.js';
import { getSpotPriceUsd } from './price.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const TRADE_LOCAL_URL = (process.env.PUMP_TRADE_URL || 'https://pumpportal.fun/api/trade-local').trim();
const DEFAULT_SLIPPAGE_BPS = Number(process.env.PUMP_SLIPPAGE_BPS || '200');      // 2%
const DEFAULT_PRIORITY_FEE_SOL = Number(process.env.PUMP_PRIORITY_FEE_SOL || '0.00001');
const DEFAULT_POOL = (process.env.PUMP_POOL || 'auto').trim();

export async function buyViaPumpTradeLocal({
  outputMint,
  amountLamports,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  priorityFeeSol = DEFAULT_PRIORITY_FEE_SOL,
  pool = DEFAULT_POOL
}) {
  const user = ensureSigner();

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

  // trade-local returns raw serialized bytes
  const buf = Buffer.from(await res.arrayBuffer());
  const tx = VersionedTransaction.deserialize(new Uint8Array(buf));
  tx.sign([user]);

  // Broadcast and learn which endpoint confirmed
  const { signature, endpointUsed } = await broadcastAndConfirmWithEndpoint(tx.serialize());

  // Use the same endpoint to fetch tx meta (avoids 401/invalid key mismatches)
  const conn = new Connection(endpointUsed || cfg.rpcUrl, 'confirmed');

  const txInfo = await conn.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0
  }).catch(() => null);

  if (!txInfo || !txInfo.meta) {
    return {
      signature,
      qtyAtoms: null,
      decimals: null,
      entryPriceUsd: null,
      routeSummary: { strategy: 'pump-trade-local', endpointUsed: endpointUsed || null }
    };
  }

  const owner = user.publicKey.toBase58();
  const pre = txInfo.meta.preTokenBalances || [];
  const post = txInfo.meta.postTokenBalances || [];

  const postEntry = post.find(b => b.mint === outputMint && (b.owner === owner || b.uiTokenAmount?.owner === owner));
  const preEntry  = pre.find (b => b.mint === outputMint && (b.owner === owner || b.uiTokenAmount?.owner === owner));

  let decimals =
    Number(postEntry?.uiTokenAmount?.decimals ??
           preEntry?.uiTokenAmount?.decimals ??
           NaN);

  if (!Number.isFinite(decimals)) {
    const mintInfo = await conn.getParsedAccountInfo(new PublicKey(outputMint)).catch(() => null);
    decimals = mintInfo?.value?.data?.parsed?.info?.decimals ?? 9;
  }

  const preAmtAtoms  = preEntry  ? BigInt(preEntry.uiTokenAmount.amount)  : 0n;
  const postAmtAtoms = postEntry ? BigInt(postEntry.uiTokenAmount.amount) : preAmtAtoms;
  const qtyAtoms = postAmtAtoms > preAmtAtoms ? (postAmtAtoms - preAmtAtoms) : 0n;

  let entryPriceUsd = null;
  if (qtyAtoms > 0n) {
    const solSpot = await getSpotPriceUsd(SOL_MINT).catch(() => null);
    const solUsd = solSpot?.priceUsd;
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
    routeSummary: { strategy: 'pump-trade-local', endpointUsed: endpointUsed || null }
  };
}
