// End-to-end check of the BUILT extension in real Chrome (npm run e2e).
//
// Launches Chrome headless with dist/ loaded into a throwaway profile, drives
// real tabs over the DevTools protocol against a local server on *.localhost
// hostnames, then reads what the real service worker captured, trained and
// predicts, and opens the real dashboard. Never touches the user's profile.
//
// Exit code 0 = every check passed.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIST = resolve('dist');
if (!existsSync(join(DIST, 'manifest.json'))) throw new Error('run npm run build first');

// The ID Chrome derives from manifest.key — it must not depend on the path.
const EXPECTED_ID = (() => {
  const key = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')).key;
  const hash = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── Local "web": every *.localhost host gets a titled page ──────────────
const web = createServer((req, res) => {
  const host = (req.headers.host ?? '').split(':')[0];
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>${host} ${req.url}</title><h1>${host}${req.url}</h1>`);
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const WEB = web.address().port;
const url = (host, path = '/') => `http://${host}.localhost:${WEB}${path}`;

// ── Chrome ──────────────────────────────────────────────────────────────
// Branded Chrome ignores --load-extension since v137; the supported route is
// the DevTools method Extensions.loadUnpacked, which needs the pipe
// transport (fd 3 = to Chrome, fd 4 = from Chrome, NUL-delimited JSON) and
// --enable-unsafe-extension-debugging.
const profile = mkdtempSync(join(tmpdir(), 'augur-e2e-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
);
const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];

// Minimal CDP client (flattened sessions).
let nextId = 1;
const pending = new Map();
let inbuf = '';
fromChrome.on('data', (chunk) => {
  inbuf += chunk.toString('utf8');
  let i;
  while ((i = inbuf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(inbuf.slice(0, i));
    inbuf = inbuf.slice(i + 1);
    if (msg.method === 'Runtime.consoleAPICalled' && process.env.E2E_DEBUG) {
      console.log('SW>', msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { resolve: res, reject: rej });
    toChrome.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
const evaluate = async (sessionId, expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
};

let exitCode = 1;
try {
  // ── 1. Install; the service worker is up, with the stable ID ─────────
  const { id: installedId } = await send('Extensions.loadUnpacked', { path: DIST });
  check('Extensions.loadUnpacked installed dist/', !!installedId, installedId);
  let sw;
  for (let i = 0; i < 40 && !sw; i++) {
    const { targetInfos } = await send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/service-worker-loader.js'));
    if (i === 39) console.log('targets:', targetInfos.map((t) => t.type + ' ' + t.url).join('\n  '));
    if (!sw) await sleep(250);
  }
  check('extension loaded, service worker running', !!sw, sw?.url);
  if (!sw) throw new Error('extension service worker did not start');
  const extId = new URL(sw.url).host;
  check('stable extension ID (from manifest key)', extId === EXPECTED_ID, extId);
  const { sessionId: swS } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });

  if (process.env.E2E_DEBUG) await send('Runtime.enable', {}, swS);
  const swEval = (code) => evaluate(swS, `(async () => { ${code} })()`);
  const idb = `
    const db = await new Promise((res, rej) => { const r = indexedDB.open('augur'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = (store) => new Promise((res) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); });
  `;

  // ── 2. Browse like a person: a habit loop over several hosts ─────────
  const open = async (u) => (await send('Target.createTarget', { url: u })).targetId;
  const hosts = ['github', 'linear', 'mail', 'figma', 'docs', 'news'];
  const ids = {};
  for (const h of hosts) {
    ids[h] = await open(url(h, `/${h}-home`));
    await sleep(400);
  }
  // Switch between them, navigate within and across sites, close some.
  for (let round = 0; round < 3; round++) {
    for (const h of ['github', 'linear', 'github', 'docs', 'mail']) {
      await send('Target.activateTarget', { targetId: ids[h] });
      await sleep(250);
    }
  }
  const { sessionId: ghS } = await send('Target.attachToTarget', { targetId: ids.github, flatten: true });
  await send('Page.navigate', { url: url('github', '/pulls') }, ghS); // same-site route: not a visit
  await sleep(500);
  await send('Page.navigate', { url: url('stackoverflow', '/q/1') }, ghS); // cross-site: a visit
  await sleep(500);
  await send('Target.closeTarget', { targetId: ids.news });
  await send('Target.closeTarget', { targetId: ids.figma });
  await sleep(500);
  // Re-open a closed site: a genuine switch-open the open head trains on.
  ids.figma = await open(url('figma', '/file/2'));
  await sleep(800);
  ids.news = await open(url('news', '/'));
  await sleep(800);
  // Genuine switch-opens: brand-new sites (never seen, so not within the
  // 2-min recently-seen window), with known-but-closed sites in the pool as
  // the negatives they're ranked against.
  for (const h of ['wiki', 'maps', 'music']) {
    await send('Target.activateTarget', { targetId: ids.docs });
    await sleep(300);
    ids[h] = await open(url(h, '/'));
    await sleep(700);
  }
  // Let the serial queue drain, then write pending model state.
  await sleep(1500);

  // ── 3. Capture ───────────────────────────────────────────────────────
  const cap = await swEval(`${idb}
    const ev = await all('events');
    const by = {}; for (const e of ev) by[e.type] = (by[e.type] ?? 0) + 1;
    const nav = ev.filter((e) => e.type === 'navigate');
    const dupNav = nav.filter((e, i) => nav.some((f, j) => j < i && f.tabId === e.tabId && f.url === e.url && e.ts - f.ts < 1000)).length;
    const doms = await all('domains');
    return { total: ev.length, by, dupNav, domains: doms.map((d) => [d.domain, d.visitCount]) };
  `);
  check('events captured (open / focus / blur / navigate / close)', ['open', 'focus', 'blur', 'navigate', 'close'].every((t) => cap.by[t] > 0), JSON.stringify(cap.by));
  check('no duplicate navigate rows', cap.dupNav === 0, `dup=${cap.dupNav}`);
  const visits = Object.fromEntries(cap.domains);
  check('same-site route is not a visit; cross-site is', (visits['github.localhost'] ?? 0) >= 1 && (visits['stackoverflow.localhost'] ?? 0) === 1, JSON.stringify(visits));

  // ── 4. Processing + training ─────────────────────────────────────────
  // Flush pending model writes the way an export does (data.flush), via a
  // page so the request takes the normal runtime-message path.
  const flushPage = await open(`chrome-extension://${extId}/src/dashboard/index.html`);
  await sleep(1500);
  const { sessionId: fS } = await send('Target.attachToTarget', { targetId: flushPage, flatten: true });
  await evaluate(fS, `new Promise((r) => chrome.runtime.sendMessage({ kind: 'data.flush' }, r))`);
  await send('Target.closeTarget', { targetId: flushPage });
  const tr = await swEval(`${idb}
    const kv = Object.fromEntries((await all('kv')).map((r) => [r.key, r.value]));
    const rec = Object.entries(kv).find(([k]) => /^model:recommend:v[0-9]+$/.test(k))?.[1];
    const pairs = await all('cooccurrence');
    return {
      recTrained: rec?.trainedSamples ?? 0,
      recPositives: rec?.positiveSamples ?? 0,
      transitionSteps: kv['transition:v2']?.steps ?? 0,
      seqKeys: Object.keys(kv['sequenceMemory:v1']?.bigram ?? {}).length,
      pairs: pairs.length,
      errors: (kv['errorLog:v1'] ?? []).map((e) => e.context + ': ' + e.message),
    };
  `);
  if (process.env.E2E_DEBUG) {
    console.log(await swEval(`${idb}
      const ev = (await all('events')).filter((e) => e.domain === 'wiki.localhost' || e.domain === 'maps.localhost');
      return JSON.stringify(ev.map((e) => [e.type, e.domain, e.tabId, e.ts % 100000, e.prevTabId ?? null, e.openedFrom ?? null]));
    `));
  }
  check('co-occurrence aggregated', tr.pairs > 0, `${tr.pairs} pairs`);
  // stackoverflow (cross-site navigate) + figma/news re-opens are within the
  // 2-min recently-seen window and rightly skipped; wiki/maps/music are new
  // sites opened in foreground tabs — the case that used to be skipped.
  check('open head trained live on foreground new-tab opens', tr.recPositives >= 4, `${tr.recPositives} groups / ${tr.recTrained} rows`);
  check('transition + sequence models trained on tab switches', tr.transitionSteps > 0 && tr.seqKeys > 0, `steps=${tr.transitionSteps} bigram keys=${tr.seqKeys}`);
  check('no errors logged by the service worker', tr.errors.length === 0, tr.errors.join(' | '));

  // ── 5. Prediction, through the real dashboard + RPC ──────────────────
  const dashUrl = `chrome-extension://${extId}/src/dashboard/index.html`;
  const dashId = await open(dashUrl);
  await sleep(3000);
  const { sessionId: dS } = await send('Target.attachToTarget', { targetId: dashId, flatten: true });
  const pred = await evaluate(dS, `(async () => {
    const rpc = (req) => new Promise((res) => chrome.runtime.sendMessage(req, res));
    const open = await rpc({ kind: 'recommend.open' });
    const cleanup = await rpc({ kind: 'cleanup.sweep' });
    const flush = await rpc({ kind: 'data.flush' });
    const ev = await rpc({ kind: 'model.evaluate', mode: 'replay', sample: 50 });
    const text = document.body.innerText;
    return {
      open: open.ok ? open.data.map((c) => c.domain + ' ' + c.score.toFixed(2)) : open.error,
      cleanup: cleanup.ok ? cleanup.data.totalTabs : cleanup.error,
      flush: flush.ok,
      evalOk: ev.ok, evaluated: ev.ok ? ev.data.evaluated : ev.error,
      rendered: text.includes('Smart suggestions') || text.includes('智能推荐'),
    };
  })()`);
  check('dashboard renders in the extension', pred.rendered);
  // Domains open in a tab right now (the github tab navigated away to
  // stackoverflow, so github is a legitimate suggestion again).
  const openSet = (await send('Target.getTargets')).targetInfos
    .filter((t) => t.type === 'page' && t.url.startsWith('http'))
    .map((t) => new URL(t.url).hostname);
  check('recommend.open answers', Array.isArray(pred.open), JSON.stringify(pred.open));
  check('open domains are never suggested', Array.isArray(pred.open) && pred.open.every((s) => !openSet.includes(s.split(' ')[0])), `open: ${openSet.join(', ')}`);
  check('cleanup sweep sees the open tabs', typeof pred.cleanup === 'number' && pred.cleanup >= 6, `${pred.cleanup} tabs`);
  check('data.flush + model.evaluate RPCs', pred.flush === true && pred.evalOk === true, `evaluated=${pred.evaluated}`);

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  console.error('✗', err.message);
} finally {
  chrome.kill();
  web.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  process.exit(exitCode);
}
