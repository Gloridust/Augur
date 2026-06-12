// Session-scoped "keep" suppression shared by the two cleanup surfaces:
//   1. InlineCleanupCard (the amber 清理建议 card, ✕ = keep)
//   2. TabWall smart-cleanup batch (coral-glow auto-selection + 关闭所选)
//
// Why this exists: both surfaces independently list the SAME stale tabs
// (one from fetchCleanupRecommendations, the other from
// fetchAllCleanupCandidates). Before this module:
//   - Keeping a tab in the card removed it from the card only — it stayed
//     coral-glowing + checked in TabWall, so "关闭所选" closed it anyway.
//   - And the card's own refresh() re-fetched the model's still-stale
//     verdict, so the kept tab reappeared on the next tab event. "Keep"
//     didn't stick.
//
// When the user says "keep this tab", that's an explicit, immediate
// intent the model can't honor fast enough (it'll take several dismiss
// samples to change its mind). So we suppress that tab from BOTH cleanup
// surfaces for the rest of the session. The model still receives the
// 'dismissed' training signal separately — this is purely the UX layer
// making "keep" mean keep, now.
//
// Keyed by tabId (stable within a browser session) with url as a
// secondary key so that if the same page is the suppression target we
// catch it even if Chrome recycled the tab id. In-memory only: a fresh
// browser session starts with a clean slate, which is the right default —
// "keep for now", not "never suggest again".

const SUPPRESS_EVENT = 'augur:cleanup-suppressed';

const suppressedTabIds = new Set<number>();
const suppressedUrls = new Set<string>();

export function suppressCleanup(tabId: number | undefined, url: string | undefined): void {
  if (tabId !== undefined) suppressedTabIds.add(tabId);
  if (url) suppressedUrls.add(url);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(SUPPRESS_EVENT, { detail: { tabId, url } }),
    );
  }
}

export function isCleanupSuppressed(
  tabId: number | undefined,
  url: string | undefined,
): boolean {
  if (tabId !== undefined && suppressedTabIds.has(tabId)) return true;
  if (url && suppressedUrls.has(url)) return true;
  return false;
}

// Subscribe to suppression events. The handler receives the kept tab so a
// live component can drop it from its own selection state immediately.
// Returns an unsubscribe function.
export function onCleanupSuppressed(
  handler: (detail: { tabId?: number; url?: string }) => void,
): () => void {
  const wrapped = (e: Event) => {
    handler((e as CustomEvent<{ tabId?: number; url?: string }>).detail);
  };
  window.addEventListener(SUPPRESS_EVENT, wrapped);
  return () => window.removeEventListener(SUPPRESS_EVENT, wrapped);
}
