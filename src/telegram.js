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

export async function sendTrackingSummary(walletsWithWin) {
  // walletsWithWin: [{ address, winRatePercent }]
  const header = `🛰️ *Tracking ${walletsWithWin.length} wallets* (win% ≥ ${cfg.minWinRatePercent})`;
  const lines = walletsWithWin.map((w, i) => {
    const pct = (Number(w.winRatePercent) || 0).toFixed(2);
    return `${String(i + 1).padStart(2, ' ')}. \`${w.address}\` — *${pct}%*`;
    // (you can add Solscan links later with inline buttons if you want)
  });
  const text = [header, ...lines].join('\n');
  await sendMessage(text);
}
