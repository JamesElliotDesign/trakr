import 'dotenv/config';

export const cfg = {
  // --- Server ---
  port: parseInt(process.env.PORT || '8080', 10),

  // --- Helius ---
  heliusApiKey: process.env.HELIUS_API_KEY,
  heliusWebhookId: process.env.HELIUS_WEBHOOK_ID || null,
  webhookPublicUrl: process.env.WEBHOOK_PUBLIC_URL, // e.g. https://<app>.up.railway.app/helius-webhook

  // --- Telegram ---
  tgToken: process.env.TELEGRAM_BOT_TOKEN,
  tgChatId: process.env.TELEGRAM_CHAT_ID,

  // --- SolanaTracker (Top Traders only; keep usage low) ---
  walletSource: 'solanatracker',
  stApiKey: process.env.ST_API_KEY,
  stBaseUrl: 'https://data.solanatracker.io',

  // selection & API usage
  minWinRatePercent: parseFloat(process.env.MIN_WIN_RATE_PERCENT || '35'), // win% threshold (0–100)
  topWallets: parseInt(process.env.TOP_WALLETS || '20', 10),               // consider first N from top page
  trackTopN: parseInt(process.env.TRACK_TOP_N || '10', 10),                // subscribe to best N
  activeWithinHours: parseInt(process.env.ACTIVE_WITHIN_HOURS || '24', 10),// require activity within N hours

  // cache to avoid rinsing free tier
  dataDir: process.env.DATA_DIR || './data',
  topWalletsCacheFile: process.env.TOP_WALLETS_CACHE_FILE || 'top_wallets.json',
  topWalletsTtlMinutes: parseInt(process.env.TOP_WALLETS_TTL_MIN || '60', 10), // refresh hourly

  // --- Price provider preference (kept for later stages) ---
  priceProviderPref: process.env.PRICE_PROVIDER_PREF || 'gmgn',

  // --- Buy detection heuristics ---
  minTokenAmount: 1,
  buyDebounceMinutes: parseInt(process.env.BUY_DEBOUNCE_MIN || '30', 10),

  // --- Exclusions (stablecoins, wSOL etc.) ---
  excludedMints: new Set([
    // wSOL
    'So11111111111111111111111111111111111111112',
    // USDC
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    // USDT
    'Es9vMFrzaCER9YzE3W4FZCwQh7Ckz4bQ6SSS6aQj6t5r'
  ])
};
