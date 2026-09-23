/**
 * R4: the queue. The scheduler decides whose Mac time a run gets, and until
 * now nothing tested it. Plain fakes, tick() called directly -- no timers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Scheduler, recentOccupancy } from '../dist/scheduler.js';
import { Store, recoverRun } from '../dist/store.js';
import { run, tempHome, testConfig } from './sim-fakes.mjs';

const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

function fakeStore(runs) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  return {
    pending: () => [...byId.values()].filter((r) => r.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    list: () => [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    get: (id) => byId.get(id),
    update: (id, patch) => Object.assign(byId.get(id), patch),
    trace: () => {},
    onChange: () => () => {},
  };
}

/** Devices are { udid, kind, status }; a request { name } matches a kind. */
function fakePool(devices, { started = true } = {}) {
  const leases = [];
  const provisions = [];
  const matches = (d, req) => !req?.name || req.name === d.kind;
  return {
    leases, provisions, devices,
    isStarted: started,
    canEverSatisfy: (req) => devices.some((d) => d.status !== 'offline' && matches(d, req)),
    matchingUdids: (req) => new Set(devices.filter((d) => d.status !== 'offline' && matches(d, req)).map((d) => d.udid)),
    warmCount: (req) => devices.filter((d) => ['ready', 'leased', 'recycling'].includes(d.status) && matches(d, req)).length,
    lease(runId, req, prefer) {
      const d = devices.find((x) => x.status === 'ready' && matches(x, req));
      if (!d) return null;
      d.status = 'leased';
      leases.push({ runId, udid: d.udid, prefer });
      return d;
    },
    async provisionFor(req) { provisions.push(req); return null; },
    list: () => devices.map((d) => ({ deviceType: d.kind, runtime: 'x' })),
  };
}

function fakeRunner() {
  const executed = [];
  return { executed, async execute(r, d) { executed.push([r.id, d.udid]); }, cancel: () => false };
}

test('the oldest pending run gets the free device', () => {
  const store = fakeStore([run('new', { createdAt: at(2) }), run('old', { createdAt: at(1) })]);
  const pool = fakePool([{ udid: 'D1', kind: 'iphone', status: 'ready' }]);
  const runner = fakeRunner();
  new Scheduler({}, pool, store, runner).tick();
  assert.deepEqual(runner.executed, [['old', 'D1']]);
});

test('a blocked run does not hold up a later one that wants a different, free device', () => {
  const store = fakeStore([
    run('ipad-run', { createdAt: at(1), request: { app: {}, device: { name: 'ipad' } } }),
    run('iphone-run', { createdAt: at(2), request: { app: {}, device: { name: 'iphone' } } }),
  ]);
  const pool = fakePool([
    { udid: 'P1', kind: 'ipad', status: 'leased' },
    { udid: 'D1', kind: 'iphone', status: 'ready' },
  ]);
  const runner = fakeRunner();
  new Scheduler({}, pool, store, runner).tick();
  assert.deepEqual(runner.executed, [['iphone-run', 'D1']]);
});

test('dispatch is plain oldest-first across tokens -- no round robin (pinned deliberately)', () => {
  const store = fakeStore([
    run('a1', { createdAt: at(1), submittedBy: { tokenId: 'A' } }),
    run('a2', { createdAt: at(2), submittedBy: { tokenId: 'A' } }),
    run('b1', { createdAt: at(3), submittedBy: { tokenId: 'B' } }),
  ]);
  const pool = fakePool([{ udid: 'D1', kind: 'iphone', status: 'ready' }, { udid: 'D2', kind: 'iphone', status: 'ready' }]);
  const runner = fakeRunner();
  new Scheduler({}, pool, store, runner).tick();
  assert.deepEqual(runner.executed.map(([id]) => id), ['a1', 'a2']);
});

test('the lease carries the run\'s tenant and artifact, for device affinity', () => {
  const store = fakeStore([run('r', { request: { app: { artifactId: 'abc' }, tenant: 'org1' } })]);
  const pool = fakePool([{ udid: 'D1', kind: 'iphone', status: 'ready' }]);
  new Scheduler({}, pool, store, fakeRunner()).tick();
  assert.deepEqual(pool.leases[0].prefer, { tenant: 'tok_a/org1', appHash: 'abc' });
});

test('nothing is dispatched, provisioned or failed before the pool has loaded', () => {
  const store = fakeStore([run('r')]);
  const pool = fakePool([], { started: false });
  const runner = fakeRunner();
  new Scheduler({}, pool, store, runner).tick();
  assert.equal(runner.executed.length, 0);
  assert.equal(pool.provisions.length, 0, 'an unloaded pool is not an empty one');
  assert.equal(store.get('r').status, 'pending');
});

test('an unsatisfiable run whose provision fails is errored, naming the pool', async () => {
  const store = fakeStore([run('r', { request: { app: {}, device: { name: 'ipad' } } })]);
  const pool = fakePool([{ udid: 'D1', kind: 'iphone', status: 'ready' }]);
  const sched = new Scheduler({}, pool, store, fakeRunner());
  sched.tick();
  sched.tick();   // provision still in flight: must not be asked twice
  assert.equal(pool.provisions.length, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.get('r').status, 'error');
  assert.match(store.get('r').error, /Pooled devices: iphone\/x/);
});

test('queue position counts only runs competing for the same devices', () => {
  const store = fakeStore([
    run('ipad1', { createdAt: at(1), request: { app: {}, device: { name: 'ipad' } } }),
    run('iphone1', { createdAt: at(2), request: { app: {}, device: { name: 'iphone' } } }),
    run('ipad2', { createdAt: at(3), request: { app: {}, device: { name: 'ipad' } } }),
    run('iphone2', { createdAt: at(4), request: { app: {}, device: { name: 'iphone' } } }),
  ]);
  const pool = fakePool([{ udid: 'P1', kind: 'ipad', status: 'leased' }, { udid: 'D1', kind: 'iphone', status: 'leased' }]);
  const sched = new Scheduler({}, pool, store, fakeRunner());
  const info = sched.queueInfo('iphone2');
  assert.equal(info.queuePosition, 3, 'the global index still counts everyone');
  assert.equal(info.queuePositionForDevice, 1, 'only iphone1 is actually ahead');
  assert.equal(info.waitingFor, 'device');
  assert.equal(info.etaSeconds, undefined, 'no history: no estimate rather than a guess');
  assert.equal(sched.queueInfo('nope'), null);
});

test('ETA comes from measured occupancy on the same devices, and is withheld across a cold boot', () => {
  const done = (id, udid, occ, s) => run(id, {
    status: 'passed', createdAt: at(s), device: { udid }, timings: { occupancyMs: occ },
  });
  const store = fakeStore([
    done('h1', 'D1', 10_000, 1), done('h2', 'D1', 20_000, 2), done('h3', 'D1', 30_000, 3),
    done('other', 'P1', 999_000, 4),
    run('q1', { createdAt: at(10), request: { app: {}, device: { name: 'iphone' } } }),
    run('q2', { createdAt: at(11), request: { app: {}, device: { name: 'iphone' } } }),
    run('cold', { createdAt: at(12), request: { app: {}, device: { name: 'ipad' } } }),
  ]);
  const pool = fakePool([
    { udid: 'D1', kind: 'iphone', status: 'leased' },
    { udid: 'P1', kind: 'ipad', status: 'booting' },
  ]);
  const sched = new Scheduler({}, pool, store, fakeRunner());
  const q2 = sched.queueInfo('q2');
  // One warm device, one run ahead: two turns of the 20s median.
  assert.equal(q2.etaSeconds, 40);
  assert.equal(q2.etaSamples, 3);
  const cold = sched.queueInfo('cold');
  assert.equal(cold.waitingFor, 'device_boot');
  assert.equal(cold.etaSeconds, undefined);
});

test('recentOccupancy takes the newest samples for the given devices only', () => {
  const runs = [
    { device: { udid: 'A' }, timings: { occupancyMs: 3 } },
    { device: { udid: 'B' }, timings: { occupancyMs: 99 } },
    { device: { udid: 'A' }, timings: {} },
    { device: { udid: 'A' }, timings: { occupancyMs: 1 } },
    { device: { udid: 'A' }, timings: { occupancyMs: 2 } },
  ];
  assert.deepEqual(recentOccupancy(runs, new Set(['A']), 2), [3, 1]);
});

/* ----------------------------------------------------------- restarts -- */

test('a pending run survives a restart in its place; one that held a device is errored', () => {
  const now = at(59);
  const queued = run('q');
  assert.equal(recoverRun(queued, now), 'requeued');
  assert.equal(queued.status, 'pending');
  assert.match(queued.trace.at(-1).text, /still queued/);

  const inFlight = run('f', { status: 'running', startedAt: at(1) });
  assert.equal(recoverRun(inFlight, now), 'errored');
  assert.equal(inFlight.status, 'error');
  assert.match(inFlight.error, /in flight/);
  assert.equal(inFlight.releasedAt, now, 'nothing more will reset its device, so it is settled');

  const done = run('d', { status: 'passed' });
  assert.equal(recoverRun(done, now), 'unchanged');
});

test('a queued run whose download headers were memory-only is errored, not requeued', () => {
  const r = run('h', { request: { app: { url: 'https://ci.example/app.zip', urlHeaders: { Authorization: '[redacted]' } } } });
  assert.equal(recoverRun(r, at(5)), 'errored');
  assert.match(r.error, /resubmit/);
});

test('Store.load requeues pending runs from disk and keeps their order', () => {
  const home = tempHome();
  for (const r of [run('b', { createdAt: at(2) }), run('a', { createdAt: at(1) }), run('x', { status: 'preparing', startedAt: at(3) })]) {
    fs.mkdirSync(path.join(home, 'runs', r.id), { recursive: true });
    fs.writeFileSync(path.join(home, 'runs', r.id, 'run.json'), JSON.stringify(r));
  }
  const store = new Store(testConfig(home));
  store.load();
  assert.deepEqual(store.pending().map((r) => r.id), ['a', 'b']);
  assert.equal(store.get('x').status, 'error');
  // Persisted, so a second restart sees the same thing.
  const again = JSON.parse(fs.readFileSync(path.join(home, 'runs', 'x', 'run.json'), 'utf8'));
  assert.equal(again.status, 'error');
});
