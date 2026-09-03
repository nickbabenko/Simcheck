import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config } from '../config.js';
import { paths } from '../config.js';
import type { AppSpec } from '../types.js';
import type { PrepareAppContext, PreparedApp } from '../device.js';
import { fetchBuild, resolveGithubArtifact } from '../fetchbuild.js';
import { execOk } from '../util.js';
import { logger } from '../log.js';
import type { AndroidTools } from './sdk.js';
import type { Adb } from './adb.js';
import { assemble } from './gradle.js';
import { assertRunnableAbi, readApk } from './apk.js';
import { deviceAbis } from './avd.js';

const log = logger('android-build');

/** Turn an AppSpec into an installable .apk on disk. */
export async function prepareApp(
  cfg: Config, tools: AndroidTools, adb: Adb, spec: AppSpec, ctx: PrepareAppContext,
): Promise<PreparedApp> {
  const { deviceId: avd, runDir, signal, artifacts } = ctx;

  const fromApk = async (apkPath: string, buildLog?: string): Promise<PreparedApp> => {
    const info = await readApk(tools, apkPath);

    // The Android counterpart of the .ipa check: an x86_64-only APK installs
    // happily on an arm64 emulator and then dies at launch with a linker
    // error that says nothing about the real mistake.
    const serial = await adb.serialForOrNull(avd);
    if (serial) assertRunnableAbi(info, await deviceAbis(adb, serial), path.basename(apkPath));

    // A test APK really has nothing to launch, and saying so here is far
    // clearer than an install that succeeds and then starts nothing.
    if (!info.launchActivity && info.instrumentationRunner) {
      throw new Error(
        `${path.basename(apkPath)} declares an instrumentation runner and no launchable activity, ` +
        'so it is an androidTest APK -- pass it as `instrumentation.testApk` instead.');
    }
    // No activity is not fatal: `aapt2 dump badging` does not report a
    // launcher entry declared through an <activity-alias>, which plenty of
    // real apps use. The backend resolves it from the device after install,
    // where PackageManager gives the authoritative answer.
    if (!info.launchActivity) {
      log.info(`${path.basename(apkPath)} has no launchable-activity in its manifest; will resolve it on the device after install`);
    }
    return {
      appPath: apkPath,
      bundleId: spec.bundleId || info.packageName,
      // Android's log stream is filtered by process name, which is the
      // package unless the manifest overrides it.
      executable: spec.bundleId || info.packageName,
      ...(info.launchActivity ? { activity: info.launchActivity } : {}),
      preinstalled: false,
      ...(buildLog ? { buildLog } : {}),
    };
  };

  // A build the daemon downloads itself, for callers that cannot upload one.
  if ((spec.url || spec.github) && !spec.artifactId) {
    if (!artifacts) throw new Error('artifact store unavailable');
    const resolved = spec.github
      ? await resolveGithubArtifact(cfg, spec.github)
      : { url: spec.url!, label: '' };
    const fetched = await fetchBuild(cfg, artifacts, {
      url: resolved.url,
      ...(resolved.label ? { label: resolved.label } : {}),
      ...(spec.urlHeaders ? { headers: spec.urlHeaders } : {}),
    }, signal);
    return fromApk(fetched.appPath);
  }

  // An uploaded build: already unpacked and validated at upload time.
  if (spec.artifactId) {
    const artifact = artifacts?.get(spec.artifactId);
    if (!artifact) throw new Error(`no uploaded artifact "${spec.artifactId}" (it may have been pruned -- re-upload it)`);
    if (artifact.platform !== 'android') {
      throw new Error(
        `artifact ${artifact.id} is an ${artifact.platform} build (${artifact.appName}), ` +
        `so it cannot run on an emulator`);
    }
    if (!fs.existsSync(artifact.appPath)) throw new Error(`artifact ${artifact.id} is registered but its .apk is missing on disk`);
    return fromApk(artifact.appPath);
  }

  // Nothing to build or copy: the app is already on the emulator.
  if (!spec.path && !spec.project) {
    if (!spec.bundleId) throw new Error('app needs `path`, `project` plus `module`, or `bundleId`');
    const serial = await adb.serialFor(avd);
    const listed = await adb.shellTry(serial, `pm list packages ${spec.bundleId}`, { timeoutMs: 30_000 });
    if (!listed.out.includes(`package:${spec.bundleId}`)) {
      throw new Error(
        `${spec.bundleId} is not installed on the leased emulator. Supply app.path or app.project ` +
        `so the harness can install it, or pick a package that is already present.`);
    }
    const activity = await launcherActivity(adb, serial, spec.bundleId);
    return {
      bundleId: spec.bundleId,
      executable: spec.bundleId,
      ...(activity ? { activity } : {}),
      preinstalled: true,
    };
  }

  if (spec.path) return fromApk(await resolveArtifact(cfg, spec.path));

  const built = await assemble(tools, {
    projectDir: spec.project!,
    module: spec.module ?? ':app',
    variant: spec.variant ?? 'debug',
    withAndroidTest: false,
    runDir,
    logName: 'build.log',
    timeoutMs: 30 * 60_000,
    ...(signal ? { signal } : {}),
  });
  return fromApk(built.apkPath, built.buildLog);
}

/** Accept an .apk, or a .zip containing one. */
async function resolveArtifact(cfg: Config, given: string): Promise<string> {
  const abs = path.resolve(given);
  if (!fs.existsSync(abs)) throw new Error(`app path does not exist: ${abs}`);
  if (fs.statSync(abs).isDirectory()) {
    throw new Error(`expected an .apk file, got a directory: ${abs}. A .app bundle is an iOS build.`);
  }
  if (/\.apk$/i.test(abs)) return abs;
  if (/\.(aab)$/i.test(abs)) {
    throw new Error(
      `${path.basename(abs)} is an .aab. An App Bundle is not installable directly -- ` +
      `generate an APK from it with bundletool, or build the assemble task instead of bundle.`);
  }
  if (!/\.zip$/i.test(abs)) throw new Error(`unsupported app artifact: ${abs} (want an .apk or a .zip containing one)`);

  // Unpack to a content-addressed dir so re-submitting the same zip is free.
  const digest = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
  const dest = path.join(paths(cfg).builds, `android-${digest}`);
  const marker = path.join(dest, '.unpacked');

  if (!fs.existsSync(marker)) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    await execOk('/usr/bin/ditto', ['-x', '-k', abs, dest], { timeoutMs: 300_000 });
    fs.writeFileSync(marker, abs);
  }
  const found = findApk(dest);
  if (!found) throw new Error(`no .apk found inside ${abs}`);
  return found;
}

function findApk(dir: string, depth = 0): string | null {
  if (depth > 4) return null;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.apk')) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const hit = findApk(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * The launcher activity of an app already on the device.
 *
 * `cmd package resolve-activity` answers this without needing the APK file,
 * which is the whole point when the build is not ours.
 */
async function launcherActivity(adb: Adb, serial: string, pkg: string): Promise<string | undefined> {
  const r = await adb.shellTry(serial, `cmd package resolve-activity --brief ${pkg}`, { timeoutMs: 30_000 });
  // The brief form prints "com.example/.MainActivity" on the last line.
  const line = r.out.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!line || !line.includes('/')) {
    log.warn(`could not resolve a launcher activity for ${pkg}; falling back to monkey`);
    return undefined;
  }
  const [, activity] = line.split('/');
  return activity?.startsWith('.') ? `${pkg}${activity}` : activity;
}
