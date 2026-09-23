/**
 * Runner.execute() end to end against fake devices: that every phase lands in
 * run.timings (reset and occupancy included, after the run is terminal), that
 * a relaunch run of the same build skips the install, that a tenant change
 * erases first, and that a missed `assert` fails the run rather than erroring.
 *
 * Real Store and Pool on a throwaway home; only the device side is faked. Each
 * run pays the executor's real settle sleeps, so these take a few seconds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Runner } from '../dist/runner.js';
import { Store } from '../dist/store.js';
import { Pool } from '../dist/pool.js';
import { tempHome, testConfig, fakePlatforms, fakeUi, device, run } from './sim-fakes.mjs';

function rig({ visible } = {}) {
  const home = tempHome();
  const cfg = testConfig(home);
  fs.writeFileSync(path.join(home, 'pool.json'), JSON.stringify([device('D1', { status: 'leased' })]));
  const platforms = fakePlatforms({ ui: fakeUi(new Set(visible ?? [])) });
  const pool = new Pool(cfg, platforms);
  pool.load();
  const store = new Store(cfg);
  const runner = new Runner(cfg, pool, store, null, {}, platforms);
  let n = 0;
  const go = async (extra = {}) => {
    const r = run(`r${++n}`, extra);
    r.createdAt = new Date(Date.now() - 50).toISOString();
    store.create(r);
    const d = pool.get('D1');
    d.status = 'leased';
    await runner.execute(store.get(r.id), d);
    return store.get(r.id);
  };
  return { go, pool, store, calls: platforms.backend.calls };
}

const installs = (calls) => calls.filter((c) => c.startsWith('install:')).length;

test('every phase is timed, and reset/occupancy land after the run is terminal', async () => {
  const { go, store } = rig();
  const r = await go();
  assert.equal(r.status, 'passed', r.error);
  const t = r.timings;
  for (const k of ['queueMs', 'prepareMs', 'installMs', 'launchMs', 'stepsMs', 'screenshotMs', 'resetMs', 'occupancyMs', 'totalMs']) {
    assert.equal(typeof t[k], 'number', `${k} missing: ${JSON.stringify(t)}`);
  }
  assert.ok(t.queueMs >= 50);
  assert.ok(t.launchMs >= 1200, 'launch includes its settle');
  assert.ok(t.occupancyMs >= t.launchMs + t.resetMs);
  assert.equal(t.totalMs, t.queueMs + t.occupancyMs);
  assert.ok(r.releasedAt, 'settled');
  // The final-state screenshot now carries its duration in the trace.
  const shot = r.trace.find((e) => e.kind === 'screenshot');
  assert.equal(typeof shot.durationMs, 'number');
  // The report is rewritten once the reset is known.
  const report = fs.readFileSync(path.join(store.dir(r.id), 'report.md'), 'utf8');
  assert.match(report, /## Timings/);
  assert.match(report, /\| reset \|/);
  assert.match(report, /\| occupancy \(device time\) \|/);
});

test('a second relaunch run of the same build for the same tenant skips the install', async () => {
  const { go, pool, calls } = rig();
  const req = { app: { artifactId: 'h1', bundleId: 'com.example.app' }, steps: [{ action: 'wait', ms: 1 }], resetPolicy: 'relaunch' };
  const first = await go({ request: structuredClone(req) });
  assert.equal(first.warm.cacheHit, false);
  assert.equal(first.warm.resetPolicyUsed, 'relaunch');
  assert.equal(pool.get('D1').installed.appHash, 'h1');
  assert.equal(installs(calls), 1);

  const second = await go({ request: structuredClone(req) });
  assert.equal(second.status, 'passed', second.error);
  assert.equal(second.warm.cacheHit, true);
  assert.equal(installs(calls), 1, 'no second install');
  assert.ok(second.trace.some((e) => /install skipped/.test(e.text)));

  // A plain run of the same build always installs fresh.
  await go({ request: { ...structuredClone(req), resetPolicy: 'uninstall' } });
  assert.equal(installs(calls), 2);
  assert.equal(pool.get('D1').installed, undefined);
});

test('a run for another tenant erases the device first, and is billed for it', async () => {
  const { go, calls } = rig();
  await go({ request: { app: { artifactId: 'h1' }, steps: [{ action: 'wait', ms: 1 }], tenant: 'org1' } });
  assert.ok(!calls.includes('erase:D1'));
  const other = await go({ request: { app: { artifactId: 'h1' }, steps: [{ action: 'wait', ms: 1 }], tenant: 'org2' } });
  assert.ok(calls.includes('erase:D1'), 'tenant change must erase');
  assert.equal(other.warm.erased, true);
  assert.equal(typeof other.timings.preResetMs, 'number');
  assert.ok(calls.indexOf('erase:D1') < calls.lastIndexOf('install:D1:/builds/com.example.app.app'), 'erase before install');
});

test('a dirty device is erased before the next install', async () => {
  const { go, pool, calls } = rig();
  pool.get('D1').dirty = true;
  await go();
  assert.ok(calls.includes('erase:D1'));
  assert.equal(pool.get('D1').dirty, undefined);
});

test('a missed assert fails the run (a verdict), and relaunch is still honoured', async () => {
  const { go } = rig({ visible: [] });
  const r = await go({
    request: {
      app: { artifactId: 'h1' }, resetPolicy: 'relaunch',
      steps: [{ action: 'open_url', url: 'app://settings' }, { action: 'assert', id: 'settings', timeoutMs: 10 }, { action: 'wait', ms: 1 }],
    },
  });
  assert.equal(r.status, 'failed');
  assert.match(r.verdict.summary, /assertion failed at step 2 of 3: #settings did not appear/);
  assert.equal(r.warm.resetPolicyUsed, 'relaunch');
});

test('an assert that holds passes, and no deep-link warning is traced', async () => {
  const { go } = rig({ visible: ['settings'] });
  const r = await go({
    request: { app: { artifactId: 'h1' }, steps: [{ action: 'open_url', url: 'app://s' }, { action: 'assert', id: 'settings' }] },
  });
  assert.equal(r.status, 'passed', r.error);
  assert.ok(!r.trace.some((e) => /nothing checks it landed/.test(e.text)));
});

test('an errored relaunch run is downgraded to uninstall and leaves nothing cached', async () => {
  const { go, pool } = rig({ visible: [] });
  const r = await go({
    request: { app: { artifactId: 'h1' }, resetPolicy: 'relaunch', steps: [{ action: 'wait_for', id: 'never', timeoutMs: 10 }] },
  });
  assert.equal(r.status, 'error');
  assert.equal(r.warm.resetPolicyUsed, 'uninstall');
  assert.ok(r.trace.some((e) => /downgraded/.test(e.text)));
  assert.equal(pool.get('D1').installed, undefined);
  assert.deepEqual(r.timingsIncomplete, ['stepsMs']);
});
