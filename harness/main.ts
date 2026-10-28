// Harness bootstrap. Order matters: chrome mock → SW module → seed data →
// dashboard. window.__augur exposes hooks the browser checks drive.
import { ChromeEvent, createChromeMock } from '../tests/chrome-mock';

const { chrome, tabs } = createChromeMock();
(globalThis as { chrome?: unknown }).chrome = chrome;

// The test mock is promise-only; the dashboard also uses callback forms and
// talks to the SW over runtime messaging — route that to the SW's listener.
const rpcCounts: Record<string, number> = {};
chrome.runtime.sendMessage = (msg: { kind: string }, cb?: (r: unknown) => void) => {
  rpcCounts[msg.kind] = (rpcCounts[msg.kind] ?? 0) + 1;
  for (const l of chrome.runtime.onMessage.listeners) l(msg, {}, (r: unknown) => cb?.(r));
};
const query = chrome.tabs.query;
chrome.tabs.query = (q: Record<string, unknown>, cb?: (t: unknown[]) => void) => {
  const p = query(q);
  if (cb) void p.then(cb);
  return p;
};
chrome.storage.onChanged = new ChromeEvent();

const HOUR = 3_600_000;
const now = Date.now();
const dash = chrome.runtime.getURL('src/dashboard/index.html');
const open: Array<[number, number, string, string, number]> = [
  // id, window, url, title, last used (h ago)
  [1, 1, dash, 'New Tab', 0],
  [2, 1, 'https://github.com/acme/app/pulls', 'Pull requests · acme/app', 0.2],
  [3, 1, 'https://linear.app/acme/team/ENG/active', 'ENG · Active', 1],
  [4, 1, 'https://docs.google.com/document/d/1', 'Q4 planning — Google Docs', 30],
  [5, 2, 'https://news.ycombinator.com/', 'Hacker News', 50],
  [6, 2, 'https://www.youtube.com/watch?v=x', 'Some talk — YouTube', 200],
  [7, 2, 'https://en.wikipedia.org/wiki/Bayes', "Bayes' theorem — Wikipedia", 400],
];
for (const [id, windowId, url, title, h] of open) {
  tabs.set(id, { id, windowId, url, title, active: id === 1 || id === 5, lastAccessed: now - h * HOUR, index: id });
}

// Synthetic habit: 12 days of a work loop (github → linear → slack-ish
// docs) with evening reading, so every model has something to learn.
async function seed() {
  const { db, extractDomain } = await import('../src/shared/db');
  if (location.search.includes('reset')) {
    await db.delete();
    location.replace(location.pathname);
    await new Promise(() => undefined);
  }
  if ((await db.events.count()) > 0) return;
  const day = ['github.com', 'linear.app', 'mail.google.com', 'github.com', 'figma.com', 'docs.google.com', 'stackoverflow.com', 'github.com'];
  const eve = ['news.ycombinator.com', 'www.youtube.com', 'en.wikipedia.org', 'twitter.com'];
  // Domains as the SW derives them (www. stripped), so open-tab exclusion
  // and the event log agree.
  const dom = (host: string) => extractDomain(`https://${host}/`);
  const rows = [];
  let tabId = 1000;
  for (let d = 12; d >= 1; d--) {
    const base = now - d * 24 * HOUR;
    const seq = [...day.map((x, i) => [x, 9 + i * 0.6] as const), ...eve.map((x, i) => [x, 20 + i * 0.5] as const)];
    for (const [host, hour] of seq) {
      const domain = dom(host);
      const ts = base + hour * HOUR + ((d * 7919) % 600) * 1000;
      const id = tabId++;
      const t = new Date(ts);
      const common = { tabId: id, domain, url: `https://${host}/`, title: domain, hourOfDay: t.getHours(), dayOfWeek: t.getDay() };
      rows.push({ ...common, type: 'open', ts, openedFrom: 'direct' });
      rows.push({ ...common, type: 'focus', ts: ts + 500 });
      rows.push({ ...common, type: 'blur', ts: ts + 20 * 60_000, focusMs: 20 * 60_000 });
      rows.push({ ...common, type: 'close', ts: ts + 25 * 60_000, focusMs: 20 * 60_000 });
    }
  }
  await db.events.bulkAdd(rows as never[]);
  const { rebuildFromEvents } = await import('../src/ml/aggregate');
  const { replayImplicitTraining, trainRecommendForest } = await import('../src/ml/rf-train');
  const { trainEmbeddingBatch } = await import('../src/ml/embedding-train');
  const { flushAll } = await import('../src/ml/flush');
  await rebuildFromEvents();
  await trainEmbeddingBatch();
  await replayImplicitTraining();
  await trainRecommendForest();
  await flushAll();
}

await import('../src/background/index');
await seed();
(window as unknown as { __augur: unknown }).__augur = { chrome, tabs, rpcCounts, ChromeEvent };
await import('../src/dashboard/main');
