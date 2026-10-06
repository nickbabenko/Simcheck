/**
 * simbase docs/30 P0 in the daemon: `assert` on text, value and enabled (R2),
 * every assertion recorded with expected vs actual (R3), and the probe on by
 * default where it can attach (R4).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StepExecutor, AssertionFailed } from '../dist/steps.js';
import { ProbeSession } from '../dist/ios/probe-session.js';
import { Runner } from '../dist/runner.js';
import { Store } from '../dist/store.js';
import { Pool } from '../dist/pool.js';
import { writeReport } from '../dist/report.js';
import { tempHome, testConfig, fakeBackend, fakeUi, fakePlatforms, device, run } from './sim-fakes.mjs';
import { stubProbe, request } from './probe-stub.mjs';

const element = (over) => ({
  type: 'StaticText', enabled: true,
  center: { x: 100, y: 100 }, frame: { x: 50, y: 90, width: 100, height: 20 }, depth: 3,
  ...over,
});

/** A UI whose screen is whatever `screen.elements` holds when it is read. */
function screenUi(elements = []) {
  const screen = { elements };
  return {
    screen,
    ui: {
      ...fakeUi(),
      async describe() { return { width: 402, height: 874, units: 'pt', elements: screen.elements, truncated: 0 }; },
    },
  };
}

function rig({ ui = fakeUi(), probe = null } = {}) {
  const home = tempHome();
  const store = new Store(testConfig(home));
  const runDir = path.join(home, 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  store.create(run('r1', { status: 'running' }));
  const exec = new StepExecutor(ui, fakeBackend(), store, {
    runId: 'r1', udid: 'U1', app: { appId: 'com.example.app', executable: 'App' },
    runDir, launchArgs: [], launchEnv: {}, signal: new AbortController().signal,
    ...(probe ? { probe } : {}),
  }, undefined);
  return { exec, store, runDir, assertions: () => store.get('r1').assertions ?? [] };
}

test('assert with text, value and enabled passes when one element has them all, and records each', async () => {
  const { ui } = screenUi([
    element({ id: 'basket-total', label: '41,00 €' }),
    element({ id: 'basket-total', label: '39,00 €' }),
    element({ id: 'promo', type: 'TextField', label: 'Code', value: 'SPRING10', enabled: false }),
  ]);
  const { exec, assertions } = rig({ ui });

  await exec.run({ action: 'assert', id: 'basket-total', text: '39,00 €' });
  await exec.run({ action: 'assert', label: 'Code', value: 'SPRING', op: 'contains', enabled: false });

  assert.deepEqual(assertions(), [
    { step: 0, kind: 'node', target: { id: 'basket-total' }, prop: 'text', op: 'eq', expected: '39,00 €', actual: '39,00 €', pass: true },
    { step: 1, kind: 'node', target: { label: 'Code' }, prop: 'value', op: 'contains', expected: 'SPRING', actual: 'SPRING10', pass: true },
    { step: 1, kind: 'node', target: { label: 'Code' }, prop: 'enabled', expected: false, actual: false, pass: true },
  ]);
});

test('a value that never matches fails the run as a verdict, with what the app had', async () => {
  const { ui } = screenUi([element({ id: 'basket-total', label: '41,00 €' }), element({ id: 'pay', type: 'Button', label: 'Pay', enabled: false })]);
  const { exec, assertions } = rig({ ui });

  await assert.rejects(exec.run({ action: 'assert', id: 'basket-total', text: '39,00 €', timeoutMs: 50, note: 'promo applied' }),
    (e) => e instanceof AssertionFailed &&
      /#basket-total text was "41,00 €", expected "39,00 €" after 50ms \(promo applied\)/.test(e.message));
  await assert.rejects(exec.run({ action: 'assert', id: 'pay', enabled: true, timeoutMs: 50 }),
    (e) => e instanceof AssertionFailed && /#pay enabled was false, expected true/.test(e.message));

  const [text, enabled] = assertions();
  assert.equal(text.pass, false);
  assert.equal(text.actual, '41,00 €');
  assert.equal(text.note, 'promo applied');
  assert.deepEqual({ prop: enabled.prop, expected: enabled.expected, actual: enabled.actual, pass: enabled.pass },
    { prop: 'enabled', expected: true, actual: false, pass: false });
});

test('an element that never appears is one failed "present" result, whatever was asked of it', async () => {
  const { exec, assertions } = rig({ ui: screenUi([]).ui });

  await assert.rejects(exec.run({ action: 'assert', id: 'basket-total', text: '39', timeoutMs: 50 }),
    (e) => e instanceof AssertionFailed && /#basket-total did not appear within 50ms/.test(e.message));
  assert.deepEqual(assertions().map(({ prop, expected, actual, pass }) => ({ prop, expected, actual, pass })),
    [{ prop: 'present', expected: true, actual: false, pass: false }]);
});

test('assert waits for the value to arrive, not just the element', async () => {
  const { ui, screen } = screenUi([element({ id: 'status', label: 'Connecting…' })]);
  const { exec, assertions } = rig({ ui });
  setTimeout(() => { screen.elements = [element({ id: 'status', label: 'Charging' })]; }, 200);

  await exec.run({ action: 'assert', id: 'status', text: 'Charging', timeoutMs: 3000 });
  assert.equal(assertions()[0].pass, true);
});

test('a presence-only assert records a result either way, and the step index skips nothing', async () => {
  const { exec, assertions } = rig({ ui: fakeUi(new Set(['settings'])) });

  await exec.run({ action: 'wait', ms: 1 });
  await exec.run({ action: 'assert', id: 'settings' });
  await assert.rejects(exec.run({ action: 'assert', label: 'Nowhere', timeoutMs: 10 }), AssertionFailed);

  assert.deepEqual(assertions().map(({ step, target, prop, pass }) => ({ step, target, prop, pass })), [
    { step: 1, target: { id: 'settings' }, prop: 'present', pass: true },
    { step: 2, target: { label: 'Nowhere' }, prop: 'present', pass: false },
  ]);
});

test('assert_request records the request it matched, or the nearest one it saw', async () => {
  const stub = await stubProbe();
  const home = tempHome();
  const runDir = path.join(home, 'probe-run');
  fs.mkdirSync(runDir, { recursive: true });
  const probe = new ProbeSession('/tmp/SimbaseProbe.dylib', stub.port, stub.token, runDir);
  const { exec, assertions } = rig({ probe });
  try {
    await exec.run({ action: 'launch' });
    stub.state.requests = [
      request(1, { url: 'https://api.example.com/items/7', status: 200 }),
      request(2, { url: 'https://api.example.com/login', method: 'POST', status: 401 }),
    ];
    await exec.run({ action: 'assert_request', urlPattern: '*/items/*', status: 200 });
    await assert.rejects(exec.run({ action: 'assert_request', urlPattern: '*/login', method: 'post', status: 200, timeoutMs: 200 }), AssertionFailed);

    const [held, missed] = assertions();
    assert.deepEqual(held, {
      step: 1, kind: 'request', match: '*/items/* -> 200',
      expected: { urlPattern: '*/items/*', status: 200 },
      actual: { method: 'GET', url: 'https://api.example.com/items/7', state: 'completed', status: 200 },
      pass: true,
    });
    assert.equal(missed.pass, false);
    assert.equal(missed.match, 'POST */login -> 200');
    assert.deepEqual(missed.expected, { urlPattern: '*/login', method: 'POST', status: 200 });
    assert.equal(missed.actual.status, 401, 'the nearest request is what the app actually did');
    assert.match(missed.message, /no completed request matching/);
  } finally {
    stub.close();
  }
});

test('the report lists every assertion with expected and actual', async () => {
  const { ui } = screenUi([element({ id: 'total', label: '41 | 2' })]);
  const { exec, store, runDir } = rig({ ui });
  await assert.rejects(exec.run({ action: 'assert', id: 'total', text: '39', timeoutMs: 10 }), AssertionFailed);

  writeReport(store.get('r1'), runDir);
  const report = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');
  assert.match(report, /## Assertions \(1 of 1 failed\)/);
  assert.match(report, /\| 1 \| \*\*failed\*\* \| #total text \| 39 \| 41 \\\| 2 \|/);
});

/* ------------------------------------------------------- probe default -- */

function runnerRig({ probeDylib }) {
  const home = tempHome();
  const cfg = { ...testConfig(home), probe: 'on', probeDylib };
  fs.writeFileSync(path.join(home, 'pool.json'), JSON.stringify([device('D1', { status: 'leased' })]));
  const platforms = fakePlatforms();
  const pool = new Pool(cfg, platforms);
  pool.load();
  const store = new Store(cfg);
  const runner = new Runner(cfg, pool, store, null, {}, platforms);
  let n = 0;
  const go = async (request) => {
    const id = `r${++n}`;
    store.create(run(id, { request: { app: { artifactId: 'a1' }, steps: [{ action: 'wait', ms: 1 }], ...request } }));
    pool.get('D1').status = 'leased';
    await runner.execute(store.get(id), pool.get('D1'));
    return store.get(id);
  };
  return { go, home };
}

const launchEntry = (done) => done.trace.find((entry) => entry.step?.action === 'launch');

test('probe left out: tried wherever the daemon has it; never with probe: false', async () => {
  const home = tempHome();
  const dylib = path.join(home, 'SimbaseProbe.dylib');
  fs.writeFileSync(dylib, 'not really a dylib');
  const { go } = runnerRig({ probeDylib: dylib });

  const defaulted = await go({});
  assert.equal(defaulted.status, 'passed', defaulted.error);
  assert.ok(launchEntry(defaulted).settle, 'the launch had a probe session to settle through');
  assert.equal(typeof defaulted.timings.settleSavedMs, 'number');

  const optedOut = await go({ probe: false });
  assert.equal(optedOut.status, 'passed', optedOut.error);
  assert.equal(launchEntry(optedOut).settle, undefined, 'no probe session at all');
  assert.ok(!optedOut.trace.some((entry) => /probe/.test(entry.text)));
  assert.equal(optedOut.timings.settleSavedMs, undefined);
});

test('probe left out on a daemon without it: the run reads exactly as before, no note', async () => {
  const { go } = runnerRig({ probeDylib: '' });
  const done = await go({});
  assert.equal(done.status, 'passed', done.error);
  assert.equal(launchEntry(done).settle, undefined);
  assert.ok(!done.trace.some((entry) => /probe/.test(entry.text)), 'nothing about a probe nobody asked for');
  assert.equal(done.timings.settleSavedMs, undefined);
});
