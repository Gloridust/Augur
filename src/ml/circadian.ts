import { db } from '../shared/db';

// Personal-circadian activity histogram (Phase 3.3). A single 24-bin
// decayed count of when THIS user is active. Used to derive `hourActivityZ`
// = z-score of the current hour against the user's own rhythm — "is this MY
// active time" rather than the wall-clock hour, which the cyclic hour
// features already cover. A 9am-spike person and a 9pm-spike person get the
// same hourActivityZ at their respective peaks, so the model can learn a
// single "predict more confidently during active hours" weight that
// generalizes across users' schedules.
//
// One KV entry (~200 bytes). Updated incrementally on each tracked event
// (cheap: one array bump) with a slow global decay applied in the nightly
// alarm so the rhythm tracks gradual schedule changes.

const KV_KEY = 'circadian:v1';
const DECAY = 0.98; // per nightly-decay tick

export interface CircadianState {
  hourCounts: number[]; // length 24
  updatedAt: number;
}

let cache: CircadianState | null = null;

function empty(): CircadianState {
  return { hourCounts: new Array(24).fill(0), updatedAt: 0 };
}

export async function loadCircadian(): Promise<CircadianState> {
  if (cache) return cache;
  const row = await db.kv.get(KV_KEY);
  const raw = row?.value as CircadianState | undefined;
  cache =
    raw && Array.isArray(raw.hourCounts) && raw.hourCounts.length === 24
      ? raw
      : empty();
  return cache;
}

export async function bumpCircadian(hour: number, now: number): Promise<void> {
  const c = await loadCircadian();
  const h = ((hour % 24) + 24) % 24;
  c.hourCounts[h] += 1;
  c.updatedAt = now;
  await db.kv.put({ key: KV_KEY, value: c, updatedAt: now });
}

export async function decayCircadian(now: number): Promise<void> {
  const c = await loadCircadian();
  for (let i = 0; i < 24; i++) c.hourCounts[i] *= DECAY;
  c.updatedAt = now;
  await db.kv.put({ key: KV_KEY, value: c, updatedAt: now });
}

// z-score of `hour`'s activity against the user's own 24-hour distribution.
// Returns 0 before enough data accumulates (std ~ 0). Synchronous against a
// passed snapshot so scoring stays O(1) per call (load once per scoring
// pass, not per candidate).
export function hourActivityZFrom(state: CircadianState, hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const counts = state.hourCounts;
  let sum = 0;
  for (const v of counts) sum += v;
  if (sum < 24) return 0; // too little data — no signal
  const mean = sum / 24;
  let variance = 0;
  for (const v of counts) variance += (v - mean) * (v - mean);
  variance /= 24;
  const std = Math.sqrt(variance);
  if (std < 1e-6) return 0;
  return (counts[h] - mean) / std;
}

export function clearCircadianCache(): void {
  cache = null;
}
