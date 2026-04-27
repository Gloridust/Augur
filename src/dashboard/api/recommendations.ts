import type {
  CleanupCandidate,
  CleanupFeatures,
  DataSummary,
  OpenCandidate,
  RecommendFeatures,
  StashedTab,
  TodayRecap,
  Workspace,
  WorkspaceTab,
} from '../../shared/types';
import { callRpc } from '../../shared/rpc';
import type { InsightsBundle } from '../../ml/insights';
import type { DataDump, ModelInspection } from '../../ml/data-ops';
import type { StashInput } from '../../ml/stash';
import type { PinRerankInput, PinRerankRow } from '../../ml/pins';

export async function fetchOpenRecommendations(): Promise<OpenCandidate[]> {
  const r = await callRpc({ kind: 'recommend.open' });
  return r.ok && r.kind === 'recommend.open' ? r.data : [];
}

export async function fetchCleanupRecommendations(): Promise<CleanupCandidate[]> {
  const r = await callRpc({ kind: 'recommend.cleanup' });
  return r.ok && r.kind === 'recommend.cleanup' ? r.data : [];
}

// Returns ALL cleanup candidates above the model's confidence threshold (no
// top-5 cap). Powers the TabWall "Smart cleanup" button.
export async function fetchAllCleanupCandidates(): Promise<CleanupCandidate[]> {
  const r = await callRpc({ kind: 'recommend.cleanup.all' });
  return r.ok && r.kind === 'recommend.cleanup.all' ? r.data : [];
}

export async function fetchInsights(): Promise<InsightsBundle | null> {
  const r = await callRpc({ kind: 'insights.get' });
  return r.ok && r.kind === 'insights.get' ? r.data : null;
}

export async function reportCleanupFeedback(
  domain: string,
  reason: string,
  features: CleanupFeatures,
  action: 'accepted' | 'dismissed' | 'snoozed',
): Promise<void> {
  await callRpc({ kind: 'feedback.cleanup', domain, reason, features, action });
}

export async function reportOpenFeedback(
  domain: string,
  features: RecommendFeatures,
  action: 'accepted' | 'dismissed' | 'ignored',
): Promise<void> {
  await callRpc({ kind: 'feedback.open', domain, features, action });
}

export async function rebuildAggregates(): Promise<void> {
  await callRpc({ kind: 'aggregate.rebuild' });
}

export async function openUrlViaSw(url: string): Promise<void> {
  await callRpc({ kind: 'openUrl', url });
}

export async function fetchSummary(): Promise<DataSummary | null> {
  const r = await callRpc({ kind: 'data.summary' });
  return r.ok && r.kind === 'data.summary' ? r.data : null;
}

export async function exportAllData(): Promise<DataDump | null> {
  const r = await callRpc({ kind: 'data.export' });
  return r.ok && r.kind === 'data.export' ? r.data : null;
}

export async function wipeAllData(): Promise<void> {
  await callRpc({ kind: 'data.wipe' });
}

export async function resetModelsOnly(): Promise<void> {
  await callRpc({ kind: 'data.resetModels' });
}

export async function fetchModelInspection(): Promise<ModelInspection | null> {
  const r = await callRpc({ kind: 'model.inspect' });
  return r.ok && r.kind === 'model.inspect' ? r.data : null;
}

export async function retrainEmbedding(): Promise<{ steps: number; vocab: number } | null> {
  const r = await callRpc({ kind: 'embedding.retrain' });
  return r.ok && r.kind === 'embedding.retrain' ? r.data : null;
}

export async function stashItems(items: StashInput[]): Promise<number[]> {
  const r = await callRpc({ kind: 'stash.add', items });
  return r.ok && r.kind === 'stash.add' ? r.data : [];
}

export async function listStashedItems(): Promise<StashedTab[]> {
  const r = await callRpc({ kind: 'stash.list' });
  return r.ok && r.kind === 'stash.list' ? r.data : [];
}

export async function unstashItem(id: number): Promise<void> {
  await callRpc({ kind: 'stash.unstash', id });
}

export async function deleteStashedItems(ids: number[]): Promise<void> {
  await callRpc({ kind: 'stash.delete', ids });
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const r = await callRpc({ kind: 'workspace.list' });
  return r.ok && r.kind === 'workspace.list' ? r.data : [];
}

export async function saveWorkspace(name: string, tabs: WorkspaceTab[]): Promise<number | null> {
  const r = await callRpc({ kind: 'workspace.save', name, tabs });
  return r.ok && r.kind === 'workspace.save' ? r.data : null;
}

export async function renameWorkspace(id: number, name: string): Promise<void> {
  await callRpc({ kind: 'workspace.update', id, name });
}

export async function updateWorkspaceTabs(id: number, tabs: WorkspaceTab[]): Promise<void> {
  await callRpc({ kind: 'workspace.update', id, tabs });
}

export async function deleteWorkspaceById(id: number): Promise<void> {
  await callRpc({ kind: 'workspace.delete', id });
}

export async function restoreWorkspace(
  id: number,
  mode: 'newWindow' | 'currentWindow',
): Promise<void> {
  await callRpc({ kind: 'workspace.restore', id, mode });
}

export async function fetchTodayRecap(): Promise<TodayRecap | null> {
  const r = await callRpc({ kind: 'insights.today' });
  return r.ok && r.kind === 'insights.today' ? r.data : null;
}

export async function rerankPinsViaModel(pins: PinRerankInput[]): Promise<PinRerankRow[]> {
  if (pins.length === 0) return [];
  const r = await callRpc({ kind: 'pins.rerank', pins });
  return r.ok && r.kind === 'pins.rerank' ? r.data : [];
}
