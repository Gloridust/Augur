// Fuzzy matching for the launcher: open tabs, pins and history by title,
// URL or domain — and Chinese titles by their pinyin initials, so "gz" finds
// "工作周报" without a pinyin dictionary.
//
// Initials come from the zh-CN collation, which ICU orders by pinyin: each
// boundary character below is the first syllable of its initial, so a
// character's initial is the last boundary it sorts at or after. Covers
// the GB2312 range — every common character. (No I/U/V initials in pinyin.)

const BOUNDARIES = '阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥扨它穵夕丫帀';
const LETTERS = 'abcdefghjklmnopqrstwxyz';
const collator = new Intl.Collator('zh-CN');
const CJK = /[一-鿿]/;

const initialCache = new Map<string, string>();

function initialOf(ch: string): string {
  let hit = initialCache.get(ch);
  if (hit !== undefined) return hit;
  hit = '';
  for (let i = BOUNDARIES.length - 1; i >= 0; i--) {
    if (collator.compare(ch, BOUNDARIES[i]) >= 0) {
      hit = LETTERS[i];
      break;
    }
  }
  initialCache.set(ch, hit);
  return hit;
}

// "Augur 工作周报 v2" → "augurgzzbv2": ASCII kept, each CJK character → its
// initial. Lets a mixed query like "gzzb" or "augurgz" match.
export function pinyinInitials(text: string): string {
  let out = '';
  for (const ch of text) out += CJK.test(ch) ? initialOf(ch) : /[a-z0-9]/i.test(ch) ? ch.toLowerCase() : '';
  return out;
}

// Higher is better; 0 = no match. Every whitespace-separated term must match.
export function matchScore(query: string, fields: { title?: string; url?: string; domain?: string }): number {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const title = (fields.title ?? '').toLowerCase();
  const url = (fields.url ?? '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
  const domain = (fields.domain ?? '').toLowerCase();
  let initials: string | null = null;
  let total = 0;
  for (const t of terms) {
    let s = 0;
    if (domain.startsWith(t)) s = 100;
    else if (title.startsWith(t)) s = 90;
    else if (new RegExp(`(^|[\\s\\-_/.·|:])${escapeRe(t)}`).test(title)) s = 80;
    else if (title.includes(t)) s = 60;
    else if (domain.includes(t) || url.includes(t)) s = 50;
    else if (/^[a-z0-9]+$/.test(t) && CJK.test(title)) {
      initials ??= pinyinInitials(fields.title ?? '');
      if (initials.startsWith(t)) s = 70;
      else if (initials.includes(t)) s = 45;
    }
    if (s === 0) return 0;
    total += s;
  }
  return total / terms.length;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
