import type {
  CleanupCandidate,
  CleanupFeatures,
  DataSummary,
  OpenCandidate,
  RecommendFeatures,
  StashedTab,
  TabEvent,
  TodayRecap,
  Workspace,
  WorkspaceTab,
} from './types';
import type { InsightsBundle } from '../ml/insights';
import type { DataDump, ModelInspection } from '../ml/data-ops';
import type { StashInput } from '../ml/stash';
import type { PinRerankInput, PinRerankRow } from '../ml/pins';

export type RpcRequest =
  | { kind: 'recommend.open' }
  | { kind: 'recommend.cleanup' }
  | { kind: 'recommend.cleanup.all'; limit?: number }
  | {
      kind: 'feedback.cleanup';
      domain: string;
      reason: string;
      features: CleanupFeatures;
      // 'dismissed-after-suggestion' is sent when the user unchecks a tab
      // that the smart-cleanup batch had auto-selected — trained at 2x
      // weight in cleanup.trainCleanupFeedback.
      action:
        | 'accepted'
        | 'dismissed'
        | 'snoozed'
        | 'dismissed-after-suggestion';
    }
  | {
      kind: 'feedback.open';
      domain: string;
      features: RecommendFeatures;
      action: 'accepted' | 'dismissed' | 'ignored';
    }
  | { kind: 'aggregate.rebuild' }
  | { kind: 'embedding.retrain' }
  | { kind: 'forest.retrain' }
  | { kind: 'sequence.rebuild' }
  | { kind: 'lr.replay' }
  | { kind: 'model.evaluate'; sample?: number }
  | { kind: 'insights.get' }
  | { kind: 'data.summary' }
  | { kind: 'data.export' }
  | { kind: 'data.wipe' }
  | { kind: 'data.resetModels' }
  | { kind: 'data.bootstrapHistory'; force?: boolean }
  | { kind: 'data.exportDebugBundle' }
  | { kind: 'data.exportUserMigration' }
  | {
      // Dashboard-initiated event log entry. `partial` is a TabEvent without
      // ts/hour/dow (SW stamps those). Used for product-surface events like
      // OracleHint accept, smart-cleanup commit, search execute, etc.
      kind: 'event.log';
      partial: Omit<TabEvent, 'ts' | 'hourOfDay' | 'dayOfWeek' | 'id'>;
    }
  | { kind: 'model.inspect' }
  | { kind: 'stash.add'; items: StashInput[] }
  | { kind: 'stash.list' }
  | { kind: 'stash.unstash'; id: number }
  | { kind: 'stash.delete'; ids: number[] }
  | { kind: 'workspace.list' }
  | { kind: 'workspace.save'; name: string; tabs: WorkspaceTab[] }
  | { kind: 'workspace.update'; id: number; name?: string; tabs?: WorkspaceTab[] }
  | { kind: 'workspace.delete'; id: number }
  | { kind: 'workspace.restore'; id: number; mode: 'newWindow' | 'currentWindow' }
  | { kind: 'insights.today' }
  | { kind: 'pins.rerank'; pins: PinRerankInput[] }
  | { kind: 'closeTabs'; tabIds: number[] }
  | { kind: 'openUrl'; url: string };

export type RpcResponse =
  | { ok: true; kind: 'recommend.open'; data: OpenCandidate[] }
  | { ok: true; kind: 'recommend.cleanup'; data: CleanupCandidate[] }
  | { ok: true; kind: 'recommend.cleanup.all'; data: CleanupCandidate[] }
  | { ok: true; kind: 'insights.get'; data: InsightsBundle }
  | { ok: true; kind: 'data.summary'; data: DataSummary }
  | { ok: true; kind: 'data.export'; data: DataDump }
  | { ok: true; kind: 'model.inspect'; data: ModelInspection }
  | { ok: true; kind: 'stash.list'; data: StashedTab[] }
  | { ok: true; kind: 'stash.add'; data: number[] }
  | { ok: true; kind: 'embedding.retrain'; data: { steps: number; vocab: number } }
  | {
      ok: true;
      kind: 'forest.retrain';
      data: { trained: number; posSamples: number; negSamples: number };
    }
  | {
      ok: true;
      kind: 'sequence.rebuild';
      data: { observed: number; bigramKeys: number };
    }
  | {
      ok: true;
      kind: 'lr.replay';
      data: { openSamples: number; cleanupSamples: number };
    }
  | {
      ok: true;
      kind: 'model.evaluate';
      data: {
        evaluated: number;
        skipped: number;
        model: { hit1: number; hit3: number; hit5: number; mrr: number };
        baseline: { hit1: number; hit3: number; hit5: number; mrr: number };
        tookMs: number;
      };
    }
  | { ok: true; kind: 'workspace.list'; data: Workspace[] }
  | { ok: true; kind: 'workspace.save'; data: number }
  | { ok: true; kind: 'insights.today'; data: TodayRecap }
  | { ok: true; kind: 'pins.rerank'; data: PinRerankRow[] }
  | {
      ok: true;
      kind: 'data.bootstrapHistory';
      data: { events: number; domains: number; skipped: boolean; reason?: string };
    }
  | {
      ok: true;
      kind: 'data.exportDebugBundle';
      // Base64-encoded zip bytes — dashboard converts to Blob and downloads.
      data: { filename: string; base64: string; size: number };
    }
  | {
      ok: true;
      kind: 'data.exportUserMigration';
      data: {
        augurUserMigration: 1;
        exportedAt: number;
        workspaces: unknown[];
        pins: unknown[];
        stash: unknown[];
      };
    }
  | { ok: true; kind: 'ack' }
  | { ok: false; error: string };

export async function callRpc<R extends RpcResponse>(req: RpcRequest): Promise<R> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!response) return reject(new Error('empty response'));
      if (response && response.ok === false) {
        return reject(new Error(response.error || 'rpc failed'));
      }
      resolve(response as R);
    });
  });
}
