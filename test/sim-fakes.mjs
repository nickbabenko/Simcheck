// In-memory doubles for the device side, so the pool, runner and scheduler can
// be driven without a simulator. Every backend call is recorded in `calls` as
// "<method>:<id>[:<arg>]" so a test can assert on exactly what was done to a
// device.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempHome(tag = 'simcheck-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
}

export function testConfig(home, extra = {}) {
  return {
    home,
    defaultTimeoutMs: 60_000,
    defaultMaxActions: 10,
    defaultResetPolicy: 'uninstall',
    retainRuns: 200,
    autoProvision: false,
    maxPoolDevices: 3,
    minFreeDiskGb: 0,
    devicePrefix: 'simtest',
    pool: [],
    poolSize: 0,
    defaultPlatform: 'ios',
    deviceType: 'iPhone 17 Pro',
    runtime: '',
    ...extra,
  };
}

export function fakeBackend() {
  const calls = [];
  const installed = new Map();   // udid -> Set of bundle ids
  const live = new Map();        // udid -> { name, booted }
  const has = (id) => installed.get(id) ?? installed.set(id, new Set()).get(id);
  return {
    calls,
    installed,
    live,
    platform: 'ios',
    deviceNoun: 'simulator',
    diskCostGb: 0,
    async preflight() { return 'ok'; },
    async resolveTarget(deviceType, runtime) { return { deviceType, runtime: runtime || 'iOS 26.0' }; },
    async create(name) { const id = `U-${name}`; live.set(id, { name, booted: false }); return id; },
    async list() {
      return [...live.entries()].map(([id, d]) => ({
        id, name: d.name, deviceType: 'iPhone 17 Pro', runtime: 'iOS 26.0', booted: d.booted, available: true,
      }));
    },
    async boot(id) { calls.push(`boot:${id}`); const d = live.get(id); if (d) d.booted = true; },
    async shutdown(id) { calls.push(`shutdown:${id}`); const d = live.get(id); if (d) d.booted = false; },
    async erase(id) { calls.push(`erase:${id}`); has(id).clear(); },
    async destroy(id) { calls.push(`destroy:${id}`); live.delete(id); },
    async install(id, appPath) { calls.push(`install:${id}:${appPath}`); has(id).add(path.basename(appPath, '.app')); },
    async uninstall(id, appId) { calls.push(`uninstall:${id}:${appId}`); has(id).delete(appId); },
    async isInstalled(id, appId) { calls.push(`isInstalled:${id}:${appId}`); return has(id).has(appId); },
    async launch(id, app) { calls.push(`launch:${id}:${app.appId}`); return 1; },
    async terminate(id, appId) { calls.push(`terminate:${id}:${appId}`); },
    async openUrl(id, url) { calls.push(`openUrl:${id}:${url}`); },
    async setAppearance() {},
    async setPermission() {},
    async resetPermissions(id, appId) { calls.push(`resetPermissions:${id}:${appId}`); },
    async screenshot(id, out) { fs.writeFileSync(out, 'png'); },
    streamLog() { return null; },
  };
}

/** A UI driver. `visible` is the set of ids/labels wait_for/assert will find. */
export function fakeUi(visible = new Set()) {
  return {
    visible,
    async describe() { return { width: 402, height: 874, elements: [] }; },
    async screenshot(out) { fs.writeFileSync(out, 'png'); },
    async tap() {},
    async type() {},
    async clearText() {},
    async pressEnter() {},
    async swipe() {},
    async gesture() {},
    async button() {},
    async waitFor(sel) { return visible.has(sel.id ?? sel.label); },
  };
}

/**
 * A Platforms registry with one iOS platform. `prepare` decides what
 * prepareApp returns for a spec (default: an installable build whose content
 * hash is its artifactId).
 */
export function fakePlatforms(opts = {}) {
  const backend = opts.backend ?? fakeBackend();
  const ui = opts.ui ?? fakeUi();
  const prepare = opts.prepare ?? (async (spec) => ({
    appPath: `/builds/${spec.bundleId ?? 'com.example.app'}.app`,
    bundleId: spec.bundleId ?? 'com.example.app',
    executable: 'App',
    preinstalled: false,
    ...(spec.artifactId ? { contentHash: spec.artifactId } : {}),
  }));
  const platform = {
    id: 'ios',
    devices: backend,
    ui: () => ui,
    touch: () => undefined,
    prepareApp: (spec, ctx) => prepare(spec, ctx),
    async runNativeTests() { throw new Error('not in these tests'); },
  };
  return {
    backend, ui,
    get: () => platform,
    has: () => true,
    available: () => ['ios'],
    default: () => 'ios',
    reason: () => '',
  };
}

/** A pooled-device record, as pool.json holds it. */
export function device(udid, extra = {}) {
  return {
    udid, platform: 'ios', name: `simtest-${udid}`, deviceType: 'iPhone 17 Pro', runtime: 'iOS 26.0',
    status: 'ready', addedAt: new Date().toISOString(), managed: true, ...extra,
  };
}

/** A run record with the fields the scheduler and runner read. */
export function run(id, extra = {}) {
  return {
    id, status: 'pending', mode: 'steps',
    request: { app: { artifactId: 'a1', bundleId: 'com.example.app' }, steps: [{ action: 'wait', ms: 1 }] },
    createdAt: new Date().toISOString(),
    submittedBy: { tokenId: 'tok_a', tokenName: 'a' },
    queuePositionAtSubmit: 0,
    executedSteps: [], screenshots: [], trace: [], artifacts: {},
    ...extra,
  };
}
