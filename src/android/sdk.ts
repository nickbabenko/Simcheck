import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Config } from '../config.js';

/**
 * Finding the Android SDK, and a JDK to run its Java tools with.
 *
 * Both matter more than they look. The daemon runs under launchd, whose
 * environment is not a login shell: ANDROID_HOME and a `java` on PATH that
 * exist in Terminal are simply absent there. Resolving both explicitly, and
 * passing them down to every child process, is what stops "works when I run
 * it by hand, fails from the daemon".
 */

const SDK_CANDIDATES = [
  path.join(os.homedir(), 'Library', 'Android', 'sdk'),
  '/opt/homebrew/share/android-commandlinetools',
  '/usr/local/share/android-commandlinetools',
  path.join(os.homedir(), 'Android', 'Sdk'),
];

/** Looks like an SDK root if it holds at least one of the tool directories. */
const looksLikeSdk = (dir: string): boolean =>
  ['platform-tools', 'cmdline-tools', 'build-tools', 'emulator'].some(
    (sub) => fs.existsSync(path.join(dir, sub)));

export function resolveSdkRoot(cfg: Config): string | null {
  const named = [cfg.androidSdk, process.env['ANDROID_HOME'], process.env['ANDROID_SDK_ROOT']]
    .filter((v): v is string => Boolean(v));
  for (const dir of named) {
    // A configured path that is wrong should say so, not be silently skipped.
    if (looksLikeSdk(dir)) return dir;
  }
  return SDK_CANDIDATES.find(looksLikeSdk) ?? null;
}

/**
 * A JDK the SDK's Java tools can run under.
 *
 * macOS ships a `/usr/bin/java` stub that is not a JVM: it prints "Unable to
 * locate a Java Runtime" and exits non-zero unless a real JDK is registered.
 * Homebrew's openjdk formulae are keg-only and do not register themselves, so
 * a machine can have three JDKs installed and still fail every Android tool.
 * Prefer a pinned LTS, since the Android Gradle Plugin is particular.
 */
const JDK_CANDIDATES = [
  '/opt/homebrew/opt/openjdk@21',
  '/opt/homebrew/opt/openjdk@17',
  '/usr/local/opt/openjdk@21',
  '/usr/local/opt/openjdk@17',
  '/opt/homebrew/opt/openjdk',
  '/usr/local/opt/openjdk',
];

const isJdk = (home: string): boolean => fs.existsSync(path.join(home, 'bin', 'java'));

export function resolveJavaHome(): string | null {
  const declared = process.env['JAVA_HOME'];
  if (declared && isJdk(declared)) return declared;

  // The system locator knows about anything properly registered.
  const located = spawnSync('/usr/libexec/java_home', ['-v', '17+'], { encoding: 'utf8', timeout: 15_000 });
  if (located.status === 0) {
    const home = String(located.stdout).trim();
    if (home && isJdk(home)) return home;
  }
  return JDK_CANDIDATES.find(isJdk) ?? null;
}

export interface AndroidTools {
  sdkRoot: string;
  javaHome: string | null;
  /** Environment every SDK child process should inherit. */
  env: NodeJS.ProcessEnv;
  adb: string;
  emulator: string;
  avdmanager: string;
  sdkmanager: string;
  /** Newest installed build-tools aapt2, or null when none is installed. */
  aapt2: string | null;
  apkanalyzer: string | null;
}

/** Newest build-tools directory, compared numerically rather than as strings
 *  -- "9.0.0" must not sort above "34.0.0". */
function newestBuildTools(sdkRoot: string): string | null {
  const dir = path.join(sdkRoot, 'build-tools');
  if (!fs.existsSync(dir)) return null;
  const versions = fs.readdirSync(dir)
    .filter((v) => fs.existsSync(path.join(dir, v, 'aapt2')))
    .sort((a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (d) return d;
      }
      return 0;
    });
  return versions[0] ? path.join(dir, versions[0], 'aapt2') : null;
}

/** Prefer a binary inside the SDK, fall back to whatever the config named
 *  (usually a bare command name, resolved on PATH). */
const pick = (sdkRoot: string, relative: string, configured: string): string => {
  const inSdk = path.join(sdkRoot, relative);
  return fs.existsSync(inSdk) ? inSdk : configured;
};

export function resolveTools(cfg: Config): AndroidTools | { error: string } {
  const sdkRoot = resolveSdkRoot(cfg);
  if (!sdkRoot) {
    return {
      error: 'no Android SDK found. Set androidSdk in ~/.simcheck/config.json or ANDROID_HOME, ' +
        'or install one with: brew install --cask android-commandlinetools',
    };
  }
  const javaHome = resolveJavaHome();
  const env: NodeJS.ProcessEnv = {
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    ...(javaHome ? { JAVA_HOME: javaHome, PATH: `${path.join(javaHome, 'bin')}:${process.env['PATH'] ?? ''}` } : {}),
  };
  const apkanalyzer = path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'apkanalyzer');

  return {
    sdkRoot,
    javaHome,
    env,
    adb: pick(sdkRoot, 'platform-tools/adb', cfg.adbBin),
    emulator: pick(sdkRoot, 'emulator/emulator', cfg.emulatorBin),
    avdmanager: pick(sdkRoot, 'cmdline-tools/latest/bin/avdmanager', cfg.avdmanagerBin),
    sdkmanager: pick(sdkRoot, 'cmdline-tools/latest/bin/sdkmanager', 'sdkmanager'),
    aapt2: newestBuildTools(sdkRoot),
    apkanalyzer: fs.existsSync(apkanalyzer) ? apkanalyzer : null,
  };
}

export const isToolsError = (t: AndroidTools | { error: string }): t is { error: string } =>
  'error' in t;
