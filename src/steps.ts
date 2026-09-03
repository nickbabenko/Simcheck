import fs from 'node:fs';
import path from 'node:path';
import type { Step } from './types.js';
import type { Store } from './store.js';
import type { DeviceBackend, LaunchTarget, TouchDriver, UiDriver } from './device.js';
import { renderScreen, type Screen } from './screen.js';
import { sleep, slug, nowIso } from './util.js';
import { logger } from './log.js';

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
}

/** Told to the caller when a multi-touch step has no driver behind it. */
export const noTouchDriver = (platform: string): string =>
  platform === 'ios'
    ? 'multi-touch needs the "baguette" CLI, which is not on PATH. Install it with: brew install baguette' +
      ' (Apple Silicon, Xcode 26+). AXe drives a single contact only, so pinch and two-finger pan are not possible without it.'
    : `multi-touch is not available on ${platform}. \`adb shell input\` drives one pointer only, so pinch, ` +
      'two-finger pan and a real double tap cannot be expressed through it. Assert the gesture from inside ' +
      'the app with an instrumentation test instead, which has genuine multi-touch.';

/**
 * Executes one `Step` against a leased simulator, recording it into the run so
 * that a natural-language scenario ends up with a replayable step list.
 */
export class StepExecutor {
  private lastScreen: Screen | null = null;

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
    try {
      const detail = await this.dispatch(step);
      this.record(step, true, Date.now() - started, undefined, detail ?? undefined);
    } catch (e) {
      this.record(step, false, Date.now() - started, (e as Error).message);
      throw e;
    }
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

  /** Returns a description of what was actually driven, where that differs
   *  from what was asked for. Anything else traces as the step itself. */
  private async dispatch(step: Step): Promise<string | void> {
    const { udid, app, signal } = this.ctx;
    switch (step.action) {
      case 'launch':
        await this.devices.launch(udid, app, step.args ?? this.ctx.launchArgs, step.env ?? this.ctx.launchEnv);
        await sleep(1200, signal);
        return;

      case 'relaunch':
        await this.devices.terminate(udid, app.appId);
        await sleep(400, signal);
        await this.devices.launch(udid, app, this.ctx.launchArgs, this.ctx.launchEnv);
        await sleep(1200, signal);
        return;

      case 'terminate':
        await this.devices.terminate(udid, app.appId);
        return;

      case 'tap':
        await this.ui.tap(step, signal);
        await sleep(600, signal);            // let the transition settle
        return;

      case 'type':
        await this.ui.type(step.text, signal);
        await sleep(300, signal);
        return;

      case 'clear_text':
        await this.ui.clearText(signal);
        return;

      case 'press_enter':
        await this.ui.pressEnter(signal);
        await sleep(600, signal);
        return;

      case 'swipe':
        await this.ui.swipe(step, signal);
        await sleep(500, signal);
        return;

      case 'gesture': {
        const screen = this.lastScreen ?? await this.refresh();
        await this.ui.gesture(step.preset, screen, step.durationMs, signal);
        await sleep(500, signal);
        return;
      }

      case 'button':
        await this.ui.button(step.button, step.durationMs, signal);
        await sleep(800, signal);
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
        await sleep(700, signal);
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
        await sleep(700, signal);
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
        await sleep(700, signal);
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
        await sleep(600, signal);
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

      case 'screenshot':
        await this.capture(step.name, step.note);
        return;

      case 'open_url':
        await this.devices.openUrl(udid, step.url);
        await sleep(1500, signal);
        return;

      case 'appearance':
        await this.devices.setAppearance(udid, step.mode);
        await sleep(800, signal);
        return;

      case 'permission':
        await this.devices.setPermission(udid, step.grant, step.service, app.appId);
        return;

      case 'describe_ui': {
        const screen = await this.refresh();
        this.store.trace(this.ctx.runId, { kind: 'note', text: renderScreen(screen) });
        return;
      }

      default: {
        const never: never = step;
        const bad = (never as { action?: unknown }).action;
        throw new Error(
          `unsupported step action ${JSON.stringify(bad)}. ` +
          `Valid actions: ${Object.keys(STEP_KEYS).sort().join(', ')}`);
      }
    }
  }

  /** Save a named PNG into the run directory and index it on the run. */
  async capture(name: string, note?: string): Promise<string> {
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
    this.store.trace(this.ctx.runId, { kind: 'screenshot', text: `captured "${unique}"`, screenshot: rel });
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
    });
  }
}

/**
 * The keys each action actually reads.
 *
 * Submitted steps used to be cast straight to `Step[]`, so a key the harness
 * does not implement was silently dropped and the run still reported success.
 * That is how three pinches at scale 3.0, 1.5 and 0.4 all performed the same
 * gesture and all passed. An unimplemented parameter must fail loudly.
 */
export const STEP_KEYS: Record<string, readonly string[]> = {
  launch: ['args', 'env'],
  terminate: [],
  relaunch: [],
  tap: ['id', 'label', 'value', 'elementType', 'x', 'y', 'waitTimeoutMs', 'note'],
  type: ['text', 'note'],
  clear_text: [],
  press_enter: [],
  swipe: ['startX', 'startY', 'endX', 'endY', 'durationMs'],
  gesture: ['preset', 'durationMs'],
  pinch: ['cx', 'cy', 'scale', 'startSpread', 'endSpread', 'durationMs', 'note'],
  pan: ['startX', 'startY', 'endX', 'endY', 'durationMs'],
  two_finger_press: ['cx', 'cy', 'gap', 'holdMs', 'note'],
  double_tap: ['x', 'y', 'id', 'label'],
  button: ['button', 'durationMs'],
  wait: ['ms', 'note'],
  wait_for: ['id', 'label', 'timeoutMs'],
  screenshot: ['name', 'note'],
  open_url: ['url'],
  appearance: ['mode'],
  permission: ['service', 'grant'],
  describe_ui: [],
};

/** Parameters without which an action cannot be carried out. Missing ones used
 *  to reach the driver as `NaN` -- `axe --start-x NaN` -- which fails deep in a
 *  subprocess instead of at submit time where the mistake is. */
const STEP_REQUIRED: Record<string, readonly string[]> = {
  swipe: ['startX', 'startY', 'endX', 'endY'],
  pan: ['startX', 'startY', 'endX', 'endY'],
  type: ['text'],
  gesture: ['preset'],
  button: ['button'],
  wait: ['ms'],
  screenshot: ['name'],
  open_url: ['url'],
  appearance: ['mode'],
  permission: ['service', 'grant'],
};

/** Actions that need at least one of a set, rather than all of it. */
const STEP_ONE_OF: Record<string, readonly string[]> = {
  tap: ['id', 'label', 'value', 'x'],
  wait_for: ['id', 'label'],
  double_tap: ['id', 'label', 'x'],
};

/** Keys the driver treats as numbers. A string here becomes NaN downstream. */
const NUMERIC_KEYS = new Set([
  'x', 'y', 'startX', 'startY', 'endX', 'endY', 'cx', 'cy', 'scale',
  'startSpread', 'endSpread', 'gap', 'holdMs', 'durationMs', 'ms',
  'timeoutMs', 'waitTimeoutMs',
]);

/** Throws if a submitted step names an action or a parameter the harness does
 *  not implement. The message names the offending key, since the whole failure
 *  mode being prevented is one that otherwise leaves no trace. */
export function validateSteps(steps: unknown[]): void {
  steps.forEach((raw, i) => {
    const where = `steps[${i}]`;
    if (!raw || typeof raw !== 'object') throw new Error(`${where} is not an object`);
    const step = raw as Record<string, unknown>;
    const action = step['action'];
    if (typeof action !== 'string') throw new Error(`${where} has no \`action\``);
    const allowed = STEP_KEYS[action];
    if (!allowed) {
      throw new Error(`${where}: unknown action "${action}". Known actions: ${Object.keys(STEP_KEYS).sort().join(', ')}`);
    }
    const unknown = Object.keys(step).filter((k) => k !== 'action' && !allowed.includes(k));
    if (unknown.length) {
      throw new Error(`${where} (${action}): unsupported ${unknown.length > 1 ? 'keys' : 'key'} ` +
        `${unknown.map((k) => `"${k}"`).join(', ')}. ${action} accepts: ${allowed.join(', ') || 'no parameters'}`);
    }

    const missing = (STEP_REQUIRED[action] ?? []).filter((k) => step[k] === undefined);
    if (missing.length) {
      throw new Error(`${where} (${action}): missing required ${missing.length > 1 ? 'keys' : 'key'} ` +
        `${missing.map((k) => `"${k}"`).join(', ')}. ${action} needs: ${STEP_REQUIRED[action]!.join(', ')}`);
    }

    const oneOf = STEP_ONE_OF[action];
    if (oneOf && !oneOf.some((k) => step[k] !== undefined)) {
      throw new Error(`${where} (${action}): needs at least one of ${oneOf.map((k) => `"${k}"`).join(', ')}`);
    }

    for (const [k, v] of Object.entries(step)) {
      if (!NUMERIC_KEYS.has(k) || v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`${where} (${action}): "${k}" must be a finite number, got ${JSON.stringify(v)}`);
      }
    }
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
    default: return step.action.replace(/_/g, ' ');
  }
}
