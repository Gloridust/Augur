// Opt-in validation on a real backup (never committed data — the file is
// read from wherever AUGUR_BACKUP points):
//
//   AUGUR_BACKUP=~/Downloads/augur-backup-….json(.gz) npx vitest run tests/real-data.test.ts
//
// Imports the backup into a fresh fake database, discards its trained
// weights, re-runs the warm-up chain (aggregates → replay → forest) and
// prints a leak-free backtest and a replay, per point kind. Seeded, so two
// runs on the same file give the same numbers.
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshWorld } from './harness';

const file = process.env.AUGUR_BACKUP;

it.skipIf(!file)('real backup: warm-up + leak-free evaluation', async () => {
  const { mulberry32 } = await import('../src/ml/pit');
  Math.random = mulberry32(Number(process.env.SEED ?? 1));
  const w = await freshWorld();
  const { parseBackupFile, writeDumpToDb } = await import('../src/shared/backup');
  const parsed = await parseBackupFile(new Uint8Array(readFileSync(file!)));
  if (parsed.kind === 'invalid') throw new Error('not an Augur backup');
  const imported = await writeDumpToDb(parsed.dump);
  console.log('imported', JSON.stringify(imported.counts));
  // Train from scratch: weights in an old backup came from older pipelines.
  const stale = /^(model:|bandit:|sequence|transition|blendCalib|embedding|urlPrefixes|domainText|circadian)/;
  await w.db.kv.bulkDelete((await w.db.kv.toArray()).map((r) => r.key).filter((k) => stale.test(k)));

  const time = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const r = await f();
    console.log(`${label}: ${Date.now() - t0} ms`, JSON.stringify(r, (k, v) => (k === 'forest' ? undefined : v)));
    return r;
  };
  const { rebuildFromEvents } = await import('../src/ml/aggregate');
  const { replayImplicitTraining, trainRecommendForest } = await import('../src/ml/rf-train');
  const { evaluateRecommend } = await import('../src/ml/eval');
  await time('aggregates', () => rebuildFromEvents());
  await time('replay', () => replayImplicitTraining({ cap: Infinity }));
  await time('forest', () => trainRecommendForest());

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  for (const mode of ['backtest', 'replay'] as const) {
    const e = await evaluateRecommend({ mode, sample: 250, splitDays: Number(process.env.SPLIT_DAYS ?? 7), persist: false, prequential: process.env.FROZEN ? false : true });
    console.log(
      `${mode} [${e.ensemble}] n=${e.evaluated} novel=${e.novel} in-pool=${pct(e.model.recallAtPool)}\n` +
        `  model    hit@1 ${pct(e.model.hit1)} (${e.ci.hit1.map(pct).join('–')})  hit@3 ${pct(e.model.hit3)}  hit@5 ${pct(e.model.hit5)}  MRR ${e.model.mrr.toFixed(3)}\n` +
        `  baseline hit@1 ${pct(e.baseline.hit1)}  hit@3 ${pct(e.baseline.hit3)}  hit@5 ${pct(e.baseline.hit5)}  MRR ${e.baseline.mrr.toFixed(3)}\n` +
        (['hit1', 'hit3'] as const)
          .map((k) => `  paired ${k}: model-only ${e.vsBaseline[k].modelOnly}, baseline-only ${e.vsBaseline[k].baselineOnly}, McNemar p=${e.vsBaseline[k].p.toPrecision(2)}`)
          .join('\n') + '\n' +
        `  reachable n=${e.reachable.n}: hit@1 ${pct(e.reachable.hit1)}  hit@3 ${pct(e.reachable.hit3)} (baseline ${pct(e.reachable.baselineHit3)})\n` +
        Object.entries(e.byKind)
          .map(([k, v]) => `  ${k.padEnd(6)} n=${v.n} hit@1 ${pct(v.hit1)} hit@3 ${pct(v.hit3)} (baseline ${pct(v.baselineHit3)})`)
          .join('\n'),
    );
    expect(e.evaluated).toBeGreaterThan(0);
  }
}, 600_000);
