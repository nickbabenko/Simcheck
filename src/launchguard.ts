/**
 * What a caller may put into the app's launch: its environment and its
 * arguments.
 *
 * Some environment variables reach past the app. `DYLD_INSERT_LIBRARIES`
 * loads arbitrary code into it; `SIMCTL_CHILD_*` is simctl's own forwarding
 * prefix, so a caller key starting with it is a second hop to anything;
 * `__XPC_*` reaches launchd's children; `MallocStackLogging*` turns on
 * allocator tracing that writes to disk; `SIMBASE_*` belongs to the harness
 * and its in-app probe. On Android, the dynamic linker's `LD_PRELOAD` and
 * `LD_LIBRARY_PATH` are the same hazard. None of these configure the app
 * under test, so none are accepted.
 *
 * The check runs twice: at submit, so the caller hears about it at once, and
 * again just before the launch, so nothing that reaches a launch without
 * passing through submit (an NL agent's `launch` step, a future caller) can
 * skip it. A Simbase control plane in front of the daemon applies the same
 * rules, but the daemon does not rely on that.
 */

import type { PlatformId } from './device.js';

export const REFUSED_ENV_PREFIXES: readonly string[] = [
  'DYLD_', 'SIMCTL_CHILD_', 'SIMBASE_', '__XPC_', 'MallocStackLogging',
];

/** Refused on Android only: the dynamic linker's own knobs. */
export const REFUSED_ANDROID_ENV_KEYS: readonly string[] = ['LD_PRELOAD', 'LD_LIBRARY_PATH'];

export const MAX_LAUNCH_ARG_BYTES = 4096;

/** A launch option the harness will not pass on. */
export class UnsafeLaunchError extends Error {}

/**
 * Whether a key is refused. The prefixes compare case-insensitively: dyld
 * itself is case-sensitive, but a harness that refused `DYLD_` and let
 * `dyld_` through would be relying on that detail to stay true.
 */
export function isRefusedEnvKey(key: string, platform: PlatformId | undefined): boolean {
  const upper = key.toUpperCase();
  const refusedPrefix = REFUSED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()));
  const refusedOnAndroid = platform !== 'ios' && REFUSED_ANDROID_ENV_KEYS.includes(upper);

  return refusedPrefix || refusedOnAndroid;
}

/**
 * Throws unless `env` is an object of string values whose keys are plain
 * names. `where` names it in the message, e.g. "app.launchEnv".
 *
 * `platform` undefined means "not settled yet": then the Android keys are
 * refused too, because refusing them on iOS costs nothing.
 */
export function assertSafeLaunchEnv(env: unknown, where: string, platform?: PlatformId): void {
  if (env === undefined) return;

  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new UnsafeLaunchError(`${where} must be an object of string values`);
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      throw new UnsafeLaunchError(`${where}.${key} must be a string, got ${typeof value}`);
    }
    if (!key || key.includes('=') || key.includes('\0')) {
      throw new UnsafeLaunchError(`${where} has an invalid variable name ${JSON.stringify(key)}`);
    }
    if (value.includes('\0')) {
      throw new UnsafeLaunchError(`${where}.${key} contains a NUL byte`);
    }
    if (isRefusedEnvKey(key, platform)) {
      throw new UnsafeLaunchError(
        `${where}.${key} is not allowed: it reaches the loader or the test harness, not your app. Remove it.`);
    }
  }
}

/** Throws unless `args` is an array of strings under 4 KB with no NUL. */
export function assertSafeLaunchArgs(args: unknown, where: string): void {
  if (args === undefined) return;

  if (!Array.isArray(args)) {
    throw new UnsafeLaunchError(`${where} must be an array of strings`);
  }

  args.forEach((arg, index) => {
    const isPlainString = typeof arg === 'string' && !arg.includes('\0');
    if (!isPlainString || Buffer.byteLength(arg) >= MAX_LAUNCH_ARG_BYTES) {
      throw new UnsafeLaunchError(
        `${where}[${index}] is not allowed: arguments must be strings under 4 KB with no NUL bytes`);
    }
  });
}

/** The shape both `app` and each step share, read loosely: this runs on raw
 *  request bodies, before anything else has checked their types. */
interface LaunchOptionsCarrier {
  app?: { launchEnv?: unknown; launchArgs?: unknown };
  steps?: unknown[];
}

/**
 * Every launch option in a run request: `app.launchEnv`, `app.launchArgs`,
 * and the `env`/`args` of every `launch` and `relaunch` step.
 */
export function assertSafeLaunchOptions(request: LaunchOptionsCarrier, platform?: PlatformId): void {
  assertSafeLaunchEnv(request.app?.launchEnv, 'app.launchEnv', platform);
  assertSafeLaunchArgs(request.app?.launchArgs, 'app.launchArgs');

  (request.steps ?? []).forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;

    const step = raw as { action?: unknown; env?: unknown; args?: unknown };
    if (step.action !== 'launch' && step.action !== 'relaunch') return;

    assertSafeLaunchEnv(step.env, `steps[${index}].env`, platform);
    assertSafeLaunchArgs(step.args, `steps[${index}].args`);
  });
}
