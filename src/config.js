import 'dotenv/config';

export const cfg = {
  port: parseInt(process.env.PORT || '8080', 10),
  heliusApiKey: process.env.HELIUS_API_KEY,
  heliusWebhookId: process.env.HELIUS_WEBHOOK_ID || null,
  webhookPublicUrl: process.env.WEBHOOK_PUBLIC_URL,      // dev: webhook.site URL
  tgToken: process.env.TELEGRAM_BOT_TOKEN,
  tgChatId: process.env.TELEGRAM_CHAT_ID,
  walletSource: process.env.WALLET_SOURCE || 'solanatracker',
  minWinRate: parseFloat(process.env.MIN_WIN_RATE || '0.6'),
  topWallets: parseInt(process.env.TOP_WALLETS || '20', 10),
  trackTopN: parseInt(process.env.TRACK_TOP_N || '10', 10),
  priceProviderPref: process.env.PRICE_PROVIDER_PREF || 'gmgn',
  // Heuristics
  minTokenAmount: 1,             // ignore dust; adjust for decimals in real impl
  buyDebounceMinutes: 30,        // avoid duplicate signals quickly after
  // Basic exclusions (stablecoins, wrapped sol)
  excludedMints: new Set([
    // add USDC, USDT, wSOL mint addresses, etc.
  ])
};
