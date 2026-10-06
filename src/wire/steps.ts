/**
 * The step union: the exact actions a run performs, as the control plane accepts them and the
 * device harness (simcheck) executes them. One schema for both sides (docs/30 R1).
 *
 * simcheck vendors this file byte for byte as `src/wire/steps.ts`; it depends on zod and
 * nothing else so that it can. Edit it here, then copy it across (simcheck's
 * `scripts/vendor-steps.mjs`). Never edit the vendored copy.
 *
 * Every member is strict: a key the harness does not implement is refused at submit rather
 * than dropped. That is how three pinches at different scales once all performed the same
 * gesture and all passed.
 */
import { z } from 'zod';

/** Longest a probe step may wait on its own: a settle, a request. */
export const MAX_STEP_WAIT_MS = 60_000;

const coordinate = z.number();
const duration = z.number().min(0);
const wait = z.number().min(0).max(MAX_STEP_WAIT_MS);
/** Waiting for an element is bounded only by the run's own 30-minute cap. */
const elementWait = z
  .number()
  .min(0)
  .max(30 * 60_000);
const note = z.string().max(500);
const env = z.record(z.string(), z.string());

export const GESTURE_PRESETS = [
  'scroll-up',
  'scroll-down',
  'scroll-left',
  'scroll-right',
  'swipe-from-left-edge',
  'swipe-from-right-edge',
  'swipe-from-top-edge',
  'swipe-from-bottom-edge',
] as const;
export const GesturePreset = z.enum(GESTURE_PRESETS);
export type GesturePreset = z.infer<typeof GesturePreset>;

/** Hardware buttons on both platforms. A driver refuses one its platform does not have. */
export const IOS_BUTTONS = ['home', 'lock', 'side-button', 'siri', 'apple-pay'] as const;
export const ANDROID_BUTTONS = [
  'home',
  'back',
  'recents',
  'power',
  'volume-up',
  'volume-down',
  'menu',
] as const;
export const HardwareButton = z.enum([
  ...IOS_BUTTONS,
  ...ANDROID_BUTTONS.filter((button) => button !== 'home'),
] as [HardwareButtonName, ...HardwareButtonName[]]);
type HardwareButtonName = (typeof IOS_BUTTONS)[number] | (typeof ANDROID_BUTTONS)[number];
export type HardwareButton = HardwareButtonName;

/**
 * How an `assert` compares `text` or `value` with what is on screen. `eq` is exact; `contains`
 * is a substring. There is deliberately no regex: a pattern from a caller, run on the device
 * host, is a denial-of-service lever (catastrophic backtracking blocks the daemon).
 */
export const AssertOp = z.enum(['eq', 'contains']);
export type AssertOp = z.infer<typeof AssertOp>;

const tap = z.strictObject({
  action: z.literal('tap'),
  id: z.string().optional(),
  label: z.string().optional(),
  value: z.string().optional(),
  elementType: z.string().optional(),
  x: coordinate.optional(),
  y: coordinate.optional(),
  waitTimeoutMs: elementWait.optional(),
  note: note.optional(),
});

const drag = {
  startX: coordinate,
  startY: coordinate,
  endX: coordinate,
  endY: coordinate,
  durationMs: duration.optional(),
};

/** Each member, keyed by action. The order is the order the docs list them in. */
export const STEP_SCHEMAS = {
  launch: z.strictObject({
    action: z.literal('launch'),
    args: z.array(z.string()).optional(),
    env: env.optional(),
  }),
  terminate: z.strictObject({ action: z.literal('terminate') }),
  relaunch: z.strictObject({ action: z.literal('relaunch') }),
  tap,
  type: z.strictObject({ action: z.literal('type'), text: z.string(), note: note.optional() }),
  clear_text: z.strictObject({ action: z.literal('clear_text') }),
  press_enter: z.strictObject({ action: z.literal('press_enter') }),
  swipe: z.strictObject({ action: z.literal('swipe'), ...drag }),
  gesture: z.strictObject({
    action: z.literal('gesture'),
    preset: GesturePreset,
    durationMs: duration.optional(),
  }),
  pinch: z.strictObject({
    action: z.literal('pinch'),
    cx: coordinate.optional(),
    cy: coordinate.optional(),
    scale: z.number().positive().optional(),
    startSpread: z.number().min(0).optional(),
    endSpread: z.number().min(0).optional(),
    durationMs: duration.optional(),
    note: note.optional(),
  }),
  pan: z.strictObject({ action: z.literal('pan'), ...drag }),
  two_finger_press: z.strictObject({
    action: z.literal('two_finger_press'),
    cx: coordinate.optional(),
    cy: coordinate.optional(),
    gap: z.number().min(0).optional(),
    holdMs: duration.optional(),
    note: note.optional(),
  }),
  double_tap: z.strictObject({
    action: z.literal('double_tap'),
    x: coordinate.optional(),
    y: coordinate.optional(),
    id: z.string().optional(),
    label: z.string().optional(),
  }),
  button: z.strictObject({
    action: z.literal('button'),
    button: HardwareButton,
    durationMs: duration.optional(),
  }),
  wait: z.strictObject({ action: z.literal('wait'), ms: duration, note: note.optional() }),
  wait_for: z.strictObject({
    action: z.literal('wait_for'),
    id: z.string().optional(),
    label: z.string().optional(),
    timeoutMs: elementWait.optional(),
  }),
  /**
   * An element must be on screen, and optionally have a text (its accessibility label, which
   * is what a static text shows), a value (a field's contents, a switch's "1"/"0") or an
   * enabled state. A miss fails the run as a verdict on the app; it does not error it.
   */
  assert: z.strictObject({
    action: z.literal('assert'),
    id: z.string().optional(),
    label: z.string().optional(),
    text: z.string().max(1000).optional(),
    value: z.string().max(1000).optional(),
    enabled: z.boolean().optional(),
    op: AssertOp.optional(),
    timeoutMs: elementWait.optional(),
    note: note.optional(),
  }),
  screenshot: z.strictObject({
    action: z.literal('screenshot'),
    name: z.string().min(1).max(200),
    note: note.optional(),
  }),
  /** `via: "app"` hands the URL to the app through the probe; `"simctl"` is the system path. */
  open_url: z.strictObject({
    action: z.literal('open_url'),
    url: z.string().min(1).max(4096),
    via: z.enum(['app', 'simctl']).optional(),
  }),
  appearance: z.strictObject({ action: z.literal('appearance'), mode: z.enum(['light', 'dark']) }),
  permission: z.strictObject({
    action: z.literal('permission'),
    service: z.string().min(1),
    grant: z.boolean(),
  }),
  describe_ui: z.strictObject({ action: z.literal('describe_ui') }),
  /** Probe only: block until the app reports itself settled. A timeout is an error. */
  wait_idle: z.strictObject({
    action: z.literal('wait_idle'),
    timeoutMs: wait.optional(),
    quietMs: wait.optional(),
  }),
  /**
   * Probe only: a completed request matching `urlPattern` (a glob where `*` is any run of
   * characters, matched against the redacted URL), and `method` / `status` when given.
   */
  assert_request: z.strictObject({
    action: z.literal('assert_request'),
    urlPattern: z.string().min(1).max(2048),
    method: z
      .string()
      .regex(/^[A-Za-z]{1,16}$/, 'must be an HTTP method such as "GET"')
      .optional(),
    status: z.number().int().min(100).max(599).optional(),
    timeoutMs: wait.optional(),
    note: note.optional(),
  }),
} as const;

export type StepAction = keyof typeof STEP_SCHEMAS;
export const STEP_ACTIONS = Object.keys(STEP_SCHEMAS) as StepAction[];

/** Actions that need at least one of these keys, rather than all of them. */
export const STEP_ONE_OF: Partial<Record<StepAction, readonly string[]>> = {
  tap: ['id', 'label', 'value', 'x'],
  wait_for: ['id', 'label'],
  assert: ['id', 'label'],
  double_tap: ['id', 'label', 'x'],
};

/** Steps that only mean anything with the in-app probe attached. */
export const PROBE_ACTIONS: readonly StepAction[] = ['wait_idle', 'assert_request'];

/** The probe-only steps, plus `open_url` through the app. */
export const needsProbe = (step: { action: string; via?: unknown }): boolean =>
  (PROBE_ACTIONS as readonly string[]).includes(step.action) ||
  (step.action === 'open_url' && step.via === 'app');

/** The rules a key list can't express: alternatives, and keys that only mean something together. */
function crossFieldProblem(step: Record<string, unknown>): string | undefined {
  const action = step['action'] as StepAction;
  const oneOf = STEP_ONE_OF[action];

  if (oneOf && !oneOf.some((key) => step[key] !== undefined)) {
    return `needs at least one of ${oneOf.map((key) => `"${key}"`).join(', ')}`;
  }

  const coordinates = action === 'tap' || action === 'double_tap';

  if (coordinates && (step['x'] === undefined) !== (step['y'] === undefined)) {
    return '"x" and "y" go together';
  }

  if (action === 'assert' && step['op'] !== undefined) {
    if (step['text'] === undefined && step['value'] === undefined) {
      return '"op" compares "text" or "value"; give one of them';
    }
  }

  return undefined;
}

const keysOf = (action: StepAction): string[] =>
  Object.keys(STEP_SCHEMAS[action].shape).filter((key) => key !== 'action');

const requiredKeysOf = (action: StepAction): string[] => {
  const shape = STEP_SCHEMAS[action].shape as Record<string, z.ZodType>;

  return keysOf(action).filter((key) => shape[key]?.safeParse(undefined).success === false);
};

/** The keys each action reads. Anything else is refused. */
export const STEP_KEYS = Object.fromEntries(
  STEP_ACTIONS.map((action) => [action, keysOf(action)]),
) as unknown as Record<StepAction, readonly string[]>;

/** Keys without which an action cannot be carried out. */
export const STEP_REQUIRED = Object.fromEntries(
  STEP_ACTIONS.map((action) => [action, requiredKeysOf(action)]),
) as unknown as Record<StepAction, readonly string[]>;

const quoteAll = (keys: readonly string[]): string => keys.map((key) => `"${key}"`).join(', ');

/** A schema issue as a person would say it, with the value that caused it. */
function issueText(issue: z.core.$ZodIssue, value: unknown): string {
  if (issue.code === 'invalid_type' && issue.expected === 'number') {
    return `must be a finite number, got ${JSON.stringify(value)}`;
  }

  if (issue.code === 'invalid_value') {
    return `must be one of ${issue.values.map((option) => JSON.stringify(option)).join(', ')}`;
  }

  if (issue.code === 'too_big') {
    return `must be at most ${String(issue.maximum)}${issue.origin === 'string' ? ' characters' : ''}`;
  }

  if (issue.code === 'too_small' && issue.origin === 'string' && Number(issue.minimum) === 1) {
    return 'must not be empty';
  }

  if (issue.code === 'too_small') {
    return `must be at least ${String(issue.minimum)}${issue.origin === 'string' ? ' characters' : ''}`;
  }

  return issue.message;
}

/** A key the action does not read, or one it cannot do without. */
function keyProblem(step: Record<string, unknown>, action: StepAction): string | undefined {
  const allowed = STEP_KEYS[action];
  const unknown = Object.keys(step).filter((key) => key !== 'action' && !allowed.includes(key));

  if (unknown.length) {
    return (
      `unsupported ${unknown.length > 1 ? 'keys' : 'key'} ${quoteAll(unknown)}. ` +
      `${action} accepts: ${allowed.join(', ') || 'no parameters'}`
    );
  }

  const required = STEP_REQUIRED[action];
  const missing = required.filter((key) => step[key] === undefined);

  if (missing.length) {
    return (
      `missing required ${missing.length > 1 ? 'keys' : 'key'} ${quoteAll(missing)}. ` +
      `${action} needs: ${required.join(', ')}`
    );
  }

  return undefined;
}

/**
 * What is wrong with one submitted step, in words that name the offending key, or undefined
 * when it is valid. `where` prefixes the message, e.g. "steps[3]".
 */
export function stepProblem(raw: unknown, where: string): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `${where} is not an object`;
  }

  const step = raw as Record<string, unknown>;
  const action = step['action'];

  if (typeof action !== 'string') {
    return `${where} has no \`action\``;
  }

  if (!Object.hasOwn(STEP_SCHEMAS, action)) {
    return `${where}: unknown action "${action}". Known actions: ${[...STEP_ACTIONS].sort().join(', ')}`;
  }

  const known = action as StepAction;
  const label = `${where} (${known})`;
  const keys = keyProblem(step, known);

  if (keys) {
    return `${label}: ${keys}`;
  }

  const parsed = STEP_SCHEMAS[known].safeParse(step);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path.join('.') ?? '';

    return `${label}: ${key ? `"${key}" ` : ''}${issue ? issueText(issue, step[key]) : 'is invalid'}`;
  }

  const crossField = crossFieldProblem(step);

  return crossField ? `${label}: ${crossField}` : undefined;
}

const members = Object.values(STEP_SCHEMAS) as unknown as [
  (typeof STEP_SCHEMAS)[StepAction],
  ...(typeof STEP_SCHEMAS)[StepAction][],
];

/** One step, any action. Parsing applies every rule `stepProblem` does. */
export const Step = z.discriminatedUnion('action', members).superRefine((step, context) => {
  const problem = crossFieldProblem(step as Record<string, unknown>);

  if (problem) {
    context.addIssue({ code: 'custom', message: problem });
  }
});
export type Step = { [A in StepAction]: z.infer<(typeof STEP_SCHEMAS)[A]> }[StepAction];
export type StepOf<A extends StepAction> = Extract<Step, { action: A }>;

/**
 * A step as a result reports it. Looser than `Step` on purpose: a harness one version ahead
 * may report an action this control plane has not heard of, and its result must still land.
 */
export const StepRecord = z.looseObject({ action: z.string() });
export type StepRecord = z.infer<typeof StepRecord> & Record<string, unknown>;

/**
 * One checked expectation, passed or failed (docs/30 R3): what was expected, what the app
 * actually had, and which step checked it. `step` indexes `executedSteps`. A node assertion
 * yields one result per property it checked (`present` when it checked none); a request
 * assertion yields one.
 */
export const AssertionResult = z.object({
  step: z.number().int().min(0),
  kind: z.enum(['node', 'request']),
  /** node: the element the step selected. */
  target: z.object({ id: z.string().optional(), label: z.string().optional() }).optional(),
  /** request: what it had to match, e.g. "POST https://api.example.com/orders* -> 201". */
  match: z.string().max(2200).optional(),
  prop: z.enum(['present', 'text', 'value', 'enabled']).optional(),
  op: z.enum(['eq', 'contains']).optional(),
  expected: z.unknown(),
  /** Absent when there was nothing to read: the element never appeared. */
  actual: z.unknown().optional(),
  pass: z.boolean(),
  /** For a failure: why, in words. */
  message: z.string().max(2000).optional(),
  note: z.string().max(500).optional(),
});
export type AssertionResult = z.infer<typeof AssertionResult>;

/** The most assertion results one run reports. */
export const MAX_ASSERTIONS = 500;
