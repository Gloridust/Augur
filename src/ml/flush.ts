// Deferred persistence for the large in-memory model/statistics blobs.
//
// The online learners mutate in-memory objects on every event; persisting the
// whole blob each time meant ~100 KB of IndexedDB rewrites per navigate and
// ~95 KB per tab switch (sequence memory), ≈36 MB/day for a heavy user, with
// every value over 64 KB spilling into a separate blob file. Now each module
// marks its blob dirty and one timer writes all dirty blobs together.
//
// Trade-off: if the service worker is killed inside the window, at most
// FLUSH_DELAY_MS of incremental statistics is lost — the event log itself is
// written immediately, so a replay can always rebuild it. Anything that reads
// these blobs back out of IndexedDB (export, debug bundle) calls flushAll()
// first; data import/reset calls discardDirty() so a stale pending write can't
// clobber freshly restored data.

import { logError } from '../shared/errorlog';

const FLUSH_DELAY_MS = 5000;

const dirty = new Map<string, () => Promise<void>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;

export function markDirty(key: string, save: () => Promise<void>): void {
  dirty.set(key, save);
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flushAll();
    }, FLUSH_DELAY_MS);
  }
}

export async function flushAll(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (inflight) await inflight;
  if (dirty.size === 0) return;
  const batch = [...dirty.entries()];
  dirty.clear();
  inflight = (async () => {
    for (const [key, save] of batch) {
      try {
        await save();
      } catch (err) {
        void logError(`flush.${key}`, err);
      }
    }
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
}

// Drop pending writes — all of them, or just one key. Call before replacing a
// blob wholesale (import, reset, rebuild), or the stale in-memory copy would
// be written back over the new data when the timer fires.
export function discardDirty(key?: string): void {
  if (key !== undefined) {
    dirty.delete(key);
    return;
  }
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  dirty.clear();
}

export function pendingDirtyKeys(): string[] {
  return [...dirty.keys()];
}
