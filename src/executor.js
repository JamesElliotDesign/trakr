// src/executor.js
import pino from 'pino';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction
} from '@solana/web3.js';
import { cfg } from './config.js';
import { getSpotPriceUsd } from './price.js';

const log = pino({ transport: { target: 'pino-pretty' }});

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUP_SWAP  = 'https://quote-api.jup.ag/v6/swap';

let _conn = null;
let _kp = null;

/* ---------------------- shared helpers ---------------------- */

function getConn() {
  if (!_conn) _conn = new Connection(cfg.rpcUrl, { commitment: 'confirmed' });
  return _conn;
}

function parseKeypair() {
  if (_kp) return _kp;
  if (!cfg.traderPrivateKey) throw new Error('TRADER_PRIVATE_KEY missing');
  const s = cfg.traderPrivateKey.trim();
  try {
    if (s.startsWith('[')) {
      const arr = JSON.parse(s);
      _kp = Keypair.fromSecretKey(Uint8Array.from(arr));
    } else {
      const bytes = bs58.decode(s);
      _kp = Keypair.fromSecretKey(bytes);
    }
    return _kp;
  } catch (e) {
    throw new Error(`Invalid TRADER_PRIVATE_KEY: ${e.message}`);
  }
}

async function ensurePrice(mint, tries = 3, delayMs = 500) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const p = await getSpotPriceUsd(mint);
    if (Number.isFinite(p?.priceUsd) && p.priceUsd > 0) return p;
    last = p;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return last;
}

async function getTokenDecimals(mintStr) {
  const conn = getConn();
  const mint = new PublicKey(mintStr);
  const acc = await conn.getParsedAccountInfo(mint);
  const dec = acc?.value?.data?.parsed?.info?.decimals;
  if (!Number.isFinite(dec)) throw new Error('cannot read token decimals');
  return dec;
}

function toAmount(qty, decimals) {
  // convert token qty -> smallest units (BigInt)
  const factor = 10 ** Math.min(decimals, 9); // avoid float overflow beyond 1e9
  const whole = Math.trunc(qty);
  const frac = qty - whole;
  const bigWhole = BigInt(whole) * BigInt(10 ** decimals);
  const bigFrac = BigInt(Math.round(frac * factor)) * BigInt(10 ** (decimals - Math.min(decimals, 9)));
  return bigWhole + bigFrac;
}

/* ------------------------- PAPER MODE ------------------------ */
async function paperBuy({ mint }) {
  const solUsd = await ensurePrice(SOL_MINT);
  const tok = await ensurePrice(mint);
  if (!Number.isFinite(solUsd?.priceUsd) || !Number.isFinite(tok?.priceUsd)) {
    throw new Error('paper buy: price unavailable');
  }
  const spendSol = cfg.buySolAmount;
  const spendUsd = spendSol * solUsd.priceUsd;
  const qty = spendUsd / tok.priceUsd;
  return {
    mode: 'paper',
    entryPriceUsd: tok.priceUsd,
    qty,
    solSpent: spendSol,
    txid: null,
    provider: tok.source || 'jupiter'
  };
}

async function paperSell({ mint, qty }) {
  const tok = await ensurePrice(mint);
  if (!Number.isFinite(tok?.priceUsd)) throw new Error('paper sell: price unavailable');
  return {
    mode: 'paper',
    exitPriceUsd: tok.priceUsd,
    txid: null,
    provider: tok.source || 'jupiter'
  };
}

/* ------------------------- LIVE MODE ------------------------- */

async function jupQuote({ inputMint, outputMint, amount, slippageBps }) {
  const u = new URL(JUP_QUOTE);
  u.searchParams.set('inputMint', inputMint);
  u.searchParams.set('outputMint', outputMint);
  u.searchParams.set('amount', String(amount)); // integer in smallest units
  u.searchParams.set('slippageBps', String(slippageBps));
  u.searchParams.set('swapMode', 'ExactIn');
  u.searchParams.set('onlyDirectRoutes', 'false');
  const r = await fetch(u.toString(), { timeout: 6000 });
  if (!r.ok) throw new Error(`quote ${r.status}`);
  return r.json();
}

async function jupSwap({ quote, userPubkey, wrapAndUnwrapSol = true }) {
  const body = {
    quoteResponse: quote,
    userPublicKey: userPubkey.toBase58(),
    wrapAndUnwrapSol,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: false,
    prioritizationFeeLamports: cfg.jupPriorityFeeLamports === 'auto'
      ? 'auto'
      : Number.isFinite(Number(cfg.jupPriorityFeeLamports))
        ? Number(cfg.jupPriorityFeeLamports)
        : 'auto'
  };
  const r = await fetch(JUP_SWAP, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 8000
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`swap ${r.status}: ${t.slice(0,300)}`);
  }
  return r.json();
}

async function sendAndConfirm(serializedTxBase64) {
  const conn = getConn();
  const kp = parseKeypair();
  const tx = VersionedTransaction.deserialize(Buffer.from(serializedTxBase64, 'base64'));
  tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3
  });
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

async function liveBuy({ mint }) {
  const conn = getConn();
  const kp = parseKeypair();
  const inputMint = SOL_MINT;
  const outputMint = mint;

  // amount of SOL (lamports)
  const lamports = BigInt(Math.round(cfg.buySolAmount * 1_000_000_000));
  if (lamports <= 0n) throw new Error('buy amount too small');

  // Jupiter quote & swap
  const quote = await jupQuote({
    inputMint,
    outputMint,
    amount: lamports.toString(),
    slippageBps: cfg.jupSlippageBps
  });

  const { swapTransaction } = await jupSwap({
    quote,
    userPubkey: kp.publicKey,
    wrapAndUnwrapSol: true
  });

  const sig = await sendAndConfirm(swapTransaction);

  // Compute entry price from quote numbers
  const outAmountUnits = BigInt(quote.outAmount);
  const decimals = await getTokenDecimals(mint);
  const qty = Number(outAmountUnits) / Number(10 ** decimals);

  const solUsd = await ensurePrice(SOL_MINT);
  const entryPriceUsd = Number.isFinite(solUsd?.priceUsd) && qty > 0
    ? (Number(lamports) / 1e9) * solUsd.priceUsd / qty
    : (await ensurePrice(mint))?.priceUsd ?? null;

  return {
    mode: 'live',
    entryPriceUsd,
    qty,
    solSpent: Number(lamports) / 1e9,
    txid: sig,
    provider: 'jupiter'
  };
}

async function liveSell({ mint, qty }) {
  const kp = parseKeypair();
  const inputMint = mint;
  const outputMint = SOL_MINT;

  const decimals = await getTokenDecimals(mint);
  const amountUnits = toAmount(qty, decimals);
  if (amountUnits <= 0n) throw new Error('sell qty too small');

  const quote = await jupQuote({
    inputMint,
    outputMint,
    amount: amountUnits.toString(),
    slippageBps: cfg.jupSlippageBps
  });

  const { swapTransaction } = await jupSwap({
    quote,
    userPubkey: kp.publicKey,
    wrapAndUnwrapSol: true
  });

  const sig = await sendAndConfirm(swapTransaction);

  const solUsd = await ensurePrice(SOL_MINT);
  const outLamports = BigInt(quote.outAmount);
  const exitPriceUsd = Number.isFinite(solUsd?.priceUsd) && qty > 0
    ? (Number(outLamports) / 1e9) * solUsd.priceUsd / qty
    : (await ensurePrice(mint))?.priceUsd ?? null;

  return {
    mode: 'live',
    exitPriceUsd,
    txid: sig,
    provider: 'jupiter'
  };
}

/* --------------------------- Public API --------------------------- */
export async function executeBuy({ mint }) {
  if (cfg.tradeMode === 'paper') return paperBuy({ mint });
  return liveBuy({ mint });
}
export async function executeSell({ mint, qty }) {
  if (cfg.tradeMode === 'paper') return paperSell({ mint, qty });
  return liveSell({ mint, qty });
}
