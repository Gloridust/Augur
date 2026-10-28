// Backup, restore and debug-bundle I/O — pure database work, safe to run in
// the dashboard page as well as the service worker.
//
// Why the page does it: chrome.runtime messages are capped at 64 MiB of
// JSON. A year of events is past that, so routing a full dump through
// sendMessage (export) or posting a parsed file back to the SW (import)
// failed outright for exactly the users whose history is worth saving. The
// page shares the extension's IndexedDB origin, so it reads and writes the
// tables directly; the SW is only asked to flush its pending model writes
// first (data.flush) and to drop its in-memory caches afterwards
// (data.invalidate). See SettingsDialog.

import { db, findDuplicateEventIds, MAINTENANCE_REBUILD_KEY } from './db';
import { loadErrorLog } from './errorlog';
import { gunzip, gzip, isGzip, isZip, readZip, writeZip } from './zip';

// The complete, restorable snapshot — this IS the backup AND the
// device-migration file. It carries everything that makes an Augur install
// "you": saved items (workspaces, pins, stash), trained intelligence (every
// model weight, embedding, bandit posterior, sequence memory, calibration —
// all in `kv`) and the raw event history the models learn from.
//
// schemaVersion 4 adds `pins` (v3 silently omitted them). Import tolerates
// v3 dumps (pins simply absent).
export interface DataDump {
  schemaVersion: 3 | 4;
  exportedAt: number;
  events: unknown[];
  feedback: unknown[];
  domains: unknown[];
  cooccurrence: unknown[];
  stash: unknown[];
  workspaces: unknown[];
  pins?: unknown[];
  kv: unknown[];
}

export interface ImportResult {
  ok: boolean;
  reason?: string;
  counts?: Record<string, number>;
}

export async function readAllTables(): Promise<DataDump> {
  const [events, feedback, domains, cooccurrence, stash, workspaces, pins, kv] = await Promise.all([
    db.events.toArray(),
    db.feedback.toArray(),
    db.domains.toArray(),
    db.cooccurrence.toArray(),
    db.stash.toArray(),
    db.workspaces.toArray(),
    db.pins.toArray(),
    db.kv.toArray(),
  ]);
  return {
    schemaVersion: 4,
    exportedAt: Date.now(),
    events,
    feedback,
    domains,
    cooccurrence,
    stash,
    workspaces,
    pins,
    kv,
  };
}

// Dedupe key for an event row. Events have an autoincrement `id` that is
// meaningless across installs, so identity is the observable tuple.
function eventKey(e: Record<string, unknown>): string {
  return `${e.ts}|${e.type}|${e.tabId ?? ''}|${e.url ?? ''}`;
}

function feedbackKey(f: Record<string, unknown>): string {
  return `${f.ts}|${f.surface ?? ''}|${f.domain ?? ''}|${f.action ?? ''}`;
}

// Strip the autoincrement PK so bulkAdd assigns fresh ids instead of
// colliding with rows that already exist in this install's table.
function stripId<T extends Record<string, unknown>>(row: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = row;
  return rest;
}

// Bundles exported by pre-queue builds carry duplicate navigate/focus/blur
// rows; drop them and flag the SW to rebuild derived aggregates from the
// cleaned log (see db.ts v5 migration). Returns the number removed.
async function dedupeAndFlagRebuild(): Promise<number> {
  const dups = await findDuplicateEventIds(db.events);
  if (dups.length) await db.events.bulkDelete(dups);
  await db.kv.put({
    key: MAINTENANCE_REBUILD_KEY,
    value: { reason: 'import', removed: dups.length },
    updatedAt: Date.now(),
  });
  return dups.length;
}

// Restore a backup into the database. Two modes:
//
//   merge=false (default): REPLACE. A migration target is normally a fresh
//   install; restoring means "make this device match the backup".
//
//   merge=true: UNION. For recovering lost history into an install that has
//   since accumulated its own data (the extension-ID-changed → fresh-DB
//   failure mode). Events/feedback are deduped on their observable tuple, so
//   importing the same bundle twice is idempotent. domains/cooccurrence are
//   NOT imported — they're derived, and the caller runs the warm-up chain
//   which rebuilds them from the merged log. kv keeps local values and only
//   adopts keys absent locally: the warm-up retrains on the union, which
//   beats month-old weights.
//
// The caller must invalidate the service worker's caches before and after
// (data.invalidate) so no stale in-memory model is written back over it.
export async function writeDumpToDb(raw: unknown, opts: { merge?: boolean } = {}): Promise<ImportResult> {
  const dump = raw as Partial<DataDump> | null;
  if (!dump || typeof dump !== 'object' || !Array.isArray(dump.events) || !Array.isArray(dump.kv)) {
    return { ok: false, reason: 'not-augur-backup' };
  }
  const tables = {
    events: dump.events ?? [],
    feedback: dump.feedback ?? [],
    domains: dump.domains ?? [],
    cooccurrence: dump.cooccurrence ?? [],
    stash: dump.stash ?? [],
    workspaces: dump.workspaces ?? [],
    pins: dump.pins ?? [],
    kv: dump.kv ?? [],
  };

  if (opts.merge) {
    const added: Record<string, number> = {};
    await db.transaction('rw', [db.events, db.feedback, db.stash, db.workspaces, db.pins, db.kv], async () => {
      const seenEv = new Set((await db.events.toArray()).map((e) => eventKey(e as never)));
      const newEvents = (tables.events as Record<string, unknown>[])
        .filter((e) => e && typeof e.ts === 'number' && !seenEv.has(eventKey(e)))
        .map(stripId);
      await db.events.bulkAdd(newEvents as never[]);
      added.events = newEvents.length;

      const seenFb = new Set((await db.feedback.toArray()).map((f) => feedbackKey(f as never)));
      const newFb = (tables.feedback as Record<string, unknown>[])
        .filter((f) => f && typeof f.ts === 'number' && !seenFb.has(feedbackKey(f)))
        .map(stripId);
      await db.feedback.bulkAdd(newFb as never[]);
      added.feedback = newFb.length;

      const stashUrls = new Set((await db.stash.toArray()).map((s) => s.url));
      const newStash = (tables.stash as Record<string, unknown>[])
        .filter((s) => s?.url && !stashUrls.has(s.url as string))
        .map(stripId);
      await db.stash.bulkAdd(newStash as never[]);
      added.stash = newStash.length;

      const wsNames = new Set((await db.workspaces.toArray()).map((w) => w.name));
      const newWs = (tables.workspaces as Record<string, unknown>[])
        .filter((w) => w?.name && !wsNames.has(w.name as string))
        .map(stripId);
      await db.workspaces.bulkAdd(newWs as never[]);
      added.workspaces = newWs.length;

      const pinKeys = new Set((await db.pins.toArray()).map((p) => p.key));
      const newPins = (tables.pins as Record<string, unknown>[]).filter(
        (p) => p?.key && !pinKeys.has(p.key as string),
      );
      await db.pins.bulkPut(newPins as never[]);
      added.pins = newPins.length;

      const localKv = new Set((await db.kv.toArray()).map((r) => r.key));
      const newKv = (tables.kv as Record<string, unknown>[]).filter(
        (r) => r?.key && !localKv.has(r.key as string),
      );
      await db.kv.bulkPut(newKv as never[]);
      added.kv = newKv.length;
    });
    added.duplicatesRemoved = await dedupeAndFlagRebuild();
    return { ok: true, counts: added };
  }

  await db.transaction(
    'rw',
    [db.events, db.feedback, db.domains, db.cooccurrence, db.stash, db.workspaces, db.pins, db.kv],
    async () => {
      await Promise.all([
        db.events.clear(),
        db.feedback.clear(),
        db.domains.clear(),
        db.cooccurrence.clear(),
        db.stash.clear(),
        db.workspaces.clear(),
        db.pins.clear(),
        db.kv.clear(),
      ]);
      await Promise.all([
        db.events.bulkAdd(tables.events as never[]),
        db.feedback.bulkAdd(tables.feedback as never[]),
        db.domains.bulkPut(tables.domains as never[]),
        db.cooccurrence.bulkPut(tables.cooccurrence as never[]),
        db.stash.bulkAdd(tables.stash as never[]),
        db.workspaces.bulkAdd(tables.workspaces as never[]),
        db.pins.bulkAdd(tables.pins as never[]),
        db.kv.bulkPut(tables.kv as never[]),
      ]);
    },
  );
  const duplicatesRemoved = await dedupeAndFlagRebuild();
  return {
    ok: true,
    counts: {
      ...Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, (v as unknown[]).length])),
      duplicatesRemoved,
    },
  };
}

// ── Files ────────────────────────────────────────────────────────────────

// Local calendar date/time — the user's "today", not UTC's.
function localStamp(d: Date, withTime: boolean): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${date}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}` : date;
}

export function backupFilename(now = new Date()): string {
  return `augur-backup-${localStamp(now, false)}.json.gz`;
}

// Backup file = gzip(JSON(DataDump)). Plain .json backups from older
// versions are still accepted by parseBackupFile.
export async function encodeBackup(dump: DataDump): Promise<Uint8Array> {
  return gzip(new TextEncoder().encode(JSON.stringify(dump)));
}

export type ParsedBackup =
  | { kind: 'backup'; dump: unknown } // full backup → REPLACE
  | { kind: 'bundle'; dump: DataDump } // debug bundle → MERGE
  | { kind: 'invalid' };

export async function parseBackupFile(bytes: Uint8Array): Promise<ParsedBackup> {
  try {
    if (isZip(bytes)) {
      const dump = await debugBundleToDump(bytes);
      return dump ? { kind: 'bundle', dump } : { kind: 'invalid' };
    }
    const raw = isGzip(bytes) ? await gunzip(bytes) : bytes;
    return { kind: 'backup', dump: JSON.parse(new TextDecoder().decode(raw)) };
  } catch {
    return { kind: 'invalid' };
  }
}

// Reassemble a DataDump from a debug-bundle zip. Matches entries by base
// name, so a bundle unzipped and re-zipped into a folder still opens.
// Returns null when the mandatory tables are missing.
export async function debugBundleToDump(bytes: Uint8Array): Promise<DataDump | null> {
  const entries = new Map<string, Uint8Array>();
  for (const [name, data] of await readZip(bytes)) {
    const base = name.split('/').pop()!;
    if (!base.startsWith('.') && !name.startsWith('__MACOSX/')) entries.set(base, data);
  }
  const dec = new TextDecoder();
  const json = <T>(name: string): T | undefined => {
    const raw = entries.get(name);
    if (!raw) return undefined;
    try {
      return JSON.parse(dec.decode(raw)) as T;
    } catch {
      return undefined;
    }
  };
  const events = json<unknown[]>('events.json');
  const kv = json<unknown[]>('kv.json');
  if (!Array.isArray(events) || !Array.isArray(kv)) return null;
  const manifest = json<{ exportedAt?: number }>('MANIFEST.json');
  return {
    schemaVersion: 4,
    exportedAt: manifest?.exportedAt ?? Date.now(),
    events,
    feedback: json<unknown[]>('feedback.json') ?? [],
    domains: json<unknown[]>('domains.json') ?? [],
    cooccurrence: json<unknown[]>('cooccurrence.json') ?? [],
    stash: json<unknown[]>('stash.json') ?? [],
    workspaces: json<unknown[]>('workspaces.json') ?? [],
    pins: json<unknown[]>('pins.json') ?? [],
    kv,
  };
}

const BUNDLE_SCHEMA = `# Augur debug bundle

This zip contains a snapshot of one user's local Augur state at the time of
export. Intended for **model post-hoc analysis** — what the recommend /
cleanup heads predicted, what the user did, where the model was wrong.

## Files

| File | Contents |
|---|---|
| MANIFEST.json | Export metadata + counts + feature name arrays |
| events.json | Raw \`db.events\` — every observed tab/window/group event |
| feedback.json | Raw \`db.feedback\` — explicit user accept/dismiss actions |
| domains.json | Aggregated per-domain stats (visit counts, hour/dow histograms, decayed frecency) |
| cooccurrence.json | Domain pair co-occurrence counts (decayed at read time from lastSeen) |
| stash.json | Currently-stashed tabs |
| workspaces.json | Saved workspaces |
| pins.json | Pinned shortcuts |
| errors.json | Persisted error ring-buffer (last 200 swallowed/uncaught errors): \`{ts, context, message, stack}\`. Empty = no failures recorded. |
| kv.json | Model weights, bandit posteriors, embeddings, sequence memory, transition model, forest, MLP, circadian histogram, URL-prefix table, eval history. |

## Privacy

This bundle includes the user's full browsing event history and trained
model weights. Treat it like raw browsing data. The user explicitly
clicked "Export debug bundle" — they're consenting to share this with
whoever they hand the file to (typically an Augur developer for review).

## Reproducing predictions

The KV entries contain serialized weights you can reload via the
\`OnlineLogReg.load()\`, \`BetaBandit\`, \`SkipGramEmbedding\`, \`RandomForest\`
constructors. Combined with \`featureNames\` in MANIFEST you can replay the
point-in-time feature builder (src/ml/pit.ts + candidate-features.ts)
offline to debug specific predictions.
`;

export async function buildDebugBundle(
  featureNames: { cleanup: readonly string[]; recommend: readonly string[] },
): Promise<{ filename: string; bytes: Uint8Array }> {
  const [dump, errorLog] = await Promise.all([readAllTables(), loadErrorLog()]);
  const exportedAt = dump.exportedAt;
  const manifest = {
    augurDebugBundle: 1,
    exportedAt,
    exportedAtIso: new Date(exportedAt).toISOString(),
    counts: {
      events: dump.events.length,
      feedback: dump.feedback.length,
      domains: dump.domains.length,
      cooccurrence: dump.cooccurrence.length,
      stash: dump.stash.length,
      workspaces: dump.workspaces.length,
      pins: dump.pins?.length ?? 0,
      kvEntries: dump.kv.length,
      errors: errorLog.length,
    },
    featureNames,
  };
  // Compact JSON: the bundle is DEFLATEd anyway, and pretty-printing a
  // 100k-row event log doubles the work for no reader benefit.
  const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
  const bytes = await writeZip(
    [
      { name: 'MANIFEST.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) },
      { name: 'SCHEMA.md', data: new TextEncoder().encode(BUNDLE_SCHEMA) },
      { name: 'events.json', data: enc(dump.events) },
      { name: 'feedback.json', data: enc(dump.feedback) },
      { name: 'domains.json', data: enc(dump.domains) },
      { name: 'cooccurrence.json', data: enc(dump.cooccurrence) },
      { name: 'stash.json', data: enc(dump.stash) },
      { name: 'workspaces.json', data: enc(dump.workspaces) },
      { name: 'pins.json', data: enc(dump.pins ?? []) },
      { name: 'kv.json', data: enc(dump.kv) },
      { name: 'errors.json', data: enc(errorLog) },
    ],
    new Date(exportedAt),
  );
  const stamp = localStamp(new Date(exportedAt), true);
  return { filename: `augur-debug-${stamp}.zip`, bytes };
}
