import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const SEEN_PATH = path.join(DATA_DIR, 'seen.json');

// ensure dir exists
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

let mem = new Map();
let dirty = false;
let writeTimer = null;

// debounce writes to avoid thrashing the FS
function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      const obj = Object.fromEntries(mem.entries());
      fs.writeFileSync(SEEN_PATH, JSON.stringify(obj), 'utf8');
    } catch { /* ignore */ }
  }, 750); // adjust if needed
}

export async function preloadSeen() {
  try {
    if (fs.existsSync(SEEN_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
      mem = new Map(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
    }
  } catch { /* ignore */ }
}

export const seenCache = {
  get: (k) => mem.get(k),
  has: (k) => mem.has(k),
  set: (k, v) => {
    mem.set(k, v);
    dirty = true;
    scheduleWrite();
  },
  delete: (k) => {
    mem.delete(k);
    dirty = true;
    scheduleWrite();
  },
  // helpful if you want to clear test state
  clear: () => {
    mem.clear();
    dirty = true;
    scheduleWrite();
  }
};

// expose a flush for graceful shutdowns
export function flushSeenSync() {
  try {
    const obj = Object.fromEntries(mem.entries());
    fs.writeFileSync(SEEN_PATH, JSON.stringify(obj), 'utf8');
  } catch { /* ignore */ }
}
