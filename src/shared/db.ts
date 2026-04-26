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
  }
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
