// Hashing-based text embedding — the on-device "semantic" layer (no external
// model, no network, no training). The whole recommend stack until now has
// treated browsing as a stream of domain IDs: every (A→B) pair learned
// independently, 300 domains = 90k pairs that 16k events can't fill. This
// gives each PAGE a vector derived from the words in its title + URL path,
// so two domains the user has never co-visited but whose pages share
// vocabulary ("auth", "invoice", "pull request") land near each other — the
// generalization domain-ID models structurally can't have.
//
// Method: the hashing trick (feature hashing). Tokenize into word unigrams +
// character trigrams, hash each token to a dimension with a sign, accumulate,
// L2-normalize. Deterministic, ~microseconds, zero stored model. This is a
// genuine first cut of a semantic embedding; a pretrained sentence model
// (model2vec / potion) would be strictly better but needs an 8–15 MB asset
// and a WASM runtime — a separate, larger effort (see doc/NEXT-PARADIGM.md).

export const TEXT_DIM = 48;

// FNV-1a — small, fast, well-distributed string hash. We derive two values
// per token (dimension index + sign) from one hash via different bit slices.
function fnv1a(str: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'at',
  'com', 'www', 'http', 'https', 'html', 'php', 'index', 'home', 'page',
]);

// Tokenize a title+URL blob into word unigrams (≥2 chars, stopworded) plus
// character trigrams of each word (captures morphology / shared roots so
// "invoices" ≈ "invoice", "github" ≈ "gitlab" partially).
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w));
  const tokens: string[] = [];
  for (const w of words) {
    tokens.push(w);
    if (w.length >= 4) {
      for (let i = 0; i + 3 <= w.length; i++) tokens.push('#' + w.slice(i, i + 3));
    }
  }
  return tokens;
}

// Embed free text into a unit vector. Word tokens get full weight; char
// trigrams get a fraction (they're noisier but help OOV / morphology).
export function embedText(text: string): Float32Array {
  const v = new Float32Array(TEXT_DIM);
  if (!text) return v;
  for (const tok of tokenize(text)) {
    const h = fnv1a(tok);
    const dim = h % TEXT_DIM;
    const sign = (h >>> 16) & 1 ? 1 : -1;
    const weight = tok.startsWith('#') ? 0.4 : 1.0;
    v[dim] += sign * weight;
  }
  // L2 normalize.
  let norm = 0;
  for (let k = 0; k < TEXT_DIM; k++) norm += v[k] * v[k];
  norm = Math.sqrt(norm);
  if (norm > 1e-9) for (let k = 0; k < TEXT_DIM; k++) v[k] /= norm;
  return v;
}

// Build the text input for a page from its title + URL path segments. The
// path words ("user/repo/pulls") carry as much intent as the title.
export function pageText(title: string | undefined, url: string | undefined): string {
  let pathWords = '';
  if (url) {
    try {
      const u = new URL(url);
      pathWords = u.pathname.replace(/[/_-]+/g, ' ');
    } catch {
      // ignore
    }
  }
  return `${title ?? ''} ${pathWords}`.trim();
}

export function textCosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n; k++) {
    dot += a[k] * b[k];
    na += a[k] * a[k];
    nb += b[k] * b[k];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom < 1e-9 ? 0 : dot / denom;
}
