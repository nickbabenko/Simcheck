import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config } from './config.js';
import { paths } from './config.js';
import type { AppSpec } from './types.js';
import { spawnSync } from 'node:child_process';
import * as simctl from './simctl.js';
import type { ArtifactStore } from './artifacts.js';
import { fetchBuild, resolveGithubArtifact } from './fetchbuild.js';
import { exec, execOk } from './util.js';
import { logger } from './log.js';

const log = logger('build');

export interface PreparedApp {
  /** Absent when the app was already on the device. */
  appPath?: string;
  bundleId: string;
  executable: string;
  buildLog?: string;   // absolute path, only when we ran xcodebuild
  /** True when we did not install it, and so must not uninstall it either. */
  preinstalled: boolean;
}

/** Turn an AppSpec into an installable .app on disk. */
export async function prepareApp(
  cfg: Config, spec: AppSpec, udid: string, runDir: string,
  signal?: AbortSignal, artifacts?: ArtifactStore,
): Promise<PreparedApp> {
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
    return {
      appPath: fetched.appPath,
      bundleId: spec.bundleId || fetched.bundleId,
      executable: path.basename(fetched.appPath, '.app'),
      preinstalled: false,
    };
  }

  // An uploaded build: already unpacked and validated at upload time.
  if (spec.artifactId) {
    const artifact = artifacts?.get(spec.artifactId);
    if (!artifact) throw new Error(`no uploaded artifact "${spec.artifactId}" (it may have been pruned -- re-upload it)`);
    if (!fs.existsSync(artifact.appPath)) throw new Error(`artifact ${artifact.id} is registered but its .app is missing on disk`);
    return {
      appPath: artifact.appPath,
      bundleId: spec.bundleId || artifact.bundleId,
      executable: path.basename(artifact.appPath, '.app'),
      preinstalled: false,
    };
  }

  // Nothing to build or copy: the app is already on the simulator.
  if (!spec.path && !spec.scheme) {
    if (!spec.bundleId) throw new Error('app needs `path`, `scheme`, or `bundleId`');
    if (!await simctl.isInstalled(udid, spec.bundleId)) {
      throw new Error(
        `${spec.bundleId} is not installed on the leased simulator. Supply app.path or app.scheme ` +
        `so the harness can install it, or pick a bundle id that is already present.`);
    }
    return { bundleId: spec.bundleId, executable: spec.bundleId.split('.').pop()!, preinstalled: true };
  }

  const appPath = spec.path
    ? await resolveArtifact(cfg, spec.path)
    : await buildFromSource(cfg, spec, udid, runDir, signal);

  const info = readInfoPlist(appPath);
  const bundleId = spec.bundleId || info.bundleId;
  if (!bundleId) throw new Error(`could not read CFBundleIdentifier from ${appPath}/Info.plist -- pass app.bundleId explicitly`);
  assertSimulatorSlice(appPath, info.executable);

  const buildLog = path.join(runDir, 'build.log');
  return {
    appPath,
    bundleId,
    executable: info.executable || path.basename(appPath, '.app'),
    preinstalled: false,
    ...(spec.path ? {} : { buildLog }),
  };
}

/** Accept a .app directory, or a .zip/.ipa-style archive containing one. */
async function resolveArtifact(cfg: Config, given: string): Promise<string> {
  const abs = path.resolve(given);
  if (!fs.existsSync(abs)) throw new Error(`app path does not exist: ${abs}`);

  if (fs.statSync(abs).isDirectory()) {
    if (!abs.endsWith('.app')) throw new Error(`expected a .app bundle, got a directory: ${abs}`);
    return abs;
  }

  if (!/\.(zip|ipa)$/i.test(abs)) throw new Error(`unsupported app artifact: ${abs} (want a .app directory or a .zip)`);
  if (/\.ipa$/i.test(abs)) {
    throw new Error(
      `${path.basename(abs)} is an .ipa -- those hold arm64 device slices and cannot run on a simulator. ` +
      `Build for "platform=iOS Simulator" and submit the resulting .app (or a zip of it).`);
  }

  // Unpack to a content-addressed dir so re-submitting the same zip is free.
  const digest = crypto.createHash('sha256')
    .update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
  const dest = path.join(paths(cfg).builds, digest);
  const marker = path.join(dest, '.unpacked');

  if (!fs.existsSync(marker)) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    await execOk('/usr/bin/ditto', ['-x', '-k', abs, dest], { timeoutMs: 300_000 });
    fs.writeFileSync(marker, abs);
  }
  const found = findApp(dest);
  if (!found) throw new Error(`no .app bundle found inside ${abs}`);
  return found;
}

function findApp(dir: string, depth = 0): string | null {
  if (depth > 4) return null;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.endsWith('.app')) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const hit = findApp(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

async function buildFromSource(
  cfg: Config, spec: AppSpec, udid: string, runDir: string, signal?: AbortSignal,
): Promise<string> {
  if (!spec.scheme) throw new Error('app.scheme is required when building from source');

  const container = spec.workspace ?? spec.project;
  if (!container) throw new Error('app.project (.xcodeproj) or app.workspace (.xcworkspace) is required when building from source');
  const containerAbs = path.resolve(container);
  if (!fs.existsSync(containerAbs)) throw new Error(`no such project/workspace: ${containerAbs}`);

  const configuration = spec.configuration ?? 'Debug';
  // Stable per-project derived data keeps rebuilds incremental across runs.
  const key = crypto.createHash('sha256').update(`${containerAbs}::${spec.scheme}::${configuration}`).digest('hex').slice(0, 16);
  const derived = path.join(paths(cfg).derived, key);
  fs.mkdirSync(derived, { recursive: true });

  const args = [
    spec.workspace ? '-workspace' : '-project', containerAbs,
    '-scheme', spec.scheme,
    '-configuration', configuration,
    '-destination', `platform=iOS Simulator,id=${udid}`,
    '-derivedDataPath', derived,
    'CODE_SIGNING_ALLOWED=NO',
    'build',
  ];

  log.info(`xcodebuild ${spec.scheme} (${configuration})`);
  const started = Date.now();
  const r = await exec('xcodebuild', args, { timeoutMs: 30 * 60_000, signal });
  const logPath = path.join(runDir, 'build.log');
  fs.writeFileSync(logPath, `$ xcodebuild ${args.join(' ')}\n\n${r.stdout}\n${r.stderr}`);

  if (r.code !== 0) {
    throw new Error(
      `xcodebuild failed (exit ${r.code}) after ${Math.round((Date.now() - started) / 1000)}s. ` +
      `Full log: ${logPath}\n${tailErrors(r.stdout + r.stderr)}`);
  }
  log.info(`built ${spec.scheme} in ${Math.round((Date.now() - started) / 1000)}s`);

  const products = path.join(derived, 'Build', 'Products', `${configuration}-iphonesimulator`);
  const app = findApp(products);
  if (app) return app;

  // Custom SYMROOT or a non-standard product dir -- ask xcodebuild directly.
  const settings = await execOk('xcodebuild', [...args.slice(0, -1), '-showBuildSettings', '-json'], { timeoutMs: 300_000 });
  const entries = JSON.parse(settings) as { buildSettings: Record<string, string> }[];
  for (const e of entries) {
    const dir = e.buildSettings['BUILT_PRODUCTS_DIR'];
    const name = e.buildSettings['FULL_PRODUCT_NAME'];
    if (dir && name?.endsWith('.app') && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  throw new Error(`build succeeded but no .app was found under ${products}`);
}

/** The last few compiler errors, which is what a caller actually needs. */
function tailErrors(output: string): string {
  const errors = output.split('\n').filter((l) => /(error:|error G|\*\* BUILD FAILED)/.test(l));
  return errors.slice(-12).join('\n') || output.split('\n').slice(-25).join('\n');
}

function readInfoPlist(appPath: string): { bundleId?: string; executable?: string } {
  const plist = path.join(appPath, 'Info.plist');
  if (!fs.existsSync(plist)) return {};
  const read = (key: string): string | undefined => {
    const r = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout).trim() || undefined : undefined;
  };
  return { bundleId: read('CFBundleIdentifier'), executable: read('CFBundleExecutable') };
}

/** Catch the single most common mistake: handing over a device build.
 *  On Apple Silicon both slices are arm64, so architecture tells us nothing --
 *  an embedded provisioning profile is the reliable signal. */
function assertSimulatorSlice(appPath: string, _executable?: string): void {
  if (fs.existsSync(path.join(appPath, 'embedded.mobileprovision'))) {
    throw new Error(
      `${path.basename(appPath)} looks like a device build -- it carries an embedded provisioning profile. ` +
      `Simulator builds come from a "platform=iOS Simulator" destination and have no profile.`);
  }
}
