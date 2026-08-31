import type { Config } from './config.js';
import type { Step } from './types.js';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import { exec, sleep } from './util.js';
import { logger } from './log.js';

const log = logger('llm');

/** What the model decides on each turn of the scenario loop. */
export interface Decision {
  /** One line on what it is doing and why -- lands in the run trace. */
  thought: string;
  /** Actions to run in order before looking at the screen again. */
  actions: Step[];
  /** Set when the scenario is over. */
  done?: { pass: boolean; summary: string; evidence?: string };
}

export interface Turn {
  /** The rendered context for this turn: screen state, results, reminders. */
  text: string;
  /** PNG paths for the model to look at. Ignored by backends without vision. */
  images?: string[];
}

/** One conversation, scoped to a single run, so history is not re-sent each turn. */
export interface LlmSession {
  decide(turn: Turn, signal?: AbortSignal): Promise<Decision>;
  /** Frees any backend-side state. Safe to call more than once. */
  close(): void;
}

export interface Llm {
  readonly name: string;
  start(system: string): LlmSession;
}

/* ------------------------------------------------------------------ schema -- */

/** Kept in sync with `Step` by hand; the model only needs the useful subset. */
export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string', description: 'One sentence: what you are doing now and why.' },
    actions: {
      type: 'array',
      description: 'Actions to perform in order. Keep to 1-4 -- you see a fresh screen after each batch.',
      items: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['tap', 'double_tap', 'type', 'clear_text', 'press_enter', 'swipe', 'gesture',
                   'pinch', 'pan', 'two_finger_press', 'button', 'wait', 'wait_for', 'screenshot',
                   'open_url', 'appearance', 'launch', 'terminate', 'relaunch', 'describe_ui'],
          },
          id: { type: 'string', description: 'tap/wait_for: accessibility identifier.' },
          label: { type: 'string', description: 'tap/wait_for: visible accessibility label.' },
          value: { type: 'string', description: 'tap: current value of the control.' },
          elementType: { type: 'string', description: 'tap: narrow by type, e.g. Button.' },
          x: { type: 'number', description: 'tap: x coordinate. Last resort -- prefer id/label.' },
          y: { type: 'number', description: 'tap: y coordinate.' },
          text: { type: 'string', description: 'type: text to enter.' },
          preset: {
            type: 'string',
            description: 'gesture: which preset.',
            enum: ['scroll-up', 'scroll-down', 'scroll-left', 'scroll-right',
                   'swipe-from-left-edge', 'swipe-from-right-edge',
                   'swipe-from-top-edge', 'swipe-from-bottom-edge'],
          },
          button: { type: 'string', enum: ['home', 'lock', 'side-button', 'siri', 'apple-pay'] },
          startX: { type: 'number' }, startY: { type: 'number' },
          endX: { type: 'number' }, endY: { type: 'number' },
          cx: { type: 'number', description: 'pinch: centre x. Defaults to the middle of the screen.' },
          cy: { type: 'number', description: 'pinch: centre y.' },
          scale: { type: 'number', description: 'pinch: zoom ratio. 3 spreads to 3x, 0.4 pinches back in. Below 1 starts wide and closes. Use this unless you need exact distances.' },
          startSpread: { type: 'number', description: 'pinch: starting distance between the fingers, in points. Overrides scale.' },
          endSpread: { type: 'number', description: 'pinch: ending distance. Larger than startSpread zooms in. Overrides scale.' },
          gap: { type: 'number', description: 'two_finger_press: distance between the two fingers, in points.' },
          holdMs: { type: 'number', description: 'two_finger_press: how long to hold both fingers down without moving them.' },
          durationMs: { type: 'number', description: 'pinch/pan/swipe: how long the gesture takes.' },
          ms: { type: 'number', description: 'wait: milliseconds.' },
          timeoutMs: { type: 'number', description: 'wait_for: give up after this long.' },
          name: { type: 'string', description: 'screenshot: the requested screenshot name.' },
          url: { type: 'string', description: 'open_url: deep link to open.' },
          mode: { type: 'string', enum: ['light', 'dark'], description: 'appearance: which mode.' },
          note: { type: 'string', description: 'Optional annotation for the report.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    done: {
      type: 'object',
      description: 'Only set once the scenario is finished or definitively blocked.',
      properties: {
        pass: { type: 'boolean', description: 'Did the scenario and its assertion hold?' },
        summary: { type: 'string', description: 'What happened, in two or three sentences.' },
        evidence: { type: 'string', description: 'What you saw on screen that justifies the verdict.' },
      },
      required: ['pass', 'summary'],
      additionalProperties: false,
    },
  },
  required: ['thought', 'actions'],
  additionalProperties: false,
} as const;

/* -------------------------------------------------------------- anthropic -- */

/** Direct Messages API. Cheapest and fastest; needs ANTHROPIC_API_KEY. */
class AnthropicLlm implements Llm {
  readonly name = 'anthropic';
  constructor(private cfg: Config, private client: any) {}

  start(system: string): LlmSession {
    const cfg = this.cfg, client = this.client;
    const messages: any[] = [];

    return {
      close() { messages.length = 0; },

      async decide(turn: Turn, signal?: AbortSignal): Promise<Decision> {
        const content: any[] = [];
        for (const img of turn.images ?? []) {
          const data = await fsp.readFile(img, { encoding: 'base64' });
          content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
        }
        content.push({ type: 'text', text: turn.text });
        messages.push({ role: 'user', content });

        const response = await client.messages.create({
          model: cfg.model,
          max_tokens: 8000,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          thinking: { type: 'adaptive' },
          output_config: { effort: cfg.effort },
          tools: [{
            name: 'decide',
            description: 'Record your next actions on the simulator.',
            strict: true,
            input_schema: DECISION_SCHEMA,
          }],
          messages,
        }, { signal });

        if (response.stop_reason === 'refusal') {
          throw new Error(`model declined the scenario (${response.stop_details?.category ?? 'unspecified'})`);
        }
        // Echo the assistant turn back verbatim so thinking blocks replay cleanly.
        messages.push({ role: 'assistant', content: response.content });

        const call = response.content.find((b: any) => b.type === 'tool_use' && b.name === 'decide');
        if (!call) {
          const text = response.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
          throw new Error(`model did not call the decide tool: ${text.slice(0, 400)}`);
        }
        // A tool_use turn must be answered before the next user turn is legal.
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: call.id, content: 'recorded' }],
        });
        return normalise(call.input);
      },
    };
  }
}

/* -------------------------------------------------------------- claude cli -- */

/**
 * Fallback that reuses the local Claude Code login, so the harness works with
 * no API key configured.
 *
 * Two things make this affordable: `--system-prompt` replaces Claude Code's
 * multi-thousand-token default prompt with ours, and `--resume` keeps one
 * session per run so each turn sends only the new screen rather than the whole
 * transcript. It is still slower and dearer per turn than the API backend.
 */
class ClaudeCliLlm implements Llm {
  readonly name = 'claude-cli';
  constructor(private cfg: Config) {}

  start(system: string): LlmSession {
    const cfg = this.cfg;
    let sessionId: string | null = null;

    return {
      close() { sessionId = null; },

      async decide(turn: Turn, signal?: AbortSignal): Promise<Decision> {
        const prompt = turn.images?.length
          ? `${turn.text}\n\nScreenshots just captured (read them if you need to):\n${turn.images.join('\n')}`
          : turn.text;

        const args = ['-p', '--model', cfg.model, '--output-format', 'json'];
        if (sessionId) {
          args.push('--resume', sessionId);
        } else {
          sessionId = randomUUID();
          args.push('--session-id', sessionId,
            '--system-prompt', system,
            '--exclude-dynamic-system-prompt-sections');
        }
        // Pure reasoning -- the harness drives the simulator, not the CLI.
        args.push('--disallowed-tools', 'Bash', 'Edit', 'Write', 'Glob', 'Grep',
          'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite');

        const r = await exec('claude', args, { input: prompt, timeoutMs: 300_000, signal });
        if (r.code !== 0) {
          sessionId = null;   // the session may not exist; start fresh next turn
          // Say whose fault this is. A driver that dies mid-scenario is a
          // harness failure; without this it reads as the app misbehaving.
          throw new Error(
            `scenario driver failed: the claude CLI exited ${r.code}. This is an infrastructure ` +
            `error, not a verdict on the app -- the app was not exercised past this point, and ` +
            `any screenshots already captured are kept. ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
        }

        let text: string;
        try {
          const envelope = JSON.parse(r.stdout) as { result?: string; is_error?: boolean; session_id?: string };
          if (envelope.is_error) throw new Error(String(envelope.result).slice(0, 400));
          if (envelope.session_id) sessionId = envelope.session_id;
          text = envelope.result ?? '';
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
          text = r.stdout;   // older CLI without a JSON envelope
        }
        return normalise(extractJson(text));
      },
    };
  }
}

/** Instruction appended to the system prompt for backends without tool calling. */
export const JSON_REPLY_CONTRACT = [
  'Reply with a single JSON object and nothing else -- no prose, no markdown fence.',
  'It must match this JSON Schema:',
  JSON.stringify(DECISION_SCHEMA),
].join('\n');

/** Pull the JSON object out of a reply that may be fenced or padded with prose. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1]?.trim() ?? trimmed;
  try { return JSON.parse(candidate); } catch { /* fall through to brace scan */ }

  const start = candidate.indexOf('{');
  if (start === -1) throw new Error(`no JSON object in model reply: ${trimmed.slice(0, 300)}`);
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i]!;
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error(`unterminated JSON in model reply: ${trimmed.slice(0, 300)}`);
}

/** Coerce a loosely-shaped model reply into a Decision we can execute.
 *
 *  Models express "I am finished" in several ways -- a `done` object, a bare
 *  `done: true` with the verdict as siblings, or a `verdict` object. Dropping
 *  any of those silently strands the run until its action budget runs out, so
 *  accept them all. */
function normalise(raw: unknown): Decision {
  const d = (raw ?? {}) as Record<string, any>;
  const actions = Array.isArray(d['actions']) ? d['actions'] : [];
  const decision: Decision = {
    thought: typeof d['thought'] === 'string' ? d['thought'] : '',
    actions: actions.filter((a) => a && typeof a.action === 'string') as Step[],
  };

  const finish = pickFinish(d);
  if (finish) decision.done = finish;
  return decision;
}

function pickFinish(d: Record<string, any>): Decision['done'] | undefined {
  // A nested object under any of the names models actually use.
  for (const key of ['done', 'verdict', 'result', 'finish']) {
    const v = d[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const pass = firstBoolean(v['pass'], v['passed'], v['success'], v['ok']);
      if (pass === undefined && !v['summary']) continue;
      return {
        pass: pass ?? false,
        summary: String(v['summary'] ?? v['reason'] ?? v['message'] ?? ''),
        ...(v['evidence'] ? { evidence: String(v['evidence']) } : {}),
      };
    }
  }
  // `done: true` with the verdict as siblings on the root object.
  const flag = firstBoolean(d['done'], d['finished'], d['complete']);
  if (flag === true) {
    const pass = firstBoolean(d['pass'], d['passed'], d['success']);
    return {
      pass: pass ?? false,
      summary: String(d['summary'] ?? d['thought'] ?? 'the scenario finished'),
      ...(d['evidence'] ? { evidence: String(d['evidence']) } : {}),
    };
  }
  return undefined;
}

const firstBoolean = (...vals: unknown[]): boolean | undefined => {
  for (const v of vals) {
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return undefined;
};

/* ---------------------------------------------------------------- factory -- */

export async function createLlm(cfg: Config): Promise<Llm | null> {
  const wanted = cfg.llmBackend;
  if (wanted === 'none') return null;

  const hasKey = Boolean(process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_AUTH_TOKEN']);
  if (wanted === 'anthropic' || (wanted === 'auto' && hasKey)) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      log.info(`natural-language scenarios via the Anthropic API (${cfg.model})`);
      return new AnthropicLlm(cfg, new Anthropic());
    } catch (e) {
      if (wanted === 'anthropic') throw e;
      log.warn('Anthropic SDK unavailable, falling back to the claude CLI', (e as Error).message);
    }
  }

  if (wanted === 'claude-cli' || wanted === 'auto') {
    // Probed once at startup, so a transient failure would disable scenarios
    // for the life of the process. Under disk or CPU pressure the CLI can take
    // well over 15s just to start, which is exactly when that bites -- so give
    // it room and retry before concluding it is absent.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const probe = await exec('claude', ['--version'], { timeoutMs: 60_000 });
      if (probe.code === 0) {
        log.info(`natural-language scenarios via the claude CLI (${probe.stdout.trim()})`);
        return new ClaudeCliLlm(cfg);
      }
      log.warn(`claude CLI probe ${attempt}/3 failed (${probe.timedOut ? 'timed out' : `exit ${probe.code}`})`);
      if (attempt < 3) await sleep(2000);
    }
    if (wanted === 'claude-cli') throw new Error('claude CLI not found on PATH after 3 attempts');
  }

  log.warn('no LLM backend available -- only explicit `steps` runs will work');
  return null;
}
