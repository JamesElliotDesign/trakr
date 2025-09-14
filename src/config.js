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

  // --- SolanaTracker (candidates only) ---
  stApiKey: process.env.ST_API_KEY,
  stBaseUrl: 'https://data.solanatracker.io',
  stWindow: process.env.ST_WINDOW || '1d',                  // '1d' or '3d'
  topWallets: parseInt(process.env.TOP_WALLETS || '20', 10),
  trackTopN: parseInt(process.env.TRACK_TOP_N || '10', 10),
  minWinRatePercent: parseFloat(process.env.MIN_WIN_RATE_PERCENT || '35'),

  // On-chain recency gate via Helius RPC
  activeWithinHours: parseInt(process.env.ACTIVE_WITHIN_HOURS || '24', 10),

  // Cache
  dataDir: process.env.DATA_DIR || './data',
  topWalletsCacheFile: process.env.TOP_WALLETS_CACHE_FILE || 'top_wallets.json',
  topWalletsTtlMinutes: parseInt(process.env.TOP_WALLETS_TTL_MIN || '60', 10),

  // --- Trading / positions ---
  tradeMode: (process.env.TRADE_MODE || 'paper').toLowerCase(), // 'paper' or 'live'
  buySolAmount: parseFloat(process.env.BUY_SOL_AMOUNT || '0.01'), // SOL per entry
  takeProfitPercent: parseFloat(process.env.TP_PERCENT || '20'),  // e.g. 20 = +20%
  stopLossPercent: parseFloat(process.env.SL_PERCENT || '10'),    // e.g. 10 = -10%
  pricePollMs: parseInt(process.env.PRICE_POLL_MS || '2000', 10), // ms between price checks

  // --- Price provider preference ---
  priceProviderPref: process.env.PRICE_PROVIDER_PREF || 'jupiter',

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
