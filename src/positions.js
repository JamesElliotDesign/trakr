// src/positions.js
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { cfg } from './config.js';

const log = pino({ transport: { target: 'pino-pretty' }});

const POS_PATH = path.join(cfg.dataDir, 'positions.json');
try { fs.mkdirSync(cfg.dataDir, { recursive: true }); } catch {}

function readAll() {
  try {
    if (!fs.existsSync(POS_PATH)) return { open: {}, closed: [] };
    const j = JSON.parse(fs.readFileSync(POS_PATH, 'utf8'));
    if (!j || typeof j !== 'object') return { open: {}, closed: [] };
    return { open: j.open || {}, closed: j.closed || [] };
  } catch {
    return { open: {}, closed: [] };
  }
}
function writeAll(state) {
  try { fs.writeFileSync(POS_PATH, JSON.stringify(state, null, 2), 'utf8'); } catch {}
}

let state = readAll();

function toBigIntOrNull(x) {
  if (x == null) return null;
  if (typeof x === 'bigint') return x;
  if (typeof x === 'string' && x.length && /^[0-9]+$/.test(x)) return BigInt(x);
  if (typeof x === 'number' && Number.isFinite(x)) return BigInt(Math.floor(x));
  return null;
}

/**
 * Open a new position
 * shape (backward compatible):
 *   {
 *     mint, wallet,
 *     entryPriceUsd,
 *     qty,            // may be atoms or undefined (legacy)
 *     qtyAtoms,       // preferred: bigint/string atoms
 *     decimals,       // token decimals if known
 *     solSpent,
 *     tsOpen,
 *     sourceTx,
 *     mode
 *   }
 */
export function openPosition({
  mint,
  wallet,
  entryPriceUsd,
  qty,
  qtyAtoms,
  decimals,
  solSpent,
  sourceTx,
  mode
}) {
  // Normalize quantity: prefer explicit qtyAtoms, else treat qty as atoms if it looks like a count
  const atoms =
    toBigIntOrNull(qtyAtoms) ??
    toBigIntOrNull(qty) ?? // legacy field — assumed atoms if provided
    null;

  // Normalize decimals if provided (keep null if unknown)
  const tokenDecimals =
    (typeof decimals === 'number' && Number.isFinite(decimals)) ? decimals : null;

  // For convenience, compute a UI qty when possible; otherwise leave null
  let qtyUi = null;
  if (atoms != null && tokenDecimals != null) {
    try {
      qtyUi = Number(atoms) / (10 ** tokenDecimals);
    } catch {
      qtyUi = null;
    }
  }

  state.open[mint] = {
    mint,
    wallet: wallet ?? null,
    entryPriceUsd: (typeof entryPriceUsd === 'number' && Number.isFinite(entryPriceUsd)) ? entryPriceUsd : null,
    // Persist both, but prefer qtyAtoms for downstream logic
    qtyAtoms: atoms,
    decimals: tokenDecimals,
    // Keep legacy field for compatibility; only set if we computed a UI number
    qty: qtyUi,
    solSpent: solSpent ?? null,
    tsOpen: Date.now(),
    sourceTx: sourceTx || null,
    mode: mode || cfg.tradeMode
  };

  writeAll(state);

  log.info(
    {
      mint,
      entry: state.open[mint].entryPriceUsd,
      qtyAtoms: state.open[mint].qtyAtoms ? String(state.open[mint].qtyAtoms) : null,
      decimals: state.open[mint].decimals
    },
    'Opened position'
  );
}

/** Close an existing position (move to closed array) */
export function closePosition(mint, { exitPriceUsd, reason, exitTx = null }) {
  const pos = state.open[mint];
  if (!pos) return null;
  const pnlPct = (typeof exitPriceUsd === 'number' && typeof pos.entryPriceUsd === 'number')
    ? ((exitPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100
    : null;

  const closed = {
    ...pos,
    exitPriceUsd: (typeof exitPriceUsd === 'number' && Number.isFinite(exitPriceUsd)) ? exitPriceUsd : null,
    pnlPct,
    tsClose: Date.now(),
    reason: reason || 'exit',
    exitTx
  };

  delete state.open[mint];
  state.closed.push(closed);
  writeAll(state);
  return closed;
}

export function getOpenPosition(mint) {
  return state.open[mint] || null;
}

export function hasOpenPosition(mint) {
  return !!state.open[mint];
}

export function listOpenPositions() {
  return Object.values(state.open);
}

export function allState() {
  return state;
}
