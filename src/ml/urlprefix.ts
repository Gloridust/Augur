import { db } from '../shared/db';

// Per-domain URL-prefix table (Phase 4.3). User value is URL-granular, not
// domain-granular: "github.com" is not actionable, "github.com/you/repo"
// is. We keep, per domain, a small decayed-count table of 2-path-segment
// URL prefixes, so a domain-level prediction can surface a precise,
// actionable URL — the change users FEEL most (predictions land on the
// right page, not just the right site).
//
// Also yields `prefixConcentration` = the top prefix's share of the
// domain's traffic — high concentration means a domain-level suggestion
// reliably maps to one page; low means the domain is browsed broadly and a
// bare-domain URL is the safer bet.
//
// One KV entry (~10–20 KB at a few hundred domains × top-5 prefixes).
// Updated on each open/navigate; pruned to top-5/domain in the nightly alarm.

const KV_KEY = 'urlPrefixes:v1';
const TOP_PER_DOMAIN = 5;
const DECAY = 0.97; // per nightly tick

export interface PrefixEntry {
  prefix: string; // full URL up to 2 path segments, e.g. https://github.com/user/repo
  count: number;
}
export interface UrlPrefixState {
  // domain → its prefix entries (unsorted; pruned to TOP_PER_DOMAIN nightly)
  byDomain: Record<string, PrefixEntry[]>;
  updatedAt: number;
}

let cache: UrlPrefixState | null = null;

function empty(): UrlPrefixState {
  return { byDomain: {}, updatedAt: 0 };
}

// Reduce a URL to "scheme://host/seg1/seg2" — enough to identify a workspace
// (repo, mailbox, board) without keeping the full query-string tail (which
// is high-cardinality and often sensitive).
export function prefixOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const segs = u.pathname.split('/').filter(Boolean).slice(0, 2);
    return `${u.protocol}//${u.host}/${segs.join('/')}`;
  } catch {
    return null;
  }
}

export async function loadUrlPrefixes(): Promise<UrlPrefixState> {
  if (cache) return cache;
  const row = await db.kv.get(KV_KEY);
  const raw = row?.value as UrlPrefixState | undefined;
  cache = raw && raw.byDomain ? raw : empty();
  return cache;
}

export async function bumpUrlPrefix(
  domain: string,
  url: string | undefined,
  now: number,
): Promise<void> {
  const prefix = prefixOf(url);
  if (!domain || !prefix) return;
  const s = await loadUrlPrefixes();
  const list = s.byDomain[domain] ?? (s.byDomain[domain] = []);
  const hit = list.find((e) => e.prefix === prefix);
  if (hit) hit.count += 1;
  else list.push({ prefix, count: 1 });
  // Soft cap inline to avoid unbounded growth between nightly prunes.
  if (list.length > TOP_PER_DOMAIN * 3) {
    list.sort((a, b) => b.count - a.count);
    s.byDomain[domain] = list.slice(0, TOP_PER_DOMAIN);
  }
  s.updatedAt = now;
  await db.kv.put({ key: KV_KEY, value: s, updatedAt: now });
}

export async function pruneUrlPrefixes(now: number): Promise<void> {
  const s = await loadUrlPrefixes();
  for (const domain of Object.keys(s.byDomain)) {
    const list = s.byDomain[domain];
    for (const e of list) e.count *= DECAY;
    list.sort((a, b) => b.count - a.count);
    const kept = list.filter((e) => e.count > 0.5).slice(0, TOP_PER_DOMAIN);
    if (kept.length === 0) delete s.byDomain[domain];
    else s.byDomain[domain] = kept;
  }
  s.updatedAt = now;
  await db.kv.put({ key: KV_KEY, value: s, updatedAt: now });
}

// Best prefix URL for a domain + concentration of its top prefix. O(1)-ish
// read against the in-memory cache (load once per scoring pass).
export function topPrefixFrom(
  state: UrlPrefixState,
  domain: string,
): { url: string | null; concentration: number } {
  const list = state.byDomain[domain];
  if (!list || list.length === 0) return { url: null, concentration: 0 };
  let top = list[0];
  let total = 0;
  for (const e of list) {
    total += e.count;
    if (e.count > top.count) top = e;
  }
  return {
    url: top.prefix,
    concentration: total > 0 ? top.count / total : 0,
  };
}

export function clearUrlPrefixCache(): void {
  cache = null;
}
