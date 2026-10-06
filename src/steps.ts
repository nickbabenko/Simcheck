import fs from 'node:fs';
import path from 'node:path';
import type { AssertionResult, Step, StepOf, StepSettle } from './types.js';
import type { Store } from './store.js';
import type { DeviceBackend, LaunchTarget, TouchDriver, UiDriver } from './device.js';
import { renderScreen, type Screen, type UiElement } from './screen.js';
import { sleep, slug, nowIso } from './util.js';
import { logger } from './log.js';
import { acceptOpenIn, findOpenInSheet } from './ios/consent.js';
import type { ProbeSession } from './ios/probe-session.js';
import { globMatches, type ProbeNetworkRequest } from './ios/probe.js';
import { assertSafeLaunchArgs, assertSafeLaunchEnv } from './launchguard.js';
import { MAX_ASSERTIONS, PROBE_ACTIONS, STEP_KEYS as WIRE_STEP_KEYS, stepProblem } from './wire/steps.js';

const log = logger('steps');

export interface ExecutorContext {
  runId: string;
  udid: string;
  /** What to launch, and what to call it in the log stream. */
  app: LaunchTarget;
  runDir: string;
  launchArgs: string[];
  launchEnv: Record<string, string>;
  signal: AbortSignal;
  /** The in-app probe, when the run asked for one (iOS). Null when it was
   *  asked for but is unavailable, so the trace still records how each step
   *  waited. Absent when the run never asked. */
  probe?: ProbeSession | null;
  /** How long one settle may wait. Default 10s. */
  settleTimeoutMs?: number;
}

/** docs/23 §3.1: bounded, and never worse than a fixed sleep. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

/** Steps that can raise system UI the probe cannot see: after these, one AXe
 *  read looks for a SpringBoard sheet. The others almost never raise one, and
 *  skipping the 200-350ms read there keeps most of the win. */
const SYSTEM_UI_CHECK = new Set(['launch', 'relaunch', 'open_url', 'button', 'tap', 'permission']);

/** Steps that only mean anything with the probe attached. */
export const PROBE_STEPS: readonly string[] = PROBE_ACTIONS;

/** Told to the caller when a multi-touch step has no driver behind it. */
export const noTouchDriver = (platform: string): string =>
  platform === 'ios'
    ? 'multi-touch needs the "baguette" CLI, which is not on PATH. Install it with: brew install baguette' +
      ' (Apple Silicon, Xcode 26+). AXe drives a single contact only, so pinch and two-finger pan are not possible without it.'
    : `multi-touch is not available on ${platform}. \`adb shell input\` drives one pointer only, so pinch, ` +
      'two-finger pan and a real double tap cannot be expressed through it. Assert the gesture from inside ' +
      'the app with an instrumentation test instead, which has genuine multi-touch.';

/** An `assert` step whose element never appeared: a verdict on the app, so
 *  the run fails rather than errors. */
export class AssertionFailed extends Error {}

/**
 * Executes one `Step` against a leased simulator, recording it into the run so
 * that a natural-language scenario ends up with a replayable step list.
 */
export class StepExecutor {
  private lastScreen: Screen | null = null;
  /** How long `open_url` watches for iOS's "Open in …?" consent sheet. It is
   *  also the settle time when none appears. Tests shorten it. */
  consentWindowMs = 2000;
  /** Sum over probe-settled steps of (fixed wait - actual wait). */
  settleSavedMs = 0;
  /** How the step in flight settled, attached to its trace line. */
  private pendingSettle: StepSettle | undefined;
  /** When each executed step started (wall ms), to tag network requests. */
  private stepStarts: number[] = [];
  /** The app's pid from the last launch, for crash attribution. */
  private appPid = 0;
  private crashNoted = false;
  private assertionCapNoted = false;

  constructor(
    private ui: UiDriver,
    private devices: DeviceBackend,
    private store: Store,
    private ctx: ExecutorContext,
    /** Required, though it may be undefined: an optional parameter let a
     *  missing argument compile, and the driver silently never arrived. */
    private touch: TouchDriver | undefined,
  ) {}

  /** Multi-touch driver, or a clear explanation of why it is unavailable. */
  private requireTouch(): TouchDriver {
    if (!this.touch) throw new Error(noTouchDriver(this.devices.platform));
    return this.touch;
  }

  /** Screen size in points, needed to scale a multi-touch gesture. */
  private async screenSize(): Promise<{ width: number; height: number }> {
    const screen = this.lastScreen ?? await this.refresh();
    if (!screen.width || !screen.height) throw new Error('could not read the screen size for a gesture');
    return { width: screen.width, height: screen.height };
  }

  get screen(): Screen | null { return this.lastScreen; }

  async refresh(): Promise<Screen> {
    this.lastScreen = await this.ui.describe(this.ctx.signal);
    return this.lastScreen;
  }

  async run(step: Step): Promise<void> {
    const started = Date.now();
    this.stepStarts.push(started);
    this.pendingSettle = undefined;
    try {
      const detail = await this.dispatch(step);
      this.record(step, true, Date.now() - started, undefined, detail ?? undefined);
    } catch (e) {
      this.record(step, false, Date.now() - started, (e as Error).message);
      throw e;
    } finally {
      await this.afterStep();
    }
  }

  /** The probe attached and answering, or null. */
  private get probe(): ProbeSession | null {
    return this.ctx.probe?.attached ? this.ctx.probe : null;
  }

  /** Index of the step that was running at `at` (wall ms), or null. */
  private stepAt = (at: number): number | null => {
    let index: number | null = null;
    this.stepStarts.forEach((startedAt, i) => { if (startedAt <= at) index = i; });
    return index;
  };

  /**
   * Between steps, with a probe: pull its evidence, and notice an app that
   * died with the probe inside it. A crash with the probe injected is the
   * customer's crash (docs/23 §6), but the reader deserves the hint.
   */
  private async afterStep(): Promise<void> {
    const probe = this.probe;
    if (!probe) return;

    await probe.pullEvidence(this.stepAt);

    if (this.appPid && !this.crashNoted && !isAlive(this.appPid)) {
      this.crashNoted = true;
      probe.detach(`the app (pid ${this.appPid}) is no longer running`);
      this.store.trace(this.ctx.runId, {
        kind: 'note',
        text: `the app process (pid ${this.appPid}) exited while the probe was attached. A crash with the probe ` +
          'injected counts as the app\'s own; re-run with probe: false to rule the probe out.',
      });
    }
  }

  /** Last evidence pull, and forget the token. Never throws. */
  async closeProbe(): Promise<{ networkLog?: string; consoleLog?: string }> {
    const probe = this.ctx.probe;
    if (!probe) return {};
    await probe.close(this.stepAt).catch(() => undefined);
    return probe.evidence();
  }

  /** The probe was asked for but cannot be used: say so once, and wait the
   *  way the harness always has. */
  private probeUnavailable(reason: string): void {
    this.store.trace(this.ctx.runId, { kind: 'note', text: `probe unavailable: ${reason}; using fixed waits` });
  }

  /**
   * Wait for the app after an action (docs/23 §3.1). With the probe, until
   * the app says it has settled, bounded by the settle timeout; a timeout is
   * not a failure, the step goes on and the trace says what was busy.
   * Without it, or if it errors, the same fixed sleep as always.
   */
  private async settleAfter(action: string, fallbackMs: number): Promise<StepSettle> {
    const probe = this.probe;
    if (!probe) {
      await sleep(fallbackMs, this.ctx.signal);
      return this.noteSettle({ via: 'sleep', waitedMs: fallbackMs, fallbackMs });
    }

    try {
      const result = await probe.client.waitSettled(this.ctx.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS, 200);
      probe.succeeded();
      const settle: StepSettle = {
        via: 'probe', waitedMs: Math.round(result.elapsedMs), fallbackMs,
        settled: result.settled, settledAtMs: result.settledAtMs,
        ...(result.busy.length ? { busy: result.busy } : {}),
      };
      if (SYSTEM_UI_CHECK.has(action)) {
        const systemUi = await this.systemSheet(action);
        if (systemUi) settle.systemUi = systemUi;
      }
      this.settleSavedMs += fallbackMs - settle.waitedMs;
      return this.noteSettle(settle);
    } catch (e) {
      const probeError = (e as Error).message;
      probe.failed(probeError);
      if (probe.detached) this.probeUnavailable(probe.detached);
      await sleep(fallbackMs, this.ctx.signal);
      return this.noteSettle({ via: 'sleep', waitedMs: fallbackMs, fallbackMs, probeError });
    }
  }

  /** Remember a settle for the step's trace line; only on probe runs, so a
   *  run that never asked for one reads exactly as before. */
  private noteSettle(settle: StepSettle): StepSettle {
    if (this.ctx.probe !== undefined) this.pendingSettle = settle;
    return settle;
  }

  /**
   * The probe sees only the app. With a SpringBoard sheet up it reports the
   * app idle (docs/23 §4), so after the steps that can raise one, AXe looks.
   * The "Open in …?" consent sheet is answered, as open_url always has; any
   * other alert or sheet is noted, and answering it is the caller's job.
   */
  private async systemSheet(action: string): Promise<string | null> {
    const screen = await this.ui.describe(this.ctx.signal).catch(() => null);
    if (!screen) return null;
    this.lastScreen = screen;

    const sheet = findOpenInSheet(screen);
    if (sheet) {
      await this.ui.tap({ x: sheet.open.center.x, y: sheet.open.center.y }, this.ctx.signal);
      this.store.trace(this.ctx.runId, { kind: 'note', text: `iOS asked ${JSON.stringify(sheet.title)} after ${action}; tapped Open` });
      await this.settleQuietly();
      return sheet.title;
    }

    const alert = screen.elements.find((element) => element.type === 'Alert' || element.type === 'Sheet');
    if (!alert) return null;

    const title = alert.label ?? alert.type;
    this.store.trace(this.ctx.runId, {
      kind: 'note',
      text: `an alert or sheet is on screen after ${action}: ${JSON.stringify(title)} -- the probe cannot see system UI, so answer it with a tap step if it is not the app's own`,
    });
    return title;
  }

  /** A settle whose result nobody records: after answering a sheet. */
  private async settleQuietly(): Promise<void> {
    const probe = this.probe;
    if (!probe) return void await sleep(1200, this.ctx.signal);
    await probe.client.waitSettled(this.ctx.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS, 200)
      .catch(() => sleep(1200, this.ctx.signal));
  }

  /** Best-effort variant for the agent loop: a failed tap is feedback, not a crash. */
  async tryRun(step: Step): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.run(step);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * The one way the app is started. The caller's env and args are checked
   * here as well as at submit: a launch step the NL agent emits never passed
   * through submit, and nothing that reaches a launch should skip the check.
   */
  private async launchApp(args: string[], env: Record<string, string>): Promise<number> {
    assertSafeLaunchEnv(env, 'launch env', this.devices.platform);
    assertSafeLaunchArgs(args, 'launch args');

    // The probe's own variables go in after the check: they are exactly the
    // keys a caller may not set.
    const probe = this.ctx.probe;
    const withProbe = probe && !probe.detached ? { ...env, ...probe.launchEnv() } : env;
    const pid = await this.devices.launch(this.ctx.udid, this.ctx.app, args, withProbe);
    this.appPid = pid;
    this.crashNoted = false;

    if (probe && !probe.detached) {
      const failure = await probe.afterLaunch(this.ctx.app.appId, pid);
      if (failure) this.probeUnavailable(failure);
    }
    return pid;
  }

  /** Whether the probe is attached right now; the runner uses it to skip a
   *  fixed sleep the probe has made redundant. */
  get probeAttached(): boolean { return Boolean(this.probe); }

  /** Whether this run has a probe session at all, attached now or not: its
   *  settle savings are worth reporting. */
  get probeRequested(): boolean { return this.ctx.probe !== undefined; }

  /** Returns a description of what was actually driven, where that differs
   *  from what was asked for. Anything else traces as the step itself. */
  private async dispatch(step: Step): Promise<string | void> {
    const { udid, app, signal } = this.ctx;
    switch (step.action) {
      case 'launch':
        await this.launchApp(step.args ?? this.ctx.launchArgs, step.env ?? this.ctx.launchEnv);
        await this.settleAfter('launch', 1200);
        return;

      case 'relaunch':
        await this.devices.terminate(udid, app.appId);
        this.ctx.probe?.appStopped();
        await sleep(400, signal);            // terminate hygiene, not a settle
        await this.launchApp(this.ctx.launchArgs, this.ctx.launchEnv);
        await this.settleAfter('relaunch', 1200);
        return;

      case 'terminate':
        await this.devices.terminate(udid, app.appId);
        this.ctx.probe?.appStopped();
        this.appPid = 0;
        return;

      case 'tap':
        await this.ui.tap(step, signal);
        await this.settleAfter('tap', 600);  // let the transition settle
        return;

      case 'type':
        await this.ui.type(step.text, signal);
        await this.settleAfter('type', 300);
        return;

      case 'clear_text':
        await this.ui.clearText(signal);
        return;

      case 'press_enter':
        await this.ui.pressEnter(signal);
        await this.settleAfter('press_enter', 600);
        return;

      case 'swipe':
        await this.ui.swipe(step, signal);
        await this.settleAfter('swipe', 500);
        return;

      case 'gesture': {
        const screen = this.lastScreen ?? await this.refresh();
        await this.ui.gesture(step.preset, screen, step.durationMs, signal);
        await this.settleAfter('gesture', 500);
        return;
      }

      case 'button':
        await this.ui.button(step.button, step.durationMs, signal);
        await this.settleAfter('button', 800);
        return;

      case 'pinch': {
        // Genuine two-contact HID input, so UIPinchGestureRecognizer fires --
        // this is assertable, unlike approximating a zoom with one finger.
        const { width, height } = await this.screenSize();
        const r = resolvePinch(step, { width, height });
        const t0 = Date.now();
        await this.requireTouch().pinch({
          cx: r.cx, cy: r.cy,
          startSpread: r.startSpread, endSpread: r.endSpread,
          width, height,
          ...(step.durationMs ? { durationMs: step.durationMs } : {}),
        }, signal);
        const drove = Date.now() - t0;
        await this.settleAfter('pinch', 700);
        return describePinchDrive(r, drove);
      }

      case 'two_finger_press': {
        // Two fingers down, nothing else. The point is the landing itself: a
        // spreading pinch confounds "the app zoomed because I spread" with
        // "the app zoomed the instant a second contact appeared".
        const { width, height } = await this.screenSize();
        const cx = step.cx ?? width / 2, cy = step.cy ?? height / 2;
        const gap = clampSpread(step.gap ?? BASE_SPREAD, cx, width);
        const holdMs = Math.min(Math.max(step.holdMs ?? 800, 50), 10_000);
        const t0 = Date.now();
        await this.requireTouch().twoFingerPress({
          x1: cx - gap / 2, y1: cy, x2: cx + gap / 2, y2: cy, width, height, holdMs,
        }, signal);
        const drove = Date.now() - t0;
        await this.settleAfter('two_finger_press', 700);
        return `two-finger press at (${Math.round(cx)},${Math.round(cy)}), gap ${Math.round(gap)}pt, ` +
          `no travel, held ${holdMs}ms, drove ${(drove / 1000).toFixed(2)}s`;
      }

      case 'pan': {
        const { width, height } = await this.screenSize();
        await this.requireTouch().pan({
          startX: step.startX, startY: step.startY,
          endX: step.endX, endY: step.endY,
          width, height,
          ...(step.durationMs ? { durationMs: step.durationMs } : {}),
        }, signal);
        await this.settleAfter('pan', 700);
        return;
      }

      case 'double_tap': {
        let { x, y } = step;
        if (x === undefined || y === undefined) {
          // Resolve a selector to a point, so callers can double-tap by id.
          const screen = await this.refresh();
          const hit = screen.elements.find((e) =>
            (step.id && e.id === step.id) || (step.label && e.label === step.label));
          if (!hit) throw new Error(`double_tap could not find ${step.id ?? step.label}`);
          x = hit.center.x; y = hit.center.y;
        }
        await this.requireTouch().doubleTap(x, y, signal);
        await this.settleAfter('double_tap', 600);
        return;
      }

      case 'wait':
        await sleep(Math.min(step.ms, 60_000), signal);
        return;

      case 'wait_for': {
        const found = await this.ui.waitFor(step, step.timeoutMs ?? 10_000, signal);
        if (!found) throw new Error(`timed out waiting for ${step.id ?? step.label}`);
        return;
      }

      case 'assert':
        return elementChecks(step).length ? this.assertElement(step) : this.assertPresent(step);

      case 'screenshot':
        // capture() writes its own trace line, timed.
        await this.capture(step.name, step.note);
        return;

      case 'open_url': {
        // In-app through the probe: no consent sheet, and nothing to wait
        // for but the app itself.
        const via = step.via ?? (this.probe ? 'app' : 'simctl');
        if (via === 'app') {
          const opened = await this.openInApp(step.url);
          if (opened) return opened;
        }

        await this.devices.openUrl(udid, step.url);
        if (this.devices.platform !== 'ios') {
          await sleep(1500, signal);
          return;
        }
        // A custom scheme's first open on a device -- and the first after
        // every erase -- waits behind SpringBoard's "Open in …?" sheet, and
        // nothing reaches the app until it is answered.
        const sheet = await acceptOpenIn(this.ui, { windowMs: this.consentWindowMs, signal });
        if (!sheet) return;
        this.store.trace(this.ctx.runId, {
          kind: 'note',
          text: `iOS asked ${JSON.stringify(sheet)} before handing ${step.url} to the app; tapped Open`,
        });
        await this.settleAfter('open_url', 1200);
        return `open ${step.url} (answered the system's consent sheet)`;
      }

      case 'appearance':
        await this.devices.setAppearance(udid, step.mode);
        await this.settleAfter('appearance', 800);
        return;

      case 'permission':
        await this.devices.setPermission(udid, step.grant, step.service, app.appId);
        return;

      case 'describe_ui': {
        const screen = await this.refresh();
        this.store.trace(this.ctx.runId, { kind: 'note', text: renderScreen(screen) });
        return;
      }

      case 'wait_idle':
        return this.waitIdle(step.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS, step.quietMs ?? 200);

      case 'assert_request':
        return this.assertRequest(step);

      default: {
        const never: never = step;
        const bad = (never as { action?: unknown }).action;
        throw new Error(
          `unsupported step action ${JSON.stringify(bad)}. ` +
          `Valid actions: ${Object.keys(STEP_KEYS).sort().join(', ')}`);
      }
    }
  }

  /** Index of the step in flight into the run's executedSteps, which record()
   *  appends to in the same order run() starts them. */
  private get stepIndex(): number { return this.stepStarts.length - 1; }

  /** One checked expectation onto the run (docs/30 R3), pass or fail. */
  private recordAssertion(result: Omit<AssertionResult, 'step'>): void {
    const run = this.store.get(this.ctx.runId);
    if (!run) return;
    const results = run.assertions ?? (run.assertions = []);
    if (results.length >= MAX_ASSERTIONS) {
      if (results.length === MAX_ASSERTIONS && !this.assertionCapNoted) {
        this.assertionCapNoted = true;
        this.store.trace(this.ctx.runId, { kind: 'note', text: `more than ${MAX_ASSERTIONS} assertions: later results are not recorded, though they still decide the verdict` });
      }
      return;
    }
    results.push({ step: this.stepIndex, ...result });
    this.store.persist(run);
  }

  /** `assert` with nothing but a selector: the element is on screen. */
  private async assertPresent(step: StepOf<'assert'>): Promise<string> {
    const { signal } = this.ctx;
    const want = selectorText(step);
    const timeoutMs = step.timeoutMs ?? 10_000;
    const found = await this.ui.waitFor(step, timeoutMs, signal);
    // An abort is the run's timeout, not the app's failure.
    if (signal.aborted) throw new Error('aborted');

    const target = targetOf(step);
    if (!found) {
      const message = `${want} did not appear within ${timeoutMs}ms` + (step.note ? ` (${step.note})` : '');
      this.recordAssertion({ kind: 'node', target, prop: 'present', expected: true, actual: false, pass: false, message, ...noteOf(step) });
      throw new AssertionFailed(message);
    }
    this.recordAssertion({ kind: 'node', target, prop: 'present', expected: true, actual: true, pass: true, ...noteOf(step) });
    return `assert ${want} is on screen -- it is`;
  }

  /**
   * `assert` with a text, value or enabled state (docs/30 R2): poll the screen
   * until an element the selector picks has all of them, or the timeout. A
   * miss is a verdict, with what the app actually had in the result.
   */
  private async assertElement(step: StepOf<'assert'>): Promise<string> {
    const { signal } = this.ctx;
    const want = selectorText(step);
    const checks = elementChecks(step);
    const timeoutMs = step.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    let candidates: UiElement[] = [];

    for (;;) {
      const screen = await this.ui.describe(signal).catch(() => null);
      if (screen) {
        this.lastScreen = screen;
        candidates = screen.elements.filter((element) => selects(element, step));
      }
      const hit = candidates.find((element) => checks.every((check) => holds(element, check)));
      if (hit) {
        for (const check of checks) {
          this.recordAssertion({ ...checkResult(step, check, hit), pass: true, ...noteOf(step) });
        }
        return `assert ${want} ${describeChecks(checks)} -- it is`;
      }
      if (Date.now() >= deadline || signal.aborted) break;
      await sleep(500, signal);
    }
    if (signal.aborted) throw new Error('aborted');

    const target = targetOf(step);
    const closest = candidates[0];
    if (!closest) {
      const message = `${want} did not appear within ${timeoutMs}ms` + (step.note ? ` (${step.note})` : '');
      this.recordAssertion({ kind: 'node', target, prop: 'present', expected: true, actual: false, pass: false, message, ...noteOf(step) });
      throw new AssertionFailed(message);
    }

    const misses: string[] = [];
    for (const check of checks) {
      const pass = holds(closest, check);
      const result = checkResult(step, check, closest);
      const message = pass ? undefined : `${want} ${check.prop} was ${JSON.stringify(result.actual)}, expected ${check.op === 'contains' ? 'it to contain ' : ''}${JSON.stringify(check.expected)}`;
      if (message) misses.push(message);
      this.recordAssertion({ ...result, pass, ...(message ? { message } : {}), ...noteOf(step) });
    }
    throw new AssertionFailed(`${misses.join('; ')} after ${timeoutMs}ms` + (step.note ? ` (${step.note})` : ''));
  }

  /**
   * open_url through the probe. Returns the step's description when the app
   * took the URL; null to fall back to the system path, with a note.
   */
  private async openInApp(url: string): Promise<string | null> {
    const probe = this.probe;
    if (!probe) {
      this.store.trace(this.ctx.runId, { kind: 'note', text: `open_url via "app" needs the probe, which is not attached; used the system path` });
      return null;
    }

    try {
      const result = await probe.client.openUrl(url);
      probe.succeeded();
      if (result.opened) {
        await this.settleAfter('open_url', 1200);
        return `open ${url} in the app, through the probe`;
      }
      this.store.trace(this.ctx.runId, {
        kind: 'note',
        text: `the app did not take ${url} in-process${result.error ? ` (${result.error})` : ''}; used the system path`,
      });
    } catch (e) {
      probe.failed((e as Error).message);
      this.store.trace(this.ctx.runId, { kind: 'note', text: `the probe could not open ${url} (${(e as Error).message}); used the system path` });
    }
    return null;
  }

  /**
   * wait_idle: the caller asked for idleness, so a settle that times out is
   * an error naming what was busy. Without a probe (it could not attach, or
   * the daemon has it switched off) the run is not failed for it: it waits a
   * fixed time and says so.
   */
  private async waitIdle(timeoutMs: number, quietMs: number): Promise<string> {
    const probe = this.probe;
    if (!probe) {
      const fixed = Math.min(timeoutMs, 2000);
      await sleep(fixed, this.ctx.signal);
      this.noteSettle({ via: 'sleep', waitedMs: fixed, fallbackMs: fixed });
      return `wait_idle without a probe: waited a fixed ${fixed}ms instead`;
    }

    const result = await probe.client.waitSettled(timeoutMs, quietMs);
    probe.succeeded();
    this.noteSettle({
      via: 'probe', waitedMs: Math.round(result.elapsedMs), fallbackMs: 0,
      settled: result.settled, settledAtMs: result.settledAtMs,
      ...(result.busy.length ? { busy: result.busy } : {}),
    });
    if (!result.settled) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for the app to settle: ${result.busy.join(', ') || 'still redrawing'}`);
    }
    return `app settled after ${Math.round(result.elapsedMs)}ms`;
  }

  /**
   * assert_request: poll the probe's request log for a completed request
   * matching the glob, method and status. A miss fails the run, as `assert`
   * does. Without a probe it cannot be checked at all, which is an error --
   * never a pass.
   */
  private async assertRequest(step: StepOf<'assert_request'>): Promise<string> {
    const probe = this.probe;
    const want = `${step.method ? `${step.method.toUpperCase()} ` : ''}${step.urlPattern}${step.status !== undefined ? ` -> ${step.status}` : ''}`;
    if (!probe) {
      throw new Error(`assert_request (${want}) needs the probe, which is not attached` +
        `${this.ctx.probe?.detached ? `: ${this.ctx.probe.detached}` : ''}; the request log cannot be checked`);
    }

    const timeoutMs = step.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    let seen: ProbeNetworkRequest[] = [];

    for (;;) {
      try {
        seen = (await probe.client.network(0)).requests;
        probe.absorb(seen, this.stepAt);
      } catch (e) {
        probe.failed((e as Error).message);
        if (!this.probe) throw new Error(`assert_request (${want}): the probe stopped answering`);
      }

      const hit = seen.find((request) => request.state === 'completed' && requestMatches(request, step));
      if (hit) {
        this.recordAssertion({ ...requestResult(step, want, hit), pass: true, ...noteOf(step) });
        return `assert request ${hit.method} ${hit.url} -> ${hit.status ?? '?'}`;
      }

      if (Date.now() >= deadline || this.ctx.signal.aborted) break;
      await sleep(100, this.ctx.signal);
    }

    if (this.ctx.signal.aborted) throw new Error('aborted');
    const nearby = seen.filter((request) => globMatches(step.urlPattern, request.url)).slice(-3);
    const near = nearby
      .map((request) => `${request.method} ${request.url} ${request.state}${request.status !== undefined ? ` ${request.status}` : ''}`);
    const message = `no completed request matching ${want} within ${timeoutMs}ms` +
      (near.length ? `; saw ${near.join('; ')}` : '') + (step.note ? ` (${step.note})` : '');
    const closest = nearby.at(-1);
    this.recordAssertion({
      ...requestResult(step, want, closest), pass: false, message: message.slice(0, 2000), ...noteOf(step),
    });
    throw new AssertionFailed(message);
  }

  /** Save a named PNG into the run directory and index it on the run. */
  async capture(name: string, note?: string): Promise<string> {
    const started = Date.now();
    const run = this.store.get(this.ctx.runId);
    const base = slug(name);
    const taken = new Set((run?.screenshots ?? []).map((s) => s.name));
    // Repeat captures of the same checkpoint get -2, -3 rather than overwriting.
    let unique = base, n = 1;
    while (taken.has(unique)) unique = `${base}-${++n}`;

    const rel = path.join('screenshots', `${unique}.png`);
    const abs = path.join(this.ctx.runDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    try {
      await this.ui.screenshot(abs, this.ctx.signal);
    } catch (e) {
      log.warn('driver screenshot failed, falling back to the device backend', (e as Error).message);
      await this.devices.screenshot(this.ctx.udid, abs);
    }
    if (!fs.existsSync(abs)) throw new Error(`screenshot "${name}" produced no file`);

    if (run) {
      run.screenshots.push({ name: unique, file: rel, at: nowIso(), ...(note ? { note } : {}) });
      this.store.persist(run);
    }
    // Timed here, not in run(): record() skips a successful screenshot step
    // because this line already describes it, which used to drop its time.
    this.store.trace(this.ctx.runId, {
      kind: 'screenshot', text: `captured "${unique}"`, screenshot: rel, durationMs: Date.now() - started,
    });
    return abs;
  }

  private record(step: Step, ok: boolean, durationMs: number, error?: string, detail?: string): void {
    const run = this.store.get(this.ctx.runId);
    if (run) {
      run.executedSteps.push(step);
      this.store.persist(run);
    }
    // A screenshot already wrote its own richer trace line.
    if (step.action === 'screenshot' && ok) return;
    this.store.trace(this.ctx.runId, {
      kind: ok ? 'step' : 'error',
      text: ok ? (detail ?? describeStep(step)) : `${describeStep(step)} -- FAILED: ${error}`,
      step, ok, durationMs,
      ...(this.pendingSettle ? { settle: this.pendingSettle } : {}),
    });
  }
}

/** Whether a process is still running. Simulator apps are host processes. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One property an `assert` checks beyond presence. */
interface ElementCheck {
  prop: 'text' | 'value' | 'enabled';
  expected: string | boolean;
  op?: 'eq' | 'contains';
}

/** What an `assert` step checks beyond presence, in a stable order. */
function elementChecks(step: StepOf<'assert'>): ElementCheck[] {
  const op = step.op ?? 'eq';
  const checks: ElementCheck[] = [];
  if (step.text !== undefined) checks.push({ prop: 'text', expected: step.text, op });
  if (step.value !== undefined) checks.push({ prop: 'value', expected: step.value, op });
  if (step.enabled !== undefined) checks.push({ prop: 'enabled', expected: step.enabled });
  return checks;
}

/** The selector semantics the drivers use for tap and wait_for: an id
 *  exactly, or a label exactly or as a substring. */
const selects = (element: UiElement, step: { id?: string; label?: string }): boolean =>
  step.id ? element.id === step.id : Boolean(step.label && (element.label === step.label || element.label?.includes(step.label)));

/** `text` is the accessibility label (what a static text shows); `value` a
 *  field's contents or a switch's state. */
const readProp = (element: UiElement, prop: ElementCheck['prop']): string | boolean | undefined =>
  prop === 'text' ? element.label : prop === 'value' ? element.value : element.enabled;

function holds(element: UiElement, check: ElementCheck): boolean {
  const actual = readProp(element, check.prop);
  if (check.prop === 'enabled') return actual === check.expected;
  if (typeof actual !== 'string') return false;
  return check.op === 'contains' ? actual.includes(String(check.expected)) : actual === check.expected;
}

const targetOf = (step: { id?: string; label?: string }): { id?: string; label?: string } =>
  step.id ? { id: step.id } : { label: step.label ?? '' };

const noteOf = (step: { note?: string }): { note?: string } => (step.note ? { note: step.note } : {});

const selectorText = (step: { id?: string; label?: string }): string =>
  step.id ? `#${step.id}` : `"${step.label}"`;

const describeChecks = (checks: ElementCheck[]): string => checks.map((check) =>
  check.prop === 'enabled' ? (check.expected ? 'is enabled' : 'is disabled')
    : `${check.prop} ${check.op === 'contains' ? 'contains' : '='} ${JSON.stringify(check.expected)}`).join(', ');

function checkResult(
  step: StepOf<'assert'>, check: ElementCheck, element: UiElement,
): Omit<AssertionResult, 'step' | 'pass'> {
  const actual = readProp(element, check.prop);
  return {
    kind: 'node', target: targetOf(step), prop: check.prop,
    ...(check.op ? { op: check.op } : {}),
    expected: check.expected,
    ...(actual !== undefined ? { actual } : {}),
  };
}

function requestResult(
  step: StepOf<'assert_request'>, want: string, request: ProbeNetworkRequest | undefined,
): Omit<AssertionResult, 'step' | 'pass'> {
  return {
    kind: 'request',
    match: want.slice(0, 2200),
    expected: {
      urlPattern: step.urlPattern,
      ...(step.method ? { method: step.method.toUpperCase() } : {}),
      ...(step.status !== undefined ? { status: step.status } : {}),
    },
    ...(request ? {
      actual: {
        method: request.method, url: request.url, state: request.state,
        ...(request.status !== undefined ? { status: request.status } : {}),
      },
    } : {}),
  };
}

function requestMatches(
  request: ProbeNetworkRequest,
  want: { urlPattern: string; method?: string; status?: number },
): boolean {
  if (want.method && request.method.toUpperCase() !== want.method.toUpperCase()) return false;
  if (want.status !== undefined && request.status !== want.status) return false;
  return globMatches(want.urlPattern, request.url);
}

/**
 * The keys each action actually reads, from the shared step contract.
 *
 * Submitted steps used to be cast straight to `Step[]`, so a key the harness
 * does not implement was silently dropped and the run still reported success.
 * That is how three pinches at scale 3.0, 1.5 and 0.4 all performed the same
 * gesture and all passed. An unimplemented parameter must fail loudly.
 */
export const STEP_KEYS: Record<string, readonly string[]> = WIRE_STEP_KEYS;

/** Throws if a submitted step names an action or a parameter the harness does
 *  not implement, or gives one a value it cannot use. The message names the
 *  offending key, since the whole failure mode being prevented is one that
 *  otherwise leaves no trace. The rules are simbase's (src/wire/steps.ts), so
 *  the control plane refuses exactly what this daemon would. */
export function validateSteps(steps: unknown[]): void {
  steps.forEach((raw, i) => {
    const problem = stepProblem(raw, `steps[${i}]`);
    if (problem) throw new Error(problem);
  });
}

/** A comfortable two-finger separation, used as the anchor when a pinch is
 *  expressed as a scale rather than as absolute distances. */
const BASE_SPREAD = 90;
/** Closer than this is not a placement two real fingers can make. */
const MIN_SPREAD = 40;
/** Keep both contacts on screen rather than off the edge, where they land nowhere. */
const FINGER_MARGIN = 12;

/** The widest separation that still puts both contacts on screen about `cx`. */
function clampSpread(spread: number, cx: number, width: number): number {
  const max = Math.max(MIN_SPREAD, 2 * Math.min(cx - FINGER_MARGIN, width - FINGER_MARGIN - cx));
  return Math.max(MIN_SPREAD, Math.min(max, spread));
}

export interface ResolvedPinch {
  cx: number; cy: number; startSpread: number; endSpread: number;
  requestedScale?: number; effectiveScale: number; clamped: boolean;
}

/**
 * Turn a pinch request into the two separations actually driven.
 *
 * The driver speaks absolute distances in points, but a zoom claim is naturally
 * a ratio -- "3x", "back down to 0.4". Both spellings are accepted; explicit
 * distances win, since they say exactly what to do.
 *
 * Zooming out has to *start* wide. Anchoring the start and shrinking from it
 * would end with the fingers closer together than a hand can place them, which
 * is why `scale < 1` divides into the base instead of multiplying it.
 */
export function resolvePinch(
  step: { cx?: number; cy?: number; scale?: number; startSpread?: number; endSpread?: number },
  screen: { width: number; height: number },
): ResolvedPinch {
  const cx = step.cx ?? screen.width / 2;
  const cy = step.cy ?? screen.height / 2;

  let start: number, end: number;
  if (step.startSpread !== undefined || step.endSpread !== undefined) {
    start = step.startSpread ?? BASE_SPREAD;
    end = step.endSpread ?? BASE_SPREAD;
  } else if (step.scale !== undefined && step.scale > 0) {
    if (step.scale >= 1) { start = BASE_SPREAD; end = BASE_SPREAD * step.scale; }
    else { start = BASE_SPREAD / step.scale; end = BASE_SPREAD; }
  } else {
    start = 60; end = 240;          // the historical default: a plain zoom in
  }

  const cs = clampSpread(start, cx, screen.width);
  const ce = clampSpread(end, cx, screen.width);
  return {
    cx, cy, startSpread: cs, endSpread: ce,
    ...(step.scale !== undefined ? { requestedScale: step.scale } : {}),
    effectiveScale: ce / cs,
    clamped: Math.round(cs) !== Math.round(start) || Math.round(ce) !== Math.round(end),
  };
}

/** What the gesture actually did, for the trace. Deliberately reports the
 *  commanded geometry and the measured time -- never a guess at what the app
 *  did with them, which only an assertion inside the app can establish. */
function describePinchDrive(r: ResolvedPinch, droveMs: number): string {
  const dir = r.endSpread > r.startSpread ? 'spread'
    : r.endSpread < r.startSpread ? 'close' : 'hold';
  const asked = r.requestedScale;
  const note = r.clamped
    ? ` -- ${asked !== undefined ? `requested ${asked.toFixed(2)}x, ` : ''}clamped to fit the screen`
    : '';
  return `pinch ${dir} ${Math.round(r.startSpread)}->${Math.round(r.endSpread)}pt ` +
    `(scale ${r.effectiveScale.toFixed(2)}x${note}) about (${Math.round(r.cx)},${Math.round(r.cy)}), ` +
    `drove ${(droveMs / 1000).toFixed(2)}s`;
}

/**
 * Warnings for an `open_url` that nothing verifies. A deep link that does not
 * land raises no error -- the app simply stays where it was -- so without a
 * `wait_for`/`assert` straight after it, a steps run passes regardless.
 */
export function lintDeepLinks(steps: readonly Step[]): string[] {
  const out: string[] = [];
  steps.forEach((step, i) => {
    if (step.action !== 'open_url') return;
    // Screenshots and plain waits in between do not verify anything.
    let j = i + 1;
    while (j < steps.length && (steps[j]!.action === 'screenshot' || steps[j]!.action === 'wait')) j++;
    const next = steps[j];
    if (next && (next.action === 'assert' || next.action === 'wait_for')) return;
    out.push(`steps[${i}] opens ${step.url} but nothing checks it landed -- add an ` +
      '{"action":"assert","id":"..."} naming an element unique to the destination screen, ' +
      'or a deep link that silently does nothing still passes');
  });
  return out;
}

/** Human-readable one-liner for the report. */
export function describeStep(step: Step): string {
  switch (step.action) {
    case 'tap': {
      const target = step.id ? `#${step.id}` : step.label ? `"${step.label}"` :
        step.value ? `value "${step.value}"` : `(${step.x},${step.y})`;
      return `tap ${target}`;
    }
    case 'type': return `type ${JSON.stringify(step.text.length > 60 ? step.text.slice(0, 60) + '...' : step.text)}`;
    case 'wait': return `wait ${step.ms}ms`;
    case 'wait_for': return `wait for ${step.id ?? step.label}`;
    case 'assert': {
      const checks = elementChecks(step);
      return `assert ${selectorText(step)} ${checks.length ? describeChecks(checks) : 'is on screen'}`;
    }
    case 'screenshot': return `screenshot "${step.name}"`;
    case 'gesture': return `gesture ${step.preset}`;
    case 'pinch': {
      // Planned, not executed -- the screen is not known here, so describe the
      // request as given rather than the resolved geometry the trace reports.
      if (step.startSpread === undefined && step.endSpread === undefined && step.scale !== undefined) {
        return `pinch scale ${step.scale}x`;
      }
      const from = step.startSpread ?? BASE_SPREAD, to = step.endSpread ?? BASE_SPREAD;
      return `pinch ${to > from ? 'spread' : to < from ? 'close' : 'hold'} ${from}->${to}pt`;
    }
    case 'two_finger_press':
      return `two-finger press${step.gap ? ` gap ${step.gap}pt` : ''}${step.holdMs ? ` for ${step.holdMs}ms` : ''}`;
    case 'pan': return `two-finger pan (${step.startX},${step.startY}) -> (${step.endX},${step.endY})`;
    case 'double_tap': return `double tap ${step.id ?? step.label ?? `(${step.x},${step.y})`}`;
    case 'button': return `press ${step.button}`;
    case 'open_url': return `open ${step.url}`;
    case 'appearance': return `switch to ${step.mode} mode`;
    case 'permission': return `${step.grant ? 'grant' : 'revoke'} ${step.service}`;
    case 'swipe': return `swipe (${step.startX},${step.startY}) -> (${step.endX},${step.endY})`;
    case 'wait_idle': return 'wait until the app is idle';
    case 'assert_request':
      return `assert a request ${step.method ? `${step.method.toUpperCase()} ` : ''}${step.urlPattern}` +
        `${step.status !== undefined ? ` -> ${step.status}` : ''} completed`;
    default: return step.action.replace(/_/g, ' ');
  }
}
