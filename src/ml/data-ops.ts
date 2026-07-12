import { db } from '../shared/db';
import { loadErrorLog } from '../shared/errorlog';
import type { DataSummary } from '../shared/types';
import { clearCleanupCaches } from './cleanup';
import { clearCircadianCache } from './circadian';
import { clearUrlPrefixCache } from './urlprefix';
import { clearDomainTextCache } from './domaintext';
import { clearBlendCalibCache } from './blendcalib';
import { clearEmbeddingCache, getEmbedding } from './embedding-train';
import { CLEANUP_FEATURE_NAMES, RECOMMEND_FEATURE_NAMES } from './features';
import { clearRecommendCaches } from './recommend';
import {
  loadBandit,
  loadCleanupModel,
  loadRecommendModel,
} from './persistence';
import { bytesToBase64, writeZip } from './zip-writer';

// The complete, restorable snapshot — this IS the backup AND the
// device-migration file. It carries everything that makes an Augur install
// "you": your saved items (workspaces, pins, stash) AND your trained
// intelligence (every model weight, embedding, bandit posterior, sequence
// memory, calibration — all in `kv`) AND the raw event history the models
// learn from. Restored via importAll(), a new device is immediately as
// smart as the old one — no weeks of cold-start retraining.
//
// schemaVersion 4 adds `pins` (v3 silently omitted them — a real bug in the
// old "full backup"). Import tolerates v3 dumps (pins simply absent).
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

export async function exportAll(): Promise<DataDump> {
  const [events, feedback, domains, cooccurrence, stash, workspaces, pins, kv] =
    await Promise.all([
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

export interface ImportResult {
  ok: boolean;
  reason?: string;
  counts?: Record<string, number>;
}

// Dedupe key for an event row. Events have an autoincrement `id` that is
// meaningless across installs, so identity is the observable tuple. Two
// legitimate events landing on the same (ts, type, tabId, url) in the same
// millisecond don't exist in practice (Chrome delivers listener callbacks
// serially and logEvent stamps Date.now()).
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

// Restore a full backup onto this device — the other half of migration that
// was missing. Two modes:
//
//   merge=false (default): REPLACE. A migration target is normally a fresh
//   install; restoring means "make this device match the backup".
//
//   merge=true: UNION. For recovering lost history into an install that has
//   since accumulated its own data (the extension-ID-changed → fresh-DB
//   failure mode). Events/feedback are deduped on their observable tuple, so
//   importing the same bundle twice is idempotent. domains/cooccurrence are
//   NOT imported in merge mode — they're derived tables, and the caller is
//   expected to run the warm-up chain (aggregate.rebuild → embedding →
//   sequence.rebuild → lr.replay → forest.retrain) which rebuilds them from
//   the merged event log. kv (model weights) keeps local values and only
//   adopts imported keys that don't exist locally, for the same reason: the
//   warm-up retrains on the union, which beats month-old weights.
//
// Caller confirms first; the dashboard reloads afterward so the SW re-reads
// models.
export async function importAll(
  raw: unknown,
  opts: { merge?: boolean } = {},
): Promise<ImportResult> {
  const merge = opts.merge ?? false;
  const dump = raw as Partial<DataDump> | null;
  if (
    !dump ||
    typeof dump !== 'object' ||
    !Array.isArray(dump.events) ||
    !Array.isArray(dump.kv)
  ) {
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

  if (merge) {
    const added: Record<string, number> = {};
    await db.transaction(
      'rw',
      [db.events, db.feedback, db.stash, db.workspaces, db.pins, db.kv],
      async () => {
        // Events: union with dedupe.
        const existingEvents = await db.events.toArray();
        const seenEv = new Set(existingEvents.map((e) => eventKey(e as never)));
        const newEvents = (tables.events as Record<string, unknown>[])
          .filter((e) => e && typeof e.ts === 'number' && !seenEv.has(eventKey(e)))
          .map(stripId);
        await db.events.bulkAdd(newEvents as never[]);
        added.events = newEvents.length;

        // Feedback: union with dedupe.
        const existingFb = await db.feedback.toArray();
        const seenFb = new Set(existingFb.map((f) => feedbackKey(f as never)));
        const newFb = (tables.feedback as Record<string, unknown>[])
          .filter((f) => f && typeof f.ts === 'number' && !seenFb.has(feedbackKey(f)))
          .map(stripId);
        await db.feedback.bulkAdd(newFb as never[]);
        added.feedback = newFb.length;

        // User artifacts: add imported rows that don't collide on content.
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

        // kv: local wins; adopt only keys absent locally (e.g. evalHistory
        // from the old install). The warm-up chain retrains weights anyway.
        const localKv = new Set((await db.kv.toArray()).map((r) => r.key));
        const newKv = (tables.kv as Record<string, unknown>[]).filter(
          (r) => r?.key && !localKv.has(r.key as string),
        );
        await db.kv.bulkPut(newKv as never[]);
        added.kv = newKv.length;
      },
    );

    clearCleanupCaches();
    clearRecommendCaches();
    clearEmbeddingCache();
    clearCircadianCache();
    clearUrlPrefixCache();
    clearDomainTextCache();
    clearBlendCalibCache();
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

  // Drop every in-memory cache so the SW reloads models from the imported kv.
  clearCleanupCaches();
  clearRecommendCaches();
  clearEmbeddingCache();
  clearCircadianCache();
  clearUrlPrefixCache();
  clearDomainTextCache();
  clearBlendCalibCache();

  return {
    ok: true,
    counts: Object.fromEntries(
      Object.entries(tables).map(([k, v]) => [k, (v as unknown[]).length]),
    ),
  };
}

// Debug bundle for ML / model post-hoc analysis. Splits each table into its
// own JSON file inside a ZIP, plus a SCHEMA.md with field documentation
// and a MANIFEST.json with versions / counts / timestamps. The split-file
// layout means analysts can `import pandas as pd; pd.read_json('events.json')`
// and similar without parsing a 50MB monolithic dump.
export interface DebugBundleResult {
  filename: string;
  base64: string;
  size: number;
}

export async function exportDebugBundle(): Promise<DebugBundleResult> {
  const [events, feedback, domains, cooccurrence, stash, workspaces, pins, kv, errorLog] =
    await Promise.all([
      db.events.toArray(),
      db.feedback.toArray(),
      db.domains.toArray(),
      db.cooccurrence.toArray(),
      db.stash.toArray(),
      db.workspaces.toArray(),
      db.pins.toArray(),
      db.kv.toArray(),
      loadErrorLog(),
    ]);

  const exportedAt = Date.now();
  const manifest = {
    augurDebugBundle: 1,
    exportedAt,
    exportedAtIso: new Date(exportedAt).toISOString(),
    counts: {
      events: events.length,
      feedback: feedback.length,
      domains: domains.length,
      cooccurrence: cooccurrence.length,
      stash: stash.length,
      workspaces: workspaces.length,
      pins: pins.length,
      kvEntries: kv.length,
      errors: errorLog.length,
    },
    featureNames: {
      cleanup: CLEANUP_FEATURE_NAMES,
      recommend: RECOMMEND_FEATURE_NAMES,
    },
  };

  const schema = `# Augur debug bundle

This zip contains a snapshot of one user's local Augur state at the time of
export. Intended for **model post-hoc analysis** — what the recommend /
cleanup heads predicted, what the user did, where the model was wrong.

## Files

| File | Contents |
|---|---|
| MANIFEST.json | Export metadata + counts + feature name arrays |
| events.json | Raw \`db.events\` — every observed tab/window/group event |
| feedback.json | Raw \`db.feedback\` — explicit user accept/dismiss actions |
| domains.json | Aggregated per-domain stats (visit counts, hour/dow histograms, etc.) |
| cooccurrence.json | Domain pair co-occurrence counts |
| stash.json | Currently-stashed tabs |
| workspaces.json | Saved workspaces |
| pins.json | Pinned shortcuts |
| errors.json | Persisted error ring-buffer (last 200 swallowed/uncaught errors): \`{ts, context, message, stack}\`. Empty = no failures recorded. |
| kv.json | Model weights, bandit posteriors, embeddings, sequence memory, forest, \
circadian histogram, URL-prefix table, eval history. Keys: \`model:cleanup:vN\`, \
\`model:recommend:vN\`, \`model:recommend:forest:vN\`, \`bandit:cleanup:v1\`, \
\`bandit:recommend:v1\`, \`embedding:v1\`, \`sequenceMemory:v1\`, \`circadian:v1\`, \
\`urlPrefixes:v1\`, \`evalHistory:v1\` |

## Privacy

This bundle includes the user's full browsing event history and trained
model weights. Treat it like raw browsing data. The user explicitly
clicked "Export debug bundle" — they're consenting to share this with
whoever they hand the file to (typically an Augur developer for review).

## Reproducing predictions

The KV entries contain serialized weights you can reload via the
\`OnlineLogReg.load()\`, \`BetaBandit\`, \`SkipGramEmbedding\`, \`RandomForest\`
constructors. Combined with \`feature_names\` in MANIFEST you can replay
\`recommendOpen\` / \`scoreCleanupCandidates\` offline to debug specific
predictions.
`;

  const stamp = new Date(exportedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const enc = (obj: unknown): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(obj, null, 2));

  const zipBytes = writeZip([
    { name: 'MANIFEST.json', data: enc(manifest) },
    { name: 'SCHEMA.md', data: new TextEncoder().encode(schema) },
    { name: 'events.json', data: enc(events) },
    { name: 'feedback.json', data: enc(feedback) },
    { name: 'domains.json', data: enc(domains) },
    { name: 'cooccurrence.json', data: enc(cooccurrence) },
    { name: 'stash.json', data: enc(stash) },
    { name: 'workspaces.json', data: enc(workspaces) },
    { name: 'pins.json', data: enc(pins) },
    { name: 'kv.json', data: enc(kv) },
    { name: 'errors.json', data: enc(errorLog) },
  ]);

  return {
    filename: `augur-debug-${stamp}.zip`,
    base64: bytesToBase64(zipBytes),
    size: zipBytes.length,
  };
}

export async function resetModelsOnly(): Promise<void> {
  // Clear just the learned weights — keep raw events, domains, co-occurrence,
  // stash, workspaces. Useful when the user wants the models to retrain from
  // their existing event log without losing history.
  const allKv = await db.kv.toArray();
  const modelKeys = allKv
    .map((row) => row.key)
    .filter(
      (k) =>
        k.startsWith('model:') ||
        k.startsWith('bandit:') ||
        k.startsWith('embedding:') ||
        k.startsWith('sequenceMemory:') ||
        k.startsWith('circadian:') ||
        k.startsWith('urlPrefixes:') ||
        k.startsWith('transition:') ||
        k.startsWith('domainText:') ||
        k.startsWith('blendCalib:') ||
        k === 'mlpEnabled:v1' ||
        k === 'lastEmbedTrainAt' ||
        k === 'lastAggregateAt',
    );
  await db.kv.bulkDelete(modelKeys);
  clearCleanupCaches();
  clearRecommendCaches();
  clearEmbeddingCache();
  clearCircadianCache();
  clearUrlPrefixCache();
  clearDomainTextCache();
  clearBlendCalibCache();
}

export async function wipeAll(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.events,
      db.feedback,
      db.domains,
      db.cooccurrence,
      db.stash,
      db.workspaces,
      db.kv,
    ],
    async () => {
      await Promise.all([
        db.events.clear(),
        db.feedback.clear(),
        db.domains.clear(),
        db.cooccurrence.clear(),
        db.stash.clear(),
        db.workspaces.clear(),
        db.kv.clear(),
      ]);
    },
  );
  // Also clear in-memory model + bandit caches so they reload as fresh.
  clearCleanupCaches();
  clearRecommendCaches();
  clearEmbeddingCache();
  clearCircadianCache();
  clearUrlPrefixCache();
  clearDomainTextCache();
  clearBlendCalibCache();
  try {
    if (chrome?.storage?.session) {
      await chrome.storage.session.clear();
    }
  } catch {
    // session storage isn't available in some contexts; ignore.
  }
}

const READY_THRESHOLD_EVENTS = 50;
const READY_THRESHOLD_LABELS = 5;

export async function getSummary(): Promise<DataSummary> {
  const [eventCount, domainCount, feedbackCount] = await Promise.all([
    db.events.count(),
    db.domains.count(),
    db.feedback.count(),
  ]);
  const first = await db.events.orderBy('ts').first();
  const last = await db.events.orderBy('ts').last();
  const cleanup = await loadCleanupModel(CLEANUP_FEATURE_NAMES.length);
  const recommend = await loadRecommendModel(RECOMMEND_FEATURE_NAMES.length);
  return {
    eventCount,
    domainCount,
    feedbackCount,
    cleanupTrainedSamples: cleanup.state.trainedSamples,
    cleanupPositiveSamples: cleanup.state.positiveSamples,
    recommendTrainedSamples: recommend.state.trainedSamples,
    recommendPositiveSamples: recommend.state.positiveSamples,
    firstEventAt: first?.ts ?? null,
    lastEventAt: last?.ts ?? null,
    recommendationsReady:
      eventCount >= READY_THRESHOLD_EVENTS || recommend.state.trainedSamples >= 20,
    cleanupReady:
      cleanup.state.trainedSamples >= READY_THRESHOLD_LABELS && eventCount >= 30,
  };
}

export interface HeadInspection {
  weights: Array<{ name: string; weight: number }>;
  bias: number;
  trainedSamples: number;
  positiveSamples: number;
  calibA: number;
  calibB: number;
  calibSamples: number;
}

export interface ModelInspection {
  cleanup: HeadInspection;
  recommend: HeadInspection;
  embedding: {
    dim: number;
    vocabSize: number;
    trainedSteps: number;
    updatedAt: number;
    sampleNeighbors: Array<{ domain: string; neighbors: Array<{ domain: string; cosine: number }> }>;
  };
  bandits: {
    cleanup: Array<{ id: string; alpha: number; beta: number; mean: number; impressions: number }>;
    recommend: Array<{ id: string; alpha: number; beta: number; mean: number; impressions: number }>;
  };
}

function topBanditArms(
  state: ReturnType<Awaited<ReturnType<typeof loadBandit>>['serialize']>,
  k = 12,
): Array<{ id: string; alpha: number; beta: number; mean: number; impressions: number }> {
  const rows = Object.entries(state.arms).map(([id, a]) => ({
    id,
    alpha: a.alpha,
    beta: a.beta,
    mean: a.alpha / (a.alpha + a.beta),
    impressions: a.impressions,
  }));
  return rows.sort((a, b) => b.impressions - a.impressions || b.mean - a.mean).slice(0, k);
}

export async function inspectModels(): Promise<ModelInspection> {
  const cleanup = await loadCleanupModel(CLEANUP_FEATURE_NAMES.length);
  const recommend = await loadRecommendModel(RECOMMEND_FEATURE_NAMES.length);
  const cleanupBandit = await loadBandit('cleanup');
  const recommendBandit = await loadBandit('recommend');
  const embedding = await getEmbedding();

  const cleanupWeights = CLEANUP_FEATURE_NAMES.map((name, i) => ({
    name: String(name),
    weight: cleanup.state.weights[i] ?? 0,
  }));
  const recommendWeights = RECOMMEND_FEATURE_NAMES.map((name, i) => ({
    name: String(name),
    weight: recommend.state.weights[i] ?? 0,
  }));

  // Top-3 most popular domains (by visit decay) → show their nearest neighbors.
  const domains = await db.domains.orderBy('visitsDecay').reverse().limit(3).toArray();
  const sampleNeighbors = domains
    .filter((d) => embedding.has(d.domain))
    .map((d) => ({ domain: d.domain, neighbors: embedding.topNeighbors(d.domain, 5) }));

  return {
    cleanup: {
      weights: cleanupWeights,
      bias: cleanup.state.bias,
      trainedSamples: cleanup.state.trainedSamples,
      positiveSamples: cleanup.state.positiveSamples,
      calibA: cleanup.state.calibA,
      calibB: cleanup.state.calibB,
      calibSamples: cleanup.state.calibSamples,
    },
    recommend: {
      weights: recommendWeights,
      bias: recommend.state.bias,
      trainedSamples: recommend.state.trainedSamples,
      positiveSamples: recommend.state.positiveSamples,
      calibA: recommend.state.calibA,
      calibB: recommend.state.calibB,
      calibSamples: recommend.state.calibSamples,
    },
    embedding: {
      dim: embedding.state.dim,
      vocabSize: embedding.vocabSize(),
      trainedSteps: embedding.state.trainedSteps,
      updatedAt: embedding.state.updatedAt,
      sampleNeighbors,
    },
    bandits: {
      cleanup: topBanditArms(cleanupBandit.serialize()),
      recommend: topBanditArms(recommendBandit.serialize()),
    },
  };
}
