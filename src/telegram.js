import fetch from 'node-fetch';
import { cfg } from './config.js';

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
