// Fresh-world harness: a brand-new chrome mock + in-memory IndexedDB, then the
// real service-worker module graph re-imported on top of them. Each test gets
// its own world, so module-level caches (tab state, model caches, the event
// queue) never leak between tests.
import { vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createChromeMock, type MockTab } from './chrome-mock';

export async function freshWorld(opts: { tabs?: MockTab[] } = {}) {
  const mock = createChromeMock();
  for (const t of opts.tabs ?? []) mock.tabs.set(t.id, { ...t });
  (globalThis as { chrome?: unknown }).chrome = mock.chrome;
  const factory = new IDBFactory();
  (globalThis as { indexedDB?: unknown }).indexedDB = factory;
  // Dexie lives in node_modules, which vi.resetModules() does not re-evaluate,
  // so it would keep the previous world's factory — point it at the new one.
  const Dexie = (await import('dexie')).default;
  Dexie.dependencies.indexedDB = factory;
  vi.resetModules();
  const { db } = await import('../src/shared/db');
  const queue = await import('../src/background/queue');
  const flush = await import('../src/ml/flush');
  const state = await import('../src/background/state');
  await import('../src/background/index');
  const c = mock.chrome;

  const settle = async () => {
    await queue.whenIdle();
  };
  const persistAll = async () => {
    await settle();
    await flush.flushAll();
    await state.flushState();
  };

  // Convenience: put a tab into the mock and fire onCreated for it.
  const openTab = async (t: MockTab) => {
    mock.tabs.set(t.id, { ...t });
    await c.tabs.onCreated.fire({ ...t });
    await settle();
  };
  const activate = async (tabId: number, windowId = 1) => {
    for (const t of mock.tabs.values()) if (t.windowId === windowId) t.active = t.id === tabId;
    await c.tabs.onActivated.fire({ tabId, windowId });
    await settle();
  };

  return { mock, c, db, queue, flush, state, settle, persistAll, openTab, activate };
}

export const HOUR = 3_600_000;
