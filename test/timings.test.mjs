/**
 * R1: phase timings on a run, and the percentile arithmetic `simcheck bench`
 * reports. Fake clock and an in-memory store, so nothing here waits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { phase, recordPhase, mergeTimings, percentile, median, summariseBench, formatBench } from '../dist/timings.js';

function memStore() {
  const runs = new Map([['r1', { id: 'r1' }]]);
  return {
    runs,
    get: (id) => runs.get(id),
    update: (id, patch) => Object.assign(runs.get(id), patch),   // shallow, like Store
  };
}

/** Advances 250ms per reading. */
function fakeClock(stepMs = 250) {
  let t = 0n;
  return () => { t += BigInt(stepMs) * 1_000_000n; return t; };
}

test('phase records elapsed ms from the injected clock', async () => {
  const store = memStore();
  await phase(store, 'r1', 'installMs', async () => 'ok', fakeClock(250));
  assert.equal(store.get('r1').timings.installMs, 250);
});

test('a successful phase is not listed as incomplete', async () => {
  const store = memStore();
  await phase(store, 'r1', 'launchMs', async () => {}, fakeClock());
  assert.equal(store.get('r1').timingsIncomplete, undefined);
});

test('a phase whose fn rejects is recorded as incomplete, and the rejection still propagates', async () => {
  const store = memStore();
  await assert.rejects(
    phase(store, 'r1', 'installMs', async () => { throw new Error('simctl install failed'); }, fakeClock(100)),
    /simctl install failed/);
  assert.equal(store.get('r1').timings.installMs, 100);
  assert.deepEqual(store.get('r1').timingsIncomplete, ['installMs']);
});

test('phases accumulate rather than clobber each other (Store.update is shallow)', async () => {
  const store = memStore();
  store.update('r1', { timings: { queueMs: 12 } });
  await phase(store, 'r1', 'prepareMs', async () => {}, fakeClock(5));
  await phase(store, 'r1', 'installMs', async () => {}, fakeClock(1200));
  recordPhase(store, 'r1', 'resetMs', 600);
  mergeTimings(store, 'r1', { occupancyMs: 9000 });
  assert.deepEqual(store.get('r1').timings, {
    queueMs: 12, prepareMs: 5, installMs: 1200, resetMs: 600, occupancyMs: 9000,
  });
});

test('a phase re-recorded as complete clears its incomplete mark', () => {
  const store = memStore();
  recordPhase(store, 'r1', 'stepsMs', 10, false);
  recordPhase(store, 'r1', 'stepsMs', 20, true);
  assert.deepEqual(store.get('r1').timingsIncomplete, []);
});

test('percentiles use nearest rank', () => {
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(xs, 50), 50);
  assert.equal(percentile(xs, 90), 90);
  assert.equal(percentile(xs, 100), 100);
  assert.equal(median([3, 1, 2]), 2);
});

test('with one sample every percentile is that sample; with none, undefined', () => {
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 90), 42);
  assert.equal(percentile([], 50), undefined);
});

test('bench summary: per-phase stats, cache hits, cold provisions, install share', () => {
  const mk = (install, occ, extra = {}) => ({
    status: 'passed', trace: [], timings: { queueMs: 5, prepareMs: 0, installMs: install, occupancyMs: occ, totalMs: occ + 5 }, ...extra,
  });
  const s = summariseBench([
    mk(2000, 10_000),
    mk(0, 8000, { warm: { cacheHit: true, reason: '' } }),
    mk(2000, 10_000, { status: 'failed', trace: [{ text: 'no warm iPhone was pooled, so a simulator is being created and booted -- slower' }] }),
  ]);
  assert.equal(s.iterations, 3);
  assert.deepEqual(s.statuses, { passed: 2, failed: 1 });
  assert.equal(s.cacheHits, 1);
  assert.equal(s.coldProvisions, 1);
  assert.equal(s.phases.installMs.p50, 2000);
  assert.equal(s.phases.occupancyMs.p50, 10_000);
  assert.equal(s.phases.occupancyMs.n, 3);
  assert.equal(s.installShare, 0.2);
  assert.equal(s.phases.launchMs, undefined, 'a phase no run reached is not reported');
  const table = formatBench(s);
  assert.match(table, /install\s+2000ms/);
  assert.match(table, /occupancy\s+10\.0s/);
  assert.match(table, /not a capacity number/);
});
