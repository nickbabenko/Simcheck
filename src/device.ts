/**
 * The seam between the harness and a platform's tooling.
 *
 * Everything above this file -- the pool, the step executor, the runner, the
 * scheduler, the API -- is written against these interfaces and never names
 * `simctl`, `adb`, `xcodebuild` or `gradle`. A platform is three pieces: a
 * device backend (create, boot, install, launch), a UI driver (read the
 * screen, tap, type) and a build preparer (turn an AppSpec into something
 * installable). Multi-touch and native test runners are optional; where a
 * platform lacks one, the harness says so rather than silently doing nothing.
 */

import type { Screen } from './screen.js';
import type { AppSpec, GesturePreset, HardwareButton } from './types.js';
import type { ArtifactStore } from './artifacts.js';

export type PlatformId = 'ios' | 'android';

export const PLATFORMS: readonly PlatformId[] = ['ios', 'android'];

export const isPlatformId = (v: unknown): v is PlatformId =>
  typeof v === 'string' && (PLATFORMS as readonly string[]).includes(v);

/* --------------------------------------------------------------- devices -- */

/** A device type and runtime resolved to whatever ids the tooling wants. */
export interface DeviceTarget {
  /** Canonical device type, e.g. "iPhone 17 Pro" or "pixel_7". */
  deviceType: string;
  /** Canonical runtime label, e.g. "iOS 27.0" or "Android 15 (API 35)". */
  runtime: string;
  /** Opaque handles the backend passes back to itself at create time. */
  deviceTypeId: string;
  runtimeId: string;
}

/** A device that exists on this machine, whether or not the pool owns it. */
export interface ExistingDevice {
  /** Stable identity: a UDID on iOS, an AVD name on Android. */
  id: string;
  name: string;
  deviceType: string;
  runtime: string;
  booted: boolean;
  /** False for a device whose runtime or system image has gone missing. */
  available: boolean;
}

export interface LogStream { kill(): void }

/**
 * Device lifecycle and app lifecycle.
 *
 * Every method takes the *stable* id, never a transient handle. An Android
 * emulator's adb serial changes between boots, so the backend resolves the id
 * to a live serial itself; the pool persists only what survives a restart.
 */
export interface DeviceBackend {
  readonly platform: PlatformId;
  /** What to call one of these in a log line or an error: "simulator", "emulator". */
  readonly deviceNoun: string;
  /**
   * Peak disk a warm device costs, in GB. Used to decide whether creating one
   * would take the machine below its free-space floor.
   */
  readonly diskCostGb: number;

  /** Toolchain check. Returns a version string, or throws an install hint. */
  preflight(): Promise<string>;

  resolveTarget(deviceType: string, runtime: string): Promise<DeviceTarget>;
  create(name: string, target: DeviceTarget): Promise<string>;
  list(): Promise<ExistingDevice[]>;
  boot(id: string): Promise<void>;
  shutdown(id: string): Promise<void>;
  erase(id: string): Promise<void>;
  destroy(id: string): Promise<void>;

  install(id: string, appPath: string): Promise<void>;
  uninstall(id: string, appId: string): Promise<void>;
  isInstalled(id: string, appId: string): Promise<boolean>;
  /** Returns the app's pid, or 0 where the platform does not report one. */
  launch(id: string, app: LaunchTarget, args: string[], env: Record<string, string>): Promise<number>;
  terminate(id: string, appId: string): Promise<void>;
  openUrl(id: string, url: string): Promise<void>;
  setAppearance(id: string, mode: 'light' | 'dark'): Promise<void>;
  setPermission(id: string, grant: boolean, service: string, appId: string): Promise<void>;
  /** Return an app to its just-installed permission state. */
  resetPermissions(id: string, appId: string): Promise<void>;
  /** Fallback capture path -- the UI driver's own is preferred. */
  screenshot(id: string, outPath: string): Promise<void>;
  /** Best-effort capture of the app's own log output. Never fatal. */
  streamLog(id: string, app: LaunchTarget, outPath: string): LogStream | null;
}

/**
 * What the backend needs in order to start an app.
 *
 * iOS launches a bundle id; Android needs a component, and reads the app's
 * own log by process name. Carrying all three keeps `launch` one method.
 */
export interface LaunchTarget {
  /** Bundle id on iOS, package name on Android. */
  appId: string;
  /** Process name, for log filtering. */
  executable: string;
  /** Fully-qualified launchable activity. Android only. */
  activity?: string;
}

/* ------------------------------------------------------------- ui driver -- */

export interface TapSelector {
  id?: string;
  label?: string;
  value?: string;
  elementType?: string;
  x?: number;
  y?: number;
  waitTimeoutMs?: number;
}

export interface SwipeSpec {
  startX: number; startY: number; endX: number; endY: number; durationMs?: number;
}

/** Reads the screen and drives single-contact input. */
export interface UiDriver {
  describe(signal?: AbortSignal, cap?: number): Promise<Screen>;
  screenshot(outPath: string, signal?: AbortSignal): Promise<void>;
  tap(sel: TapSelector, signal?: AbortSignal): Promise<void>;
  type(text: string, signal?: AbortSignal): Promise<void>;
  clearText(signal?: AbortSignal): Promise<void>;
  pressEnter(signal?: AbortSignal): Promise<void>;
  swipe(a: SwipeSpec, signal?: AbortSignal): Promise<void>;
  gesture(
    preset: GesturePreset,
    screen: { width: number; height: number },
    durationMs?: number,
    signal?: AbortSignal,
  ): Promise<void>;
  button(button: HardwareButton, durationMs?: number, signal?: AbortSignal): Promise<void>;
  waitFor(sel: { id?: string; label?: string }, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
}

/**
 * Genuine two-contact input, which is what makes a gesture claim assertable
 * rather than perceptual. Optional: a platform without one fails the
 * multi-touch steps with an explanation instead of approximating them.
 */
export interface TouchDriver {
  pinch(a: {
    cx: number; cy: number; startSpread: number; endSpread: number;
    width: number; height: number; durationMs?: number;
  }, signal?: AbortSignal): Promise<void>;
  twoFingerPress(a: {
    x1: number; y1: number; x2: number; y2: number;
    width: number; height: number; holdMs: number;
  }, signal?: AbortSignal): Promise<void>;
  pan(a: {
    startX: number; startY: number; endX: number; endY: number;
    width: number; height: number; durationMs?: number;
  }, signal?: AbortSignal): Promise<void>;
  doubleTap(x: number, y: number, signal?: AbortSignal): Promise<void>;
}

/* ------------------------------------------------------------------ apps -- */

export interface PreparedApp {
  /** Absent when the app was already on the device. */
  appPath?: string;
  /** Bundle id on iOS, package name on Android. */
  bundleId: string;
  /** Process name, for the log stream. */
  executable: string;
  /** Launchable activity. Android only. */
  activity?: string;
  /** Absolute path, only when the harness ran the build itself. */
  buildLog?: string;
  /** True when we did not install it, and so must not uninstall it either. */
  preinstalled: boolean;
}

/* ---------------------------------------------------------- native tests -- */

export interface NativeTestCase {
  name: string;
  identifier: string;
  status: string;          // Passed | Failed | Skipped | ...
  durationSeconds?: number;
  failure?: string;
}

export interface NativeTestAttachment {
  /** Path relative to the run directory. */
  file: string;
  /** The name the test gave it, e.g. "after-pinch". */
  name: string;
  /** Which test produced it. */
  test?: string;
  associatedWithFailure: boolean;
}

export interface NativeTestOutcome {
  passed: boolean;
  total: number;
  failed: number;
  skipped: number;
  cases: NativeTestCase[];
  /** Screenshots and files the tests recorded themselves. */
  attachments: NativeTestAttachment[];
  summary: string;
  /** Build/run log written into the run directory, e.g. "xcodebuild.log". */
  logFile: string;
}

/* -------------------------------------------------------------- platform -- */

export interface PrepareAppContext {
  deviceId: string;
  runDir: string;
  artifacts?: ArtifactStore;
  signal?: AbortSignal;
}

export interface NativeTestContext {
  deviceId: string;
  runDir: string;
  signal?: AbortSignal;
}

/** Everything the harness needs in order to run against one platform. */
export interface PlatformSupport {
  readonly id: PlatformId;
  readonly devices: DeviceBackend;
  /** Driver bound to one device. Cheap to construct; make one per run. */
  ui(deviceId: string): UiDriver;
  /** Multi-touch driver, or undefined when this platform has none available. */
  touch(deviceId: string): TouchDriver | undefined;
  prepareApp(spec: AppSpec, ctx: PrepareAppContext): Promise<PreparedApp>;
  /**
   * Run the app's own test bundle -- XCUITest on iOS, instrumentation on
   * Android. Undefined where the run request carries no spec for it.
   */
  runNativeTests(spec: unknown, ctx: NativeTestContext): Promise<NativeTestOutcome>;
}
