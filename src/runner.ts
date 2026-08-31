import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Config } from './config.js';
import type { Pool } from './pool.js';
import type { Store } from './store.js';
import type { Llm } from './llm.js';
import type { ArtifactStore } from './artifacts.js';
import type { PooledDevice, Run, Step } from './types.js';
import { Axe } from './axe.js';
import { Baguette } from './baguette.js';
import { StepExecutor } from './steps.js';
import { runScenario } from './agent.js';
import { runXcTest } from './xctest.js';
import { prepareApp } from './build.js';
import { writeReport } from './report.js';
import * as simctl from './simctl.js';
import { logger } from './log.js';
import { nowIso, sleep } from './util.js';

const log = logger('runner');

/** Host only -- a signed CI URL can carry credentials in its query string. */
const safeHost = (url: string): string => {
  try { return new URL(url).hostname; } catch { return 'the given URL'; }
};

/**
 * Owns the lifecycle of one run on one leased simulator:
 * prepare the build, install it, drive the scenario, write the evidence,
 * then hand the device back to the pool in a clean state.
 */
export class Runner {
  private aborts = new Map<string, AbortController>();

  constructor(
    private cfg: Config,
    private pool: Pool,
    private store: Store,
    private llm: Llm | null,
    private artifacts: ArtifactStore,
    /** Whether the multi-touch driver was found at startup. */
    private multiTouch = false,
  ) {}

  cancel(runId: string): boolean {
    const ctl = this.aborts.get(runId);
    if (!ctl) return false;
    ctl.abort();
    return true;
  }

  get active(): number { return this.aborts.size; }

  async execute(run: Run, device: PooledDevice): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(run.id, controller);
    // An XCUITest run compiles a test bundle before it runs anything, so it can
    // legitimately outlast the default budget. Honour its own timeout rather
    // than aborting it from underneath -- otherwise the subprocess limit is
    // meaningless and the run reports "no tests ran" for no visible reason.
    const timeoutMs = Math.max(
      run.request.timeoutMs ?? this.cfg.defaultTimeoutMs,
      run.request.xctest?.timeoutMs ?? 0,
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = controller.signal;

    const runDir = this.store.dir(run.id);
    const axe = new Axe(this.cfg.axeBin, device.udid);
    // Optional: absent, only the multi-touch steps fail, and they say why.
    const touch = this.multiTouch ? new Baguette(this.cfg.baguetteBin, device.udid) : undefined;
    let bundleId: string | undefined;
    let installedByUs = false;
    let logStream: { kill(): void } | null = null;

    this.store.update(run.id, {
      status: 'preparing',
      startedAt: nowIso(),
      device: { udid: device.udid, name: device.name, runtime: device.runtime },
    });

    try {
      /* -- build / unpack ------------------------------------------------- */
      const appSpec = run.request.app ?? {};
      this.store.trace(run.id, {
        kind: 'note',
        text: appSpec.github ? `resolving the newest artifact from ${appSpec.github.repo}`
          : appSpec.url ? `downloading the build from ${safeHost(appSpec.url)}`
          : appSpec.artifactId ? `using uploaded artifact ${appSpec.artifactId}`
          : appSpec.path ? 'preparing app bundle'
          : appSpec.scheme ? 'building from source'
          : 'using the app already installed on the simulator',
      });
      // Real download headers live only in memory, never on the run record.
      const secretHeaders = this.store.takeSecret(run.id);
      const appSpecForRun = secretHeaders
        ? { ...run.request.app, urlHeaders: secretHeaders }
        : run.request.app;
      const describesAnApp = Boolean(
        appSpecForRun && (appSpecForRun.path || appSpecForRun.scheme || appSpecForRun.bundleId
          || appSpecForRun.artifactId || appSpecForRun.url || appSpecForRun.github));

      const app = describesAnApp
        ? await prepareApp(this.cfg, appSpecForRun, device.udid, runDir, signal, this.artifacts)
        : null;

      if (app) {
        bundleId = app.bundleId;
        this.store.update(run.id, {
          bundleId, ...(app.appPath ? { appPath: app.appPath } : {}),
          artifacts: { ...run.artifacts, ...(app.buildLog && fs.existsSync(app.buildLog) ? { buildLog: 'build.log' } : {}) },
        });
      }
      this.store.trace(run.id, {
        kind: 'note',
        text: !app ? 'no app named -- xcodebuild will build and install it'
          : app.appPath ? `app ${bundleId} at ${app.appPath}`
          : `app ${bundleId} (already installed)`,
      });

      /* -- install and launch --------------------------------------------- */
      if (app?.appPath && bundleId) {
        await simctl.uninstall(device.udid, bundleId);
        await simctl.install(device.udid, app.appPath);
        installedByUs = true;
        this.store.trace(run.id, { kind: 'note', text: 'installed' });
      }

      logStream = app ? this.streamAppLog(device.udid, app.executable, runDir) : null;
      if (logStream) {
        const cur = this.store.get(run.id)!;
        this.store.update(run.id, { artifacts: { ...cur.artifacts, appLog: 'app.log' } });
      }

      const executor = new StepExecutor(axe, this.store, {
        runId: run.id,
        udid: device.udid,
        bundleId: bundleId ?? '',
        runDir,
        launchArgs: appSpec.launchArgs ?? [],
        launchEnv: appSpec.launchEnv ?? {},
        signal,
      }, touch);

      this.store.update(run.id, { status: 'running' });
      if (run.mode !== 'xctest') {
        // xcodebuild installs and launches the app itself for an XCUITest run.
        await executor.run({ action: 'launch' });
        await sleep(1200, signal);
      }

      /* -- drive ----------------------------------------------------------- */
      if (run.mode === 'xctest') {
        const outcome = await runXcTest(this.cfg, run.request.xctest!, device.udid, runDir, signal);
        // Attachments XCUITest recorded become part of the evidence, alongside
        // whatever the harness captured itself.
        const current = this.store.get(run.id)!;
        for (const a of outcome.attachments.filter((x) => /\.(png|jpe?g)$/i.test(x.file))) {
          current.screenshots.push({
            name: a.test ? `${a.test}-${a.name}` : a.name,
            file: a.file,
            at: nowIso(),
            note: a.associatedWithFailure
              ? `XCUITest attachment from the failure in ${a.test ?? 'a test'}`
              : `XCUITest attachment from ${a.test ?? 'a test'}`,
          });
        }
        this.store.update(run.id, {
          screenshots: current.screenshots,
          tests: {
            total: outcome.total, failed: outcome.failed, skipped: outcome.skipped,
            cases: outcome.cases.map((c) => ({
              name: c.name, status: c.status,
              ...(c.failure ? { failure: c.failure } : {}),
              ...(c.durationSeconds ? { durationSeconds: c.durationSeconds } : {}),
            })),
          },
          artifacts: { ...current.artifacts, xcodebuildLog: 'xcodebuild.log' },
          verdict: { pass: outcome.passed, summary: outcome.summary },
        });
        for (const c of outcome.cases.filter((x) => /fail/i.test(x.status))) {
          this.store.trace(run.id, { kind: 'error', text: `${c.name}: ${c.failure ?? 'failed'}` });
        }
      } else if (run.mode === 'scenario') {
        if (!this.llm) throw new Error('no LLM backend configured, so natural-language scenarios cannot run -- submit explicit `steps`, or set ANTHROPIC_API_KEY and restart the daemon');
        const result = await runScenario({
          llm: this.llm, run, store: this.store, exec: executor, runDir,
          maxActions: run.request.maxActions ?? this.cfg.defaultMaxActions,
          signal,
        });
        this.store.update(run.id, {
          actionsUsed: result.actionsUsed,
          verdict: { pass: result.pass, summary: result.summary, ...(result.evidence ? { evidence: result.evidence } : {}) },
        });
      } else {
        for (const step of run.request.steps ?? []) {
          if (signal.aborted) break;
          await executor.run(step as Step);
        }
        this.store.update(run.id, {
          actionsUsed: (run.request.steps ?? []).length,
          verdict: { pass: true, summary: `all ${(run.request.steps ?? []).length} steps completed without error` },
        });
      }

      // A final frame is always worth having, whatever the verdict -- except
      // after an XCUITest run, which tears its own app down.
      if (run.mode !== 'xctest') {
        await executor.capture('final-state', 'Screen at the end of the run').catch((e) =>
          log.warn('final screenshot failed', (e as Error).message));
      }

      const current = this.store.get(run.id)!;
      const missing = (run.request.screenshots ?? []).filter(
        (w) => !current.screenshots.some((s) => s.name === w));

      let status: Run['status'];
      if (signal.aborted) status = 'timeout';
      else if (!current.verdict?.pass) status = 'failed';
      else if (missing.length) status = 'failed';
      else status = 'passed';

      if (missing.length && current.verdict?.pass) {
        this.store.update(run.id, {
          verdict: {
            pass: false,
            summary: `${current.verdict.summary} However, the run did not capture the requested screenshot(s): ${missing.join(', ')}.`,
            ...(current.verdict.evidence ? { evidence: current.verdict.evidence } : {}),
          },
        });
      }
      this.store.update(run.id, { status, finishedAt: nowIso() });

    } catch (e) {
      const aborted = signal.aborted;
      const message = aborted
        ? `run exceeded its ${Math.round(timeoutMs / 1000)}s budget`
        : (e as Error).message;
      log.error(`run ${run.id} ${aborted ? 'timed out' : 'errored'}`, message);
      // An error is a harness fault, not a verdict -- say what evidence survived
      // so the reader can tell a broken harness from a broken app.
      const kept = this.store.get(run.id)?.screenshots.length ?? 0;
      const withEvidence = kept && !aborted
        ? `${message} (${kept} screenshot${kept === 1 ? '' : 's'} captured before the failure are retained)`
        : message;
      this.store.trace(run.id, { kind: 'error', text: withEvidence });
      this.store.update(run.id, {
        status: aborted ? 'timeout' : 'error',
        error: withEvidence,
        finishedAt: nowIso(),
      });
    } finally {
      clearTimeout(timer);
      this.aborts.delete(run.id);
      this.store.forgetSecret(run.id);
      logStream?.kill();

      const finished = this.store.get(run.id)!;
      try {
        const report = writeReport(finished, runDir);
        this.store.update(run.id, { artifacts: { ...finished.artifacts, report } });
      } catch (e) {
        log.warn('could not write report', (e as Error).message);
      }

      // Only remove an app we put there -- never uninstall a preinstalled one.
      await this.pool.release(device.udid, {
        bundleId,
        uninstall: installedByUs,
        policy: run.request.resetPolicy ?? this.cfg.defaultResetPolicy,
      });
    }
  }

  /** Best-effort capture of the app's own log output. Never fatal. */
  private streamAppLog(udid: string, executable: string, runDir: string): { kill(): void } | null {
    try {
      const out = fs.openSync(path.join(runDir, 'app.log'), 'a');
      const child = spawn('xcrun', [
        'simctl', 'spawn', udid, 'log', 'stream',
        '--style', 'compact', '--level', 'default',
        '--predicate', `process == "${executable}"`,
      ], { stdio: ['ignore', out, out] });
      child.on('error', () => {});
      return { kill: () => { try { child.kill('SIGTERM'); } catch { /* gone */ } try { fs.closeSync(out); } catch { /* closed */ } } };
    } catch (e) {
      log.warn('app log stream unavailable', (e as Error).message);
      return null;
    }
  }
}
