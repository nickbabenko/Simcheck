import fs from 'node:fs';
import path from 'node:path';
import type { Run, StepSettle } from './types.js';
import { describeStep } from './steps.js';

const MODE_LABEL: Record<string, string> = {
  scenario: 'natural language',
  steps: 'explicit steps',
  xctest: 'XCUITest',
  instrumentation: 'Android instrumentation',
};

const VERDICT_BADGE: Record<string, string> = {
  passed: 'PASSED', failed: 'FAILED', error: 'HARNESS ERROR',
  timeout: 'TIMED OUT', cancelled: 'CANCELLED',
};

/**
 * The artefact a human actually reads on a PR: verdict up top, evidence
 * inline, full trace underneath. Screenshot links are relative so the file
 * renders correctly straight out of the run directory.
 */
const reusedBuild = (run: Run): boolean => Boolean(run.warm?.cacheHit);

export function writeReport(run: Run, runDir: string): string {
  const L: string[] = [];
  const dur = run.startedAt && run.finishedAt
    ? `${Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000)}s`
    : 'n/a';

  L.push(`# ${VERDICT_BADGE[run.status] ?? run.status.toUpperCase()} - ${run.request.label ?? run.id}`);
  L.push('');
  if (run.verdict) L.push(`> ${run.verdict.summary}`, '');
  if (run.error) L.push('```', run.error, '```', '');

  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Run | \`${run.id}\` |`);
  L.push(`| Status | **${run.status}** |`);
  L.push(`| Mode | ${MODE_LABEL[run.mode] ?? run.mode} |`);
  if (run.device) L.push(`| Device | ${run.device.name} - ${run.device.runtime} |`);
  if (run.bundleId) L.push(`| ${run.device?.platform === 'android' ? 'Package' : 'Bundle'} | \`${run.bundleId}\` |`);
  L.push(`| Duration | ${dur} |`);
  if (run.actionsUsed !== undefined) L.push(`| Actions | ${run.actionsUsed} |`);
  if (run.warm) {
    L.push(`| Install | ${run.warm.cacheHit ? 'skipped (warm cache hit)' : 'fresh'}${run.warm.erased ? ', device erased first' : ''} |`);
    const used = run.warm.resetPolicyUsed ?? run.warm.resetPolicyRequested;
    if (used) L.push(`| Reset | ${used}${run.warm.resetPolicyUsed && run.warm.resetPolicyUsed !== run.warm.resetPolicyRequested ? ` (requested ${run.warm.resetPolicyRequested})` : ''} |`);
  }
  L.push('');
  if (reusedBuild(run)) {
    // A relaunch run starts from whatever the app persisted, not a clean
    // install; a reader of the evidence needs to know that.
    L.push('> This run reused an installed build (`resetPolicy: relaunch`): it started from the app\'s persisted state, not a fresh install.', '');
  }
  const t = run.timings;
  if (t && Object.keys(t).length) {
    const ms = (v?: number) => (v === undefined ? '-' : v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
    const rows: [string, number | undefined][] = [
      ['queue', t.queueMs], ['prepare', t.prepareMs], ['pre-reset (erase)', t.preResetMs],
      ['install', t.installMs], ['launch', t.launchMs], ['steps', t.stepsMs],
      ['native tests', t.nativeTestMs], ['final screenshot', t.screenshotMs], ['reset', t.resetMs],
      ['occupancy (device time)', t.occupancyMs], ['total', t.totalMs],
    ];
    L.push('## Timings', '', '| Phase | Time |', '|---|---|');
    for (const [name, v] of rows) if (v !== undefined) L.push(`| ${name} | ${ms(v)} |`);
    if (run.timingsIncomplete?.length) L.push('', `Cut short: ${run.timingsIncomplete.join(', ')} (lower bounds).`);
    if (t.settleSavedMs !== undefined) {
      L.push('', `Probe settling ${t.settleSavedMs >= 0 ? 'saved' : 'cost'} ${ms(Math.abs(t.settleSavedMs))} against fixed sleeps.`);
    }
    L.push('');
  }

  if (run.request.scenario) L.push('## Scenario', '', run.request.scenario, '');
  if (run.request.assert) L.push('## Assertion', '', run.request.assert, '');

  if (run.verdict?.evidence) L.push('## Evidence', '', run.verdict.evidence, '');

  if (run.assertions?.length) {
    const failed = run.assertions.filter((a) => !a.pass).length;
    L.push(`## Assertions (${failed ? `${failed} of ${run.assertions.length} failed` : `all ${run.assertions.length} held`})`, '');
    L.push('| Step | | Checked | Expected | Actual |', '|---|---|---|---|---|');
    for (const a of run.assertions) {
      const what = a.kind === 'request' ? `request ${a.match ?? ''}` : `${a.target?.id ? `#${a.target.id}` : `"${a.target?.label ?? ''}"`} ${a.prop ?? 'present'}${a.op === 'contains' ? ' contains' : ''}`;
      L.push(`| ${a.step + 1} | ${a.pass ? 'held' : '**failed**'} | ${cell(what)} | ${cell(a.expected)} | ${a.actual === undefined ? '-' : cell(a.actual)} |`);
    }
    L.push('');
  }

  if (run.tests) {
    L.push('## Tests', '');
    L.push(`${run.tests.total} run, ${run.tests.failed} failed, ${run.tests.skipped} skipped`, '');
    const failures = run.tests.cases.filter((c) => /fail/i.test(c.status));
    if (failures.length) {
      L.push('### Failures', '');
      for (const c of failures) {
        L.push(`**${c.name}**`, '');
        if (c.failure) L.push('```', c.failure, '```', '');
      }
    }
    L.push('<details><summary>All cases</summary>', '');
    L.push('| Test | Result | Duration |', '|---|---|---|');
    for (const c of run.tests.cases) {
      L.push(`| ${c.name} | ${c.status} | ${c.durationSeconds ? c.durationSeconds + 's' : ''} |`);
    }
    L.push('', '</details>', '');
  }

  const wanted = run.request.screenshots ?? [];
  const taken = new Set(run.screenshots.map((s) => s.name));
  const missing = wanted.filter((w) => !taken.has(w));

  if (run.screenshots.length) {
    L.push('## Screenshots', '');
    for (const s of run.screenshots) {
      L.push(`### ${s.name}`);
      if (s.note) L.push('', `_${s.note}_`);
      L.push('', `![${s.name}](${s.file})`, '');
    }
  }
  if (missing.length) {
    L.push('## Screenshots not captured', '');
    for (const m of missing) L.push(`- \`${m}\` - the scenario never reached this state`);
    L.push('');
  }

  if (run.executedSteps.length) {
    L.push('## Steps executed', '');
    L.push('These replay verbatim - submit them as a `steps` run for a deterministic re-check.', '');
    L.push('```json');
    L.push(JSON.stringify(run.executedSteps, null, 2));
    L.push('```', '');
  }

  L.push('## Trace', '');
  for (const t of run.trace) {
    const time = t.at.slice(11, 19);
    const prefix = { thought: '~', step: '.', error: '!', screenshot: '*', note: '#' }[t.kind] ?? '.';
    const ms = t.durationMs ? ` (${t.durationMs}ms)` : '';
    L.push(`\`${time}\` ${prefix} ${t.text.replace(/\n/g, '\n      ')}${ms}${t.settle ? ` [${describeSettle(t.settle)}]` : ''}`);
  }
  L.push('');

  const out = path.join(runDir, 'report.md');
  fs.writeFileSync(out, L.join('\n'));
  return 'report.md';
}

/** One line on how a step waited: "settled by probe in 412ms (sleep was
 *  600ms)", or "timed out after 10000ms: spinner". Network and console
 *  evidence never appear in the report: they are private by default. */
function describeSettle(settle: StepSettle): string {
  if (settle.via === 'sleep') {
    return `fixed wait ${settle.waitedMs}ms${settle.probeError ? `; probe error: ${settle.probeError}` : ''}`;
  }
  const outcome = settle.settled
    ? `settled by probe in ${settle.waitedMs}ms`
    : `timed out after ${settle.waitedMs}ms: ${settle.busy?.join(', ') || 'still redrawing'}`;
  const was = settle.fallbackMs ? ` (sleep was ${settle.fallbackMs}ms)` : '';
  return `${outcome}${was}${settle.systemUi ? `; system UI: ${settle.systemUi}` : ''}`;
}

/** A value in a markdown table cell: JSON for anything but a string, and no
 *  pipe or newline to break the row. */
function cell(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200);
}
