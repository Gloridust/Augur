// The guarantees the training pipeline rests on:
//   1. No feature for time t can see an event at or after t.
//   2. Point-in-time aggregates (replay/forest/eval) produce EXACTLY the same
//      features as the live tables (serving/live training) at the same moment.
//   3. The evaluator runs end-to-end and reports intervals.
import { describe, expect, it } from 'vitest';
import { freshWorld, HOUR } from './harness';
import type { TabEvent } from '../src/shared/types';

function ev(p: Partial<TabEvent> & { type: TabEvent['type']; ts: number }): TabEvent {
  const d = new Date(p.ts);
  return { hourOfDay: d.getHours(), dayOfWeek: d.getDay(), ...p } as TabEvent;
}

// A small but non-trivial history: three domains, switches, SPA navigations,
// closes, spread over ~2 days.
function history(t0: number): TabEvent[] {
  const out: TabEvent[] = [];
  let ts = t0;
  const step = (ms: number) => (ts += ms);
  const doms = ['a.com', 'b.com', 'c.com'];
  for (let day = 0; day < 2; day++) {
    for (let i = 0; i < 12; i++) {
      const d = doms[(i * 7 + day) % 3];
      const tab = 100 + ((i + day) % 4);
      out.push(ev({ type: 'open', ts: step(4 * 60_000), tabId: tab, url: `https://${d}/`, domain: d }));
      out.push(ev({ type: 'focus', ts: step(1000), tabId: tab, url: `https://${d}/`, domain: d }));
      out.push(ev({ type: 'navigate', ts: step(20_000), tabId: tab, url: `https://${d}/x${i}`, domain: d }));
      out.push(ev({ type: 'blur', ts: step(60_000), tabId: tab, domain: d, focusMs: 60_000 }));
      if (i % 3 === 0) out.push(ev({ type: 'close', ts: step(1000), tabId: tab, url: `https://${d}/`, domain: d, focusMs: 60_000, durationMs: 90_000 }));
    }
    step(18 * HOUR);
  }
  return out;
}

describe('point-in-time correctness', () => {
  it('features at time t never see an event at t (half-open windows)', async () => {
    const w = await freshWorld();
    const { liveSource } = await import('../src/ml/sources');
    const T = Date.now();
    await w.db.events.add(ev({ type: 'open', ts: T, tabId: 1, url: 'https://n.com/', domain: 'n.com' }));
    expect(await liveSource(T).session('n.com')).toBe(0);
    expect(await liveSource(T).velocity('n.com')).toBe(0);
    expect(await liveSource(T + 1).session('n.com')).toBe(1);
  });

  it('point-in-time aggregates equal the live tables at the same instant (train/serve parity)', async () => {
    const w = await freshWorld();
    const { rebuildFromEvents } = await import('../src/ml/aggregate');
    const { liveSource } = await import('../src/ml/sources');
    const { PointInTimeAggregates } = await import('../src/ml/pit');
    const t0 = Date.now() - 3 * 24 * HOUR;
    const events = history(t0);
    await w.db.events.bulkAdd(events);
    const now = events[events.length - 1].ts + 1;
    await rebuildFromEvents(now);

    const pit = new PointInTimeAggregates();
    for (const e of events) pit.advance(e);
    const live = liveSource(now);
    const p = pit.source(now);

    for (const d of ['a.com', 'b.com', 'c.com']) {
      const ls = (await live.stats(d))!;
      const ps = (await p.stats(d))!;
      expect(ps.visitCount).toBe(ls.visitCount);
      expect(ps.hourDist).toEqual(ls.hourDist);
      expect(ps.avgFocusMs).toBeCloseTo(ls.avgFocusMs, 6);
      expect(ps.lastVisit).toBe(ls.lastVisit);
      expect(await p.velocity(d)).toBeCloseTo(await live.velocity(d), 9);
      expect(await p.session(d)).toBe(await live.session(d));
      for (const other of ['a.com', 'b.com', 'c.com']) {
        expect(await p.cooccurrence(d, other)).toBeCloseTo(await live.cooccurrence(d, other), 9);
      }
    }
    const lTop = (await live.topByFrecency(3)).map((s) => s.domain);
    const pTop = (await p.topByFrecency(3)).map((s) => s.domain);
    expect(pTop).toEqual(lTop);
  });

  it('the shared feature builder gives identical vectors from either source', async () => {
    const w = await freshWorld();
    const { rebuildFromEvents } = await import('../src/ml/aggregate');
    const { liveSource } = await import('../src/ml/sources');
    const { PointInTimeAggregates } = await import('../src/ml/pit');
    const { buildCandidateFeatures, makeFeatureContext } = await import('../src/ml/candidate-features');
    const { liveModels } = await import('../src/ml/recommend');
    const { vectorFromRecommend } = await import('../src/ml/features');
    const t0 = Date.now() - 3 * 24 * HOUR;
    const events = history(t0);
    await w.db.events.bulkAdd(events);
    const now = events[events.length - 1].ts + 1;
    await rebuildFromEvents(now);
    const pit = new PointInTimeAggregates();
    for (const e of events) pit.advance(e);

    const m = await liveModels();
    const fc = makeFeatureContext({ ts: now, focusHistory: ['a.com', 'b.com'] }, m);
    for (const d of ['a.com', 'c.com']) {
      const a = vectorFromRecommend(await buildCandidateFeatures(fc, d, liveSource(now), m));
      const b = vectorFromRecommend(await buildCandidateFeatures(fc, d, pit.source(now), m));
      a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 6));
    }
  });
});

describe('evaluator', () => {
  it('runs replay and backtest on point-in-time features and reports Wilson intervals', async () => {
    const w = await freshWorld();
    const { evaluateRecommend } = await import('../src/ml/eval');
    const t0 = Date.now() - 20 * 24 * HOUR;
    const events: TabEvent[] = [];
    // 20 days of a repeating a → b → c habit.
    for (let day = 0; day < 20; day++) {
      for (const [i, d] of ['a.com', 'b.com', 'c.com'].entries()) {
        const ts = t0 + day * 24 * HOUR + i * 10 * 60_000;
        events.push(ev({ type: 'open', ts, tabId: day * 10 + i, url: `https://${d}/`, domain: d }));
        events.push(ev({ type: 'focus', ts: ts + 500, tabId: day * 10 + i, url: `https://${d}/`, domain: d }));
        // Closed before the next one opens — an open domain is never a target.
        events.push(ev({ type: 'close', ts: ts + 5 * 60_000, tabId: day * 10 + i, url: `https://${d}/`, domain: d }));
      }
    }
    await w.db.events.bulkAdd(events);

    const replay = await evaluateRecommend({ mode: 'replay', sample: 30, persist: false });
    expect(replay.evaluated).toBeGreaterThan(0);
    expect(replay.ci.hit3[0]).toBeLessThanOrEqual(replay.model.hit3);
    expect(replay.ci.hit3[1]).toBeGreaterThanOrEqual(replay.model.hit3);

    const back = await evaluateRecommend({ mode: 'backtest', sample: 30, splitDays: 5, persist: false });
    expect(back.evaluated).toBeGreaterThan(0);
    expect(back.ensemble.startsWith('lr')).toBe(true);
    // A strict daily habit is learnable: the model must beat chance (1/3 top-1).
    expect(back.model.hit3).toBeGreaterThan(0.5);
  });
});
