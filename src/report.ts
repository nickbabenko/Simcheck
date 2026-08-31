import fs from 'node:fs';
import path from 'node:path';
import type { Run } from './types.js';
import { describeStep } from './steps.js';

const VERDICT_BADGE: Record<string, string> = {
  passed: 'PASSED', failed: 'FAILED', error: 'HARNESS ERROR',
  timeout: 'TIMED OUT', cancelled: 'CANCELLED',
};

/**
 * The artefact a human actually reads on a PR: verdict up top, evidence
 * inline, full trace underneath. Screenshot links are relative so the file
 * renders correctly straight out of the run directory.
 */
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
  L.push(`| Mode | ${run.mode === 'scenario' ? 'natural language' : run.mode === 'xctest' ? 'XCUITest' : 'explicit steps'} |`);
  if (run.device) L.push(`| Device | ${run.device.name} - ${run.device.runtime} |`);
  if (run.bundleId) L.push(`| Bundle | \`${run.bundleId}\` |`);
  L.push(`| Duration | ${dur} |`);
  if (run.actionsUsed !== undefined) L.push(`| Actions | ${run.actionsUsed} |`);
  L.push('');

  if (run.request.scenario) L.push('## Scenario', '', run.request.scenario, '');
  if (run.request.assert) L.push('## Assertion', '', run.request.assert, '');

  if (run.verdict?.evidence) L.push('## Evidence', '', run.verdict.evidence, '');

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
    L.push(`\`${time}\` ${prefix} ${t.text.replace(/\n/g, '\n      ')}${ms}`);
  }
  L.push('');

  const out = path.join(runDir, 'report.md');
  fs.writeFileSync(out, L.join('\n'));
  return 'report.md';
}
