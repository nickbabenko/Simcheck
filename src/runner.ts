import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { Pool } from './pool.js';
import type { Store } from './store.js';
import type { Llm } from './llm.js';
import type { ArtifactStore } from './artifacts.js';
import type { Platforms } from './platforms.js';
import type { LaunchTarget } from './device.js';
import type { PooledDevice, Run, Step } from './types.js';
import { isNativeTestMode } from './types.js';
import { StepExecutor } from './steps.js';
import { runScenario } from './agent.js';
import { writeReport } from './report.js';
import { logger } from './log.js';
import { nowIso, sleep } from './util.js';

const log = logger('runner');

/** Host only -- a signed CI URL can carry credentials in its query string. */
const safeHost = (url: string): string => {
  try { return new URL(url).hostname; } catch { return 'the given URL'; }
};

/**
 * Owns the lifecycle of one run on one leased device:
 * prepare the build, install it, drive the scenario, write the evidence,
 * then hand the device back to the pool in a clean state.
 *
 * Which platform that device belongs to is settled once, here, by looking it
 * up in the registry; everything below works through the platform interfaces.
 */
export class Runner {
  private aborts = new Map<string, AbortController>();

  constructor(
    private cfg: Config,
    private pool: Pool,
    private store: Store,
    private llm: Llm | null,
    private artifacts: ArtifactStore,
    private platforms: Platforms,
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
    // A native test run compiles a test bundle before it runs anything, so it
    // can legitimately outlast the default budget. Honour its own timeout
    // rather than aborting it from underneath -- otherwise the subprocess
    // limit is meaningless and the run reports "no tests ran" for no visible
    // reason.
    const nativeTest = run.request.xctest ?? run.request.instrumentation;
    const timeoutMs = Math.max(
      run.request.timeoutMs ?? this.cfg.defaultTimeoutMs,
      nativeTest?.timeoutMs ?? 0,
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = controller.signal;

    const runDir = this.store.dir(run.id);
    const platform = this.platforms.get(device.platform);
    const ui = platform.ui(device.udid);
    // Optional: absent, only the multi-touch steps fail, and they say why.
    const touch = platform.touch(device.udid);
    let launchTarget: LaunchTarget | undefined;
    let bundleId: string | undefined;
    let installedByUs = false;
    let logStream: { kill(): void } | null = null;

    this.store.update(run.id, {
      status: 'preparing',
      startedAt: nowIso(),
      device: {
        udid: device.udid, name: device.name,
        runtime: device.runtime, platform: device.platform,
      },
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
          : (appSpec.scheme || appSpec.module) ? 'building from source'
          : `using the app already installed on the ${platform.devices.deviceNoun}`,
      });
      // Real download headers live only in memory, never on the run record.
      const secretHeaders = this.store.takeSecret(run.id);
      const appSpecForRun = secretHeaders
        ? { ...run.request.app, urlHeaders: secretHeaders }
        : run.request.app;
      const describesAnApp = Boolean(
        appSpecForRun && (appSpecForRun.path || appSpecForRun.scheme || appSpecForRun.bundleId
          || appSpecForRun.artifactId || appSpecForRun.url || appSpecForRun.github
          || appSpecForRun.module));

      const app = describesAnApp
        ? await platform.prepareApp(appSpecForRun, {
            deviceId: device.udid, runDir, artifacts: this.artifacts, signal,
          })
        : null;

      if (app) {
        bundleId = app.bundleId;
        launchTarget = {
          appId: app.bundleId,
          executable: app.executable,
          ...(app.activity ? { activity: app.activity } : {}),
        };
        this.store.update(run.id, {
          bundleId, ...(app.appPath ? { appPath: app.appPath } : {}),
          artifacts: { ...run.artifacts, ...(app.buildLog && fs.existsSync(app.buildLog) ? { buildLog: 'build.log' } : {}) },
        });
      }
      this.store.trace(run.id, {
        kind: 'note',
        text: !app ? 'no app named -- the platform test runner will build and install it'
          : app.appPath ? `app ${bundleId} at ${app.appPath}`
          : `app ${bundleId} (already installed)`,
      });

      /* -- install and launch --------------------------------------------- */
      if (app?.appPath && bundleId) {
        await platform.devices.uninstall(device.udid, bundleId);
        await platform.devices.install(device.udid, app.appPath);
        installedByUs = true;
        this.store.trace(run.id, { kind: 'note', text: 'installed' });
      }

      logStream = launchTarget
        ? platform.devices.streamLog(device.udid, launchTarget, path.join(runDir, 'app.log'))
        : null;
      if (logStream) {
        const cur = this.store.get(run.id)!;
        this.store.update(run.id, { artifacts: { ...cur.artifacts, appLog: 'app.log' } });
      }

      const executor = new StepExecutor(ui, platform.devices, this.store, {
        runId: run.id,
        udid: device.udid,
        app: launchTarget ?? { appId: bundleId ?? '', executable: bundleId ?? '' },
        runDir,
        launchArgs: appSpec.launchArgs ?? [],
        launchEnv: appSpec.launchEnv ?? {},
        signal,
      }, touch);

      this.store.update(run.id, { status: 'running' });
      if (!isNativeTestMode(run.mode)) {
        // The platform's test runner installs and launches the app itself.
        await executor.run({ action: 'launch' });
        await sleep(1200, signal);
      }

      /* -- drive ----------------------------------------------------------- */
      if (isNativeTestMode(run.mode)) {
        const outcome = await platform.runNativeTests(nativeTest!, {
          deviceId: device.udid, runDir, signal,
        });
        // Attachments the suite recorded become part of the evidence,
        // alongside whatever the harness captured itself.
        const current = this.store.get(run.id)!;
        for (const a of outcome.attachments.filter((x) => /\.(png|jpe?g)$/i.test(x.file))) {
          current.screenshots.push({
            name: a.test ? `${a.test}-${a.name}` : a.name,
            file: a.file,
            at: nowIso(),
            note: a.associatedWithFailure
              ? `attachment from the failure in ${a.test ?? 'a test'}`
              : `attachment from ${a.test ?? 'a test'}`,
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
          artifacts: { ...current.artifacts, testLog: outcome.logFile },
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
      // after a native test run, which tears its own app down.
      if (!isNativeTestMode(run.mode)) {
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
}
