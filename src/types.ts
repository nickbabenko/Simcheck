/** Shared vocabulary for the harness. Kept dependency-free so the MCP server,
 *  the CLI and the daemon can all import it without pulling in the runtime. */

import type { PlatformId } from './device.js';

export type DeviceStatus =
  | 'pending'    // in the pool, not yet booted -- waiting to be picked up
  | 'booting'
  | 'ready'      // pre-booted and idle, available to lease
  | 'leased'     // currently running a job
  | 'recycling'  // job finished, being reset back to a clean state
  | 'offline';   // boot or reset failed; excluded from scheduling

export type RunStatus =
  | 'pending'    // queued, no device yet
  | 'preparing'  // device leased; building / installing
  | 'running'    // scenario executing
  | 'passed'
  | 'failed'     // scenario ran, assertion did not hold
  | 'error'      // harness/build/install blew up -- not a verdict on the app
  | 'cancelled'
  | 'timeout';

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'passed', 'failed', 'error', 'cancelled', 'timeout',
];

export const isTerminal = (s: RunStatus): boolean => TERMINAL_STATUSES.includes(s);

/**
 * Which build to test. Give exactly one of:
 *  - `path`: a prebuilt simulator .app / emulator .apk (or a zip of one)
 *  - `scheme` + `project`/`workspace` (iOS) or `project` + `module` (Android):
 *    build it from source
 *  - `bundleId` alone: an app already installed on the pooled devices
 *  - `artifactId`: a build previously uploaded to POST /v1/artifacts
 *  - `url`: a zipped .app, or a bare .apk, the daemon downloads itself
 */
export interface AppSpec {
  /** Id returned by an artifact upload. The safest option for a remote
   *  caller, since it names no path on this machine. */
  artifactId?: string;
  /** https URL of a .zip containing a simulator .app, or an .apk. The daemon
   *  fetches it, which is how a caller that cannot upload a binary (an MCP
   *  client passing JSON, say) supplies a build from CI. */
  url?: string;
  /** Headers for that fetch. Prefer `buildCredentials` in the daemon config:
   *  then the caller never handles the secret. Never logged or persisted. */
  urlHeaders?: Record<string, string>;
  /** Fetch the newest matching GitHub Actions artifact. The daemon resolves it
   *  with its own stored credentials, so no token passes through the caller. */
  github?: {
    /** "owner/repo" */
    repo: string;
    /** Artifact name, as given to actions/upload-artifact. */
    artifact?: string;
    /** Restrict to one workflow run. */
    runId?: number;
    /** Restrict to artifacts built from this branch. */
    branch?: string;
  };
  /** A prebuilt simulator .app bundle or an .apk, or a .zip containing one. */
  path?: string;
  /** Build from source instead. On iOS an .xcodeproj; on Android the Gradle
   *  project directory (the one holding gradlew). */
  project?: string;
  /** iOS only: an .xcworkspace. */
  workspace?: string;
  /** iOS only: the scheme to build. */
  scheme?: string;
  /** iOS only: build configuration. Default: Debug. */
  configuration?: string;
  /** Android only: Gradle module. Default ":app". */
  module?: string;
  /** Android only: build variant. Default "debug". */
  variant?: string;
  /** Read from the built Info.plist / manifest when omitted. On its own --
   *  with no `path` and no source -- it means "already installed, just
   *  launch it". Bundle id on iOS, package name on Android. */
  bundleId?: string;
  /** iOS only: arguments passed to the app process on launch. */
  launchArgs?: string[];
  /** Environment variables on iOS; string intent extras on Android. */
  launchEnv?: Record<string, string>;
}

export interface DeviceRequest {
  /** Which platform to run on. Inferred from the app when omitted -- an .apk
   *  means Android -- and otherwise falls back to the daemon default. */
  platform?: PlatformId;
  /** Device type, e.g. "iPhone 17 Pro" or "pixel_7". Defaults to the pool's. */
  name?: string;
  /** Runtime, e.g. "iOS 27.0" or "android-35". Defaults to the pool's. */
  runtime?: string;
  /** Lease a specific pooled device by its stable id. */
  udid?: string;
}

/* ------------------------------------------------------------------ steps -- */

/** A single deterministic action. The agent emits these too, so an NL run
 *  always produces a replayable step list. */
export type Step =
  | { action: 'launch'; args?: string[]; env?: Record<string, string> }
  | { action: 'terminate' }
  | { action: 'relaunch' }
  | { action: 'tap'; id?: string; label?: string; value?: string; elementType?: string; x?: number; y?: number; waitTimeoutMs?: number; note?: string }
  | { action: 'type'; text: string; note?: string }
  | { action: 'clear_text' }
  | { action: 'press_enter' }
  | { action: 'swipe'; startX: number; startY: number; endX: number; endY: number; durationMs?: number }
  | { action: 'gesture'; preset: GesturePreset; durationMs?: number }
  | { action: 'pinch'; cx?: number; cy?: number; scale?: number; startSpread?: number; endSpread?: number; durationMs?: number; note?: string }
  | { action: 'pan'; startX: number; startY: number; endX: number; endY: number; durationMs?: number }
  | { action: 'two_finger_press'; cx?: number; cy?: number; gap?: number; holdMs?: number; note?: string }
  | { action: 'double_tap'; x?: number; y?: number; id?: string; label?: string }
  | { action: 'button'; button: HardwareButton; durationMs?: number }
  | { action: 'wait'; ms: number; note?: string }
  | { action: 'wait_for'; id?: string; label?: string; timeoutMs?: number }
  | { action: 'screenshot'; name: string; note?: string }
  | { action: 'open_url'; url: string }
  | { action: 'appearance'; mode: 'light' | 'dark' }
  | { action: 'permission'; service: string; grant: boolean }
  | { action: 'describe_ui' };

export type GesturePreset =
  | 'scroll-up' | 'scroll-down' | 'scroll-left' | 'scroll-right'
  | 'swipe-from-left-edge' | 'swipe-from-right-edge'
  | 'swipe-from-top-edge' | 'swipe-from-bottom-edge';

/**
 * Hardware buttons, across both platforms. A driver rejects one its own
 * platform does not have rather than pressing something else -- `siri` on an
 * emulator is a mistake worth surfacing, not silently ignoring.
 */
export type HardwareButton =
  // iOS
  | 'home' | 'lock' | 'side-button' | 'siri' | 'apple-pay'
  // Android
  | 'back' | 'recents' | 'power' | 'volume-up' | 'volume-down' | 'menu';

export const IOS_BUTTONS: readonly HardwareButton[] = ['home', 'lock', 'side-button', 'siri', 'apple-pay'];
export const ANDROID_BUTTONS: readonly HardwareButton[] = ['home', 'back', 'recents', 'power', 'volume-up', 'volume-down', 'menu'];

/* ------------------------------------------------------------------- runs -- */

/** An XCUITest bundle to run, for assertions the screen cannot settle. */
export interface XcTestSpec {
  /** A pre-built .xctestrun. Works even where the project cannot be compiled. */
  xctestrun?: string;
  /** Or build from source: */
  project?: string;
  workspace?: string;
  scheme?: string;
  configuration?: string;
  testPlan?: string;
  /** -only-testing / -skip-testing, e.g. "AppUITests/PinchTests/testZoom". */
  only?: string[];
  skip?: string[];
  timeoutMs?: number;
}

/** An Android instrumentation suite -- the Android answer to XCUITest. */
export interface InstrumentationSpec {
  /** Pre-built APKs, so nothing is compiled here. Both are required together:
   *  the test APK instruments the app APK, and needs it installed. */
  testApk?: string;
  appApk?: string;
  /** Or build from source: the Gradle project directory (holding gradlew). */
  project?: string;
  /** Gradle module. Default ":app". */
  module?: string;
  /** Build variant. Default "debug". */
  variant?: string;
  /** Instrumentation runner. Read from the test APK's manifest when omitted. */
  runner?: string;
  /** -e class filters, e.g. "com.example.PinchTest#testZoom". */
  only?: string[];
  /** -e notClass filters. */
  skip?: string[];
  timeoutMs?: number;
}

export interface RunRequest {
  /** Optional only for a native-test run, where the build system installs
   *  the app itself. */
  app: AppSpec;
  /** Natural-language scenario. Mutually exclusive with `steps`. */
  scenario?: string;
  /** Explicit deterministic steps. Mutually exclusive with `scenario`. */
  steps?: Step[];
  /** iOS: run an XCUITest bundle instead of driving the UI from outside. */
  xctest?: XcTestSpec;
  /** Android: run an instrumentation suite instead of driving the UI. */
  instrumentation?: InstrumentationSpec;
  /** Screenshot names the caller expects back. In NL mode these are the
   *  agent's checklist; in step mode they are validated against the steps. */
  screenshots?: string[];
  /** NL success criteria, evaluated from the final UI + screenshots. */
  assert?: string;
  device?: DeviceRequest;
  timeoutMs?: number;
  /** How to return the device to the pool. `uninstall` is fast (default);
   *  `erase` is a full factory reset and costs ~30s. */
  resetPolicy?: 'uninstall' | 'erase';
  /** Safety valve on the NL agent loop. */
  maxActions?: number;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface TraceEntry {
  at: string;
  kind: 'step' | 'thought' | 'note' | 'error' | 'screenshot';
  text: string;
  step?: Step;
  screenshot?: string;
  durationMs?: number;
  ok?: boolean;
}

export interface Screenshot {
  name: string;
  file: string;      // relative to the run dir
  at: string;
  note?: string;
}

/** How the run drove the device. The two native-test modes are named
 *  separately because the reader wants to know which suite actually ran. */
export type RunMode = 'steps' | 'scenario' | 'xctest' | 'instrumentation';

/** Modes where the platform's own test runner installs and drives the app. */
export const isNativeTestMode = (m: RunMode): boolean => m === 'xctest' || m === 'instrumentation';

export interface Run {
  id: string;
  status: RunStatus;
  request: RunRequest;
  mode: RunMode;
  createdAt: string;
  /** Which token submitted this, for auditing and per-token limits. */
  submittedBy?: { tokenId: string; tokenName: string };
  startedAt?: string;
  finishedAt?: string;
  queuePositionAtSubmit: number;
  device?: { udid: string; name: string; runtime: string; platform: PlatformId };
  /** Bundle id on iOS, package name on Android. */
  bundleId?: string;
  appPath?: string;
  /** The steps actually executed -- replayable verbatim as a `steps` run. */
  executedSteps: Step[];
  screenshots: Screenshot[];
  trace: TraceEntry[];
  verdict?: { pass: boolean; summary: string; evidence?: string };
  error?: string;
  actionsUsed?: number;
  /** Structured results, when the mode ran a native test suite. */
  tests?: {
    total: number; failed: number; skipped: number;
    cases: { name: string; status: string; failure?: string; durationSeconds?: number }[];
  };
  /** Relative paths inside the run directory. */
  artifacts: { report?: string; appLog?: string; buildLog?: string; testLog?: string };
}

export interface PooledDevice {
  /** Stable identity: a simulator UDID on iOS, an AVD name on Android. */
  udid: string;
  platform: PlatformId;
  name: string;         // pool name, e.g. "simcheck-01"
  deviceType: string;   // e.g. "iPhone 17 Pro" / "pixel_7"
  runtime: string;      // e.g. "iOS 27.0" / "Android 15 (API 35)"
  status: DeviceStatus;
  currentRunId?: string;
  addedAt: string;
  readyAt?: string;
  lastError?: string;
  /** true if the harness created it (and may therefore delete it). */
  managed: boolean;
}
