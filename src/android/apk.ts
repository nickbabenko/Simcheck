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
    if (r.code === 0) {
      const info = parseBadging(r.stdout);
      // `badging` is a summary, and it omits things it has no line for: an
      // <instrumentation> declaration is one (measured against an APK whose
      // manifest plainly contains one), an <activity-alias> launcher entry is
      // another. The compiled manifest is authoritative, so fall back to it
      // rather than concluding the APK lacks what it actually declares.
      if (!info.instrumentationRunner || !info.launchActivity) {
        const fromManifest = await readCompiledManifest(tools, apkPath);
        if (fromManifest) {
          info.instrumentationRunner ??= fromManifest.instrumentationRunner;
          info.instrumentationTarget ??= fromManifest.instrumentationTarget;
          info.launchActivity ??= fromManifest.launchActivity;
        }
      }
      return info;
    }
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

/**
 * Read what `badging` leaves out, from the compiled manifest.
 *
 * `aapt2 dump xmltree` prints the binary XML as an indented element tree:
 *
 *   E: instrumentation (line=9)
 *     A: ...:name(0x01010003)="androidx.test.runner.AndroidJUnitRunner" (Raw: "...")
 *     A: ...:targetPackage(0x01010021)="com.simcheck.demo" (Raw: "...")
 *
 * Attributes belong to the element above them, so the parse is a scan that
 * remembers which element it is inside.
 */
async function readCompiledManifest(
  tools: AndroidTools, apkPath: string,
): Promise<Partial<ApkInfo> | null> {
  const r = await exec(tools.aapt2!, ['dump', 'xmltree', apkPath, '--file', 'AndroidManifest.xml'],
    { timeoutMs: 120_000, env: tools.env });
  if (r.code !== 0) {
    log.warn(`aapt2 dump xmltree failed for ${path.basename(apkPath)}`, r.stderr.trim().slice(0, 200));
    return null;
  }
  return parseXmlTree(r.stdout);
}

/** The `package` attribute is not on every element, so activity names are
 *  qualified by the caller when they start with a dot. */
export function parseXmlTree(out: string): Partial<ApkInfo> {
  const result: Partial<ApkInfo> = {};
  let element: string | null = null;
  let elementIndent = 0;
  // An activity's LAUNCHER category appears in a nested intent-filter, so the
  // candidate name is held until its filter proves it is the launcher.
  let pendingActivity: string | null = null;
  let sawLauncher = false;
  let packageName: string | undefined;

  const attr = (line: string, name: string): string | undefined =>
    line.match(new RegExp(`:${name}\\(0x[0-9a-f]+\\)="([^"]*)"`))?.[1]
    ?? line.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

  for (const raw of out.split('\n')) {
    const indent = raw.search(/\S/);
    const line = raw.trim();

    const el = line.match(/^E: ([\w-]+)/);
    if (el) {
      // Leaving an activity subtree without having seen LAUNCHER: discard it.
      if (pendingActivity && indent <= elementIndent && el[1] !== 'intent-filter' && el[1] !== 'category' && el[1] !== 'action') {
        if (sawLauncher) result.launchActivity ??= pendingActivity;
        pendingActivity = null;
        sawLauncher = false;
      }
      element = el[1]!;
      elementIndent = indent;
      if (element === 'activity' || element === 'activity-alias') { pendingActivity = null; sawLauncher = false; }
      continue;
    }

    if (!line.startsWith('A: ')) continue;

    if (element === 'manifest') packageName ??= attr(line, 'package');
    if (element === 'instrumentation') {
      result.instrumentationRunner ??= attr(line, 'name');
      result.instrumentationTarget ??= attr(line, 'targetPackage');
    }
    if (element === 'activity' || element === 'activity-alias') {
      const name = attr(line, 'name');
      if (name) pendingActivity ??= name;
    }
    if (element === 'category' && attr(line, 'name') === 'android.intent.category.LAUNCHER') {
      sawLauncher = true;
    }
  }
  if (pendingActivity && sawLauncher) result.launchActivity ??= pendingActivity;
  if (result.launchActivity?.startsWith('.') && packageName) {
    result.launchActivity = `${packageName}${result.launchActivity}`;
  }
  return result;
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
