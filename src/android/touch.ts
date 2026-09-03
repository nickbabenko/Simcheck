import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TouchDriver } from '../device.js';
import type { Config } from '../config.js';
import { logger } from '../log.js';
import type { Adb } from './adb.js';
import { findApk } from './gradle.js';
import { parseInstrumentation } from './instrument.js';

const log = logger('android-touch');

export const DRIVER_PACKAGE = 'com.simcheck.driver';
export const DRIVER_TEST_PACKAGE = 'com.simcheck.driver.test';
const RUNNER = 'androidx.test.runner.AndroidJUnitRunner';

export interface DriverApks {
  app: string;
  test: string;
}

/**
 * Locate the built multi-touch driver.
 *
 * The driver is a UiAutomator instrumentation that ships in this repo and is
 * built once (`driver/build.sh`). It is optional in exactly the way baguette
 * is on iOS: without it the multi-touch steps fail with an explanation, and
 * everything else works.
 */
export function resolveDriverApks(cfg: Config): DriverApks | null {
  const roots = [
    cfg.androidDriverDir,
    // The daemon runs out of dist/, so the driver sits one level up from it.
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'driver'),
  ].filter(Boolean) as string[];

  for (const root of roots) {
    const outputs = path.join(root, 'build', 'outputs', 'apk');
    const app = findApk(path.join(outputs, 'debug'));
    const test = findApk(path.join(outputs, 'androidTest', 'debug'));
    if (app && test) return { app, test };
  }
  return null;
}

export const driverMissingMessage = (): string =>
  'multi-touch on Android needs the simcheck driver APK, which has not been built. ' +
  'Build it once with: ./driver/build.sh (needs a JDK and Gradle). ' +
  '`adb shell input` drives a single pointer, so pinch, two-finger pan and a real double tap ' +
  'cannot be performed without it -- or assert the gesture from an instrumentation test instead.';

/** Install the driver onto a device, if it is not already there. */
export async function installDriver(adb: Adb, serial: string, apks: DriverApks): Promise<void> {
  const installed = await adb.shellTry(serial, `pm list packages ${DRIVER_TEST_PACKAGE}`, { timeoutMs: 30_000 });
  if (installed.out.includes(`package:${DRIVER_TEST_PACKAGE}`)) return;

  for (const apk of [apks.app, apks.test]) {
    // -t permits a test-only package, which the androidTest APK always is.
    const r = await adb.rawTry(serial, ['install', '-r', '-t', apk], { timeoutMs: 300_000 });
    const out = r.stdout + r.stderr;
    if (r.code !== 0 || /Failure|INSTALL_FAILED/i.test(out)) {
      throw new Error(`installing the multi-touch driver (${path.basename(apk)}) failed: ${out.trim().slice(0, 400)}`);
    }
  }
  log.info(`installed the multi-touch driver on ${serial}`);
}

/**
 * Multi-touch through the driver APK.
 *
 * One `am instrument` call per gesture. That costs a process launch -- on the
 * order of a second -- which is acceptable for a step and is the price of
 * having genuine multiple contacts at all: nothing in `adb shell input` can
 * express two fingers.
 */
export class UiAutomatorTouch implements TouchDriver {
  constructor(private adb: Adb, private avd: string, private apks: DriverApks) {}

  private async run(
    action: string, params: Record<string, number>, signal?: AbortSignal,
  ): Promise<void> {
    const serial = await this.adb.serialFor(this.avd);
    await installDriver(this.adb, serial, this.apks);

    const args = ['shell', 'am', 'instrument', '-w', '-r', '-e', 'action', action];
    for (const [k, v] of Object.entries(params)) {
      if (!Number.isFinite(v)) throw new Error(`multi-touch ${action}: "${k}" is not a finite number`);
      args.push('-e', k, String(Math.round(v * 100) / 100));
    }
    args.push(`${DRIVER_TEST_PACKAGE}/${RUNNER}`);

    const r = await this.adb.rawTry(serial, args, { timeoutMs: 120_000, ...(signal ? { signal } : {}) });
    const output = r.stdout + r.stderr;

    if (/INSTRUMENTATION_FAILED/.test(output)) {
      throw new Error(
        `the multi-touch driver did not run: ${output.split('\n').find((l) => /FAILED|Error/.test(l))?.trim().slice(0, 300)}. ` +
        'Rebuild it with ./driver/build.sh');
    }
    // The driver asserts nothing about the app, so any failure it reports is a
    // failure to perform the gesture -- which must not pass silently.
    const failure = parseInstrumentation(output)
      .find((e) => e.code === -1 || e.code === -2);
    if (failure) {
      const stack = (failure.fields['stack'] ?? '').trim();
      throw new Error(`multi-touch ${action} failed on the device: ${stack.split('\n')[0] ?? 'no detail'}`);
    }
  }

  async pinch(a: {
    cx: number; cy: number; startSpread: number; endSpread: number;
    width: number; height: number; durationMs?: number;
  }, signal?: AbortSignal): Promise<void> {
    await this.run('pinch', {
      cx: a.cx, cy: a.cy,
      startSpread: a.startSpread, endSpread: a.endSpread,
      durationMs: a.durationMs ?? 600,
    }, signal);
  }

  async twoFingerPress(a: {
    x1: number; y1: number; x2: number; y2: number;
    width: number; height: number; holdMs: number;
  }, signal?: AbortSignal): Promise<void> {
    // The harness expresses this as two absolute contacts; the driver takes a
    // centre and a gap, which is the same thing said once rather than twice.
    await this.run('two_finger_press', {
      cx: (a.x1 + a.x2) / 2,
      cy: (a.y1 + a.y2) / 2,
      gap: Math.abs(a.x2 - a.x1),
      holdMs: a.holdMs,
    }, signal);
  }

  async pan(a: {
    startX: number; startY: number; endX: number; endY: number;
    width: number; height: number; durationMs?: number;
  }, signal?: AbortSignal): Promise<void> {
    await this.run('pan', {
      startX: a.startX, startY: a.startY,
      endX: a.endX, endY: a.endY,
      durationMs: a.durationMs ?? 600,
    }, signal);
  }

  async doubleTap(x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.run('double_tap', { x, y }, signal);
  }
}
