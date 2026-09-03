import fs from 'node:fs';
import path from 'node:path';
import { exec } from '../util.js';
import type { AndroidTools } from './sdk.js';
import { logger } from '../log.js';

const log = logger('apk');

export interface ApkInfo {
  packageName: string;
  /** Fully-qualified launchable activity, when the APK declares one. A test
   *  APK has none, which is how you can tell the two apart. */
  launchActivity?: string;
  /** Instrumentation runner class, for an androidTest APK. */
  instrumentationRunner?: string;
  /** The app an instrumentation APK targets. */
  instrumentationTarget?: string;
  /** Native ABIs the APK carries. Empty means it has no native code and will
   *  run anywhere. */
  abis: string[];
}

/**
 * Read an APK's manifest.
 *
 * `aapt2 dump badging` is the primary path because it ships with build-tools
 * and answers everything in one call. `apkanalyzer` is the fallback for an SDK
 * that has cmdline-tools but no build-tools; it needs several calls and cannot
 * report native ABIs as directly, so it is second choice rather than first.
 */
export async function readApk(tools: AndroidTools, apkPath: string): Promise<ApkInfo> {
  if (!fs.existsSync(apkPath)) throw new Error(`no such APK: ${apkPath}`);

  if (tools.aapt2) {
    const r = await exec(tools.aapt2, ['dump', 'badging', apkPath], { timeoutMs: 120_000, env: tools.env });
    if (r.code === 0) return parseBadging(r.stdout);
    log.warn(`aapt2 could not read ${path.basename(apkPath)}`, r.stderr.trim().slice(0, 200));
  }

  if (tools.apkanalyzer) {
    const info = await viaApkanalyzer(tools, apkPath);
    if (info) return info;
  }

  throw new Error(
    `could not read the manifest of ${path.basename(apkPath)}: no usable aapt2 or apkanalyzer in the SDK at ` +
    `${tools.sdkRoot}. Install build-tools with: sdkmanager "build-tools;35.0.0"`);
}

/**
 * Parse `aapt2 dump badging` output.
 *
 * The format is a set of `key: name='value'` lines, quoted with single quotes
 * that cannot themselves appear in an Android identifier, so a narrow regex is
 * safe here and a general-purpose parser would be pretence.
 */
export function parseBadging(out: string): ApkInfo {
  const field = (line: string, key: string): string | undefined =>
    line.match(new RegExp(`${key}='([^']*)'`))?.[1];

  let packageName = '';
  let launchActivity: string | undefined;
  let instrumentationRunner: string | undefined;
  let instrumentationTarget: string | undefined;
  const abis: string[] = [];

  for (const line of out.split('\n')) {
    if (line.startsWith('package:')) packageName = field(line, 'name') ?? packageName;
    else if (line.startsWith('launchable-activity:')) launchActivity ??= field(line, 'name');
    else if (line.startsWith('instrumentation:')) {
      instrumentationRunner ??= field(line, 'name');
      instrumentationTarget ??= field(line, 'targetPackage');
    } else if (line.startsWith('native-code:') || line.startsWith('alt-native-code:')) {
      for (const m of line.matchAll(/'([^']+)'/g)) if (m[1]) abis.push(m[1]);
    }
  }

  if (!packageName) throw new Error('aapt2 reported no package name for this APK');
  return {
    packageName,
    ...(launchActivity ? { launchActivity } : {}),
    ...(instrumentationRunner ? { instrumentationRunner } : {}),
    ...(instrumentationTarget ? { instrumentationTarget } : {}),
    abis: [...new Set(abis)],
  };
}

/** Fallback for an SDK with cmdline-tools but no build-tools. */
async function viaApkanalyzer(tools: AndroidTools, apkPath: string): Promise<ApkInfo | null> {
  const call = async (args: string[]): Promise<string | null> => {
    const r = await exec(tools.apkanalyzer!, args, { timeoutMs: 120_000, env: tools.env });
    return r.code === 0 ? r.stdout.trim() : null;
  };

  const packageName = await call(['manifest', 'application-id', apkPath]);
  if (!packageName) return null;

  // Native ABIs show up as lib/<abi>/ entries in the archive listing.
  const files = await call(['files', 'list', apkPath]) ?? '';
  const abis = [...new Set(
    [...files.matchAll(/^\/lib\/([^/]+)\//gm)].map((m) => m[1]!),
  )];

  // The full manifest carries the launcher intent filter and any
  // <instrumentation> declaration; both are worth having but neither is fatal.
  const manifest = await call(['manifest', 'print', apkPath]) ?? '';
  const launchActivity = launchableFromManifest(manifest, packageName);
  const runner = manifest.match(/<instrumentation[^>]*android:name="([^"]+)"/)?.[1];
  const target = manifest.match(/<instrumentation[^>]*android:targetPackage="([^"]+)"/)?.[1];

  return {
    packageName,
    ...(launchActivity ? { launchActivity } : {}),
    ...(runner ? { instrumentationRunner: runner } : {}),
    ...(target ? { instrumentationTarget: target } : {}),
    abis,
  };
}

/**
 * The activity carrying the LAUNCHER category.
 *
 * Manifests name activities relatively (".MainActivity") as often as fully,
 * so the package has to be prepended when the name starts with a dot.
 */
export function launchableFromManifest(manifest: string, packageName: string): string | undefined {
  const blocks = manifest.split(/<activity[\s-]/).slice(1);
  for (const block of blocks) {
    const body = block.split('</activity>')[0] ?? '';
    if (!body.includes('android.intent.category.LAUNCHER')) continue;
    const name = block.match(/android:name="([^"]+)"/)?.[1];
    if (!name) continue;
    return name.startsWith('.') ? `${packageName}${name}` : name;
  }
  return undefined;
}

/**
 * Refuse a build that cannot run on this emulator.
 *
 * The Android counterpart of handing over an .ipa: an APK built only for
 * x86_64 installs happily on an arm64 emulator and then dies at first launch
 * with a linker error that says nothing about the real mistake. Catching it at
 * prepare time makes the message the one the caller needs.
 */
export function assertRunnableAbi(info: ApkInfo, deviceAbis: string[], apkName: string): void {
  if (!info.abis.length) return;              // no native code: runs anywhere
  if (info.abis.some((a) => deviceAbis.includes(a))) return;
  throw new Error(
    `${apkName} carries native code for ${info.abis.join(', ')}, but the emulator runs ` +
    `${deviceAbis.join(', ')}. On Apple silicon you need an arm64-v8a slice -- an x86_64-only ` +
    `build installs but crashes on launch with a linker error.`);
}
