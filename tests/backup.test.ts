// Backup / restore / debug bundle — the page-side I/O path.
import { describe, expect, it } from 'vitest';
import { freshWorld, HOUR } from './harness';
import type { TabEvent } from '../src/shared/types';

function ev(p: Partial<TabEvent> & { type: TabEvent['type']; ts: number }): TabEvent {
  const d = new Date(p.ts);
  return { hourOfDay: d.getHours(), dayOfWeek: d.getDay(), ...p } as TabEvent;
}

describe('zip', () => {
  it('round-trips DEFLATE and STORE entries through the central directory', async () => {
    const { readZip, writeZip } = await import('../src/shared/zip');
    const big = new TextEncoder().encode(JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ i, url: 'https://a.com/' }))));
    const tiny = new TextEncoder().encode('{}');
    const zip = await writeZip([
      { name: 'big.json', data: big },
      { name: 'tiny.json', data: tiny },
    ]);
    expect(zip.length).toBeLessThan(big.length / 5); // actually compressed
    const out = await readZip(zip);
    expect(out.get('big.json')).toEqual(big);
    expect(out.get('tiny.json')).toEqual(tiny);
  });
});

describe('backup files', () => {
  it('export → import (replace) restores every table; gzip and legacy plain JSON both parse', async () => {
    const w = await freshWorld();
    const { readAllTables, encodeBackup, parseBackupFile, writeDumpToDb } = await import('../src/shared/backup');
    const t = Date.now() - HOUR;
    await w.db.events.bulkAdd([
      ev({ type: 'open', ts: t, tabId: 1, url: 'https://a.com/', domain: 'a.com' }),
      ev({ type: 'focus', ts: t + 10, tabId: 1, url: 'https://a.com/', domain: 'a.com' }),
    ]);
    await w.db.kv.put({ key: 'model:test', value: { w: [1, 2] }, updatedAt: t });
    await w.db.pins.add({ key: 'https://a.com/', url: 'https://a.com/', title: 'A', domain: 'a.com', pinnedAt: t, manualOrder: 0 });

    const dump = await readAllTables();
    const gz = await encodeBackup(dump);
    expect(gz[0]).toBe(0x1f);
    const parsed = await parseBackupFile(gz);
    expect(parsed.kind).toBe('backup');
    const legacy = await parseBackupFile(new TextEncoder().encode(JSON.stringify(dump)));
    expect(legacy.kind).toBe('backup');

    await w.db.events.clear();
    await w.db.pins.clear();
    const r = await writeDumpToDb((parsed as { dump: unknown }).dump);
    expect(r.ok).toBe(true);
    expect(await w.db.events.count()).toBe(2);
    expect(await w.db.pins.count()).toBe(1);
    expect((await w.db.kv.get('model:test'))?.value).toEqual({ w: [1, 2] });
  });

  it('a debug bundle merges idempotently and survives re-zipping into a folder', async () => {
    const w = await freshWorld();
    const { buildDebugBundle, parseBackupFile, writeDumpToDb } = await import('../src/shared/backup');
    const { readZip, writeZip } = await import('../src/shared/zip');
    const t = Date.now() - 2 * HOUR;
    await w.db.events.bulkAdd([
      ev({ type: 'open', ts: t, tabId: 1, url: 'https://a.com/', domain: 'a.com' }),
      ev({ type: 'open', ts: t + 60_000, tabId: 2, url: 'https://b.com/', domain: 'b.com' }),
    ]);
    const { bytes } = await buildDebugBundle({ cleanup: ['x'], recommend: ['y'] });

    // Simulate Finder: unzip → folder → re-zip.
    const entries = await readZip(bytes);
    const rezipped = await writeZip([...entries].map(([name, data]) => ({ name: `augur-debug/${name}`, data })));

    const parsed = await parseBackupFile(rezipped);
    expect(parsed.kind).toBe('bundle');
    // Fresh install that has since logged one event of its own.
    await w.db.events.clear();
    await w.db.events.add(ev({ type: 'open', ts: Date.now(), tabId: 9, url: 'https://c.com/', domain: 'c.com' }));
    const dump = (parsed as { dump: unknown }).dump;
    const first = await writeDumpToDb(dump, { merge: true });
    expect(first.counts?.events).toBe(2);
    const second = await writeDumpToDb(dump, { merge: true });
    expect(second.counts?.events).toBe(0);
    expect(await w.db.events.count()).toBe(3);
  });

  it('rejects files that are not Augur backups', async () => {
    await freshWorld();
    const { parseBackupFile, writeDumpToDb } = await import('../src/shared/backup');
    expect((await parseBackupFile(new TextEncoder().encode('not json'))).kind).toBe('invalid');
    const r = await writeDumpToDb({ hello: 1 });
    expect(r).toMatchObject({ ok: false, reason: 'not-augur-backup' });
  });
});
