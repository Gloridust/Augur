// Data-layer tests: schema migration, aggregates, insights, replay.
import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import Dexie from 'dexie';
import { freshWorld, HOUR } from './harness';
import type { TabEvent } from '../src/shared/types';

function ev(p: Partial<TabEvent> & { type: TabEvent['type']; ts: number }): TabEvent {
  const d = new Date(p.ts);
  return { hourOfDay: d.getHours(), dayOfWeek: d.getDay(), ...p } as TabEvent;
}

describe('v5 schema migration', () => {
  it('removes duplicate navigate/focus/blur rows written by the old SW and flags an aggregate rebuild', async () => {
    const factory = new IDBFactory();
    (globalThis as { indexedDB?: unknown }).indexedDB = factory;
    Dexie.dependencies.indexedDB = factory;

    // An install at schema v4 with the July-2026 duplicate patterns.
    const old = new Dexie('augur');
    old.version(1).stores({
      events: '++id, ts, type, tabId, domain, url, [domain+ts], [type+ts]',
      feedback: '++id, ts, surface, domain, action',
      domains: 'domain, lastVisit, visitsDecay, updatedAt',
      cooccurrence: 'pair, a, b, count, lastSeen',
      kv: 'key, updatedAt',
    });
    old.version(2).stores({ stash: '++id, stashedAt, domain, source, url' });
    old.version(3).stores({ workspaces: '++id, name, updatedAt, createdAt' });
    old.version(4).stores({ pins: '++id, &key, pinnedAt, manualOrder' });
    const t = 1_700_000_000_000;
    await old.table('events').bulkAdd([
      ev({ type: 'navigate', ts: t, tabId: 1, url: 'https://a.com/x', domain: 'a.com' }),
      ev({ type: 'navigate', ts: t + 1, tabId: 1, url: 'https://a.com/x', domain: 'a.com' }), // dup
      ev({ type: 'navigate', ts: t + 5000, tabId: 1, url: 'https://a.com/x', domain: 'a.com' }), // revisit, keep
      ev({ type: 'blur', ts: t + 6000, tabId: 1, domain: 'a.com', focusMs: 900 }),
      ev({ type: 'blur', ts: t + 6001, tabId: 1, domain: 'a.com', focusMs: 900 }), // dup
      ev({ type: 'focus', ts: t + 7000, tabId: 2, domain: 'b.com' }),
      ev({ type: 'focus', ts: t + 7002, tabId: 2, domain: 'b.com' }), // dup
    ]);
    old.close();

    vi.resetModules();
    const { db, MAINTENANCE_REBUILD_KEY } = await import('../src/shared/db');
    await db.open();
    const rows = await db.events.orderBy('ts').toArray();
    expect(rows.map((r) => r.ts - t)).toEqual([0, 5000, 6000, 7000]);
    expect((await db.kv.get(MAINTENANCE_REBUILD_KEY))?.value).toMatchObject({ removed: 3 });
    db.close();
  });
});

describe('aggregates', () => {
  it('counts a visit only on ARRIVAL — same-domain SPA navigations are not visits', async () => {
    const w = await freshWorld();
    const { rebuildFromEvents } = await import('../src/ml/aggregate');
    const t = Date.now() - HOUR;
    await w.db.events.bulkAdd([
      ev({ type: 'open', ts: t, tabId: 1, url: 'https://app.com/', domain: 'app.com' }),
      ev({ type: 'navigate', ts: t + 1000, tabId: 1, url: 'https://app.com/a', domain: 'app.com' }),
      ev({ type: 'navigate', ts: t + 2000, tabId: 1, url: 'https://app.com/b', domain: 'app.com' }),
      ev({ type: 'navigate', ts: t + 3000, tabId: 1, url: 'https://docs.com/', domain: 'docs.com' }),
      ev({ type: 'navigate', ts: t + 4000, tabId: 1, url: 'https://app.com/c', domain: 'app.com' }),
    ]);
    await rebuildFromEvents();
    expect((await w.db.domains.get('app.com'))?.visitCount).toBe(2); // open + return from docs
    expect((await w.db.domains.get('docs.com'))?.visitCount).toBe(1);
    const pair = await w.db.cooccurrence.get('app.com::docs.com');
    expect(pair?.count).toBeCloseTo(2, 4); // docs after app, app after docs (exact decay between)
  });

  it('live path: a same-domain navigate does not bump visits; a cross-domain one does', async () => {
    const w = await freshWorld();
    await w.openTab({ id: 1, windowId: 1, url: 'https://app.com/' });
    for (const url of ['https://app.com/a', 'https://app.com/b', 'https://other.com/']) {
      w.mock.tabs.get(1)!.url = url;
      await w.c.tabs.onUpdated.fire(1, { url }, { ...w.mock.tabs.get(1)! });
    }
    await w.settle();
    expect((await w.db.domains.get('app.com'))?.visitCount).toBe(1);
    expect((await w.db.domains.get('other.com'))?.visitCount).toBe(1);
    // ...but every navigate is still in the log.
    expect(await w.db.events.where('[type+ts]').between(['navigate', 0], ['navigate', Infinity]).count()).toBe(3);
  });
});

describe('insights', () => {
  it("today's tabs-opened count comes from the [type+ts] index", async () => {
    const w = await freshWorld();
    const { buildTodayRecap } = await import('../src/ml/insights');
    const now = Date.now();
    const yesterday = now - 30 * HOUR;
    await w.db.events.bulkAdd([
      ev({ type: 'open', ts: yesterday, tabId: 9, domain: 'x.com' }),
      ev({ type: 'open', ts: now - 60_000, tabId: 1, domain: 'a.com' }),
      ev({ type: 'open', ts: now - 30_000, tabId: 2, domain: 'b.com' }),
      ev({ type: 'navigate', ts: now - 20_000, tabId: 3, domain: 'c.com' }),
    ]);
    const r = await buildTodayRecap(now);
    expect(r.tabsOpened).toBe(2);
  });
});

describe('replay trainer', () => {
  it('trains the open head on switch-opens and the cleanup head on refocus/close outcomes', async () => {
    const w = await freshWorld();
    const { replayImplicitTraining } = await import('../src/ml/rf-train');
    const t = Date.now() - 10 * HOUR;
    const rows: TabEvent[] = [];
    // Tabs 1 (a.com) and 2 (b.com); user ping-pongs, then leaves tab 1 in the
    // background for 2h and comes back; tab 3 is opened, backgrounded, closed 3h later.
    rows.push(ev({ type: 'open', ts: t, tabId: 1, url: 'https://a.com/', domain: 'a.com' }));
    rows.push(ev({ type: 'focus', ts: t + 10, tabId: 1, url: 'https://a.com/', domain: 'a.com' }));
    rows.push(ev({ type: 'open', ts: t + 5 * 60_000, tabId: 2, url: 'https://b.com/', domain: 'b.com' }));
    rows.push(ev({ type: 'blur', ts: t + 5 * 60_000 + 5, tabId: 1, domain: 'a.com', focusMs: 300_000 }));
    rows.push(ev({ type: 'focus', ts: t + 5 * 60_000 + 10, tabId: 2, url: 'https://b.com/', domain: 'b.com', prevTabId: 1 }));
    rows.push(ev({ type: 'open', ts: t + 20 * 60_000, tabId: 3, url: 'https://c.com/', domain: 'c.com' }));
    rows.push(ev({ type: 'blur', ts: t + 2 * HOUR, tabId: 2, domain: 'b.com', focusMs: 1000 }));
    rows.push(ev({ type: 'focus', ts: t + 2 * HOUR + 10, tabId: 1, url: 'https://a.com/', domain: 'a.com', prevTabId: 2 })); // refocused after ~2h
    rows.push(ev({ type: 'close', ts: t + 3 * HOUR, tabId: 3, url: 'https://c.com/', domain: 'c.com' })); // closed, never viewed
    await w.db.events.bulkAdd(rows);

    const r = await replayImplicitTraining();
    expect(r.openSamples).toBeGreaterThanOrEqual(1); // b.com and/or c.com opens
    expect(r.cleanupSamples).toBe(2); // tab 1 refocused, tab 3 closed
  });
});
