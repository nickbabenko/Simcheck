import path from 'node:path';
import type { Llm, LlmSession, Decision } from './llm.js';
import { JSON_REPLY_CONTRACT } from './llm.js';
import type { Run, Step } from './types.js';
import type { Store } from './store.js';
import type { StepExecutor } from './steps.js';
import { renderScreen } from './axe.js';
import { describeStep } from './steps.js';
import { logger } from './log.js';

const log = logger('agent');

export interface AgentResult {
  pass: boolean;
  summary: string;
  evidence?: string;
  actionsUsed: number;
  exhausted: boolean;
}

const SYSTEM = `You are driving a real iOS Simulator to carry out a test scenario on behalf of another engineer.

You act through a small set of actions. After each batch you get the fresh accessibility tree of whatever is now on screen, so work in small steps and check the result rather than guessing several screens ahead.

How to work:
- Prefer tapping by "id" (the accessibility identifier), then by "label". Use x/y coordinates only when an element has neither, taking them from the "@x,y" centre in the tree.
- If a tap does nothing, re-read the tree before retrying. The element may not have appeared yet -- "wait_for" is better than a blind "wait".
- Scroll with the "gesture" action when what you need is not in the tree. The tree lists only what is currently rendered.
- Capture a screenshot with the exact name the caller asked for, at the moment the screen genuinely shows that state. These screenshots are the evidence a human will review, so they must be right.
- Text fields usually need a tap to focus before "type". Use "clear_text" to empty an existing value.

Finishing:
- Set "done" as soon as the scenario is complete or you are definitively blocked. Do not keep exploring once you have what was asked for.
- "done.pass" is your honest verdict on the assertion, not on whether you managed to drive the UI. If the app behaved wrongly, that is pass=false with an explanation.
- If you cannot complete the scenario at all (a screen never loads, a control does not exist), set pass=false and say precisely where you got stuck and what you saw.
- Never claim you saw something you did not. The engineer is using your verdict to decide whether to ship.`;

/** Run a natural-language scenario to completion, or until its budget runs out. */
export async function runScenario(opts: {
  llm: Llm;
  run: Run;
  store: Store;
  exec: StepExecutor;
  runDir: string;
  maxActions: number;
  signal: AbortSignal;
}): Promise<AgentResult> {
  const { llm, run, store, exec, maxActions, signal } = opts;
  const req = run.request;

  const system = llm.name === 'claude-cli' ? `${SYSTEM}\n\n${JSON_REPLY_CONTRACT}` : SYSTEM;
  const session: LlmSession = llm.start(system);

  let actionsUsed = 0;
  let turn = 0;
  let lastFeedback = 'The app has just been launched.';
  let freshScreenshots: string[] = [];
  let consecutiveParseFailures = 0;
  // Backends without enforced tool schemas occasionally reply in prose.
  const remindJson = llm.name === 'claude-cli';

  try {
    while (actionsUsed < maxActions) {
      if (signal.aborted) return { pass: false, summary: 'run cancelled', actionsUsed, exhausted: false };
      turn++;

      const screen = await exec.refresh().catch((e) => {
        log.warn('describe-ui failed', (e as Error).message);
        return null;
      });

      const text = renderTurn({
        req, run, turn,
        screen: screen ? renderScreen(screen) : '(could not read the accessibility tree this turn)',
        feedback: lastFeedback,
        remaining: maxActions - actionsUsed,
        remindJson,
      });

      let decision: Decision;
      try {
        decision = await session.decide({ text, images: freshScreenshots.slice(0, 2) }, signal);
        consecutiveParseFailures = 0;
      } catch (e) {
        const msg = (e as Error).message;
        store.trace(run.id, { kind: 'error', text: `model call failed: ${msg}` });

        // A malformed reply is usually recoverable -- ask again, plainly.
        if (++consecutiveParseFailures <= 2 && /JSON/i.test(msg)) {
          lastFeedback = 'Your last reply was not valid JSON, so nothing was executed. '
            + 'Reply with ONLY a JSON object matching the schema -- no prose and no markdown fence. '
            + 'To finish, set "done" to an OBJECT: {"pass": true|false, "summary": "..."}.';
          continue;
        }
        return { pass: false, summary: `the driving model failed: ${msg}`, actionsUsed, exhausted: false };
      }
      freshScreenshots = [];

      if (decision.thought) {
        store.trace(run.id, { kind: 'thought', text: decision.thought });
      }

      const results: string[] = [];
      for (const action of decision.actions) {
        if (signal.aborted) break;
        if (actionsUsed >= maxActions) {
          results.push('(action budget exhausted before this step ran)');
          break;
        }
        actionsUsed++;
        const step = action as Step;
        const outcome = await exec.tryRun(step);
        results.push(outcome.ok
          ? `ok: ${describeStep(step)}`
          : `FAILED: ${describeStep(step)} -- ${outcome.error}`);

        if (outcome.ok && step.action === 'screenshot') {
          const shot = run.screenshots[run.screenshots.length - 1];
          if (shot) freshScreenshots.push(path.join(opts.runDir, shot.file));
        }
      }

      if (decision.done) {
        return { ...decision.done, actionsUsed, exhausted: false };
      }

      lastFeedback = results.length
        ? `Results of your last actions:\n${results.map((r) => `  - ${r}`).join('\n')}`
        : 'You returned no actions last turn. Either act or set "done".';
    }

    return {
      pass: false,
      summary: `ran out of actions after ${actionsUsed} steps without reaching a verdict`,
      actionsUsed,
      exhausted: true,
    };
  } finally {
    session.close();
  }
}

function renderTurn(o: {
  req: Run['request'];
  run: Run;
  turn: number;
  screen: string;
  feedback: string;
  remaining: number;
  remindJson: boolean;
}): string {
  const wanted = o.req.screenshots ?? [];
  const taken = new Set(o.run.screenshots.map((s) => s.name));
  const outstanding = wanted.filter((w) => !taken.has(w));

  const parts: string[] = [];

  if (o.turn === 1) {
    parts.push(`SCENARIO\n${o.req.scenario}`);
    if (o.req.assert) parts.push(`ASSERTION TO EVALUATE\n${o.req.assert}`);
    if (wanted.length) {
      parts.push(`SCREENSHOTS THE CALLER ASKED FOR (use these exact names)\n${wanted.map((w) => `  - ${w}`).join('\n')}`);
    }
  }

  parts.push(o.feedback);

  if (outstanding.length) {
    parts.push(`Screenshots still outstanding: ${outstanding.join(', ')}`);
  } else if (wanted.length) {
    parts.push('All requested screenshots have been captured.');
  }

  parts.push(`CURRENT SCREEN\n${o.screen}`);
  parts.push(`Turn ${o.turn}. ${o.remaining} actions left in the budget.`);
  if (o.remindJson) {
    parts.push('Reply with ONLY a JSON object: {"thought": "...", "actions": [...], "done": {"pass": bool, "summary": "..."}}. '
      + 'Omit "done" until you are finished. "done" must be an object, never true/false.');
  }

  return parts.join('\n\n');
}
