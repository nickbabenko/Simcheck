/**
 * Greybox probe integration (packages/probe/INTEGRATION.md): launch plumbing
 * with a per-run port and token, settle instead of fixed sleeps with a
 * fallback, the SpringBoard check, wait_idle and assert_request, private
 * network/console evidence, and the rule that the probe never fails a run.
 *
 * Driven against a stub of the probe's HTTP API; the real dylib was verified
 * on a simulator with the greybox fixture (see the commit message).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StepExecutor, AssertionFailed, validateSteps } from '../dist/steps.js';
import { ProbeSession } from '../dist/ios/probe-session.js';
import { globMatches, resolveProbe } from '../dist/ios/probe.js';
import { Runner } from '../dist/runner.js';
import { Store } from '../dist/store.js';
import { Pool } from '../dist/pool.js';
import { TokenStore } from '../dist/auth.js';
import { Client } from '../dist/client.js';
import { createServer } from '../dist/server.js';
import { tempHome, testConfig, fakeBackend, fakeUi, fakePlatforms, device, run } from './sim-fakes.mjs';
import { stubProbe, request } from './probe-stub.mjs';

/** An executor with a probe session pointed at the stub. */
async function rig({ ui = fakeUi(), withProbe = true, stub: given } = {}) {
  const stub = given ?? await stubProbe();
  const home = tempHome();
  const store = new Store(testConfig(home));
  const runDir = path.join(home, 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  store.create(run('r1', { status: 'running' }));

  const backend = fakeBackend();
  const launches = [];
  backend.launch = async (id, app, args, env) => { launches.push(env); return 1; };

  const probe = withProbe ? new ProbeSession('/tmp/SimbaseProbe.dylib', stub.port, stub.token, runDir) : null;
  const exec = new StepExecutor(ui, backend, store, {
    runId: 'r1', udid: 'U1', app: { appId: 'com.example.app', executable: 'App' },
    runDir, launchArgs: [], launchEnv: { API_BASE_URL: 'https://x.test' },
    signal: new AbortController().signal, probe, settleTimeoutMs: 2000,
  }, undefined);
  exec.consentWindowMs = 30;
  const trace = () => store.get('r1').trace;
  return { exec, stub, store, backend, launches, runDir, trace, probe };
}

test('launch injects the probe after the caller\'s env, and settles through it', async () => {
  const { exec, stub, launches, trace } = await rig();
  try {
    const started = Date.now();
    await exec.run({ action: 'launch' });

    assert.equal(launches.length, 1);
    const env = launches[0];
    assert.equal(env.API_BASE_URL, 'https://x.test', 'the caller\'s env survives');
    assert.equal(env.DYLD_INSERT_LIBRARIES, '/tmp/SimbaseProbe.dylib');
    assert.equal(env.SIMBASE_PROBE_PORT, String(stub.port));
    assert.equal(env.SIMBASE_PROBE_TOKEN, stub.token);
    assert.ok(exec.probeAttached);
    assert.ok(Date.now() - started < 1200, 'no fixed 1200ms sleep');

    const step = trace().find((entry) => entry.kind === 'step');
    assert.equal(step.settle.via, 'probe');
    assert.equal(step.settle.waitedMs, 120);
    assert.equal(step.settle.fallbackMs, 1200);
    assert.equal(exec.settleSavedMs, 1080);
    assert.ok(!JSON.stringify(trace()).includes(stub.token), 'the token never reaches the trace');
  } finally {
    stub.close();
  }
});

test('a hello from another app is not trusted: fixed waits, a note, and the run goes on', async () => {
  const stub = await stubProbe({ bundleId: 'com.someone.else' });
  const { exec, trace } = await rig({ stub });
  try {
    const started = Date.now();
    await exec.run({ action: 'launch' });
    assert.equal(exec.probeAttached, false);
    assert.ok(Date.now() - started >= 1200, 'fell back to the fixed sleep');
    const note = trace().find((entry) => entry.kind === 'note');
    assert.match(note.text, /probe unavailable: port \d+ answered for com\.someone\.else.*using fixed waits/);
    const step = trace().find((entry) => entry.kind === 'step');
    assert.equal(step.settle.via, 'sleep');
  } finally {
    stub.close();
  }
});

test('two failed settles in a row detach the probe; the steps still pass', async () => {
  const { exec, stub, trace } = await rig();
  try {
    await exec.run({ action: 'launch' });
    stub.state.failSettle = true;
    await exec.run({ action: 'type', text: 'a' });
    await exec.run({ action: 'type', text: 'b' });
    assert.equal(exec.probeAttached, false);
    const steps = trace().filter((entry) => entry.kind === 'step');
    assert.match(steps[1].settle.probeError, /answered 500/);
    assert.ok(trace().some((entry) => /probe unavailable: 2 probe calls in a row failed/.test(entry.text)));
    await exec.run({ action: 'type', text: 'c' });
    assert.equal(trace().filter((entry) => entry.kind === 'step')[3].settle.via, 'sleep');
  } finally {
    stub.close();
  }
});

test('a settle timeout is not a failure: the step passes and the trace says what was busy', async () => {
  const { exec, stub, trace } = await rig();
  try {
    await exec.run({ action: 'launch' });
    stub.state.settle = { settled: false, elapsedMs: 2000, settledAtMs: null, busy: ['spinner'] };
    await exec.run({ action: 'swipe', startX: 1, startY: 1, endX: 2, endY: 2 });
    const swipe = trace().filter((entry) => entry.kind === 'step')[1];
    assert.equal(swipe.ok, true);
    assert.equal(swipe.settle.settled, false);
    assert.deepEqual(swipe.settle.busy, ['spinner']);
    assert.equal(exec.settleSavedMs, 1080 + (500 - 2000), 'savings can go negative, honestly');
  } finally {
    stub.close();
  }
});

test('after a tap AXe looks for system UI the probe cannot see; after type it does not', async () => {
  const ui = fakeUi();
  let describes = 0;
  const sheet = {
    width: 402, height: 874, units: 'pt', truncated: 0,
    elements: [{ type: 'Alert', label: '“App” Would Like to Send You Notifications', enabled: true, center: { x: 200, y: 400 }, frame: { x: 40, y: 350, width: 320, height: 100 }, depth: 1 }],
  };
  ui.describe = async () => { describes += 1; return sheet; };
  const { exec, stub, trace } = await rig({ ui });
  try {
    await exec.run({ action: 'launch' });
    const afterLaunch = describes;
    await exec.run({ action: 'type', text: 'x' });
    assert.equal(describes, afterLaunch, 'no AXe read after type');
    await exec.run({ action: 'tap', id: 'go' });
    assert.equal(describes, afterLaunch + 1);
    const tap = trace().filter((entry) => entry.kind === 'step').pop();
    assert.match(tap.settle.systemUi, /Would Like to Send You Notifications/);
    assert.ok(trace().some((entry) => entry.kind === 'note' && /alert or sheet is on screen after tap/.test(entry.text)));
  } finally {
    stub.close();
  }
});

test('open_url goes through the app by default with the probe, and never touches simctl', async () => {
  const { exec, stub, backend } = await rig();
  try {
    await exec.run({ action: 'launch' });
    await exec.run({ action: 'open_url', url: 'greyfix://item/7' });
    assert.ok(stub.state.calls.some((call) => call.startsWith('POST /v1/open-url')));
    assert.ok(!backend.calls.some((call) => call.startsWith('openUrl:')));

    stub.state.opened = false;
    await exec.run({ action: 'open_url', url: 'https://example.com' });
    assert.ok(backend.calls.includes('openUrl:U1:https://example.com'), 'not taken in-app: the system path');

    await exec.run({ action: 'open_url', url: 'greyfix://item/8', via: 'simctl' });
    assert.ok(backend.calls.includes('openUrl:U1:greyfix://item/8'));
  } finally {
    stub.close();
  }
});

test('assert_request passes on a completed match and fails the run (a verdict) on a miss', async () => {
  const { exec, stub } = await rig();
  try {
    await exec.run({ action: 'launch' });
    stub.state.requests = [
      request(1, { url: 'https://api.example.com/items/7?api_key=<redacted>', status: 200 }),
      request(2, { url: 'https://api.example.com/login', method: 'POST', status: 401 }),
      request(3, { url: 'https://api.example.com/slow', state: 'running', status: undefined }),
    ];
    await exec.run({ action: 'assert_request', urlPattern: 'https://api.example.com/items/*', method: 'get', status: 200 });

    await assert.rejects(
      exec.run({ action: 'assert_request', urlPattern: '*/login', method: 'POST', status: 200, timeoutMs: 300 }),
      (e) => e instanceof AssertionFailed && /no completed request matching POST \*\/login -> 200.*saw POST .*login completed 401/.test(e.message));
    await assert.rejects(
      exec.run({ action: 'assert_request', urlPattern: '*/slow', timeoutMs: 200 }),
      (e) => e instanceof AssertionFailed, 'a request still running does not count');
  } finally {
    stub.close();
  }
});

test('wait_idle: a timeout is an error; without a probe it waits a fixed time instead of failing', async () => {
  const { exec, stub } = await rig();
  try {
    await exec.run({ action: 'launch' });
    await exec.run({ action: 'wait_idle' });
    stub.state.settle = { settled: false, elapsedMs: 300, settledAtMs: null, busy: ['network'] };
    await assert.rejects(exec.run({ action: 'wait_idle', timeoutMs: 300 }), /timed out after 300ms .*network/);
  } finally {
    stub.close();
  }

  const bare = await rig({ withProbe: false });
  try {
    await bare.exec.run({ action: 'wait_idle', timeoutMs: 50 });
    assert.match(bare.trace().find((entry) => entry.kind === 'step').text, /without a probe: waited a fixed 50ms/);
    await assert.rejects(bare.exec.run({ action: 'assert_request', urlPattern: '*' }), (e) =>
      !(e instanceof AssertionFailed) && /needs the probe/.test(e.message));
  } finally {
    bare.stub.close();
  }
});

test('network.json and console.log are pulled per step, tagged with the step running when a request started', async () => {
  const { exec, stub, runDir } = await rig();
  try {
    await exec.run({ action: 'launch' });
    stub.state.requests = [request(1, { state: 'running', status: undefined })];
    stub.state.lines = [{ seq: 1, at: Date.now(), stream: 'stdout', line: 'fixture: loaded item 7' }];
    await exec.run({ action: 'tap', id: 'row_7' });

    // The request finishes later: the next pull picks up its completion,
    // keeping the step it was first seen in.
    stub.state.requests = [request(1, { startedAt: stub.state.requests[0].startedAt })];
    await exec.run({ action: 'wait', ms: 1 });
    const evidence = await exec.closeProbe();

    assert.deepEqual(evidence, { networkLog: 'network.json', consoleLog: 'console.log' });
    const network = JSON.parse(fs.readFileSync(path.join(runDir, 'network.json'), 'utf8'));
    assert.equal(network.requests.length, 1);
    assert.equal(network.requests[0].state, 'completed');
    assert.equal(network.requests[0].step, 1, 'started during step 1 (the tap)');
    assert.match(fs.readFileSync(path.join(runDir, 'console.log'), 'utf8'), /stdout fixture: loaded item 7/);
  } finally {
    stub.close();
  }
});

test('the probe steps validate their keys', () => {
  validateSteps([{ action: 'wait_idle', timeoutMs: 5000, quietMs: 300 }, { action: 'assert_request', urlPattern: '*/x', status: 200 }]);
  assert.throws(() => validateSteps([{ action: 'assert_request' }]), /missing required key "urlPattern"/);
  assert.throws(() => validateSteps([{ action: 'assert_request', urlPattern: '*', method: 'G ET' }]), /HTTP method/);
  assert.throws(() => validateSteps([{ action: 'wait_idle', timeoutMs: 120_000 }]), /between 0 and 60000/);
  assert.throws(() => validateSteps([{ action: 'open_url', url: 'x://y', via: 'safari' }]), /"app" or "simctl"/);
});

test('globMatches: * is the only wildcard, and nothing backtracks', () => {
  assert.ok(globMatches('https://api.example.com/items/*', 'https://api.example.com/items/7?x=1'));
  assert.ok(globMatches('*/items/*/detail', 'https://h/items/7/detail'));
  assert.ok(!globMatches('*/items/*/detail', 'https://h/items/7/detail/more'));
  assert.ok(globMatches('exact', 'exact'));
  assert.ok(!globMatches('a.c', 'abc'), 'a dot is a dot');
  assert.ok(!globMatches('ab*ba', 'aba'), 'prefix and suffix may not overlap');
  const started = Date.now();
  globMatches(`${'*a'.repeat(50)}b`, 'a'.repeat(5000));
  assert.ok(Date.now() - started < 200);
});

test('resolveProbe: the kill switch, a missing file, and a sha256 that does not match', () => {
  const home = tempHome();
  const dylib = path.join(home, 'SimbaseProbe.dylib');
  fs.writeFileSync(dylib, 'dylib bytes');
  const digest = crypto.createHash('sha256').update('dylib bytes').digest('hex');

  assert.match(resolveProbe({ probe: 'off', probeDylib: dylib }).unavailable, /switched off/);
  assert.match(resolveProbe({ probe: 'on', probeDylib: '' }).unavailable, /no probe dylib/);
  assert.match(resolveProbe({ probe: 'on', probeDylib: path.join(home, 'nope') }).unavailable, /not at/);
  assert.deepEqual(resolveProbe({ probe: 'on', probeDylib: dylib }), { dylibPath: dylib });

  fs.writeFileSync(`${dylib}.sha256`, `${digest}  SimbaseProbe.dylib\n`);
  assert.deepEqual(resolveProbe({ probe: 'on', probeDylib: dylib }), { dylibPath: dylib });
  fs.writeFileSync(dylib, 'tampered');
  assert.match(resolveProbe({ probe: 'on', probeDylib: dylib }).unavailable, /does not match/);
});

test('runner: probe: true with no dylib runs anyway, notes why, and records settleSavedMs 0', async () => {
  const home = tempHome();
  const cfg = { ...testConfig(home), probe: 'on', probeDylib: '' };
  fs.writeFileSync(path.join(home, 'pool.json'), JSON.stringify([device('D1', { status: 'leased' })]));
  const platforms = fakePlatforms();
  const pool = new Pool(cfg, platforms);
  pool.load();
  const store = new Store(cfg);
  const runner = new Runner(cfg, pool, store, null, {}, platforms);
  const record = run('r1', { request: { app: { artifactId: 'a1' }, steps: [{ action: 'wait', ms: 1 }], probe: true } });
  store.create(record);
  await runner.execute(store.get('r1'), pool.get('D1'));

  const done = store.get('r1');
  assert.equal(done.status, 'passed', done.error);
  assert.ok(done.trace.some((entry) => /probe unavailable: no probe dylib is configured/.test(entry.text)));
  assert.equal(done.timings.settleSavedMs, 0);
  assert.equal(done.artifacts.networkLog, undefined);
});

/* --------------------------------------------------------------- server -- */

async function daemon(platform = 'ios') {
  const cfg = { ...testConfig(tempHome()), identityBindings: {}, maxArtifactBytes: 1e9 };
  const tokens = new TokenStore(cfg);
  tokens.load();
  const owner = tokens.create({ name: 'owner', preset: 'remote' });
  const other = tokens.create({ name: 'other', preset: 'readonly' });
  const store = new Store(cfg);
  const deps = {
    cfg, store, tokens,
    pool: { list: () => [], get: () => undefined, targetCount: () => 0 },
    runner: { active: 0, cancel: () => false },
    scheduler: { tick() {}, queueInfo: () => null, queuePosition: () => 0 },
    audit: { record() {} },
    artifacts: { get: () => undefined },
    edge: { mode: 'none', async verify() { return { via: 'loopback', subject: 'local' }; } },
    platforms: { has: () => true, default: () => platform, available: () => [platform], reason: () => '' },
    llmName: null,
  };
  const server = createServer(deps);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const client = (secret) => new Client({ ...cfg, host: '127.0.0.1', port }, secret);
  const get = (secret, route) => fetch(`http://127.0.0.1:${port}${route}`, { headers: { authorization: `Bearer ${secret}` } });
  return { server, store, owner: client(owner.secret), other: client(other.secret), ownerSecret: owner.secret, otherSecret: other.secret, get };
}

const REQ = { app: { bundleId: 'com.example.app' }, steps: [{ action: 'wait', ms: 1 }] };

test('over HTTP: probe steps need probe: true, and the probe is iOS only', async () => {
  const { server, owner } = await daemon();
  try {
    await assert.rejects(owner.submit({ ...REQ, steps: [{ action: 'wait_idle' }] }), /steps\[0\] \(wait_idle\) needs the in-app probe/);
    await assert.rejects(owner.submit({ ...REQ, steps: [{ action: 'open_url', url: 'x://y', via: 'app' }] }), /open_url with via "app"/);
    await assert.rejects(owner.submit({ ...REQ, settleTimeoutMs: 5000 }), /only applies with "probe": true/);
    await assert.rejects(owner.submit({ ...REQ, probe: true, evidence: { network: 'everyone' } }), /"private" or "public"/);
    const ok = await owner.submit({ ...REQ, probe: true, steps: [{ action: 'wait_idle' }, { action: 'assert_request', urlPattern: '*' }] });
    assert.equal(ok.request.probe, true);
  } finally {
    server.close();
  }

  const android = await daemon('android');
  try {
    await assert.rejects(android.owner.submit({ ...REQ, probe: true }), /iOS simulator only/);
  } finally {
    android.server.close();
  }
});

test('over HTTP: network.json and console.log are private to the submitter unless opted public', async () => {
  const { server, store, owner, ownerSecret, otherSecret, get } = await daemon();
  try {
    const submitted = await owner.submit({ ...REQ, probe: true });
    fs.writeFileSync(path.join(store.dir(submitted.id), 'network.json'), '{"requests":[]}');
    store.update(submitted.id, { artifacts: { networkLog: 'network.json' } });

    assert.equal((await get(ownerSecret, `/v1/runs/${submitted.id}/network.json`)).status, 200);
    assert.equal((await get(otherSecret, `/v1/runs/${submitted.id}/network.json`)).status, 404, 'another token sees nothing');
    assert.equal((await get(ownerSecret, `/v1/runs/${submitted.id}/console.log`)).status, 404, 'never captured');

    const shared = await owner.submit({ ...REQ, probe: true, evidence: { network: 'public' } });
    fs.writeFileSync(path.join(store.dir(shared.id), 'network.json'), '{"requests":[]}');
    store.update(shared.id, { artifacts: { networkLog: 'network.json' } });
    assert.equal((await get(otherSecret, `/v1/runs/${shared.id}/network.json`)).status, 200);
  } finally {
    server.close();
  }
});
