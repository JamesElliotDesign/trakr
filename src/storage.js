import Redis from 'ioredis';

const PREFIX = 'seen';
let mem = new Map();
let redis = null;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    // optional: tls, retryStrategy, etc.
  });
}

/** Preload the seen cache from Redis (hash). Call once on boot. */
export async function preloadSeen() {
  if (!redis) return;
  const all = await redis.hgetall(PREFIX); // { key1: "ts", key2: "ts", ... }
  for (const [k, v] of Object.entries(all)) mem.set(k, Number(v));
}

/** Write-through helpers with in-memory hot path. */
export const seenCache = {
  get: (k) => mem.get(k),
  has: (k) => mem.has(k),
  set: (k, v) => {
    mem.set(k, v);
    if (redis) redis.hset(PREFIX, k, String(v)).catch(() => {});
  },
  delete: (k) => {
    mem.delete(k);
    if (redis) redis.hdel(PREFIX, k).catch(() => {});
  }
};
