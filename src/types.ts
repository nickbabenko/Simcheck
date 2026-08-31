/** Shared vocabulary for the harness. Kept dependency-free so the MCP server,
 *  the CLI and the daemon can all import it without pulling in the runtime. */

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
 *  - `path`: a prebuilt simulator .app (or a zip of one)
 *  - `scheme` + `project`/`workspace`: build it from source
 *  - `bundleId` alone: an app already installed on the pooled simulators
 *  - `artifactId`: a .app previously uploaded to POST /v1/artifacts
 *  - `url`: a zipped simulator .app the daemon downloads itself
 */
export interface AppSpec {
  /** Id returned by an artifact upload. The safest option for a remote
   *  caller, since it names no path on this machine. */
  artifactId?: string;
  /** https URL of a .zip containing a simulator .app. The daemon fetches it,
   *  which is how a caller that cannot upload a binary (an MCP client passing
   *  JSON, say) supplies a build from CI. */
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
  /** A prebuilt simulator .app bundle, or a .zip containing one. */
  path?: string;
  /** Build from source instead. */
  project?: string;    // .xcodeproj
  workspace?: string;  // .xcworkspace
  scheme?: string;
  configuration?: string;  // default: Debug
  /** Read from the built Info.plist when omitted. On its own -- with no
   *  `path` and no `scheme` -- it means "already installed, just launch it". */
  bundleId?: string;
  launchArgs?: string[];
  launchEnv?: Record<string, string>;
}

export interface DeviceRequest {
  /** Device type, e.g. "iPhone 17 Pro". Defaults to the pool's device type. */
  name?: string;
  /** Runtime, e.g. "iOS 27.0". Defaults to the pool's runtime. */
  runtime?: string;
  /** Lease a specific pooled device by UDID. */
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

export type HardwareButton = 'home' | 'lock' | 'side-button' | 'siri' | 'apple-pay';

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

export interface RunRequest {
  /** Optional only for an `xctest` run, where xcodebuild installs the app. */
  app: AppSpec;
  /** Natural-language scenario. Mutually exclusive with `steps`. */
  scenario?: string;
  /** Explicit deterministic steps. Mutually exclusive with `scenario`. */
  steps?: Step[];
  /** Run an XCUITest bundle instead of driving the UI from outside. */
  xctest?: XcTestSpec;
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

export interface Run {
  id: string;
  status: RunStatus;
  request: RunRequest;
  mode: 'steps' | 'scenario' | 'xctest';
  createdAt: string;
  /** Which token submitted this, for auditing and per-token limits. */
  submittedBy?: { tokenId: string; tokenName: string };
  startedAt?: string;
  finishedAt?: string;
  queuePositionAtSubmit: number;
  device?: { udid: string; name: string; runtime: string };
  bundleId?: string;
  appPath?: string;
  /** The steps actually executed -- replayable verbatim as a `steps` run. */
  executedSteps: Step[];
  screenshots: Screenshot[];
  trace: TraceEntry[];
  verdict?: { pass: boolean; summary: string; evidence?: string };
  error?: string;
  actionsUsed?: number;
  /** Structured XCUITest results, when mode is 'xctest'. */
  tests?: {
    total: number; failed: number; skipped: number;
    cases: { name: string; status: string; failure?: string; durationSeconds?: number }[];
  };
  /** Relative paths inside the run directory. */
  artifacts: { report?: string; appLog?: string; buildLog?: string; xcodebuildLog?: string };
}

export interface PooledDevice {
  udid: string;
  name: string;         // simulator name, e.g. "sim-harness-01"
  deviceType: string;   // e.g. "iPhone 17 Pro"
  runtime: string;      // e.g. "iOS 27.0"
  status: DeviceStatus;
  currentRunId?: string;
  addedAt: string;
  readyAt?: string;
  lastError?: string;
  /** true if the harness created it (and may therefore delete it). */
  managed: boolean;
}
