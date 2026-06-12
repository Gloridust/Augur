import { db } from '../shared/db';
import { embedText, pageText, textCosine, TEXT_DIM } from './textembed';

// Per-domain semantic text vector — the running mean of the hashed text
// embeddings (textembed.ts) of pages visited on that domain. This is what
// makes the "semantic" features comparable across candidates: each domain
// carries a vector summarizing what its pages are ABOUT (the words in their
// titles + URL paths), independent of co-visit statistics.
//
// Storage: TEXT_DIM(48) floats × ~300 domains ≈ 60 KB JSON. Updated
// incrementally on each open/navigate; decayed toward recent content in the
// nightly prune so a domain that changed purpose (e.g. a repo you stopped
// using) drifts rather than staying anchored to old titles.

const KV_KEY = 'domainText:v1';
const DECAY = 0.97;
const MAX_DOMAINS = 600;

export interface DomainTextState {
  // domain → { vec (length TEXT_DIM), n: observation count for the mean }
  byDomain: Record<string, { vec: number[]; n: number }>;
  updatedAt: number;
}

let cache: DomainTextState | null = null;

function empty(): DomainTextState {
  return { byDomain: {}, updatedAt: 0 };
}

export async function loadDomainText(): Promise<DomainTextState> {
  if (cache) return cache;
  const row = await db.kv.get(KV_KEY);
  const raw = row?.value as DomainTextState | undefined;
  cache = raw && raw.byDomain ? raw : empty();
  return cache;
}

// Fold a freshly-visited page's text into its domain's running-mean vector.
export async function observeDomainText(
  domain: string,
  title: string | undefined,
  url: string | undefined,
  now: number,
): Promise<void> {
  if (!domain || domain.startsWith('chrome')) return;
  const text = pageText(title, url);
  if (!text) return;
  const emb = embedText(text);
  const s = await loadDomainText();
  const cur = s.byDomain[domain];
  if (!cur) {
    s.byDomain[domain] = { vec: Array.from(emb), n: 1 };
  } else {
    // Incremental mean with a soft cap on n so recent pages keep some pull.
    const n = Math.min(cur.n + 1, 50);
    for (let k = 0; k < TEXT_DIM; k++) {
      cur.vec[k] = (cur.vec[k] * cur.n + emb[k]) / (cur.n + 1);
    }
    cur.n = n;
  }
  s.updatedAt = now;
  await db.kv.put({ key: KV_KEY, value: s, updatedAt: now });
}

export async function pruneDomainText(now: number): Promise<void> {
  const s = await loadDomainText();
  const entries = Object.entries(s.byDomain);
  for (const [, e] of entries) e.n = Math.max(1, e.n * DECAY);
  // If the table grew past the cap, drop the least-observed domains.
  if (entries.length > MAX_DOMAINS) {
    entries.sort((a, b) => b[1].n - a[1].n);
    s.byDomain = Object.fromEntries(entries.slice(0, MAX_DOMAINS));
  }
  s.updatedAt = now;
  await db.kv.put({ key: KV_KEY, value: s, updatedAt: now });
}

// Read a domain's text vector (or null). Synchronous against a loaded
// snapshot so scoring stays O(1) per candidate.
export function vecOf(state: DomainTextState, domain: string): number[] | null {
  return state.byDomain[domain]?.vec ?? null;
}

export function textSim(
  state: DomainTextState,
  a: string,
  b: string,
): number {
  const va = vecOf(state, a);
  const vb = vecOf(state, b);
  if (!va || !vb) return 0;
  return textCosine(va, vb);
}

// Mean text vector over a set of domains (e.g. the recent focus session) —
// the "what is this session about" centroid.
export function sessionTextVec(
  state: DomainTextState,
  domains: string[],
): Float32Array | null {
  const acc = new Float32Array(TEXT_DIM);
  let count = 0;
  for (const d of domains) {
    const v = vecOf(state, d);
    if (!v) continue;
    for (let k = 0; k < TEXT_DIM; k++) acc[k] += v[k];
    count += 1;
  }
  if (count === 0) return null;
  for (let k = 0; k < TEXT_DIM; k++) acc[k] /= count;
  return acc;
}

export function clearDomainTextCache(): void {
  cache = null;
}
