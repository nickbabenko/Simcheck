import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { XcTestSpec } from './types.js';
import { exec } from './util.js';
import { logger } from './log.js';

const log = logger('xctest');

export interface XcAttachment {
  /** Path relative to the run directory. */
  file: string;
  /** The name the test gave it, e.g. "after-pinch". */
  name: string;
  /** Which test produced it. */
  test?: string;
  associatedWithFailure: boolean;
}

export interface XcTestCase {
  name: string;
  identifier: string;
  status: string;          // Passed | Failed | Skipped | Expected Failure
  durationSeconds?: number;
  failure?: string;
}

export interface XcTestOutcome {
  passed: boolean;
  total: number;
  failed: number;
  skipped: number;
  cases: XcTestCase[];
  /** Attachments XCUITest recorded, with the names the tests gave them. */
  attachments: XcAttachment[];
  summary: string;
  resultBundle: string;
}

/**
 * Run an XCUITest bundle against a leased simulator.
 *
 * This is the mode for claims the screen cannot settle: that a gesture changed
 * `zoomScale`, that a delegate fired, that state is right rather than merely
 * looking right. Assertions live in the app's own test target, where they
 * belong -- the harness supplies a warm device and turns the result into the
 * same evidence report as every other run.
 */
export async function runXcTest(
  cfg: Config, spec: XcTestSpec, udid: string, runDir: string, signal?: AbortSignal,
): Promise<XcTestOutcome> {
  const resultBundle = path.join(runDir, 'TestResults.xcresult');
  fs.rmSync(resultBundle, { recursive: true, force: true });

  const destination = `platform=iOS Simulator,id=${udid}`;
  const args: string[] = [];

  if (spec.xctestrun) {
    // Pre-built: nothing is compiled here, so this works even on a machine
    // that cannot build the project.
    const abs = path.resolve(spec.xctestrun);
    if (!fs.existsSync(abs)) throw new Error(`no such .xctestrun: ${abs}`);
    args.push('test-without-building', '-xctestrun', abs);
  } else {
    if (!spec.scheme) throw new Error('xctest needs either `xctestrun` (pre-built) or `scheme` plus a project/workspace');
    const container = spec.workspace ?? spec.project;
    if (!container) throw new Error('xctest from source needs `project` or `workspace`');
    const abs = path.resolve(container);
    if (!fs.existsSync(abs)) throw new Error(`no such project/workspace: ${abs}`);
    args.push('test', spec.workspace ? '-workspace' : '-project', abs, '-scheme', spec.scheme);
    if (spec.configuration) args.push('-configuration', spec.configuration);
  }

  args.push('-destination', destination, '-resultBundlePath', resultBundle);
  // Narrow to a plan, a target, or individual tests.
  if (spec.testPlan) args.push('-testPlan', spec.testPlan);
  for (const only of spec.only ?? []) args.push('-only-testing', only);
  for (const skip of spec.skip ?? []) args.push('-skip-testing', skip);
  args.push('CODE_SIGNING_ALLOWED=NO');

  log.info(`xcodebuild ${args[0]} on ${udid}`);
  const started = Date.now();
  const r = await exec('xcodebuild', args, { timeoutMs: (spec.timeoutMs ?? 30 * 60_000), signal });
  fs.writeFileSync(path.join(runDir, 'xcodebuild.log'), `$ xcodebuild ${args.join(' ')}\n\n${r.stdout}\n${r.stderr}`);
  const seconds = Math.round((Date.now() - started) / 1000);

  if (!fs.existsSync(resultBundle)) {
    // No bundle means it never got as far as running tests.
    throw new Error(
      `xcodebuild produced no result bundle after ${seconds}s (exit ${r.code}). ` +
      `Full log: ${path.join(runDir, 'xcodebuild.log')}\n${tailErrors(r.stdout + r.stderr)}`);
  }

  const outcome = await readResults(resultBundle, runDir, signal);
  log.info(`${outcome.total} tests in ${seconds}s: ${outcome.failed} failed, ${outcome.skipped} skipped`);
  return outcome;
}

/** Turn an .xcresult into structured cases plus extracted attachments. */
async function readResults(resultBundle: string, runDir: string, signal?: AbortSignal): Promise<XcTestOutcome> {
  const summaryRaw = await exec('xcrun',
    ['xcresulttool', 'get', 'test-results', 'summary', '--path', resultBundle, '--compact'],
    { timeoutMs: 120_000, signal });

  let summary: Record<string, unknown> = {};
  try { summary = JSON.parse(summaryRaw.stdout) as Record<string, unknown>; }
  catch { log.warn('could not parse the result summary'); }

  const testsRaw = await exec('xcrun',
    ['xcresulttool', 'get', 'test-results', 'tests', '--path', resultBundle, '--compact'],
    { timeoutMs: 120_000, signal });

  const cases: XcTestCase[] = [];
  try {
    // The tree nests suites arbitrarily deep; only leaves are test cases.
    const walk = (node: Record<string, any>): void => {
      if (node['nodeType'] === 'Test Case' || (node['result'] && !node['children'])) {
        cases.push({
          name: String(node['name'] ?? ''),
          identifier: String(node['nodeIdentifier'] ?? node['name'] ?? ''),
          status: String(node['result'] ?? 'Unknown'),
          ...(node['duration'] ? { durationSeconds: Number(String(node['duration']).replace(/[^\d.]/g, '')) } : {}),
          ...(node['children']?.length ? { failure: collectFailures(node) } : {}),
        });
      }
      for (const child of node['children'] ?? []) walk(child as Record<string, any>);
    };
    for (const root of (JSON.parse(testsRaw.stdout) as { testNodes?: Record<string, any>[] }).testNodes ?? []) walk(root);
  } catch (e) {
    log.warn('could not parse the test tree', (e as Error).message);
  }

  // Screenshots and other attachments XCUITest recorded, so a failure comes
  // with a picture rather than only a message.
  const attachDir = path.join(runDir, 'attachments');
  const attachments: XcAttachment[] = [];
  const exported = await exec('xcrun',
    ['xcresulttool', 'export', 'attachments', '--path', resultBundle, '--output-path', attachDir],
    { timeoutMs: 300_000, signal });

  if (exported.code === 0 && fs.existsSync(attachDir)) {
    // Files land under opaque UUID names. The manifest carries the name the
    // test actually gave each attachment, plus which test it came from --
    // without it a reviewer sees "3F5D3B93-....png" and learns nothing.
    const manifestPath = path.join(attachDir, 'manifest.json');
    const named = new Map<string, { name: string; test: string; failure: boolean }>();
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
          testIdentifier?: string;
          attachments?: { exportedFileName?: string; suggestedHumanReadableName?: string; isAssociatedWithFailure?: boolean }[];
        }[];
        for (const entry of manifest) {
          const test = (entry.testIdentifier ?? '').split('/').pop()?.replace(/\(\)$/, '') ?? '';
          for (const a of entry.attachments ?? []) {
            if (!a.exportedFileName) continue;
            // "after-pinch_0_<uuid>.png" -> "after-pinch"
            const readable = (a.suggestedHumanReadableName ?? a.exportedFileName)
              .replace(/_\d+_[0-9A-F-]{36}(?=\.)/i, '')
              .replace(/\.[^.]+$/, '');
            named.set(a.exportedFileName, {
              name: readable, test,
              failure: Boolean(a.isAssociatedWithFailure),
            });
          }
        }
      } catch (e) {
        log.warn('could not read the attachment manifest', (e as Error).message);
      }
    }

    for (const f of walkFiles(attachDir)) {
      const base = path.basename(f);
      if (base === 'manifest.json') continue;
      const meta = named.get(base);
      attachments.push({
        file: path.relative(runDir, f),
        name: meta?.name ?? base.replace(/\.[^.]+$/, ''),
        ...(meta?.test ? { test: meta.test } : {}),
        associatedWithFailure: meta?.failure ?? false,
      });
    }
  }

  const failed = cases.filter((c) => /fail/i.test(c.status)).length;
  const skipped = cases.filter((c) => /skip/i.test(c.status)).length;
  const total = cases.length || Number(summary['totalTestCount'] ?? 0);
  const declaredFailed = Number(summary['failedTests'] ?? failed);
  const passed = declaredFailed === 0 && failed === 0 && total > 0;

  return {
    passed, total,
    failed: Math.max(failed, declaredFailed),
    skipped,
    cases, attachments, resultBundle,
    summary: passed
      ? `${total} test${total === 1 ? '' : 's'} passed`
      : total === 0
        ? 'no tests ran -- check the scheme, test plan or -only-testing filters'
        : `${Math.max(failed, declaredFailed)} of ${total} tests failed`,
  };
}

function collectFailures(node: Record<string, any>): string | undefined {
  const messages: string[] = [];
  const walk = (n: Record<string, any>): void => {
    if (n['nodeType'] === 'Failure Message' && n['name']) messages.push(String(n['name']));
    for (const c of n['children'] ?? []) walk(c as Record<string, any>);
  };
  walk(node);
  return messages.length ? messages.join('\n') : undefined;
}

function* walkFiles(dir: string, depth = 0): Generator<string> {
  if (depth > 4) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full, depth + 1);
    else if (!e.name.startsWith('.')) yield full;
  }
}

const tailErrors = (output: string): string => {
  const errors = output.split('\n').filter((l) => /(error:|Testing failed|\*\* TEST)/.test(l));
  return errors.slice(-12).join('\n') || output.split('\n').slice(-20).join('\n');
};
