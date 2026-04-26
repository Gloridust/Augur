import { rebuildFromEvents } from '../ml/aggregate';
import {
  recordCleanupImpressions,
  scoreCleanupCandidates,
  trainCleanupFeedback,
} from '../ml/cleanup';
import {
  exportAll,
  getSummary,
  inspectModels,
  resetModelsOnly,
  wipeAll,
} from '../ml/data-ops';
import { trainEmbeddingBatch } from '../ml/embedding-train';
import { buildInsights, buildTodayRecap } from '../ml/insights';
import {
  recommendOpen,
  recordRecommendImpressions,
  trainRecommendFeedback,
} from '../ml/recommend';
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

async function buildContext(): Promise<{
  hour: number;
  dow: number;
  focusedDomain?: string;
  openDomains: string[];
  pinnedDomains: string[];
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
  return {
    hour: now.getHours(),
    dow: now.getDay(),
    focusedDomain,
    openDomains,
    pinnedDomains,
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
      case 'model.inspect': {
        const data = await inspectModels();
        return { ok: true, kind: 'model.inspect', data };
      }
      case 'embedding.retrain': {
        const data = await trainEmbeddingBatch();
        return { ok: true, kind: 'embedding.retrain', data };
      }
      case 'stash.add': {
        const data = await stashTabs(req.items);
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
        }
        return { ok: true, kind: 'ack' };
      }
      case 'stash.delete': {
        await deleteStashed(req.ids);
        return { ok: true, kind: 'ack' };
      }
      case 'workspace.list': {
        const data = await listWorkspaces();
        return { ok: true, kind: 'workspace.list', data };
      }
      case 'workspace.save': {
        const id = await saveWorkspace({ name: req.name, tabs: req.tabs });
        return { ok: true, kind: 'workspace.save', data: id };
      }
      case 'workspace.update': {
        await updateWorkspace(req.id, { name: req.name, tabs: req.tabs });
        return { ok: true, kind: 'ack' };
      }
      case 'workspace.delete': {
        await deleteWorkspace(req.id);
        return { ok: true, kind: 'ack' };
      }
      case 'workspace.restore': {
        await restoreWorkspace(req.id, req.mode);
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
