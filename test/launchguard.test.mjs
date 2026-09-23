/**
 * The launch env/args denylist: refused at submit, and again at the launch
 * itself, so a launch that never passed through submit (an NL agent's step)
 * cannot carry DYLD_INSERT_LIBRARIES or a linker knob into the app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertSafeLaunchArgs, assertSafeLaunchEnv, assertSafeLaunchOptions, isRefusedEnvKey,
} from '../dist/launchguard.js';
import { StepExecutor } from '../dist/steps.js';
import { TokenStore } from '../dist/auth.js';
import { Client } from '../dist/client.js';
import { createServer } from '../dist/server.js';
import { Store } from '../dist/store.js';
import { tempHome, testConfig, fakeBackend, fakeUi, run } from './sim-fakes.mjs';

test('the refused prefixes are refused on every platform, case-insensitively', () => {
  const refused = [
    'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'dyld_insert_libraries',
    'SIMCTL_CHILD_DYLD_INSERT_LIBRARIES', 'SIMBASE_PROBE_TOKEN', '__XPC_DYLD_INSERT_LIBRARIES',
    'MallocStackLogging', 'MallocStackLoggingNoCompact',
  ];
  for (const key of refused) {
    assert.equal(isRefusedEnvKey(key, 'ios'), true, key);
    assert.equal(isRefusedEnvKey(key, 'android'), true, key);
  }
  for (const key of ['API_BASE_URL', 'FEATURE_FLAGS', 'LD_PRELOAD_NOT_REALLY', 'MY_DYLD_']) {
    assert.equal(isRefusedEnvKey(key, 'ios'), false, key);
  }
});

test('LD_PRELOAD and LD_LIBRARY_PATH are refused on Android, and while the platform is unknown', () => {
  assert.equal(isRefusedEnvKey('LD_PRELOAD', 'android'), true);
  assert.equal(isRefusedEnvKey('LD_LIBRARY_PATH', 'android'), true);
  assert.equal(isRefusedEnvKey('LD_PRELOAD', undefined), true);
  assert.equal(isRefusedEnvKey('LD_PRELOAD', 'ios'), false);
});

test('env must be an object of strings with plain names and no NUL', () => {
  assert.throws(() => assertSafeLaunchEnv([], 'app.launchEnv'), /must be an object/);
  assert.throws(() => assertSafeLaunchEnv({ A: 1 }, 'app.launchEnv'), /app\.launchEnv\.A must be a string/);
  assert.throws(() => assertSafeLaunchEnv({ 'A=B': 'x' }, 'app.launchEnv'), /invalid variable name/);
  assert.throws(() => assertSafeLaunchEnv({ A: 'x\0y' }, 'app.launchEnv'), /NUL/);
  assert.throws(() => assertSafeLaunchEnv({ DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' }, 'app.launchEnv', 'ios'),
    /app\.launchEnv\.DYLD_INSERT_LIBRARIES is not allowed/);
  assertSafeLaunchEnv({ API_BASE_URL: 'https://example.com' }, 'app.launchEnv', 'ios');
  assertSafeLaunchEnv(undefined, 'app.launchEnv');
});

test('launch args must be strings under 4 KB with no NUL', () => {
  assertSafeLaunchArgs(['-UITestMode', '1', 'x'.repeat(4095)], 'app.launchArgs');
  assert.throws(() => assertSafeLaunchArgs(['x'.repeat(4096)], 'app.launchArgs'), /app\.launchArgs\[0\]/);
  assert.throws(() => assertSafeLaunchArgs(['ok', 'a\0b'], 'app.launchArgs'), /app\.launchArgs\[1\]/);
  assert.throws(() => assertSafeLaunchArgs(['ok', 7], 'app.launchArgs'), /app\.launchArgs\[1\]/);
  assert.throws(() => assertSafeLaunchArgs('-flag', 'app.launchArgs'), /must be an array/);
});

test('every launch and relaunch step is checked, not only app.launchEnv', () => {
  const request = {
    app: { bundleId: 'com.example.app', launchEnv: { API: 'x' } },
    steps: [
      { action: 'launch', env: { OK: '1' } },
      { action: 'tap', id: 'go' },
      { action: 'launch', env: { SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: '/x' } },
    ],
  };
  assert.throws(() => assertSafeLaunchOptions(request, 'ios'), /steps\[2\]\.env\.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES/);
  assert.throws(() => assertSafeLaunchOptions({
    app: {}, steps: [{ action: 'relaunch', env: { LD_PRELOAD: '/x.so' } }],
  }, 'android'), /steps\[0\]\.env\.LD_PRELOAD/);
  assert.throws(() => assertSafeLaunchOptions({
    app: {}, steps: [{ action: 'launch', args: ['a\0'] }],
  }, 'ios'), /steps\[0\]\.args\[0\]/);
});

/* ---------------------------------------------------------- at submit -- */

async function daemon(platform = 'ios') {
  const cfg = { ...testConfig(tempHome()), identityBindings: {}, maxArtifactBytes: 1e9 };
  const tokens = new TokenStore(cfg);
  tokens.load();
  const { secret } = tokens.create({ name: 'ci', preset: 'remote' });
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
  const client = new Client({ ...cfg, host: '127.0.0.1', port: server.address().port }, secret);
  return { server, client };
}

test('over HTTP: a refused key in app.launchEnv or a launch step is a 400 at submit', async () => {
  const { server, client } = await daemon();
  try {
    const base = { app: { bundleId: 'com.example.app' }, steps: [{ action: 'wait', ms: 1 }] };
    await assert.rejects(
      client.submit({ ...base, app: { ...base.app, launchEnv: { DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' } } }),
      (e) => e.status === 400 && /app\.launchEnv\.DYLD_INSERT_LIBRARIES is not allowed/.test(e.message));
    await assert.rejects(
      client.submit({ ...base, steps: [{ action: 'launch', env: { __XPC_X: '1' } }] }),
      (e) => e.status === 400 && /steps\[0\]\.env\.__XPC_X/.test(e.message));
    await assert.rejects(
      client.submit({ ...base, app: { ...base.app, launchArgs: ['x'.repeat(5000)] } }),
      (e) => e.status === 400 && /under 4 KB/.test(e.message));
    const ok = await client.submit({ ...base, app: { ...base.app, launchEnv: { API_BASE_URL: 'https://x.test' } } });
    assert.equal(ok.status, 'pending');
  } finally {
    server.close();
  }
});

test('over HTTP: LD_PRELOAD is refused for an Android run', async () => {
  const { server, client } = await daemon('android');
  try {
    await assert.rejects(client.submit({
      app: { bundleId: 'com.example.app', launchEnv: { LD_PRELOAD: '/data/local/tmp/x.so' } },
      steps: [{ action: 'wait', ms: 1 }],
    }), (e) => e.status === 400 && /LD_PRELOAD/.test(e.message));
  } finally {
    server.close();
  }
});

/* ------------------------------------------------- at the launch itself -- */

function executor(launchEnv, platform = 'ios') {
  const home = tempHome();
  const store = new Store(testConfig(home));
  const runDir = path.join(home, 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  store.create(run('r1', { status: 'running' }));
  const backend = { ...fakeBackend(), platform };
  const exec = new StepExecutor(fakeUi(), backend, store, {
    runId: 'r1', udid: 'U1', app: { appId: 'com.example.app', executable: 'App' },
    runDir, launchArgs: [], launchEnv, signal: new AbortController().signal,
  }, undefined);
  return { exec, backend };
}

test('the executor refuses a bad env at the launch, even when submit was skipped', async () => {
  const { exec, backend } = executor({});
  await assert.rejects(exec.run({ action: 'launch', env: { DYLD_INSERT_LIBRARIES: '/x' } }), /not allowed/);
  assert.equal(backend.calls.filter((c) => c.startsWith('launch:')).length, 0, 'nothing was launched');
});

test('relaunch re-checks the run\'s own launchEnv, and LD_PRELOAD on Android', async () => {
  const { exec, backend } = executor({ LD_PRELOAD: '/x.so' }, 'android');
  await assert.rejects(exec.run({ action: 'relaunch' }), /LD_PRELOAD/);
  assert.equal(backend.calls.filter((c) => c.startsWith('launch:')).length, 0);
});
