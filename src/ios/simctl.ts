import { exec, execOk } from '../util.js';
import { logger } from '../log.js';

const log = logger('simctl');

export interface SimDevice {
  udid: string;
  name: string;
  state: string;                 // Booted | Shutdown | Booting | Creating
  isAvailable: boolean;
  deviceTypeIdentifier: string;
  runtimeIdentifier: string;     // synthesised from the map key
}

export interface SimRuntime {
  identifier: string;
  name: string;                  // e.g. "iOS 27.0"
  version: string;
  isAvailable: boolean;
  supportedDeviceTypes: { name: string; identifier: string }[];
}

const xc = (args: string[], timeoutMs = 120_000) => execOk('xcrun', ['simctl', ...args], { timeoutMs });

export async function listDevices(): Promise<SimDevice[]> {
  const raw = await xc(['list', 'devices', '--json']);
  const parsed = JSON.parse(raw) as { devices: Record<string, Omit<SimDevice, 'runtimeIdentifier'>[]> };
  const out: SimDevice[] = [];
  for (const [runtimeIdentifier, devices] of Object.entries(parsed.devices)) {
    for (const d of devices) out.push({ ...d, runtimeIdentifier });
  }
  return out;
}

export async function listRuntimes(): Promise<SimRuntime[]> {
  const raw = await xc(['list', 'runtimes', '--json']);
  const all = (JSON.parse(raw) as { runtimes: SimRuntime[] }).runtimes;
  // Xcode can list the same identifier twice (a stale build alongside the live
  // one). Keep the available copy.
  const byId = new Map<string, SimRuntime>();
  for (const r of all) {
    const seen = byId.get(r.identifier);
    if (!seen || (!seen.isAvailable && r.isAvailable)) byId.set(r.identifier, r);
  }
  return [...byId.values()].filter((r) => r.isAvailable);
}

export async function listDeviceTypes(): Promise<{ identifier: string; name: string }[]> {
  const raw = await xc(['list', 'devicetypes', '--json']);
  return (JSON.parse(raw) as { devicetypes: { identifier: string; name: string }[] }).devicetypes;
}

/** Resolve a human name ("iOS 27.0", "27.0", or '' for newest) to a runtime. */
export async function resolveRuntime(want: string): Promise<SimRuntime> {
  const runtimes = (await listRuntimes()).filter((r) => r.identifier.includes('SimRuntime.iOS'));
  if (!runtimes.length) throw new Error('no available iOS simulator runtimes -- install one via Xcode > Settings > Components');
  if (!want) {
    // Newest by numeric version.
    return runtimes.sort((a, b) => cmpVersion(b.version, a.version))[0]!;
  }
  const needle = want.toLowerCase().replace(/^ios\s*/, '').trim();
  const hit = runtimes.find((r) => r.version === needle)
    ?? runtimes.find((r) => r.name.toLowerCase() === want.toLowerCase())
    ?? runtimes.find((r) => r.version.startsWith(needle));
  if (!hit) throw new Error(`no iOS runtime matching "${want}" (have: ${runtimes.map((r) => r.version).join(', ')})`);
  return hit;
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export async function resolveDeviceType(want: string, runtime: SimRuntime): Promise<{ identifier: string; name: string }> {
  const supported = runtime.supportedDeviceTypes ?? [];
  const hit = supported.find((d) => d.name.toLowerCase() === want.toLowerCase());
  if (hit) return hit;
  const all = await listDeviceTypes();
  const loose = all.find((d) => d.name.toLowerCase() === want.toLowerCase());
  if (loose) return loose;
  const iphones = supported.filter((d) => d.name.startsWith('iPhone')).map((d) => d.name);
  throw new Error(`device type "${want}" is not available on ${runtime.name} (have: ${iphones.join(', ') || 'none'})`);
}

export const create = (name: string, deviceTypeId: string, runtimeId: string): Promise<string> =>
  xc(['create', name, deviceTypeId, runtimeId]).then((s) => s.trim());

export async function boot(udid: string): Promise<void> {
  const r = await exec('xcrun', ['simctl', 'boot', udid], { timeoutMs: 180_000 });
  // Booting an already-booted device is a no-op we should not treat as failure.
  if (r.code !== 0 && !/current state: Booted|Unable to boot device in current state: Booted/i.test(r.stderr)) {
    throw new Error(`boot ${udid} failed: ${r.stderr.trim()}`);
  }
  await xc(['bootstatus', udid, '-b'], 300_000);
}

export async function shutdown(udid: string): Promise<void> {
  const r = await exec('xcrun', ['simctl', 'shutdown', udid], { timeoutMs: 120_000 });
  if (r.code !== 0 && !/current state: Shutdown/i.test(r.stderr)) {
    log.warn(`shutdown ${udid} returned ${r.code}`, r.stderr.trim().slice(0, 200));
  }
}

export const erase = (udid: string) => xc(['erase', udid], 300_000).then(() => undefined);
export const deleteDevice = (udid: string) => xc(['delete', udid], 120_000).then(() => undefined);
export const install = (udid: string, appPath: string) => xc(['install', udid, appPath], 300_000).then(() => undefined);

export async function uninstall(udid: string, bundleId: string): Promise<void> {
  // Not installed is fine -- that is the state we wanted.
  await exec('xcrun', ['simctl', 'uninstall', udid, bundleId], { timeoutMs: 120_000 });
}

export async function launch(
  udid: string, bundleId: string, args: string[] = [], env: Record<string, string> = {},
): Promise<number> {
  const envArgs: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) envArgs[`SIMCTL_CHILD_${k}`] = v;
  const out = await execOk('xcrun',
    ['simctl', 'launch', '--terminate-running-process', udid, bundleId, ...args],
    { timeoutMs: 120_000, env: envArgs });
  const m = out.match(/:\s*(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

export async function terminate(udid: string, bundleId: string): Promise<void> {
  await exec('xcrun', ['simctl', 'terminate', udid, bundleId], { timeoutMs: 60_000 });
}

export const openUrl = (udid: string, url: string) => xc(['openurl', udid, url], 60_000).then(() => undefined);
export const setAppearance = (udid: string, mode: 'light' | 'dark') => xc(['ui', udid, 'appearance', mode], 60_000).then(() => undefined);

export async function setPrivacy(udid: string, grant: boolean, service: string, bundleId: string): Promise<void> {
  await exec('xcrun', ['simctl', 'privacy', udid, grant ? 'grant' : 'revoke', service, bundleId], { timeoutMs: 60_000 });
}

/** Fallback screenshot path -- AXe is preferred but this always works. */
export const screenshot = (udid: string, out: string) => xc(['io', udid, 'screenshot', '--type=png', out], 60_000).then(() => undefined);

/** Reset every privacy grant for one app, so a reinstall prompts afresh. */
export async function resetPrivacy(udid: string, bundleId: string): Promise<void> {
  await exec('xcrun', ['simctl', 'privacy', udid, 'reset', 'all', bundleId], { timeoutMs: 60_000 });
}

export async function isInstalled(udid: string, bundleId: string): Promise<boolean> {
  const r = await exec('xcrun', ['simctl', 'get_app_container', udid, bundleId], { timeoutMs: 30_000 });
  return r.code === 0;
}
