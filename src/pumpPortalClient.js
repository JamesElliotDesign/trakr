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
  const endpoint = endpointUsed || cfg.rpcUrl;
  const conn = new Connection(endpoint, 'confirmed');

  // Retry helper: try a few times at 'confirmed', then a few at 'finalized'
  async function getTxWithMeta(sig) {
    const tries = [
      { commitment: 'confirmed', attempts: 4, backoffMs: 200 },
      { commitment: 'finalized', attempts: 4, backoffMs: 300 }
    ];
    for (const tier of tries) {
      for (let i = 0; i < tier.attempts; i++) {
        const info = await conn.getTransaction(sig, {
          commitment: tier.commitment,
          maxSupportedTransactionVersion: 0
        }).catch(() => null);
        if (info?.meta?.postTokenBalances?.length) return info;
        await new Promise(r => setTimeout(r, tier.backoffMs * (i + 1)));
      }
    }
    return null;
  }

  // Fallback: poll wallet balance for the mint on the SAME RPC
  async function pollWalletBalanceForMint({ ownerPk, mintPk }) {
    const owner = new PublicKey(ownerPk);
    const mint  = new PublicKey(mintPk);

    const tiers = [
      { attempts: 6, backoffMs: 250 },  // ~5.25s max
      { attempts: 4, backoffMs: 400 }   // +2.4s
    ];

    for (const t of tiers) {
      for (let i = 0; i < t.attempts; i++) {
        const resp = await conn.getParsedTokenAccountsByOwner(owner, { mint }).catch(() => null);
        const rows = resp?.value || [];
        // pick largest balance (in case of multiple ATAs)
        let best = null;
        for (const it of rows) {
          const ui = it.account.data?.parsed?.info?.tokenAmount;
          if (!ui) continue;
          const amt = ui.amount ? BigInt(ui.amount) : 0n;
          const dec = Number(ui.decimals ?? 9);
          if (!best || amt > best.amt) best = { amt, dec };
        }
        if (best && best.amt > 0n) return best; // { amt: bigint, dec: number }
        await new Promise(r => setTimeout(r, t.backoffMs * (i + 1)));
      }
    }
    return null;
  }

  const txInfo = await getTxWithMeta(signature);

  let qtyAtoms = 0n;
  let decimals = 9;

  // 1) First choice: parse from tx meta (most precise)
  if (txInfo?.meta) {
    const owner = user.publicKey.toBase58();
    const pre = txInfo.meta.preTokenBalances || [];
    const post = txInfo.meta.postTokenBalances || [];

    const postEntry = post.find(b => b.mint === outputMint && (b.owner === owner || b.uiTokenAmount?.owner === owner));
    const preEntry  = pre.find (b => b.mint === outputMint && (b.owner === owner || b.uiTokenAmount?.owner === owner));

    if (postEntry || preEntry) {
      decimals = Number(postEntry?.uiTokenAmount?.decimals ?? preEntry?.uiTokenAmount?.decimals ?? 9);
      const preAmtAtoms  = preEntry  ? BigInt(preEntry.uiTokenAmount.amount)  : 0n;
      const postAmtAtoms = postEntry ? BigInt(postEntry.uiTokenAmount.amount) : preAmtAtoms;
      qtyAtoms = postAmtAtoms > preAmtAtoms ? (postAmtAtoms - preAmtAtoms) : 0n;
    }
  }

  // 2) Fallback: if meta didn’t have balances yet, poll wallet balance now
  if (qtyAtoms === 0n) {
    const ownerPk = user.publicKey.toBase58();
    const fallback = await pollWalletBalanceForMint({ ownerPk, mintPk: outputMint });
    if (fallback) {
      qtyAtoms = fallback.amt;
      decimals = fallback.dec;
    }
  }

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
    qtyAtoms: qtyAtoms > 0n ? qtyAtoms : null,
    decimals,
    entryPriceUsd,
    routeSummary: { strategy: 'pump-trade-local', endpointUsed: endpoint }
  };
}

/**
 * Sell ALL tokens via Pump Portal (percentage-based).
 * Avoids local BigInt math at exit time and prevents "Cannot convert undefined to a BigInt".
 */
export async function sellAllViaPumpTradeLocal({
  outputMint,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  priorityFeeSol = DEFAULT_PRIORITY_FEE_SOL,
  pool = DEFAULT_POOL
}) {
  const user = ensureSigner();
  const slippagePercent = slippageBps / 100;

  const body = {
    publicKey: user.publicKey.toBase58(),
    action: 'sell',
    mint: outputMint,
    amount: '100%',             // sell everything
    denominatedInSol: 'false',  // amount is tokens/percentage, not SOL
    slippage: slippagePercent,  // %
    priorityFee: priorityFeeSol,
    pool
  };

  const res = await fetch(TRADE_LOCAL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`pump trade-local (sell) failed: ${res.status} ${t || res.statusText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const tx = VersionedTransaction.deserialize(new Uint8Array(buf));
  tx.sign([user]);

  const { signature, endpointUsed } = await broadcastAndConfirmWithEndpoint(tx.serialize());

  return {
    signature,
    routeSummary: { strategy: 'pump-trade-local', endpointUsed: endpointUsed || null }
  };
}
