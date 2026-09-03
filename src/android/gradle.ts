import fs from 'node:fs';
import path from 'node:path';
import { exec } from '../util.js';
import { logger } from '../log.js';
import type { AndroidTools } from './sdk.js';

const log = logger('gradle');

export interface GradleBuild {
  /** Absolute path to the assembled APK. */
  apkPath: string;
  /** Absolute path to the androidTest APK, when one was asked for. */
  testApkPath?: string;
  /** Absolute path to the log written into the run directory. */
  buildLog: string;
}

/** ":app" -> "app"; ":features:login" -> "features/login". */
const modulePath = (module: string): string =>
  module.replace(/^:/, '').replace(/:/g, path.sep);

/** "debug" -> "assembleDebug"; "freeRelease" -> "assembleFreeRelease". */
const taskFor = (prefix: string, variant: string): string =>
  `${prefix}${variant.charAt(0).toUpperCase()}${variant.slice(1)}`;

/** The wrapper if the project has one, else whatever `gradle` is on PATH.
 *  The wrapper is strongly preferred: it pins the Gradle version the project
 *  actually builds with, which a stray system Gradle will not match. */
function gradleCommand(projectDir: string): { cmd: string; args: string[] } {
  const wrapper = path.join(projectDir, 'gradlew');
  if (fs.existsSync(wrapper)) return { cmd: wrapper, args: [] };
  log.warn(`no gradlew in ${projectDir}; falling back to a system gradle, which may be the wrong version`);
  return { cmd: 'gradle', args: [] };
}

/**
 * Find what a Gradle build actually produced.
 *
 * The Android Gradle Plugin writes an `output-metadata.json` naming the APK it
 * built, which is the only reliable answer: the filename encodes flavour,
 * build type, version and signing config, and guessing it right for every
 * project shape is not possible. Globbing is the fallback for older plugins.
 */
export function findApk(outputDir: string): string | null {
  if (!fs.existsSync(outputDir)) return null;

  const metadata = path.join(outputDir, 'output-metadata.json');
  if (fs.existsSync(metadata)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metadata, 'utf8')) as {
        elements?: { outputFile?: string }[];
      };
      const file = parsed.elements?.[0]?.outputFile;
      if (file) {
        const abs = path.isAbsolute(file) ? file : path.join(outputDir, file);
        if (fs.existsSync(abs)) return abs;
      }
    } catch (e) {
      log.warn('output-metadata.json was unreadable, falling back to a directory scan', (e as Error).message);
    }
  }

  const apks = fs.readdirSync(outputDir).filter((f) => f.endsWith('.apk'));
  // An unsigned intermediate sits beside the real one in some configurations.
  const preferred = apks.find((f) => !f.includes('unsigned')) ?? apks[0];
  return preferred ? path.join(outputDir, preferred) : null;
}

interface BuildOpts {
  projectDir: string;
  module: string;
  variant: string;
  /** Also assemble the androidTest APK, for an instrumentation run. */
  withAndroidTest: boolean;
  runDir: string;
  logName: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Assemble an Android app, and optionally its instrumentation APK, from source.
 *
 * Both come out of one Gradle invocation when both are wanted: a second call
 * would re-run configuration for no benefit, and on a large project that is
 * the expensive half.
 */
export async function assemble(tools: AndroidTools, opts: BuildOpts): Promise<GradleBuild> {
  const projectDir = path.resolve(opts.projectDir);
  if (!fs.existsSync(projectDir)) throw new Error(`no such Gradle project: ${projectDir}`);
  if (!fs.existsSync(path.join(projectDir, 'settings.gradle'))
      && !fs.existsSync(path.join(projectDir, 'settings.gradle.kts'))
      && !fs.existsSync(path.join(projectDir, 'build.gradle'))
      && !fs.existsSync(path.join(projectDir, 'build.gradle.kts'))) {
    throw new Error(
      `${projectDir} does not look like a Gradle project -- no settings.gradle or build.gradle in it. ` +
      `app.project should be the directory holding gradlew.`);
  }
  if (!tools.javaHome) {
    throw new Error(
      'Gradle needs a JDK and none was found. Install one with: brew install openjdk@21 ' +
      '(then re-run ./install.sh so the daemon inherits JAVA_HOME).');
  }

  const module = opts.module || ':app';
  const variant = opts.variant || 'debug';
  const { cmd, args: baseArgs } = gradleCommand(projectDir);
  const tasks = [`${module}:${taskFor('assemble', variant)}`];
  if (opts.withAndroidTest) tasks.push(`${module}:${taskFor('assemble', variant)}AndroidTest`);

  const args = [
    ...baseArgs,
    ...tasks,
    // A daemon left running after the build would hold the project lock and
    // memory for as long as the harness lives.
    '--no-daemon',
    '--console=plain',
  ];

  log.info(`gradle ${tasks.join(' ')} in ${projectDir}`);
  const started = Date.now();
  const r = await exec(cmd, args, {
    cwd: projectDir,
    timeoutMs: opts.timeoutMs,
    env: tools.env,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const buildLog = path.join(opts.runDir, opts.logName);
  fs.writeFileSync(buildLog, `$ ${cmd} ${args.join(' ')}\n(in ${projectDir})\n\n${r.stdout}\n${r.stderr}`);

  if (r.code !== 0) {
    throw new Error(
      `gradle ${tasks.join(' ')} failed (exit ${r.code}) after ${Math.round((Date.now() - started) / 1000)}s. ` +
      `Full log: ${buildLog}\n${tailErrors(r.stdout + r.stderr)}`);
  }
  log.info(`assembled ${module} ${variant} in ${Math.round((Date.now() - started) / 1000)}s`);

  const outputs = path.join(projectDir, modulePath(module), 'build', 'outputs', 'apk');
  const apkPath = findApk(path.join(outputs, ...variantDirs(variant)));
  if (!apkPath) {
    throw new Error(
      `gradle reported success but no APK was found under ${outputs}. ` +
      `Check the module ("${module}") and variant ("${variant}"). Full log: ${buildLog}`);
  }

  let testApkPath: string | undefined;
  if (opts.withAndroidTest) {
    const found = findApk(path.join(outputs, 'androidTest', ...variantDirs(variant)));
    if (!found) {
      throw new Error(
        `no androidTest APK was produced for ${module} ${variant}. ` +
        `Does the module have a src/androidTest source set with an instrumentation runner? Full log: ${buildLog}`);
    }
    testApkPath = found;
  }

  return { apkPath, ...(testApkPath ? { testApkPath } : {}), buildLog };
}

/**
 * Where AGP puts a variant's outputs.
 *
 * A plain build type is one directory ("debug"); a flavoured variant is nested
 * ("free/debug"), so "freeRelease" has to be split on the case boundary.
 */
export function variantDirs(variant: string): string[] {
  const parts = variant.split(/(?=[A-Z])/).map((p) => p.charAt(0).toLowerCase() + p.slice(1));
  return parts.length > 1 ? parts : [variant];
}

/** The last few real errors, which is what a caller actually needs. */
function tailErrors(output: string): string {
  const lines = output.split('\n');
  const errors = lines.filter((l) =>
    /^e: |error:|FAILURE:|Caused by:|> Task .* FAILED|What went wrong/i.test(l));
  return errors.slice(-12).join('\n') || lines.slice(-25).join('\n');
}
