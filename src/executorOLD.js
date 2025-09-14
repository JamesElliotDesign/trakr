// src/executor.js
import pino from 'pino';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  SendTransactionError
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
  const dec =
    acc?.value?.data?.parsed?.info?.decimals ??
    acc?.value?.data?.parsed?.info?.mintAuthority?.decimals; // token-2022 sometimes parses oddly
  if (!Number.isFinite(dec)) throw new Error('cannot read token decimals');
  return dec;
}

function toAmount(qty, decimals) {
  const factor = 10 ** Math.min(decimals, 9);
  const whole = Math.trunc(qty);
  const frac = qty - whole;
  const bigWhole = BigInt(whole) * BigInt(10 ** decimals);
  const bigFrac = BigInt(Math.round(frac * factor)) * BigInt(10 ** (decimals - Math.min(decimals, 9)));
  return bigWhole + bigFrac;
}

function parseJupErrorMessage(e) {
  const msg = String(e?.message || e);
  // Common Jupiter custom codes seen in wild launches
  // 0x1771: route/amount/slippage related
  // 0x1788 / 0x1789: route stage failures (often brand-new pools / token-2022 edge-cases)
  let code = null;
  const m = msg.match(/custom program error:\s*(0x[0-9a-fA-F]+)/);
  if (m) code = m[1];
  return { msg, code };
}

async function sendAndConfirm(serializedTxBase64) {
  const conn = getConn();
  const kp = parseKeypair();
  const tx = VersionedTransaction.deserialize(Buffer.from(serializedTxBase64, 'base64'));
  tx.sign([kp]);

  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3
    });
    await conn.confirmTransaction(sig, 'confirmed');
    return sig;
  } catch (e) {
    if (e instanceof SendTransactionError) {
      const logs = await e.getLogs(getConn()).catch(() => null);
      log.warn({ err: e.message, logs }, 'sendRawTransaction failed');
    }
    throw e;
  }
}

/* ------------------ Jupiter quote/swap w/ retries ------------------ */

async function jupQuote({ inputMint, outputMint, amount, slippageBps }) {
  const u = new URL(JUP_QUOTE);
  u.searchParams.set('inputMint', inputMint);
  u.searchParams.set('outputMint', outputMint);
  u.searchParams.set('amount', String(amount)); // integer in smallest units
  u.searchParams.set('slippageBps', String(slippageBps));
  u.searchParams.set('swapMode', 'ExactIn');
  u.searchParams.set('onlyDirectRoutes', 'false');
  // NOTE: leave platformFeeBps unset for now
  const r = await fetch(u.toString(), { timeout: 6500 });
  if (!r.ok) throw new Error(`quote ${r.status}`);
  return r.json();
}

async function jupSwap({ quote, userPubkey, wrapAndUnwrapSol = true, asLegacyTransaction = false, priorityLamports }) {
  const body = {
    quoteResponse: quote,
    userPublicKey: userPubkey.toBase58(),
    wrapAndUnwrapSol,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: false,
    prioritizationFeeLamports:
      priorityLamports === 'auto'
        ? 'auto'
        : Number.isFinite(Number(priorityLamports))
          ? Number(priorityLamports)
          : 'auto',
    asLegacyTransaction // last-resort toggle helps on some congested routes
  };
  const r = await fetch(JUP_SWAP, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 9500
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`swap ${r.status}: ${t.slice(0, 500)}`);
  }
  return r.json();
}

async function tryRoute({ inputMint, outputMint, amount, baseSlippageBps, bump, asLegacy }) {
  const slippage = Math.min(baseSlippageBps + bump, 1500); // cap at 15%
  // Priority fee strategy: auto -> 200k -> 500k lamports
  const pf =
    bump >= 400 ? 500_000 :
    bump >= 200 ? 200_000 :
    cfg.jupPriorityFeeLamports;

  const quote = await jupQuote({ inputMint, outputMint, amount, slippageBps: slippage });
  if (!quote || !quote.outAmount || BigInt(quote.outAmount) === 0n) {
    throw new Error('empty route (outAmount=0)');
  }
  const { swapTransaction } = await jupSwap({
    quote,
    userPubkey: parseKeypair().publicKey,
    wrapAndUnwrapSol: true,
    asLegacyTransaction: !!asLegacy,
    priorityLamports: pf
  });
  const sig = await sendAndConfirm(swapTransaction);
  return { sig, quote, usedSlippageBps: slippage, priorityLamports: pf, asLegacy: !!asLegacy };
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

async function liveBuy({ mint }) {
  const inputMint = SOL_MINT;
  const outputMint = mint;
  const lamports = BigInt(Math.round(cfg.buySolAmount * 1_000_000_000));
  if (lamports <= 0n) throw new Error('buy amount too small');

  // 3-attempt ladder: base, +200bps, +400bps (legacy last)
  const attempts = [
    { bump: 0, asLegacy: false },
    { bump: 200, asLegacy: false },
    { bump: 400, asLegacy: true }
  ];

  let lastErr = null;
  for (const a of attempts) {
    try {
      const r = await tryRoute({
        inputMint,
        outputMint,
        amount: lamports.toString(),
        baseSlippageBps: cfg.jupSlippageBps,
        bump: a.bump,
        asLegacy: a.asLegacy
      });

      // Compute entry price from quote numbers
      const outUnits = BigInt(r.quote.outAmount);
      const decimals = await getTokenDecimals(mint);
      const qty = Number(outUnits) / Number(10 ** decimals);

      const solUsd = await ensurePrice(SOL_MINT);
      const entryPriceUsd = Number.isFinite(solUsd?.priceUsd) && qty > 0
        ? (Number(lamports) / 1e9) * solUsd.priceUsd / qty
        : (await ensurePrice(mint))?.priceUsd ?? null;

      log.info(
        { mint, slippageBps: r.usedSlippageBps, priorityLamports: r.priorityLamports, asLegacy: r.asLegacy },
        'liveBuy filled'
      );

      return {
        mode: 'live',
        entryPriceUsd,
        qty,
        solSpent: Number(lamports) / 1e9,
        txid: r.sig,
        provider: 'jupiter'
      };
    } catch (e) {
      const { code, msg } = parseJupErrorMessage(e);
      lastErr = e;
      log.warn({ mint, code, err: msg }, 'liveBuy attempt failed');
      await new Promise(r => setTimeout(r, 350)); // tiny backoff between attempts
      continue;
    }
  }
  throw lastErr || new Error('liveBuy failed after retries');
}

async function liveSell({ mint, qty }) {
  const inputMint = mint;
  const outputMint = SOL_MINT;

  const decimals = await getTokenDecimals(mint);
  const amountUnits = toAmount(qty, decimals);
  if (amountUnits <= 0n) throw new Error('sell qty too small');

  const attempts = [
    { bump: 0, asLegacy: false },
    { bump: 200, asLegacy: false },
    { bump: 400, asLegacy: true }
  ];

  let lastErr = null;
  for (const a of attempts) {
    try {
      const r = await tryRoute({
        inputMint,
        outputMint,
        amount: amountUnits.toString(),
        baseSlippageBps: cfg.jupSlippageBps,
        bump: a.bump,
        asLegacy: a.asLegacy
      });

      const solUsd = await ensurePrice(SOL_MINT);
      const outLamports = BigInt(r.quote.outAmount);
      const exitPriceUsd = Number.isFinite(solUsd?.priceUsd) && qty > 0
        ? (Number(outLamports) / 1e9) * solUsd.priceUsd / qty
        : (await ensurePrice(mint))?.priceUsd ?? null;

      log.info(
        { mint, slippageBps: r.usedSlippageBps, priorityLamports: r.priorityLamports, asLegacy: r.asLegacy },
        'liveSell filled'
      );

      return {
        mode: 'live',
        exitPriceUsd,
        txid: r.sig,
        provider: 'jupiter'
      };
    } catch (e) {
      const { code, msg } = parseJupErrorMessage(e);
      lastErr = e;
      log.warn({ mint, code, err: msg }, 'liveSell attempt failed');
      await new Promise(r => setTimeout(r, 350));
      continue;
    }
  }

  throw lastErr || new Error('liveSell failed after retries');
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
