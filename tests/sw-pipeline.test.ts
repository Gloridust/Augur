// End-to-end tests of the service-worker event pipeline, driving the real
// chrome.* listeners. Each one pins a bug found in the July 2026 audit.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshWorld, HOUR } from './harness';

afterEach(() => {
  vi.useRealTimers();
});

describe('event capture', () => {
  it('logs ONE navigate when Chrome fires the url update and the complete update back-to-back', async () => {
    const w = await freshWorld();
    await w.openTab({ id: 1, windowId: 1, url: 'https://a.com/x', title: 'A' });

    // Chrome dispatches both without waiting for the async handlers.
    w.mock.tabs.get(1)!.url = 'https://a.com/y';
    const p1 = w.c.tabs.onUpdated.fire(1, { url: 'https://a.com/y' }, { ...w.mock.tabs.get(1)! });
    const p2 = w.c.tabs.onUpdated.fire(1, { status: 'complete' }, { ...w.mock.tabs.get(1)! });
    await Promise.all([p1, p2]);
    await w.settle();

    const navs = await w.db.events.where('[type+ts]').between(['navigate', 0], ['navigate', Infinity]).toArray();
    expect(navs).toHaveLength(1);
    expect(navs[0].url).toBe('https://a.com/y');
  });

  it('logs ONE blur + ONE focus when onActivated and windows.onFocusChanged report the same switch', async () => {
    const w = await freshWorld();
    await w.openTab({ id: 1, windowId: 1, url: 'https://a.com/', active: true });
    await w.openTab({ id: 2, windowId: 1, url: 'https://b.com/' });
    await w.activate(1);
    const before = await w.db.events.count();

    w.mock.tabs.get(1)!.active = false;
    w.mock.tabs.get(2)!.active = true;
    await Promise.all([
      w.c.tabs.onActivated.fire({ tabId: 2, windowId: 1 }),
      w.c.windows.onFocusChanged.fire(1),
    ]);
    await w.settle();

    const after = (await w.db.events.toArray()).slice(before);
    expect(after.filter((e) => e.type === 'blur')).toHaveLength(1);
    expect(after.filter((e) => e.type === 'focus')).toHaveLength(1);
  });

  it('starts a focus segment for a tab that was active before it had a trackable URL (Cmd+T → type URL)', async () => {
    const w = await freshWorld();
    // New-tab page: untracked URL, becomes active.
    w.mock.tabs.set(5, { id: 5, windowId: 1, url: 'chrome://newtab/', active: true });
    await w.c.tabs.onCreated.fire({ id: 5, windowId: 1, url: 'chrome://newtab/' });
    await w.c.tabs.onActivated.fire({ tabId: 5, windowId: 1 });
    await w.settle();
    // User types a URL; the page finishes loading.
    w.mock.tabs.get(5)!.url = 'https://typed.com/';
    await w.c.tabs.onUpdated.fire(5, { status: 'complete' }, { ...w.mock.tabs.get(5)! });
    await w.settle();

    const types = (await w.db.events.toArray()).map((e) => e.type);
    expect(types).toContain('open');
    expect(types).toContain('focus');
    expect((await w.state.getTabState(5))?.focusedAt).toBeDefined();
  });
});

describe('live training', () => {
  it('a genuine switch-open trains the open model (was dead: the event saw itself in the 2-min filter)', async () => {
    const w = await freshWorld();
    await w.openTab({ id: 1, windowId: 1, url: 'https://a.com/', active: true });
    await w.activate(1);
    // Some history so the candidate pool has negatives: domains visited and
    // closed again (open domains are never candidates).
    await w.openTab({ id: 2, windowId: 1, url: 'https://c.com/' });
    await w.openTab({ id: 3, windowId: 1, url: 'https://d.com/' });
    await w.activate(1);
    await w.closeTab(2);
    await w.closeTab(3);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10 * 60_000); // past the 2-min recency window
    await w.openTab({ id: 4, windowId: 1, url: 'https://b.com/' });
    await w.persistAll();

    const { RECOMMEND_MODEL_VERSION } = await import('../src/ml/persistence');
    const row = await w.db.kv.get(RECOMMEND_MODEL_VERSION);
    const model = row?.value as { trainedSamples: number; positiveSamples: number } | undefined;
    expect(model?.positiveSamples ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('a URL typed into a new foreground tab trains (the tab is already focused when it commits)', async () => {
    const w = await freshWorld();
    const { RECOMMEND_MODEL_VERSION } = await import('../src/ml/persistence');
    // History: a site visited and closed, so the pool has a negative.
    await w.openTab({ id: 1, windowId: 1, url: 'https://old.com/' });
    await w.closeTab(1);
    await w.openTab({ id: 2, windowId: 1, url: 'https://work.com/' });
    await w.activate(2);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    // Cmd+T: the new-tab page opens in the foreground first…
    const dash = 'chrome-extension://test-extension/src/dashboard/index.html';
    await w.openTab({ id: 3, windowId: 1, url: dash, active: true });
    await w.activate(3);
    // …then the typed URL commits in that already-focused tab.
    w.mock.tabs.get(3)!.url = 'https://typed.com/';
    await w.c.tabs.onUpdated.fire(3, { url: 'https://typed.com/' }, { ...w.mock.tabs.get(3)! });
    await w.persistAll();
    vi.useRealTimers();
    const model = (await w.db.kv.get(RECOMMEND_MODEL_VERSION))?.value as { positiveSamples: number } | undefined;
    expect(model?.positiveSamples ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('every tab switch trains the factorized transition model', async () => {
    const w = await freshWorld();
    await w.openTab({ id: 1, windowId: 1, url: 'https://a.com/' });
    await w.openTab({ id: 2, windowId: 1, url: 'https://b.com/' });
    for (let i = 0; i < 4; i++) {
      await w.activate(1);
      await w.activate(2);
    }
    await w.persistAll();
    const t = (await w.db.kv.get('transition:v2'))?.value as { steps: number } | undefined;
    expect(t?.steps ?? 0).toBeGreaterThanOrEqual(6);
  });
});

describe('cleanup outcome labels', () => {
  it('switching back to a tab backgrounded ≥30 min trains the cleanup head; a 5-min gap does not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const w = await freshWorld();
    await w.openTab({ id: 1, windowId: 1, url: 'https://a.com/' });
    await w.openTab({ id: 2, windowId: 1, url: 'https://b.com/' });
    await w.activate(1);
    await w.activate(2); // tab 1 goes to the background

    vi.setSystemTime(t0 + 5 * 60_000);
    await w.activate(1); // short gap → no label
    await w.activate(2);
    await w.persistAll();
    const before = ((await w.db.kv.get('model:cleanup:v5'))?.value as { trainedSamples?: number } | undefined)?.trainedSamples ?? 0;
    expect(before).toBe(0);

    vi.setSystemTime(t0 + 2 * HOUR);
    await w.activate(1); // came back after ~2h → "refocused" outcome
    await w.persistAll();
    const after = ((await w.db.kv.get('model:cleanup:v5'))?.value as { trainedSamples: number }).trainedSamples;
    expect(after).toBe(1);
  });

  it('closing a backgrounded tab is a "closed" outcome, but closing the tab in view is not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const w = await freshWorld();
    await w.openTab({ id: 1, windowId: 1, url: 'https://a.com/' });
    await w.openTab({ id: 2, windowId: 1, url: 'https://b.com/' });
    await w.activate(1);
    await w.activate(2);
    vi.setSystemTime(t0 + 3 * HOUR);

    await w.c.tabs.onRemoved.fire(2, { windowId: 1, isWindowClosing: false }); // in view
    await w.settle();
    await w.c.tabs.onRemoved.fire(1, { windowId: 1, isWindowClosing: false }); // backgrounded 3h
    await w.persistAll();

    const m = (await w.db.kv.get('model:cleanup:v5'))?.value as { trainedSamples: number; positiveSamples: number };
    expect(m.trainedSamples).toBe(1);
    expect(m.positiveSamples).toBe(1);
  });
});

describe('startup + badge', () => {
  it('adopts restored tabs from tab.lastAccessed in one write, and the badge counts only ≥24h-idle / never-viewed', async () => {
    const now = Date.now();
    const w = await freshWorld({
      tabs: [
        { id: 1, windowId: 1, url: 'https://old.com/', lastAccessed: now - 30 * HOUR },
        { id: 2, windowId: 1, url: 'https://recent.com/', lastAccessed: now - 3 * HOUR },
        { id: 3, windowId: 1, url: 'https://here.com/', lastAccessed: now - 1000, active: true },
      ],
    });
    await w.c.runtime.onStartup.fire();
    await w.settle();

    const s1 = await w.state.getTabState(1);
    expect(s1?.lastFocusedAt).toBe(now - 30 * HOUR);
    expect(s1?.focusCount).toBe(1); // restored ≠ never viewed
    expect(w.mock.badge.text).toBe('1'); // only old.com (30h idle); recent.com 3h idle is not stale
  });
});
