/**
 * R4: a 429 carries structured fields (code, limit, current, and
 * retryAfterSeconds where it is computable) next to the human message, and
 * the client keeps them rather than flattening the refusal to a string.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TokenStore } from '../dist/auth.js';
import { Client, ApiError } from '../dist/client.js';
import { createServer } from '../dist/server.js';
import { Store } from '../dist/store.js';
import { tempHome, testConfig } from './sim-fakes.mjs';

test('the hourly cap refuses with code, limit, current and an honest retry-after', () => {
  const tokens = new TokenStore(testConfig(tempHome()));
  tokens.load();
  const { record } = tokens.create({ name: 'invitee', preset: 'remote', maxRunsPerHour: 2 });
  const who = { id: record.id, name: record.name, capabilities: record.capabilities, maxConcurrentRuns: 2, maxRunsPerHour: 2 };
  tokens.checkRate(who);
  tokens.checkRate(who);
  try {
    tokens.checkRate(who);
    assert.fail('third submission within the hour should be refused');
  } catch (e) {
    assert.equal(e.status, 429);
    assert.match(e.message, /limited to 2 runs per hour/);
    assert.equal(e.detail.code, 'max_runs_per_hour');
    assert.equal(e.detail.limit, 2);
    assert.equal(e.detail.current, 2);
    assert.ok(e.detail.retryAfterSeconds > 3500 && e.detail.retryAfterSeconds <= 3600, String(e.detail.retryAfterSeconds));
  }
});

test('the client surfaces a 429\'s structured fields on an ApiError', async () => {
  const server = http.createServer((req, res) => {
    const body = JSON.stringify({
      error: 'token "a" already has 2 runs in flight (limit 2). Wait for one to finish.',
      code: 'max_concurrent_runs', limit: 2, current: 2,
    });
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = new Client({ ...testConfig(tempHome()), host: '127.0.0.1', port: server.address().port }, 'tok');
    await assert.rejects(client.submit({ app: {} }), (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 429);
      assert.deepEqual(e.detail, { code: 'max_concurrent_runs', limit: 2, current: 2 });
      assert.match(e.message, /already has 2 runs in flight/, 'the human message is kept');
      return true;
    });
  } finally {
    server.close();
  }
});

test('a plain error body still yields an ApiError, with no detail', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'app is required' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = new Client({ ...testConfig(tempHome()), host: '127.0.0.1', port: server.address().port }, 'tok');
    await assert.rejects(client.submit({}), (e) => e instanceof ApiError && e.status === 400 && e.detail === undefined);
  } finally {
    server.close();
  }
});

/* ------------------------------------------------- over the real server -- */

async function daemon() {
  const cfg = { ...testConfig(tempHome()), identityBindings: {}, maxArtifactBytes: 1e9 };
  const tokens = new TokenStore(cfg);
  tokens.load();
  const { secret } = tokens.create({ name: 'invitee', preset: 'remote', maxConcurrentRuns: 1 });
  const store = new Store(cfg);
  const deps = {
    cfg, store, tokens,
    pool: { list: () => [], get: () => undefined, targetCount: () => 0 },
    runner: { active: 0, cancel: () => false },
    scheduler: { tick() {}, queueInfo: () => null, queuePosition: () => 0 },
    audit: { record() {} },
    artifacts: { get: () => undefined },
    edge: { mode: 'none', async verify() { return { via: 'loopback', subject: 'local' }; } },
    platforms: { has: () => true, default: () => 'ios', available: () => ['ios'], reason: () => '' },
    llmName: null,
  };
  const server = createServer(deps);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new Client({ ...cfg, host: '127.0.0.1', port: server.address().port }, secret);
  return { server, client, store };
}

const REQ = { app: { bundleId: 'com.example.app' }, steps: [{ action: 'wait', ms: 1 }] };

test('over HTTP: the in-flight cap answers 429 with the structured fields and the message', async () => {
  const { server, client } = await daemon();
  try {
    await client.submit(structuredClone(REQ));
    await assert.rejects(client.submit(structuredClone(REQ)), (e) => {
      assert.equal(e.status, 429);
      assert.deepEqual(e.detail, { code: 'max_concurrent_runs', limit: 1, current: 1 });
      assert.match(e.message, /runs in flight \(limit 1\)/);
      return true;
    });
  } finally {
    server.close();
  }
});

test('over HTTP: resetPolicy and tenant are validated at submit', async () => {
  const { server, client } = await daemon();
  try {
    await assert.rejects(client.submit({ ...structuredClone(REQ), resetPolicy: 'none' }), /resetPolicy must be one of: uninstall, erase, relaunch/);
    await assert.rejects(client.submit({ ...structuredClone(REQ), tenant: 'a b' }), /tenant must be/);
    const ok = await client.submit({ ...structuredClone(REQ), resetPolicy: 'relaunch', tenant: 'org_1' });
    assert.equal(ok.request.resetPolicy, 'relaunch');
  } finally {
    server.close();
  }
});

test('over HTTP: wait?settled=true holds until the device is released', async () => {
  const { server, client, store } = await daemon();
  try {
    const run = await client.submit(structuredClone(REQ));
    store.update(run.id, { status: 'passed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    const plain = await client.waitOnce(run.id, 1000);
    assert.equal(plain.done, true);
    assert.equal(plain.settled, false, 'terminal, but the device is still resetting');
    const pending = client.waitOnce(run.id, 5000, true);
    setTimeout(() => store.update(run.id, { releasedAt: new Date().toISOString(), timings: { resetMs: 5, occupancyMs: 50 } }), 100);
    const settled = await pending;
    assert.equal(settled.settled, true);
    assert.equal(settled.timings.occupancyMs, 50);
  } finally {
    server.close();
  }
});
