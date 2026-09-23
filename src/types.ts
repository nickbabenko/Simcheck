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
  /** Like wait_for, but a miss is a verdict on the app (the run fails) rather
   *  than a harness error. Put one straight after an `open_url` so a deep link
   *  that did not land fails the run instead of passing it silently. */
  | { action: 'assert'; id?: string; label?: string; timeoutMs?: number; note?: string }
  | { action: 'screenshot'; name: string; note?: string }
  /** `via: "app"` hands the URL to the app through the probe (no system
   *  consent sheet); `"simctl"` is the system path. Default: app when the
   *  probe is attached, simctl otherwise. */
  | { action: 'open_url'; url: string; via?: 'app' | 'simctl' }
  | { action: 'appearance'; mode: 'light' | 'dark' }
  | { action: 'permission'; service: string; grant: boolean }
  | { action: 'describe_ui' }
  /** Probe only: block until the app reports itself settled. A timeout is an
   *  error: the caller asked for idleness explicitly. */
  | { action: 'wait_idle'; timeoutMs?: number; quietMs?: number }
  /** Probe only: a completed request matching `urlPattern` (a glob, `*` =
   *  any run of characters, matched against the redacted URL), and `method`
   *  / `status` when given. A miss fails the run, like `assert`. */
  | { action: 'assert_request'; urlPattern: string; method?: string; status?: number; timeoutMs?: number; note?: string };

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
   *  `erase` is a full factory reset and costs ~30s. `relaunch` keeps the app
   *  installed so the next `relaunch` run of the same build, for the same
   *  tenant, skips the install entirely -- opt-in, because such a run starts
   *  from whatever state the app persisted (container, defaults, keychain,
   *  permission grants), not from a fresh install. A run that ends in
   *  error/timeout/cancelled is always downgraded to `uninstall`. */
  resetPolicy?: ResetPolicy;
  /** Who this run is for, when one token submits on behalf of several
   *  customers (a fleet runner). Namespaced under the submitting token, so it
   *  can never name another token's tenant. A device that last ran another
   *  tenant's build is erased before this run installs anything: iOS keeps
   *  permission grants, keychain items and the pasteboard past an uninstall. */
  tenant?: string;
  /** Record the screen from just after install to just before the reset,
   *  and attach `video.mp4` and a `preview.gif` to the run. Off by default.
   *  Best-effort: a recording that fails is a trace note, not a failed run. */
  record?: boolean;
  /** iOS simulator only: attach the in-app probe for settle detection,
   *  network and console evidence. Off by default. The probe never fails a
   *  run: when it cannot attach, the run uses fixed waits and says so. */
  probe?: boolean;
  /** With `probe`: how long one settle may wait before the step moves on
   *  anyway. Default 10s. */
  settleTimeoutMs?: number;
  /** Who may read the probe's network.json / console.log. Private (the
   *  submitting token only) unless set to 'public'. */
  evidence?: { network?: 'private' | 'public' };
  /** Safety valve on the NL agent loop. */
  maxActions?: number;
  label?: string;
  metadata?: Record<string, unknown>;
}

export type ResetPolicy = 'uninstall' | 'erase' | 'relaunch';
export const RESET_POLICIES: readonly ResetPolicy[] = ['uninstall', 'erase', 'relaunch'];

/**
 * Per-phase wall time for one run, in milliseconds, measured with a monotonic
 * clock. Field names match the Simbase wire contract (`Timings`). A phase that
 * is absent was never reached. Phases do not overlap, so everything from
 * prepare to reset sums to (roughly) `occupancyMs`.
 */
export interface RunTimings {
  /** Submit -> device leased (startedAt - createdAt). Includes any cold
   *  provision the scheduler had to do first. */
  queueMs?: number;
  /** Fetch / unpack / build the app. Near zero for an uploaded artifact. */
  prepareMs?: number;
  /** Erase before install, because the device last held another tenant's
   *  build or came back from a crash with unknown contents. Billed to the run
   *  that caused it. Not part of the Simbase contract; additive. */
  preResetMs?: number;
  /** Uninstall + install, or the cache check alone on a warm hit. */
  installMs?: number;
  /** First launch plus its settle time. */
  launchMs?: number;
  /** The steps / scenario (mid-run screenshots included). */
  stepsMs?: number;
  /** A native test suite (xctest / instrumentation). Additive. */
  nativeTestMs?: number;
  /** The final-state capture. */
  screenshotMs?: number;
  /** Returning the device to the pool, after finishedAt. */
  resetMs?: number;
  /** Device time this run cost: (finishedAt - startedAt) + reset. The number
   *  a device-minute bills. */
  occupancyMs?: number;
  /** Submit -> device released: queue + occupancy. */
  totalMs?: number;
  /** Converting a recording into video.mp4 and preview.gif. Runs after the
   *  device is back in the pool, so it is in neither occupancy nor total. */
  recordMs?: number;
  /** Fixed sleeps avoided by probe settling: the sum over probe-settled
   *  steps of (the fixed wait it replaced - what it actually waited). Can be
   *  negative, when an app took longer to settle than the sleep allowed. */
  settleSavedMs?: number;
}

export type PhaseKey = 'prepareMs' | 'preResetMs' | 'installMs' | 'launchMs' | 'stepsMs'
  | 'nativeTestMs' | 'screenshotMs' | 'resetMs';

export interface TraceEntry {
  at: string;
  kind: 'step' | 'thought' | 'note' | 'error' | 'screenshot';
  text: string;
  step?: Step;
  screenshot?: string;
  durationMs?: number;
  ok?: boolean;
  /** How the step waited for the app afterwards (probe runs only). */
  settle?: StepSettle;
}

/** One step's wait for the app to settle. */
export interface StepSettle {
  /** 'probe' when the app said it had settled (or timed out saying why);
   *  'sleep' for the fixed wait used without one. */
  via: 'probe' | 'sleep';
  waitedMs: number;
  /** The fixed wait this replaced. */
  fallbackMs: number;
  settled?: boolean;
  settledAtMs?: number | null;
  /** What was still busy when a settle timed out. */
  busy?: string[];
  /** A system sheet or alert AXe saw after the settle, which the probe
   *  cannot see. */
  systemUi?: string;
  probeError?: string;
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
  artifacts: {
    report?: string; appLog?: string; buildLog?: string; testLog?: string;
    /** `video.mp4` and `preview.gif`, relative to the run directory, when
     *  the run asked to be recorded and the recording survived. */
    video?: string; preview?: string;
    /** Probe evidence: `network.json` and `console.log`. Private to the
     *  submitting token unless the run set `evidence.network: 'public'`. */
    networkLog?: string; consoleLog?: string;
  };
  /** Per-phase timings, filled in as the run progresses. `resetMs`,
   *  `occupancyMs` and `totalMs` land after the run is terminal, once the
   *  device has been reset -- wait for `releasedAt` (or use
   *  `/wait?settled=true`) before reading them. */
  timings?: RunTimings;
  /** Phases that were cut short by an error, cancel or timeout: their
   *  timing is real but a lower bound. */
  timingsIncomplete?: PhaseKey[];
  /** When the device was handed back to the pool. Absent until then, and on
   *  a run that never held a device. */
  releasedAt?: string;
  /** What the warm-app cache did for this run. */
  warm?: {
    /** True when the install was skipped because the device already held
     *  this exact build for this tenant. */
    cacheHit: boolean;
    /** Why it did or did not hit, in words. */
    reason: string;
    /** The device was erased first (tenant change, or unknown contents). */
    erased?: boolean;
    resetPolicyRequested?: ResetPolicy;
    /** Differs from requested when a dirty run was downgraded. */
    resetPolicyUsed?: ResetPolicy;
  };
}

/** Terminal, and the device (if any) is back in the pool -- so the timings
 *  are final. */
export const isSettled = (run: Pick<Run, 'status' | 'startedAt' | 'releasedAt'>): boolean =>
  isTerminal(run.status) && (!run.startedAt || Boolean(run.releasedAt));

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
  /** The build the harness left installed on this device (resetPolicy
   *  `relaunch`), so an identical run can skip the install. Only ever a
   *  cache: the device is checked before it is trusted. */
  installed?: {
    bundleId: string;
    /** Content hash of the build: the artifact id for uploaded/fetched
     *  builds, the zip digest for a local zip. */
    appHash: string;
    tenant?: string;
    installedAt: string;
  };
  /** Whose build last ran on this device since it was last erased. A run for
   *  a different tenant erases the device before installing. */
  tenant?: string;
  /** The device came back from a daemon crash mid-run: what is on it is
   *  unknown, so the next run that installs anything erases it first. */
  dirty?: boolean;
}
