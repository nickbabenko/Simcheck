import fs from 'node:fs';
import path from 'node:path';
import type { InstrumentationSpec } from '../types.js';
import type { NativeTestAttachment, NativeTestCase, NativeTestContext, NativeTestOutcome } from '../device.js';
import { logger } from '../log.js';
import type { Adb } from './adb.js';
import type { AndroidTools } from './sdk.js';
import { assemble } from './gradle.js';
import { readApk } from './apk.js';

const log = logger('instrument');

export const GRADLE_LOG = 'gradle.log';
export const INSTRUMENT_LOG = 'instrument.log';

/**
 * AndroidJUnitRunner reports each test with a status code.
 * The names are from android.app.Instrumentation and AndroidJUnitRunner; the
 * numbers are what actually comes down the wire.
 */
const STATUS = {
  START: 1,
  OK: 0,
  ERROR: -1,
  FAILURE: -2,
  IGNORED: -3,
  ASSUMPTION_FAILURE: -4,
} as const;

const STATUS_NAME: Record<number, string> = {
  [STATUS.OK]: 'Passed',
  [STATUS.ERROR]: 'Failed',
  [STATUS.FAILURE]: 'Failed',
  [STATUS.IGNORED]: 'Skipped',
  [STATUS.ASSUMPTION_FAILURE]: 'Skipped',
};

interface StatusEvent {
  code: number;
  fields: Record<string, string>;
}

/**
 * Parse `am instrument -r` output.
 *
 * The format is a flat stream of `INSTRUMENTATION_STATUS: key=value` lines
 * terminated by an `INSTRUMENTATION_STATUS_CODE: n`, where `stack` and
 * `stream` values run over many lines. Continuation lines are the whole
 * difficulty: a stack trace contains no marker saying it belongs to the key
 * above it, so anything not starting with a known prefix is appended to
 * whichever key was last opened.
 */
export function parseInstrumentation(out: string): StatusEvent[] {
  const events: StatusEvent[] = [];
  let fields: Record<string, string> = {};
  let lastKey: string | null = null;

  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');

    const status = line.match(/^INSTRUMENTATION_STATUS: ([^=]+)=(.*)$/);
    if (status) {
      lastKey = status[1]!.trim();
      fields[lastKey] = status[2]!;
      continue;
    }

    const code = line.match(/^INSTRUMENTATION_STATUS_CODE: (-?\d+)/);
    if (code) {
      events.push({ code: Number(code[1]), fields });
      // class/test carry across the START..result pair, but a fresh object
      // per event keeps one test's stack trace off the next one.
      fields = {};
      lastKey = null;
      continue;
    }

    // The run-level summary at the end, and the overall exit code.
    if (/^INSTRUMENTATION_(RESULT|CODE|FAILED)/.test(line)) {
      const result = line.match(/^INSTRUMENTATION_RESULT: ([^=]+)=(.*)$/);
      if (result) { lastKey = `result.${result[1]!.trim()}`; fields[lastKey] = result[2]!; }
      else if (line.startsWith('INSTRUMENTATION_CODE')) {
        events.push({ code: STATUS.START, fields: { ...fields, _final: line } });
        fields = {}; lastKey = null;
      } else {
        lastKey = null;
      }
      continue;
    }

    if (lastKey) fields[lastKey] = `${fields[lastKey] ?? ''}\n${line}`;
  }
  return events;
}

/** Turn the event stream into one record per test. */
export function casesFrom(events: StatusEvent[]): NativeTestCase[] {
  const cases: NativeTestCase[] = [];
  for (const e of events) {
    if (e.code === STATUS.START || !(e.code in STATUS_NAME)) continue;
    const cls = (e.fields['class'] ?? '').trim();
    const test = (e.fields['test'] ?? '').trim();
    if (!cls && !test) continue;
    const stack = (e.fields['stack'] ?? '').trim();
    cases.push({
      name: cls ? `${cls.split('.').pop()}.${test}` : test,
      identifier: `${cls}#${test}`,
      status: STATUS_NAME[e.code]!,
      ...(stack ? { failure: stack } : {}),
    });
  }
  return cases;
}

/**
 * Run an instrumentation suite against a booted emulator.
 *
 * The Android answer to XCUITest: assertions live in the app's own androidTest
 * source set, where they can see state the screen cannot settle, and the
 * harness supplies a warm device and turns the result into the same evidence
 * report as every other run.
 */
export async function runInstrumentation(
  tools: AndroidTools, adb: Adb, spec: InstrumentationSpec, ctx: NativeTestContext,
): Promise<NativeTestOutcome> {
  const { deviceId: avd, runDir, signal } = ctx;
  const serial = await adb.serialFor(avd);
  const timeoutMs = spec.timeoutMs ?? 30 * 60_000;
  const started = Date.now();

  /* -- get two APKs, built or given ------------------------------------- */
  let appApk: string;
  let testApk: string;

  if (spec.testApk && spec.appApk) {
    appApk = path.resolve(spec.appApk);
    testApk = path.resolve(spec.testApk);
    for (const [label, p] of [['appApk', appApk], ['testApk', testApk]] as const) {
      if (!fs.existsSync(p)) throw new Error(`no such ${label}: ${p}`);
    }
  } else {
    if (!spec.project) {
      throw new Error('instrumentation needs `project` (a Gradle project) or `testApk` plus `appApk`');
    }
    const built = await assemble(tools, {
      projectDir: spec.project,
      module: spec.module ?? ':app',
      variant: spec.variant ?? 'debug',
      withAndroidTest: true,
      runDir,
      logName: GRADLE_LOG,
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    appApk = built.apkPath;
    testApk = built.testApkPath!;
  }

  /* -- install both ------------------------------------------------------ */
  const appInfo = await readApk(tools, appApk);
  const testInfo = await readApk(tools, testApk);
  const runner = spec.runner ?? testInfo.instrumentationRunner;
  if (!runner) {
    throw new Error(
      `${path.basename(testApk)} declares no instrumentation runner, so it is not a test APK. ` +
      `Pass \`runner\` explicitly if it really is one.`);
  }

  // -t permits a test-only package, which an androidTest APK always is.
  for (const [label, apk] of [['app', appApk], ['test', testApk]] as const) {
    const r = await adb.rawTry(serial, ['install', '-r', '-t', apk], { timeoutMs: 300_000, ...(signal ? { signal } : {}) });
    const out = r.stdout + r.stderr;
    if (r.code !== 0 || /Failure|INSTALL_FAILED/i.test(out)) {
      throw new Error(`installing the ${label} APK failed: ${out.trim().slice(0, 500)}`);
    }
  }
  log.info(`installed ${appInfo.packageName} and ${testInfo.packageName}`);

  /* -- run --------------------------------------------------------------- */
  // AndroidX Test writes anything a test saves into additionalTestOutputDir,
  // which is the documented way to get screenshots back off the device.
  const outputDir = `/sdcard/Download/simcheck-${Date.now().toString(36)}`;
  await adb.shellTry(serial, `mkdir -p ${outputDir}`, { timeoutMs: 30_000 });

  const args = ['shell', 'am', 'instrument', '-w', '-r'];
  if (spec.only?.length) args.push('-e', 'class', spec.only.join(','));
  if (spec.skip?.length) args.push('-e', 'notClass', spec.skip.join(','));
  args.push('-e', 'additionalTestOutputDir', outputDir);
  args.push(`${testInfo.packageName}/${runner}`);

  log.info(`am instrument ${testInfo.packageName}/${runner} on ${serial}`);
  const r = await adb.rawTry(serial, args, { timeoutMs, ...(signal ? { signal } : {}) });
  const output = r.stdout + r.stderr;
  fs.writeFileSync(path.join(runDir, INSTRUMENT_LOG),
    `$ adb -s ${serial} ${args.join(' ')}\n\n${output}`);
  const seconds = Math.round((Date.now() - started) / 1000);

  // A crashed or missing runner produces INSTRUMENTATION_FAILED and no cases,
  // which is a harness-visible failure rather than a verdict on the app.
  if (/INSTRUMENTATION_FAILED/.test(output)) {
    throw new Error(
      `instrumentation did not start after ${seconds}s: ${firstFailure(output)}. ` +
      `Full log: ${path.join(runDir, INSTRUMENT_LOG)}`);
  }

  const cases = casesFrom(parseInstrumentation(output));
  const attachments = await pullOutputs(adb, serial, outputDir, runDir, signal);
  await adb.shellTry(serial, `rm -rf ${outputDir}`, { timeoutMs: 30_000 }).catch(() => {});

  const failed = cases.filter((c) => /fail/i.test(c.status)).length;
  const skipped = cases.filter((c) => /skip/i.test(c.status)).length;
  const total = cases.length;
  const passed = total > 0 && failed === 0;

  log.info(`${total} tests in ${seconds}s: ${failed} failed, ${skipped} skipped`);
  return {
    passed, total, failed, skipped, cases, attachments,
    logFile: INSTRUMENT_LOG,
    summary: passed
      ? `${total} test${total === 1 ? '' : 's'} passed`
      : total === 0
        ? 'no tests ran -- check the runner, the `only`/`skip` filters, and that the androidTest source set has tests'
        : `${failed} of ${total} tests failed`,
  };
}

/** Copy whatever the tests wrote back into the run directory. */
async function pullOutputs(
  adb: Adb, serial: string, deviceDir: string, runDir: string, signal?: AbortSignal,
): Promise<NativeTestAttachment[]> {
  const listing = await adb.shellTry(serial, `ls -1 ${deviceDir} 2>/dev/null`, { timeoutMs: 30_000 });
  const names = listing.out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!names.length) return [];

  const localDir = path.join(runDir, 'attachments');
  fs.mkdirSync(localDir, { recursive: true });
  const attachments: NativeTestAttachment[] = [];

  for (const name of names) {
    // A device path is not a local one; never let a name escape the run dir.
    const safe = path.basename(name);
    if (!safe || safe.startsWith('.')) continue;
    const local = path.join(localDir, safe);
    const pulled = await adb.rawTry(serial, ['pull', `${deviceDir}/${name}`, local], {
      timeoutMs: 120_000, ...(signal ? { signal } : {}),
    });
    if (pulled.code !== 0 || !fs.existsSync(local)) {
      log.warn(`could not pull ${name} from the device`, pulled.stderr.trim().slice(0, 160));
      continue;
    }
    // AndroidX names a saved file after the test that saved it, so the part
    // before the first dash is a usable attribution.
    const stem = safe.replace(/\.[^.]+$/, '');
    attachments.push({
      file: path.relative(runDir, local),
      name: stem,
      associatedWithFailure: /fail/i.test(stem),
    });
  }
  return attachments;
}

const firstFailure = (output: string): string =>
  output.split('\n').find((l) => /INSTRUMENTATION_FAILED|Error|Exception/.test(l))?.trim().slice(0, 300)
  ?? 'no reason given';
