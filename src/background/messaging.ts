import { rebuildFromEvents } from '../ml/aggregate';
import {
  cleanupSweep,
  recordCleanupImpressions,
  scoreCleanupCandidates,
  trainCleanupFeedback,
} from '../ml/cleanup';
import {
  exportAll,
  exportDebugBundle,
  importAll,
  getSummary,
  inspectModels,
  resetModelsOnly,
  wipeAll,
} from '../ml/data-ops';
import { db as sharedDb } from '../shared/db';
import type { TabEvent } from '../shared/types';
import { trainEmbeddingBatch } from '../ml/embedding-train';
import { bootstrapFromHistory } from '../ml/history-bootstrap';
import { buildInsights, buildTodayRecap } from '../ml/insights';
import {
  invalidateForestCache,
  mlpStatus,
  recommendOpen,
  recordRecommendImpressions,
  setMlpEnabled,
  trainRecommendFeedback,
} from '../ml/recommend';
import {
  rebuildSequenceMemory,
  replayImplicitTraining,
  trainRecommendForest,
} from '../ml/rf-train';
// Static imports for the on-demand model tools. These were `await import(...)`
// before, which made eval.ts a separate chunk loaded via a dynamic `import()`
// at runtime — and dynamic import() inside a service worker triggered Vite's
// DOM-based preload machinery ("document is not defined" on Run evaluation /
// backtest). Folding them into the SW's static graph removes every runtime
// import() from the worker. There's no circular dependency through messaging.
import { evaluateRecommend } from '../ml/eval';
import { loadEvalHistory } from '../ml/persistence';
import { rerankPins } from '../ml/pins';
import {
  deleteStashed,
  listStash,
  stashTabs,
  unstashOne,
} from '../ml/stash';
import {
  deleteWorkspace,
  listWorkspaces,
  restoreWorkspace,
  saveWorkspace,
  updateWorkspace,
} from '../ml/workspaces';
import { extractDomain } from '../shared/db';
import type { RpcRequest, RpcResponse } from '../shared/rpc';

// Log a product-surface event directly to db.events. Used by RPC handlers
// that mutate user state (pin add, stash, workspace save, etc.) so future
// models can train on these explicit user actions. Errors are swallowed —
// telemetry failure shouldn't break the originating action.
type EventPayload = Omit<TabEvent, 'ts' | 'hourOfDay' | 'dayOfWeek' | 'id'>;
async function logEvent(partial: EventPayload): Promise<void> {
  try {
    const now = new Date();
    await sharedDb.events.add({
      ...partial,
      ts: Date.now(),
      hourOfDay: now.getHours(),
      dayOfWeek: now.getDay(),
    });
  } catch {
    // ignore
  }
}

async function buildContext(): Promise<{
  hour: number;
  dow: number;
  focusedDomain?: string;
  openDomains: string[];
  pinnedDomains: string[];
  focusHistory: string[];
  sessionStartTs?: number;
}> {
  const now = new Date();
  const tabs = await chrome.tabs.query({});
  const openDomains = Array.from(
    new Set(tabs.map((t) => extractDomain(t.url)).filter(Boolean)),
  );
  const pinnedDomains = Array.from(
    new Set(
      tabs.filter((t) => t.pinned).map((t) => extractDomain(t.url)).filter(Boolean),
    ),
  );
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const focusedDomain = extractDomain(active?.url) || undefined;
  // Recent focus history from chrome.storage.session — populated by the
  // SW's startFocusSegment path. Used by sequence-memory predictors for
  // candidate generation and per-candidate scoring.
  const fhRaw = await chrome.storage.session.get(['augur:focusHistory', 'augur:session']);
  const focusHistory = Array.isArray(fhRaw['augur:focusHistory'])
    ? (fhRaw['augur:focusHistory'] as string[])
    : [];
  const sess = fhRaw['augur:session'] as { startTs: number } | undefined;
  return {
    hour: now.getHours(),
    dow: now.getDay(),
    focusedDomain,
    openDomains,
    pinnedDomains,
    focusHistory,
    sessionStartTs: sess?.startTs,
  };
}

async function handle(req: RpcRequest): Promise<RpcResponse> {
  try {
    switch (req.kind) {
      case 'recommend.open': {
        const ctx = await buildContext();
        const data = await recommendOpen(ctx);
        await recordRecommendImpressions(data);
        return { ok: true, kind: 'recommend.open', data };
      }
      case 'recommend.cleanup': {
        const tabs = await chrome.tabs.query({});
        const data = await scoreCleanupCandidates(tabs);
        await recordCleanupImpressions(data);
        return { ok: true, kind: 'recommend.cleanup', data };
      }
      case 'recommend.cleanup.all': {
        // Smart cleanup button — return all candidates above threshold (no
        // top-5 cap), so users with many zombie tabs can sweep them at once.
        // Hard ceiling at 50 to avoid pathological cases.
        const tabs = await chrome.tabs.query({});
        const cap = Math.min(req.limit ?? 50, 50);
        const data = await scoreCleanupCandidates(tabs, Date.now(), { bulk: true, limit: cap });
        await recordCleanupImpressions(data);
        return { ok: true, kind: 'recommend.cleanup.all', data };
      }
      case 'cleanup.sweep': {
        const tabs = await chrome.tabs.query({});
        const data = await cleanupSweep(tabs);
        await recordCleanupImpressions(data.candidates);
        return { ok: true, kind: 'cleanup.sweep', data };
      }
      case 'feedback.cleanup': {
        await trainCleanupFeedback(req.features, req.domain, req.reason, req.action);
        return { ok: true, kind: 'ack' };
      }
      case 'feedback.open': {
        await trainRecommendFeedback(req.domain, req.features, req.action);
        return { ok: true, kind: 'ack' };
      }
      case 'aggregate.rebuild': {
        await rebuildFromEvents();
        return { ok: true, kind: 'ack' };
      }
      case 'insights.get': {
        const data = await buildInsights();
        return { ok: true, kind: 'insights.get', data };
      }
      case 'data.summary': {
        const data = await getSummary();
        return { ok: true, kind: 'data.summary', data };
      }
      case 'data.export': {
        const data = await exportAll();
        return { ok: true, kind: 'data.export', data };
      }
      case 'data.wipe': {
        await wipeAll();
        return { ok: true, kind: 'ack' };
      }
      case 'data.resetModels': {
        await resetModelsOnly();
        return { ok: true, kind: 'ack' };
      }
      case 'data.bootstrapHistory': {
        const data = await bootstrapFromHistory({ force: req.force === true });
        return { ok: true, kind: 'data.bootstrapHistory', data };
      }
      case 'data.exportDebugBundle': {
        const data = await exportDebugBundle();
        return { ok: true, kind: 'data.exportDebugBundle', data };
      }
      case 'data.import': {
        const data = await importAll(req.dump);
        return { ok: true, kind: 'data.import', data };
      }
      case 'event.log': {
        // Dashboard-side product events (OracleHint accept, smart-cleanup
        // commit, search executed, etc). These are NOT inferable from
        // chrome.* events, so we let the dashboard write them directly to
        // db.events. We intentionally skip updateOnEvent / cooccurrence
        // updates — those are for tab-lifecycle events, not UI telemetry.
        const now = new Date();
        await sharedDb.events.add({
          ...req.partial,
          ts: Date.now(),
          hourOfDay: now.getHours(),
          dayOfWeek: now.getDay(),
        });
        return { ok: true, kind: 'ack' };
      }
      case 'model.inspect': {
        const data = await inspectModels();
        return { ok: true, kind: 'model.inspect', data };
      }
      case 'embedding.retrain': {
        const data = await trainEmbeddingBatch();
        return { ok: true, kind: 'embedding.retrain', data };
      }
      case 'forest.retrain': {
        const data = await trainRecommendForest();
        invalidateForestCache();
        return { ok: true, kind: 'forest.retrain', data };
      }
      case 'sequence.rebuild': {
        const data = await rebuildSequenceMemory();
        return { ok: true, kind: 'sequence.rebuild', data };
      }
      case 'lr.replay': {
        const data = await replayImplicitTraining();
        return { ok: true, kind: 'lr.replay', data };
      }
      case 'model.evaluate': {
        const data = await evaluateRecommend({
          sample: req.sample ?? 60,
          mode: req.mode ?? 'replay',
          splitDays: req.splitDays,
          note: req.note,
        });
        return { ok: true, kind: 'model.evaluate', data };
      }
      case 'model.evalHistory': {
        const data = await loadEvalHistory();
        return { ok: true, kind: 'model.evalHistory', data };
      }
      case 'model.mlpStatus': {
        return { ok: true, kind: 'model.mlpStatus', data: await mlpStatus() };
      }
      case 'model.setMlp': {
        await setMlpEnabled(req.enabled);
        return { ok: true, kind: 'model.setMlp', data: { enabled: req.enabled } };
      }
      case 'stash.add': {
        const data = await stashTabs(req.items);
        await logEvent({
          type: 'stash_added',
          count: req.items.length,
          domains: Array.from(
            new Set(req.items.map((i) => extractDomain(i.url)).filter(Boolean)),
          ),
        });
        return { ok: true, kind: 'stash.add', data };
      }
      case 'stash.list': {
        const data = await listStash();
        return { ok: true, kind: 'stash.list', data };
      }
      case 'stash.unstash': {
        const item = await unstashOne(req.id);
        if (item) {
          await chrome.tabs.create({ url: item.url, active: true });
          await logEvent({
            type: 'stash_unstashed',
            url: item.url,
            domain: extractDomain(item.url),
          });
        }
        return { ok: true, kind: 'ack' };
      }
      case 'stash.delete': {
        await deleteStashed(req.ids);
        await logEvent({
          type: 'stash_deleted',
          count: req.ids.length,
        });
        return { ok: true, kind: 'ack' };
      }
      case 'workspace.list': {
        const data = await listWorkspaces();
        return { ok: true, kind: 'workspace.list', data };
      }
      case 'workspace.save': {
        const id = await saveWorkspace({ name: req.name, tabs: req.tabs });
        await logEvent({
          type: 'workspace_saved',
          count: req.tabs.length,
          domains: Array.from(
            new Set(req.tabs.map((t) => extractDomain(t.url)).filter(Boolean)),
          ),
          meta: { id, name: req.name },
        });
        return { ok: true, kind: 'workspace.save', data: id };
      }
      case 'workspace.update': {
        await updateWorkspace(req.id, { name: req.name, tabs: req.tabs });
        await logEvent({
          type: 'workspace_updated',
          meta: { id: req.id, hasName: !!req.name, tabCount: req.tabs?.length },
        });
        return { ok: true, kind: 'ack' };
      }
      case 'workspace.delete': {
        await deleteWorkspace(req.id);
        await logEvent({
          type: 'workspace_deleted',
          meta: { id: req.id },
        });
        return { ok: true, kind: 'ack' };
      }
      case 'workspace.restore': {
        await restoreWorkspace(req.id, req.mode);
        await logEvent({
          type: 'workspace_restored',
          meta: { id: req.id, mode: req.mode },
        });
        return { ok: true, kind: 'ack' };
      }
      case 'insights.today': {
        const data = await buildTodayRecap();
        return { ok: true, kind: 'insights.today', data };
      }
      case 'pins.rerank': {
        const ctx = await buildContext();
        const data = await rerankPins(req.pins, ctx);
        return { ok: true, kind: 'pins.rerank', data };
      }
      case 'closeTabs': {
        if (req.tabIds.length > 0) await chrome.tabs.remove(req.tabIds);
        return { ok: true, kind: 'ack' };
      }
      case 'openUrl': {
        await chrome.tabs.create({ url: req.url, active: true });
        return { ok: true, kind: 'ack' };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerMessaging(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const req = message as RpcRequest;
    handle(req)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  });
}
