// src/telegram.js
import fetch from 'node-fetch';
import { cfg } from './config.js';

async function sendMessage(text) {
  const url = `https://api.telegram.org/bot${cfg.tgToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: cfg.tgChatId,
      text,
      parse_mode: 'Markdown'
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Telegram error: ${res.status} ${t}`);
  }
}

export async function sendSignal({ wallet, mint, amount, priceUsd, sourceTx, provider }) {
  const text = [
    '📈 *Buy Signal Detected*',
    `• Wallet: \`${wallet}\``,
    `• Token (mint): \`${mint}\``,
    amount != null ? `• Amount: ${amount}` : null,
    priceUsd != null ? `• Price: $${priceUsd}` : '• Price: _unknown_',
    sourceTx ? `• Tx: \`${sourceTx}\`` : null,
    provider ? `• Price Source: ${provider}` : null
  ].filter(Boolean).join('\n');
  await sendMessage(text);
}

function fmtAgo(ms) {
  if (ms === 0) return '0–24h';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 1) return `${h}h${m ? ` ${m}m` : ''}`;
  return `${m}m`;
}

export async function sendTrackingSummary(walletsWithWin = []) {
  const header = `🛰️ *Tracking ${walletsWithWin.length} wallets* (win% ≥ ${cfg.minWinRatePercent}, active ≤ ${cfg.activeWithinHours}h)`;
  const lines = walletsWithWin.map((w, i) => {
    const pct = (Number(w.winRatePercent) || 0).toFixed(2);
    const act = (w.lastActiveMsAgo == null) ? 'unknown' : fmtAgo(w.lastActiveMsAgo);
    return `${String(i + 1).padStart(2, ' ')}. \`${w.address}\` — *${pct}%* (active ${act} ago)`;
  });
  await sendMessage([header, ...lines].join('\n'));
}

/* --- Entries & exits --- */

function normalizeAtoms(x) {
  if (x == null) return null;
  if (typeof x === 'bigint') return x;
  if (typeof x === 'string' && /^[0-9]+$/.test(x)) return BigInt(x);
  if (typeof x === 'number' && Number.isFinite(x)) return BigInt(Math.floor(x));
  return null;
}

function prettyNumber(n, maxFrac = 6) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  // trim unnecessary decimals while keeping precision for small caps
  const s = n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
  return s;
}

export async function sendEntryNotice({ mint, entryPriceUsd, qty, decimals, solSpent, mode, txid }) {
  // Qty can be UI number, atoms as bigint/string/number, or undefined.
  let qtyLine = '• Qty: pending';
  const atoms = normalizeAtoms(qty);
  if (atoms != null && typeof decimals === 'number' && Number.isFinite(decimals)) {
    // atoms + decimals → UI tokens
    const ui = Number(atoms) / (10 ** decimals);
    const uiPretty = prettyNumber(ui, 6) ?? ui;
    qtyLine = `• Qty: ${uiPretty}`;
  } else if (typeof qty === 'number' && Number.isFinite(qty)) {
    // treat as already-UI number
    const uiPretty = prettyNumber(qty, 6) ?? qty;
    qtyLine = `• Qty: ${uiPretty}`;
  }

  const entryPretty = (typeof entryPriceUsd === 'number' && Number.isFinite(entryPriceUsd))
    ? prettyNumber(entryPriceUsd, 12)
    : 'pending';

  const lines = [
    '🟢 *Position OPENED*',
    `• Token: \`${mint}\``,
    `• Mode: ${mode ?? (cfg.tradeMode || 'live')}`,
    `• Entry: $${entryPretty}`,
    qtyLine,
    solSpent != null ? `• Spent: ${solSpent} SOL` : null,
    txid ? `• Tx: \`${txid}\`` : null,
    `• TP: +${cfg.takeProfitPercent}%`,
    `• SL: -${cfg.stopLossPercent}%`
  ].filter(Boolean);
  await sendMessage(lines.join('\n'));
}

export async function sendExitNotice({ mint, entry, exit, pnlPct, reason, txid, mode }) {
  const entryPretty = (typeof entry === 'number' && Number.isFinite(entry)) ? prettyNumber(entry, 12) : 'unknown';
  const exitPretty  = (typeof exit === 'number'  && Number.isFinite(exit))  ? prettyNumber(exit, 12)  : 'unknown';

  const lines = [
    '🔴 *Position CLOSED*',
    `• Token: \`${mint}\``,
    `• Mode: ${mode ?? (cfg.tradeMode || 'live')}`,
    `• Entry: $${entryPretty}`,
    `• Exit: $${exitPretty}`,
    pnlPct != null && Number.isFinite(pnlPct) ? `• PnL: ${Number(pnlPct).toFixed(2)}%` : null,
    `• Reason: ${reason}`,
    txid ? `• Tx: \`${txid}\`` : null
  ].filter(Boolean);
  await sendMessage(lines.join('\n'));
}
