import { db } from '../shared/db';
import { discardDirty, flushAll } from './flush';
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

export type { DataDump, ImportResult } from '../shared/backup';

// Backup / restore / debug-bundle I/O runs in the dashboard page (see
// shared/backup.ts — a full dump does not fit through a 64 MiB runtime
// message). The service worker's part is these two hooks around it.

// Before the page reads the tables: write pending model state to kv so the
// export is current. Returns what the page can't know without importing the
// ML modules.
export async function flushForExport(): Promise<{
  featureNames: { cleanup: readonly string[]; recommend: readonly string[] };
}> {
  await flushAll();
  return { featureNames: { cleanup: CLEANUP_FEATURE_NAMES, recommend: RECOMMEND_FEATURE_NAMES } };
}

// Around a page-side import: drop every pending write and in-memory model so
// nothing stale is written back over the imported tables and the next use
// reloads from the database. Called both before and after the write.
export function invalidateAfterExternalWrite(): void {
  discardDirty();
  clearAllCaches();
}

function clearAllCaches(): void {
  clearCleanupCaches();
  clearRecommendCaches();
  clearEmbeddingCache();
  clearCircadianCache();
  clearUrlPrefixCache();
  clearDomainTextCache();
  clearBlendCalibCache();
}

export async function resetModelsOnly(): Promise<void> {
  discardDirty(); // stale in-memory copies must not be written back afterwards
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
  invalidateAfterExternalWrite();
}

export async function wipeAll(): Promise<void> {
  discardDirty(); // stale in-memory copies must not be written back afterwards
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
  invalidateAfterExternalWrite();
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
