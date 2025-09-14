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

/**
 * Open a new position
 * shape: {
 *   mint, wallet, entryPriceUsd, qty, solSpent, tsOpen, sourceTx, mode
 * }
 */
export function openPosition({ mint, wallet, entryPriceUsd, qty, solSpent, sourceTx, mode }) {
  state.open[mint] = {
    mint,
    wallet,
    entryPriceUsd,
    qty,
    solSpent: solSpent ?? null,
    tsOpen: Date.now(),
    sourceTx: sourceTx || null,
    mode: mode || cfg.tradeMode
  };
  writeAll(state);
}

/** Close an existing position (move to closed array) */
export function closePosition(mint, { exitPriceUsd, reason, exitTx = null }) {
  const pos = state.open[mint];
  if (!pos) return null;
  const pnlPct = exitPriceUsd && pos.entryPriceUsd
    ? ((exitPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100
    : null;

  const closed = {
    ...pos,
    exitPriceUsd: exitPriceUsd ?? null,
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
