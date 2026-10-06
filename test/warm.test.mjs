/**
 * R3a: the warm-app cache decisions, and the pool's side of them -- affinity
 * on lease, what release records, and what a crash leaves behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decideInstall, decideRelease, leaseScore, tenantOf } from '../dist/warm.js';
import { Pool } from '../dist/pool.js';
import { validateSteps, lintDeepLinks } from '../dist/steps.js';
import { tempHome, testConfig, fakePlatforms, device } from './sim-fakes.mjs';

const cached = (extra = {}) => ({
  installed: { bundleId: 'com.x', appHash: 'h1', tenant: 'T', installedAt: '' }, tenant: 'T', ...extra,
});
const ask = (over = {}) => ({ device: cached(), bundleId: 'com.x', appHash: 'h1', tenant: 'T', resetPolicy: 'relaunch', ...over });

test('same build, same tenant, relaunch requested: reuse', () => {
  assert.equal(decideInstall(ask()).action, 'reuse');
  assert.equal(decideInstall(ask()).erase, false);
});

test('a different hash reinstalls, without erasing', () => {
  const d = decideInstall(ask({ appHash: 'h2' }));
  assert.deepEqual([d.action, d.erase], ['install', false]);
});

test('a different tenant erases first, regardless of hash', () => {
  for (const appHash of ['h1', 'h2', undefined]) {
    const d = decideInstall(ask({ tenant: 'U', appHash }));
    assert.deepEqual([d.action, d.erase], ['install', true], `hash ${appHash}`);
  }
});

test('a tenant change erases even when the run did not ask for relaunch', () => {
  const d = decideInstall(ask({ tenant: 'U', resetPolicy: 'uninstall' }));
  assert.equal(d.erase, true);
});

test('a dirty device (back from a crash) erases before install', () => {
  const d = decideInstall(ask({ device: cached({ dirty: true }) }));
  assert.deepEqual([d.action, d.erase], ['install', true]);
});

test('nothing cached, or no content hash, installs fresh', () => {
  assert.equal(decideInstall(ask({ device: {} })).action, 'install');
  assert.equal(decideInstall(ask({ appHash: undefined })).action, 'install');
});

test('only a relaunch run reuses; uninstall/erase runs always install fresh', () => {
  assert.equal(decideInstall(ask({ resetPolicy: 'uninstall' })).action, 'install');
  assert.equal(decideInstall(ask({ resetPolicy: 'erase' })).action, 'install');
});

test('a clean device with no tenant recorded never erases', () => {
  assert.equal(decideInstall(ask({ device: {} , tenant: 'anyone' })).erase, false);
});

test('release: relaunch is kept only after a clean finish', () => {
  const base = { requested: 'relaunch', ours: true, appHash: 'h1' };
  assert.equal(decideRelease({ ...base, status: 'passed' }), 'relaunch');
  assert.equal(decideRelease({ ...base, status: 'failed' }), 'relaunch', 'a failed assertion is a verdict, not a fault');
  for (const status of ['error', 'timeout', 'cancelled']) {
    assert.equal(decideRelease({ ...base, status }), 'uninstall', status);
  }
  assert.equal(decideRelease({ ...base, status: 'passed', appHash: undefined }), 'uninstall');
  assert.equal(decideRelease({ ...base, requested: 'erase', status: 'error' }), 'erase');
});

test('tenant is namespaced under the submitting token', () => {
  assert.equal(tenantOf({ submittedBy: { tokenId: 'tok_a' }, request: {} }), 'tok_a');
  assert.equal(tenantOf({ submittedBy: { tokenId: 'tok_a' }, request: { tenant: 'org1' } }), 'tok_a/org1');
  assert.notEqual(
    tenantOf({ submittedBy: { tokenId: 'tok_b' }, request: { tenant: 'org1' } }),
    tenantOf({ submittedBy: { tokenId: 'tok_a' }, request: { tenant: 'org1' } }),
    'another token naming the same tenant is a different tenant');
});

test('lease score: warm build > same tenant > clean > another tenant or dirty', () => {
  const want = { tenant: 'T', appHash: 'h1' };
  assert.equal(leaseScore(cached(), want), 3);
  assert.equal(leaseScore({ tenant: 'T' }, want), 2);
  assert.equal(leaseScore({}, want), 1);
  assert.equal(leaseScore({ tenant: 'U' }, want), 0);
  assert.equal(leaseScore(cached({ dirty: true }), want), 0);
});

/* ------------------------------------------------------------------ pool -- */

function poolWith(devices, platforms = fakePlatforms()) {
  const home = tempHome();
  fs.writeFileSync(path.join(home, 'pool.json'), JSON.stringify(devices));
  const pool = new Pool(testConfig(home), platforms);
  pool.load();
  return { pool, platforms, home };
}

test('lease prefers the device already holding the build for this tenant', () => {
  const { pool } = poolWith([
    device('A', { tenant: 'U' }),
    device('B'),
    device('C', { tenant: 'T', installed: { bundleId: 'com.x', appHash: 'h1', tenant: 'T', installedAt: '' } }),
  ]);
  assert.equal(pool.lease('r1', undefined, { tenant: 'T', appHash: 'h1' }).udid, 'C');
  // With C busy: a clean device beats one carrying another tenant's residue.
  assert.equal(pool.lease('r2', undefined, { tenant: 'T', appHash: 'h1' }).udid, 'B');
  // Affinity is a tie-break, never a reason to wait: the last one still leases.
  assert.equal(pool.lease('r3', undefined, { tenant: 'T', appHash: 'h1' }).udid, 'A');
  assert.equal(pool.lease('r4', undefined, { tenant: 'T' }), null);
});

test('release with relaunch keeps the app and records it as the cache', async () => {
  const { pool, platforms } = poolWith([device('A', { status: 'leased' })]);
  await pool.release('A', { bundleId: 'com.x', uninstall: true, policy: 'relaunch', tenant: 'T', keep: { bundleId: 'com.x', appHash: 'h1' } });
  const d = pool.get('A');
  assert.equal(d.status, 'ready');
  assert.equal(d.installed.appHash, 'h1');
  assert.equal(d.installed.tenant, 'T');
  assert.equal(d.tenant, 'T');
  assert.ok(!platforms.backend.calls.some((c) => c.startsWith('uninstall:')), 'relaunch must not uninstall');
  assert.ok(platforms.backend.calls.includes('terminate:A:com.x'));
});

test('release with uninstall drops the cache but remembers the tenant', async () => {
  const { pool } = poolWith([device('A', {
    status: 'leased', installed: { bundleId: 'com.x', appHash: 'h1', tenant: 'T', installedAt: '' },
  })]);
  await pool.release('A', { bundleId: 'com.x', uninstall: true, policy: 'uninstall', tenant: 'T' });
  const d = pool.get('A');
  assert.equal(d.installed, undefined);
  assert.equal(d.tenant, 'T', 'keychain and pasteboard residue still belong to T');
});

test('release with erase clears cache, tenant and dirt', async () => {
  const { pool, platforms } = poolWith([device('A', {
    status: 'leased', tenant: 'T', dirty: true, installed: { bundleId: 'com.x', appHash: 'h1', installedAt: '' },
  })]);
  await pool.release('A', { bundleId: 'com.x', uninstall: true, policy: 'erase', tenant: 'T' });
  const d = pool.get('A');
  assert.deepEqual([d.installed, d.tenant, d.dirty], [undefined, undefined, undefined]);
  assert.ok(platforms.backend.calls.includes('erase:A'));
});

test('adopt marks a device that was mid-run dirty, and leaves an idle one alone', async () => {
  const platforms = fakePlatforms();
  platforms.backend.live.set('A', { name: 'simtest-A', booted: true });
  platforms.backend.live.set('B', { name: 'simtest-B', booted: true });
  platforms.backend.live.set('S', { name: 'simtest-99', booted: true });   // an orphan
  const warm = { bundleId: 'com.x', appHash: 'h1', tenant: 'T', installedAt: '' };
  const { pool } = poolWith([
    device('A', { status: 'leased', currentRunId: 'r1', installed: warm }),
    device('B', { status: 'ready', installed: warm }),
  ], platforms);
  await pool.adopt();
  assert.equal(pool.get('A').dirty, true);
  assert.equal(pool.get('A').installed, undefined, 'the cache cannot vouch for a crashed run');
  assert.equal(pool.get('A').status, 'ready');
  assert.equal(pool.get('B').dirty, undefined);
  assert.deepEqual(pool.get('B').installed, warm);
  assert.equal(pool.get('S').dirty, true, 'an orphan has unknown history');
});

test('eraseLeased resets the device and forgets its cache', async () => {
  const { pool, platforms } = poolWith([device('A', { status: 'leased', tenant: 'U', dirty: true })]);
  await pool.eraseLeased('A');
  assert.deepEqual(platforms.backend.calls, ['shutdown:A', 'erase:A', 'boot:A']);
  assert.equal(pool.get('A').tenant, undefined);
  assert.equal(pool.get('A').dirty, undefined);
  assert.equal(pool.get('A').status, 'leased', 'still the run\'s device');
});

/* ------------------------------------------------------------ assertions -- */

test('the relaunch -> open_url -> assert sequence validates', () => {
  validateSteps([
    { action: 'terminate' },
    { action: 'relaunch' },
    { action: 'open_url', url: 'myapp://settings' },
    { action: 'assert', id: 'settings-title', timeoutMs: 5000, note: 'deep link landed' },
  ]);
  assert.throws(() => validateSteps([{ action: 'assert' }]), /needs at least one of/);
  validateSteps([{ action: 'assert', id: 'x', text: 'y', value: '1', enabled: true, op: 'contains' }]);
  assert.throws(() => validateSteps([{ action: 'assert', id: 'x', op: 'eq' }]), /"op" compares "text" or "value"/);
  assert.throws(() => validateSteps([{ action: 'assert', id: 'x', text: 'y', colour: 'red' }]), /unsupported key "colour"/);
});

test('an open_url with nothing checking it is flagged; one followed by assert or wait_for is not', () => {
  assert.equal(lintDeepLinks([{ action: 'open_url', url: 'a://b' }]).length, 1);
  assert.equal(lintDeepLinks([{ action: 'open_url', url: 'a://b' }, { action: 'screenshot', name: 's' }]).length, 1);
  assert.equal(lintDeepLinks([{ action: 'open_url', url: 'a://b' }, { action: 'assert', id: 'x' }]).length, 0);
  assert.equal(lintDeepLinks([
    { action: 'open_url', url: 'a://b' }, { action: 'wait', ms: 200 }, { action: 'wait_for', label: 'Settings' },
  ]).length, 0);
});
