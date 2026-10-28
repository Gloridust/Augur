import Dexie, { type EntityTable } from 'dexie';
import type {
  CoOccurrence,
  DomainStats,
  FeedbackEvent,
  PinnedItem,
  StashedTab,
  TabEvent,
  Workspace,
} from './types';

export interface KV {
  key: string;
  value: unknown;
  updatedAt: number;
}

export class ChromeHomepageDB extends Dexie {
  events!: EntityTable<TabEvent, 'id'>;
  feedback!: EntityTable<FeedbackEvent & { id?: number }, 'id'>;
  domains!: EntityTable<DomainStats, 'domain'>;
  cooccurrence!: EntityTable<CoOccurrence, 'pair'>;
  stash!: EntityTable<StashedTab, 'id'>;
  workspaces!: EntityTable<Workspace, 'id'>;
  pins!: EntityTable<PinnedItem, 'id'>;
  kv!: EntityTable<KV, 'key'>;

  constructor() {
    super('augur');
    this.version(1).stores({
      events: '++id, ts, type, tabId, domain, url, [domain+ts], [type+ts]',
      feedback: '++id, ts, surface, domain, action',
      domains: 'domain, lastVisit, visitsDecay, updatedAt',
      cooccurrence: 'pair, a, b, count, lastSeen',
      kv: 'key, updatedAt',
    });
    this.version(2).stores({
      stash: '++id, stashedAt, domain, source, url',
    });
    this.version(3).stores({
      workspaces: '++id, name, updatedAt, createdAt',
    });
    this.version(4).stores({
      pins: '++id, &key, pinnedAt, manualOrder',
    });
    // v5: drop the four event indexes nothing queries (type, tabId, domain,
    // url) — each was maintained on every insert of the hottest table — and
    // remove the duplicate rows the pre-queue service worker wrote (two
    // onUpdated paths both logging one navigate; onActivated +
    // windows.onFocusChanged both logging one focus/blur). Derived tables were
    // inflated by those duplicates, so a rebuild is flagged for the SW.
    this.version(5)
      .stores({ events: '++id, ts, [domain+ts], [type+ts]' })
      .upgrade(async (tx) => {
        const dupIds = await findDuplicateEventIds(tx.table('events'));
        if (dupIds.length) await tx.table('events').bulkDelete(dupIds);
        await tx.table('kv').put({
          key: MAINTENANCE_REBUILD_KEY,
          value: { reason: 'v5-dedupe', removed: dupIds.length },
          updatedAt: Date.now(),
        });
      });
  }
}

export const MAINTENANCE_REBUILD_KEY = 'maintenance:rebuildAggregates';

// Ids of events that duplicate the previous same-kind event for the same tab:
//   navigate — same url within 1 s of the tab's previous navigate
//   focus/blur — within 1 s of the tab's previous focus/blur, with no
//                opposite transition in between
export async function findDuplicateEventIds(
  // Loose table type: called with both the typed db.events and the untyped
  // table handle inside a version-upgrade transaction.
  events: { orderBy(index: string): { each(cb: (e: TabEvent) => void): Promise<unknown> } },
): Promise<number[]> {
  const lastNav = new Map<number, { url?: string; ts: number }>();
  const lastFocusEdge = new Map<number, { type: string; ts: number }>();
  const dup: number[] = [];
  await events.orderBy('ts').each((e: TabEvent) => {
    if (e.tabId === undefined || e.id === undefined) return;
    if (e.type === 'navigate') {
      const prev = lastNav.get(e.tabId);
      if (prev && prev.url === e.url && e.ts - prev.ts < 1000) dup.push(e.id);
      else lastNav.set(e.tabId, { url: e.url, ts: e.ts });
    } else if (e.type === 'focus' || e.type === 'blur') {
      const prev = lastFocusEdge.get(e.tabId);
      if (prev && prev.type === e.type && e.ts - prev.ts < 1000) dup.push(e.id);
      else lastFocusEdge.set(e.tabId, { type: e.type, ts: e.ts });
    }
  });
  return dup;
}

export const db = new ChromeHomepageDB();

export function extractDomain(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:') {
      return u.protocol.replace(':', '');
    }
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
