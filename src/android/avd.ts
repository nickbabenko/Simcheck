import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { DeviceTarget, ExistingDevice } from '../device.js';
import { exec, sleep } from '../util.js';
import { logger } from '../log.js';
import type { Adb } from './adb.js';
import { waitForBoot } from './adb.js';
import type { AndroidTools } from './sdk.js';

const log = logger('avd');

/** API level to the marketing name people actually say out loud. */
const ANDROID_VERSION: Record<number, string> = {
  28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13',
  34: '14', 35: '15', 36: '16',
};

export const runtimeLabel = (api: number): string =>
  ANDROID_VERSION[api] ? `Android ${ANDROID_VERSION[api]} (API ${api})` : `API ${api}`;

export interface SystemImage {
  /** sdkmanager package id, e.g. "system-images;android-35;google_apis;arm64-v8a". */
  packageId: string;
  api: number;
  tag: string;      // google_apis | google_apis_playstore | default | android-wear
  abi: string;      // arm64-v8a | x86_64
  label: string;
}

/**
 * Installed system images, read off disk rather than from `sdkmanager --list`.
 *
 * sdkmanager takes several seconds and needs a working JDK; the directory
 * layout under the SDK root is the same information and needs neither. This
 * runs on every pool reconcile, so the difference matters.
 */
export function listSystemImages(sdkRoot: string): SystemImage[] {
  const root = path.join(sdkRoot, 'system-images');
  if (!fs.existsSync(root)) return [];
  const found: SystemImage[] = [];

  for (const apiDir of readDirs(root)) {
    const api = Number(apiDir.match(/^android-(\d+)$/)?.[1]);
    if (!Number.isFinite(api)) continue;
    for (const tag of readDirs(path.join(root, apiDir))) {
      for (const abi of readDirs(path.join(root, apiDir, tag))) {
        // A half-finished download leaves the directory but no image.
        const dir = path.join(root, apiDir, tag, abi);
        if (!fs.existsSync(path.join(dir, 'system.img')) && !fs.existsSync(path.join(dir, 'source.properties'))) continue;
        found.push({
          packageId: `system-images;${apiDir};${tag};${abi}`,
          api, tag, abi,
          label: runtimeLabel(api),
        });
      }
    }
  }
  return found.sort((a, b) => b.api - a.api);
}

const readDirs = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
};

/** The ABI an emulator should use on this host. Rosetta can run an x86_64
 *  image on Apple silicon, but it is slow enough to time out real runs. */
export const preferredAbi = (): string => (process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64');

/**
 * Resolve a requested runtime to an installed system image.
 *
 * Accepts what a caller would naturally write: "" for newest, "35",
 * "android-35", "Android 15", or a full package id.
 */
export function resolveSystemImage(sdkRoot: string, want: string): SystemImage {
  const images = listSystemImages(sdkRoot);
  const abi = preferredAbi();
  if (!images.length) {
    throw new Error(
      `no Android system images are installed under ${sdkRoot}. Install one with: ` +
      `sdkmanager "system-images;android-35;google_apis;${abi}"`);
  }
  // Prefer an image this host can run at native speed.
  const runnable = images.filter((i) => i.abi === abi);
  const pool = runnable.length ? runnable : images;

  if (!want) {
    const newest = pool[0]!;
    if (!runnable.length) {
      log.warn(`no ${abi} system image installed; falling back to ${newest.abi}, which will be slow`);
    }
    return newest;
  }

  const needle = want.trim().toLowerCase();
  const exact = pool.find((i) => i.packageId.toLowerCase() === needle);
  if (exact) return exact;

  const api = Number(needle.match(/(\d+)/)?.[1]);
  // "Android 15" names a marketing version, "35" an API level; try both.
  const byApi = Number.isFinite(api)
    ? pool.find((i) => i.api === api)
      ?? pool.find((i) => ANDROID_VERSION[i.api] === String(api))
    : undefined;
  if (byApi) return byApi;

  throw new Error(
    `no installed system image matching "${want}" (have: ${pool.map((i) => i.packageId).join(', ')})`);
}

/* ------------------------------------------------------------------ avds -- */

const avdHome = (): string =>
  process.env['ANDROID_AVD_HOME'] || path.join(os.homedir(), '.android', 'avd');

/** Read `key=value` config, which both .ini and config.ini use. */
function readIni(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0 || line.startsWith('#')) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch { /* unreadable: treat as absent */ }
  return out;
}

/**
 * Every AVD defined on this machine, read from ~/.android/avd.
 *
 * Booted-ness is not in there, so the caller supplies the set of AVD names adb
 * currently reports as attached.
 */
export function listAvds(bootedNames: Set<string>): ExistingDevice[] {
  const home = avdHome();
  if (!fs.existsSync(home)) return [];
  const out: ExistingDevice[] = [];

  for (const entry of fs.readdirSync(home)) {
    if (!entry.endsWith('.ini')) continue;
    const name = entry.slice(0, -4);
    const ini = readIni(path.join(home, entry));
    const dir = ini['path'] || path.join(home, `${name}.avd`);
    const config = readIni(path.join(dir, 'config.ini'));

    // image.sysdir.1 looks like "system-images/android-35/google_apis/arm64-v8a/"
    const sysdir = config['image.sysdir.1'] ?? '';
    const api = Number(sysdir.match(/android-(\d+)/)?.[1] ?? ini['target']?.match(/(\d+)/)?.[1]);
    const available = fs.existsSync(dir);

    out.push({
      id: name,
      name,
      deviceType: config['hw.device.name'] ?? 'unknown',
      runtime: Number.isFinite(api) ? runtimeLabel(api) : 'unknown',
      booted: bootedNames.has(name),
      available,
    });
  }
  return out;
}

export const avdExists = (name: string): boolean =>
  fs.existsSync(path.join(avdHome(), `${name}.ini`));

/**
 * Create an AVD.
 *
 * avdmanager asks whether you want to define a custom hardware profile when
 * the device it was given is unfamiliar; answering "no" on stdin keeps it from
 * blocking forever on a daemon with no terminal.
 */
export async function createAvd(
  tools: AndroidTools, name: string, target: DeviceTarget,
): Promise<void> {
  const args = [
    'create', 'avd',
    '-n', name,
    '-k', target.runtimeId,
    '-d', target.deviceTypeId,
    '--force',
  ];
  const r = await exec(tools.avdmanager, args, {
    timeoutMs: 300_000, env: tools.env, input: 'no\n',
  });
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim();
    if (/Unable to locate a Java Runtime|JAVA_HOME/i.test(why)) {
      throw new Error(
        `avdmanager could not find a JDK. Install one (brew install openjdk@21) and set ` +
        `JAVA_HOME, or set it in ~/.simcheck/config.json. Underlying error: ${why.slice(0, 200)}`);
    }
    if (/device.*not.*(found|valid)|Invalid.*device/i.test(why)) {
      throw new Error(
        `avdmanager does not know a device profile called "${target.deviceTypeId}". ` +
        `List the valid ones with: avdmanager list device`);
    }
    throw new Error(`avdmanager create avd failed (exit ${r.code}): ${why.slice(0, 600)}`);
  }
  log.info(`created AVD ${name} (${target.deviceTypeId} / ${target.runtime})`);
}

export async function deleteAvd(tools: AndroidTools, name: string): Promise<void> {
  if (!avdExists(name)) return;
  const r = await exec(tools.avdmanager, ['delete', 'avd', '-n', name], {
    timeoutMs: 120_000, env: tools.env,
  });
  if (r.code !== 0) log.warn(`avdmanager delete avd ${name} exited ${r.code}`, (r.stderr || r.stdout).slice(0, 200));
}

/**
 * Boot an emulator and wait until Android is actually usable.
 *
 * The emulator process must outlive this call -- it is the device -- so it is
 * detached and its output goes to a file rather than a pipe nobody drains.
 * A pipe would fill and wedge the emulator once the buffer was full.
 */
export async function bootEmulator(
  tools: AndroidTools, adb: Adb, name: string, opts: {
    logDir: string;
    wipeData: boolean;
    gpu: string;
    bootTimeoutMs: number;
    extraArgs?: string[];
  },
): Promise<string> {
  if (!fs.existsSync(tools.emulator)) {
    throw new Error(
      `no emulator binary at ${tools.emulator}. Install it with: sdkmanager "emulator"`);
  }
  fs.mkdirSync(opts.logDir, { recursive: true });
  const logPath = path.join(opts.logDir, `emulator-${name}.log`);
  const out = fs.openSync(logPath, 'a');

  const args = [
    '-avd', name,
    '-no-window',
    '-no-audio',
    '-no-boot-anim',
    // Never write a snapshot on exit: the pool's contract is that a recycled
    // device is clean, and a saved snapshot would carry the last run's state
    // into the next one.
    '-no-snapshot-save',
    '-gpu', opts.gpu,
    ...(opts.wipeData ? ['-wipe-data'] : []),
    ...(opts.extraArgs ?? []),
  ];

  log.info(`starting emulator ${name}${opts.wipeData ? ' (wiping data)' : ''}`);
  const child = spawn(tools.emulator, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...tools.env },
  });
  child.unref();
  child.on('error', (e) => log.error(`emulator ${name} failed to spawn`, String(e)));

  // The serial is only knowable once it registers with adb, so poll for it.
  const deadline = Date.now() + opts.bootTimeoutMs;
  let serial: string | null = null;
  while (!serial) {
    await sleep(2000);
    serial = await adb.serialForOrNull(name).catch(() => null);
    if (serial) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `emulator ${name} never attached to adb within ${Math.round(opts.bootTimeoutMs / 1000)}s. ` +
        `Its output is in ${logPath}`);
    }
  }

  await waitForBoot(adb, serial, Math.max(30_000, deadline - Date.now()));
  log.info(`emulator ${name} booted as ${serial}`);
  return serial;
}

/** Ask the emulator console to shut down, then wait for it to detach. */
export async function killEmulator(adb: Adb, name: string, timeoutMs = 60_000): Promise<void> {
  const serial = await adb.serialForOrNull(name).catch(() => null);
  if (!serial) return;                     // already gone
  await adb.rawTry(serial, ['emu', 'kill'], { timeoutMs: 30_000 });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    adb.forget(name);
    const still = await adb.serialForOrNull(name).catch(() => null);
    if (!still) return;
    if (Date.now() >= deadline) {
      log.warn(`emulator ${name} did not detach within ${Math.round(timeoutMs / 1000)}s`);
      return;
    }
    await sleep(1000);
  }
}

/** The ABIs a booted device can execute, for the APK compatibility check. */
export async function deviceAbis(adb: Adb, serial: string): Promise<string[]> {
  const out = await adb.shell(serial, 'getprop ro.product.cpu.abilist').catch(() => '');
  const list = out.trim().split(',').map((a) => a.trim()).filter(Boolean);
  if (list.length) return list;
  const single = await adb.shell(serial, 'getprop ro.product.cpu.abi').catch(() => '');
  return single.trim() ? [single.trim()] : [];
}
