/**
 * S2, Android isolation: the guest firewall that keeps a tenant's app off the
 * host's loopback (10.0.2.2 is the host's 127.0.0.1 inside an emulator), and
 * the wipe that a tenant change forces on Android, where shared storage
 * survives an uninstall.
 *
 * The firewall is driven against a scripted adb here; the real thing was
 * verified on an API 35 google_apis emulator (see the commit message).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIREWALL_SCRIPT, ensureGuestFirewall, probeGuestIsolation } from '../dist/android/firewall.js';
import { decideAndroidPreRunErase } from '../dist/warm.js';
import { Runner } from '../dist/runner.js';
import { Store } from '../dist/store.js';
import { Pool } from '../dist/pool.js';
import { tempHome, testConfig, fakePlatforms, fakeBackend, device, run } from './sim-fakes.mjs';

/* ---------------------------------------------------------- firewall -- */

/**
 * An adb double. `root` says whether `adb root` works; `reachable` says
 * whether the guest's host aliases connect (i.e. the rule is missing);
 * `firstRule` is what `iptables -S OUTPUT` lists first.
 */
function scriptedAdb({ root = true, reachable = false, firstRule = '-A OUTPUT -j simcheck_isolation' } = {}) {
  const calls = [];
  let isRoot = false;
  return {
    calls,
    async rawTry(serial, args) {
      calls.push(args.join(' '));
      if (args[0] === 'root') {
        if (!root) return { code: 1, stdout: 'adbd cannot run as root in production builds\n', stderr: '' };
        isRoot = true;
        return { code: 0, stdout: 'restarting adbd as root\n', stderr: '' };
      }
      if (args[0] === 'unroot') isRoot = false;
      return { code: 0, stdout: '', stderr: '' };
    },
    async shellTry(serial, command) {
      calls.push(`shell ${command}`);
      if (command === 'id -u') return { code: 0, out: isRoot ? '0\n' : '2000\n' };
      if (command.includes('-S OUTPUT')) return { code: 0, out: `-P OUTPUT ACCEPT\n${firstRule}\n-A OUTPUT -j oem_out\n` };
      if (command.includes('nc -z')) return { code: 0, out: `simcheck-nc=${reachable ? 0 : 1}\n` };
      return { code: 0, out: '' };
    },
  };
}

test('the script rejects both host aliases, idempotently, at the top of OUTPUT', () => {
  assert.match(FIREWALL_SCRIPT, /iptables -w -A simcheck_isolation -d 10\.0\.2\.2\/32 -j REJECT/);
  assert.match(FIREWALL_SCRIPT, /ip6tables -w -A simcheck_isolation -d fec0::2\/128 -j REJECT/);
  assert.match(FIREWALL_SCRIPT, /iptables -w -C OUTPUT -j simcheck_isolation 2>\/dev\/null \|\| iptables -w -I OUTPUT 1 -j simcheck_isolation/);
  assert.match(FIREWALL_SCRIPT, /iptables -w -F simcheck_isolation/, 'flushed, so re-applying never stacks rules');
  assert.doesNotMatch(FIREWALL_SCRIPT, /10\.0\.2\.3/, 'DNS is left alone');
});

test('ensure: roots, installs, drops root, then verifies from the non-root shell', async () => {
  const adb = scriptedAdb();
  const outcome = await ensureGuestFirewall(adb, 'emulator-5600', 'required');
  assert.equal(outcome.applied, true);
  assert.ok(outcome.verified.includes('ipv4'));
  assert.equal(outcome.problem, undefined);

  const order = ['root', 'shell id -u', `shell ${FIREWALL_SCRIPT}`, 'unroot'].map((c) => adb.calls.indexOf(c));
  assert.ok(order.every((at) => at >= 0), adb.calls.join('\n'));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order');
  const probe = adb.calls.findIndex((c) => c.includes('nc -z -w 3 10.0.2.2'));
  assert.ok(probe > adb.calls.indexOf('unroot'), 'probed as the non-root shell, the way an app would connect');
});

test('required: an image that refuses adb root takes the emulator out, with the reason', async () => {
  await assert.rejects(ensureGuestFirewall(scriptedAdb({ root: false }), 'emulator-5600', 'required'),
    /guest firewall not in place.*adb root was refused.*google_apis.*10\.0\.2\.2:5037/s);
});

test('required: a host that is still reachable from inside the guest is a failure', async () => {
  await assert.rejects(ensureGuestFirewall(scriptedAdb({ reachable: true }), 'emulator-5600', 'required'),
    /still reachable over ipv4/);
});

test('required: a jump that is not first in OUTPUT is a failure', async () => {
  await assert.rejects(ensureGuestFirewall(scriptedAdb({ firstRule: '-A OUTPUT -j oem_out' }), 'emulator-5600', 'required'),
    /jump is not first in OUTPUT/);
});

test('best-effort reports the problem without throwing; off does nothing; an unknown mode fails closed', async () => {
  const soft = await ensureGuestFirewall(scriptedAdb({ root: false }), 'emulator-5600', 'best-effort');
  assert.equal(soft.applied, false);
  assert.match(soft.problem, /adb root was refused/);

  const adb = scriptedAdb();
  const off = await ensureGuestFirewall(adb, 'emulator-5600', 'off');
  assert.equal(off.applied, false);
  assert.equal(adb.calls.length, 0);

  await assert.rejects(ensureGuestFirewall(scriptedAdb({ root: false }), 'emulator-5600', 'false'), /not in place/);
});

test('the probe only counts a refusal, and a missing nc proves nothing', async () => {
  const adb = scriptedAdb();
  const probe = await probeGuestIsolation(adb, 'emulator-5600');
  assert.ok(probe.tested.includes('ipv4'));
  assert.deepEqual(probe.refused, probe.tested);

  adb.shellTry = async () => ({ code: 0, out: 'simcheck-nc=missing\n' });
  await assert.rejects(probeGuestIsolation(adb, 'emulator-5600'), /could not probe 10\.0\.2\.2/);
});

/* ------------------------------------------------ tenant change wipes -- */

test('Android: a different tenant, or a dirty emulator, is wiped before any run', () => {
  const ask = (device, platform = 'android') => decideAndroidPreRunErase({ platform, device, tenant: 'tok/b' });
  assert.match(ask({ tenant: 'tok/a' }), /shared storage survives an uninstall/);
  assert.match(ask({ dirty: true }), /unknown contents/);
  assert.equal(ask({ tenant: 'tok/b' }), null);
  assert.equal(ask({}), null);
  assert.equal(ask({ tenant: 'tok/a' }, 'ios'), null, 'iOS keeps its install-time rule in decideInstall');
});

function androidRig(prepare) {
  const home = tempHome();
  const cfg = testConfig(home);
  fs.writeFileSync(path.join(home, 'pool.json'), JSON.stringify([device('D1', { status: 'leased', platform: 'android' })]));
  const backend = { ...fakeBackend(), platform: 'android', deviceNoun: 'emulator' };
  const platforms = fakePlatforms({ backend, prepare });
  const pool = new Pool(cfg, platforms);
  pool.load();
  const store = new Store(cfg);
  const runner = new Runner(cfg, pool, store, null, {}, platforms);
  let count = 0;
  const go = async (tenant) => {
    const record = run(`r${++count}`, {
      request: { app: { bundleId: 'com.example.app' }, steps: [{ action: 'wait', ms: 1 }], tenant },
    });
    store.create(record);
    const leased = pool.get('D1');
    leased.status = 'leased';
    await runner.execute(store.get(record.id), leased);
    return store.get(record.id);
  };
  return { go, pool, calls: backend.calls };
}

test('Android: a run that installed nothing still marks the emulator, and the next tenant gets a wiped one', async () => {
  // The app was already on the device: the harness installs nothing, yet
  // the run could still have written to /sdcard.
  const alreadyInstalled = async (spec) => ({ bundleId: spec.bundleId, executable: 'App', preinstalled: true });
  const { go, pool, calls } = androidRig(alreadyInstalled);

  const first = await go('org1');
  assert.equal(first.status, 'passed', first.error);
  assert.equal(pool.get('D1').tenant, 'tok_a/org1', 'recorded although nothing was installed');
  assert.ok(!calls.includes('erase:D1'));

  const same = await go('org1');
  assert.equal(same.status, 'passed', same.error);
  assert.ok(!calls.includes('erase:D1'), 'the same tenant is not wiped');

  const other = await go('org2');
  assert.equal(other.status, 'passed', other.error);
  assert.ok(calls.includes('erase:D1'), 'a tenant change wipes the emulator');
  assert.ok(calls.indexOf('erase:D1') < calls.lastIndexOf('launch:D1:com.example.app'), 'before the app runs');
  assert.equal(other.warm.erased, true);
  assert.equal(typeof other.timings.preResetMs, 'number');
  assert.ok(other.trace.some((entry) => /shared storage survives an uninstall/.test(entry.text)));
  assert.equal(pool.get('D1').tenant, 'tok_a/org2');
});
