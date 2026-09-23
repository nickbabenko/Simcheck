import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { Pool } from './pool.js';
import type { Store } from './store.js';
import type { Llm } from './llm.js';
import type { ArtifactStore } from './artifacts.js';
import type { Platforms } from './platforms.js';
import type { DeviceBackend, LaunchTarget, ScreenRecording } from './device.js';
import type { PooledDevice, ResetPolicy, Run, Step } from './types.js';
import { isNativeTestMode } from './types.js';
import { StepExecutor, AssertionFailed, lintDeepLinks } from './steps.js';
import { phase, recordPhase, mergeTimings, elapsedMs, monotonic } from './timings.js';
import { decideAndroidPreRunErase, decideInstall, decideRelease, tenantOf } from './warm.js';
import { runScenario } from './agent.js';
import { writeReport } from './report.js';
import { transcode, RAW_VIDEO } from './video.js';
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
    let appHash: string | undefined;
    let logStream: { kill(): void } | null = null;
    let recording: ScreenRecording | null = null;
    let rawVideo: string[] = [];
    const tenant = tenantOf(run);
    const requestedPolicy: ResetPolicy = run.request.resetPolicy ?? this.cfg.defaultResetPolicy;

    // Monotonic from here: an ISO diff across a long install can be bent by a
    // clock step. queueMs is the exception -- it spans the scheduler, and its
    // start only exists as createdAt.
    const leasedAt = monotonic();
    const startedAt = nowIso();
    this.store.update(run.id, {
      status: 'preparing',
      startedAt,
      device: {
        udid: device.udid, name: device.name,
        runtime: device.runtime, platform: device.platform,
      },
      timings: { ...run.timings, queueMs: Math.max(0, Date.parse(startedAt) - Date.parse(run.createdAt)) },
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
        ? await phase(this.store, run.id, 'prepareMs', () => platform.prepareApp(appSpecForRun, {
            deviceId: device.udid, runDir, artifacts: this.artifacts, signal,
          }))
        : null;
      appHash = app?.contentHash;

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
      const wipeReason = decideAndroidPreRunErase({
        platform: device.platform, device: this.pool.get(device.udid) ?? device, tenant,
      });
      if (wipeReason) {
        this.store.trace(run.id, { kind: 'note', text: wipeReason });
        await phase(this.store, run.id, 'preResetMs', () => this.pool.eraseLeased(device.udid, signal));
        this.store.update(run.id, { warm: { cacheHit: false, reason: wipeReason, erased: true, resetPolicyRequested: requestedPolicy } });
      }

      if (app?.appPath && bundleId) {
        const id = bundleId;
        const appPath = app.appPath;
        const pooled = this.pool.get(device.udid) ?? device;
        const decision = decideInstall({ device: pooled, bundleId: id, appHash, tenant, resetPolicy: requestedPolicy });

        if (decision.erase) {
          this.store.trace(run.id, { kind: 'note', text: decision.reason });
          await phase(this.store, run.id, 'preResetMs', () => this.pool.eraseLeased(device.udid, signal));
        }

        let reused = false;
        await phase(this.store, run.id, 'installMs', async () => {
          // The record is a cache, never the truth: check the device.
          if (decision.action === 'reuse' && await platform.devices.isInstalled(device.udid, id)) {
            reused = true;
            return;
          }
          // A different app left warm by an earlier relaunch run: not ours to
          // keep once this device moves on to another build.
          const stale = this.pool.get(device.udid)?.installed;
          if (stale && stale.bundleId !== id) {
            await platform.devices.uninstall(device.udid, stale.bundleId).catch(() => {});
          }
          await platform.devices.uninstall(device.udid, id);
          await platform.devices.install(device.udid, appPath);
        });
        installedByUs = true;
        const reason = decision.action === 'reuse' && !reused
          ? 'the cache said this build was installed, but the device disagreed; reinstalled'
          : decision.reason;
        this.store.update(run.id, {
          warm: {
            cacheHit: reused, reason,
            ...(decision.erase || wipeReason ? { erased: true } : {}),
            resetPolicyRequested: requestedPolicy,
          },
        });
        this.store.trace(run.id, {
          kind: 'note',
          text: reused ? `warm: install skipped -- ${reason}` : `installed (${reason})`,
        });
      }

      logStream = launchTarget
        ? platform.devices.streamLog(device.udid, launchTarget, path.join(runDir, 'app.log'))
        : null;
      if (logStream) {
        const cur = this.store.get(run.id)!;
        this.store.update(run.id, { artifacts: { ...cur.artifacts, appLog: 'app.log' } });
      }

      // After install, before launch: the film starts on the home screen and
      // shows the app coming up.
      if (run.request.record) recording = await this.startRecording(run.id, platform.devices, device.udid, runDir);

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
        await phase(this.store, run.id, 'launchMs', async () => {
          await executor.run({ action: 'launch' });
          await sleep(1200, signal);
        });
      }

      /* -- drive ----------------------------------------------------------- */
      if (isNativeTestMode(run.mode)) {
        const outcome = await phase(this.store, run.id, 'nativeTestMs', () => platform.runNativeTests(nativeTest!, {
          deviceId: device.udid, runDir, signal,
        }));
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
        const llm = this.llm;
        const result = await phase(this.store, run.id, 'stepsMs', () => runScenario({
          llm, run, store: this.store, exec: executor, runDir,
          maxActions: run.request.maxActions ?? this.cfg.defaultMaxActions,
          signal,
        }));
        this.store.update(run.id, {
          actionsUsed: result.actionsUsed,
          verdict: { pass: result.pass, summary: result.summary, ...(result.evidence ? { evidence: result.evidence } : {}) },
        });
      } else {
        const steps = (run.request.steps ?? []) as Step[];
        for (const warning of lintDeepLinks(steps)) {
          this.store.trace(run.id, { kind: 'note', text: warning });
        }
        let failedAssertion: string | null = null;
        let done = 0;
        await phase(this.store, run.id, 'stepsMs', async () => {
          for (const step of steps) {
            if (signal.aborted) break;
            try {
              await executor.run(step);
              done++;
            } catch (e) {
              // A missed `assert` is a verdict on the app, not a harness
              // fault: the run fails, it does not error.
              if (e instanceof AssertionFailed) { failedAssertion = e.message; done++; break; }
              throw e;
            }
          }
        });
        this.store.update(run.id, {
          actionsUsed: done,
          verdict: failedAssertion
            ? { pass: false, summary: `assertion failed at step ${done} of ${steps.length}: ${failedAssertion}` }
            : { pass: true, summary: `all ${steps.length} steps completed without error` },
        });
      }

      // A final frame is always worth having, whatever the verdict -- except
      // after a native test run, which tears its own app down.
      if (!isNativeTestMode(run.mode)) {
        await phase(this.store, run.id, 'screenshotMs',
          () => executor.capture('final-state', 'Screen at the end of the run')).catch((e) =>
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
      // Before the reset, so the film ends on the run's last frame rather than
      // on the app being uninstalled.
      if (recording) rawVideo = await this.stopRecording(run.id, recording);

      const finished = this.store.get(run.id)!;
      try {
        const report = writeReport(finished, runDir);
        this.store.update(run.id, { artifacts: { ...finished.artifacts, report } });
      } catch (e) {
        log.warn('could not write report', (e as Error).message);
      }

      // Only remove an app we put there -- never uninstall a preinstalled one.
      const usedPolicy = decideRelease({
        requested: requestedPolicy, status: finished.status, ours: installedByUs, appHash,
      });
      const ranMs = elapsedMs(leasedAt, monotonic());
      const t0 = monotonic();
      await this.pool.release(device.udid, {
        bundleId,
        uninstall: installedByUs,
        policy: usedPolicy,
        // On Android any run can leave files in shared storage, whoever
        // installed the app, so the device always learns who used it.
        ...(installedByUs || device.platform === 'android' ? { tenant } : {}),
        ...(usedPolicy === 'relaunch' && installedByUs && bundleId && appHash ? { keep: { bundleId, appHash } } : {}),
      });
      const resetMs = elapsedMs(t0, monotonic());

      // The reset is device time this run caused, so it is billed to it even
      // though it happens after the run's own status went terminal.
      const after = this.store.get(run.id);
      if (after) {
        recordPhase(this.store, run.id, 'resetMs', resetMs);
        const queueMs = after.timings?.queueMs ?? 0;
        mergeTimings(this.store, run.id, { occupancyMs: ranMs + resetMs, totalMs: queueMs + ranMs + resetMs });
        if (after.warm || usedPolicy !== requestedPolicy) {
          this.store.update(run.id, {
            warm: {
              cacheHit: false, reason: 'no app installed by the harness', ...after.warm,
              resetPolicyRequested: requestedPolicy, resetPolicyUsed: usedPolicy,
            },
          });
        }
        if (usedPolicy !== requestedPolicy) {
          this.store.trace(run.id, {
            kind: 'note',
            text: `reset downgraded from "${requestedPolicy}" to "${usedPolicy}" -- a run that did not finish cleanly never leaves its app behind`,
          });
        }
        // The device is back in the pool, so converting costs no device time.
        if (rawVideo.length) await this.convertRecording(run.id, rawVideo, runDir);
        // Once more, now the reset and occupancy are known. The first write
        // stays, so a reader who wakes on the terminal status has a report.
        try {
          writeReport(this.store.get(run.id)!, runDir);
        } catch (e) {
          log.warn('could not rewrite report', (e as Error).message);
        }
        // Last, because it is what a settled waiter wakes on.
        this.store.update(run.id, { releasedAt: nowIso() });
      }
    }
  }

  /** Start recording; a failure is a trace note and the run goes on. */
  private async startRecording(
    runId: string, devices: DeviceBackend, udid: string, runDir: string,
  ): Promise<ScreenRecording | null> {
    if (!devices.recordVideo) {
      this.store.trace(runId, { kind: 'note', text: `recording is not supported on this ${devices.deviceNoun}; the run continues without video` });
      return null;
    }
    try {
      return await devices.recordVideo(udid, path.join(runDir, RAW_VIDEO));
    } catch (e) {
      this.store.trace(runId, { kind: 'note', text: `could not start recording: ${(e as Error).message}; the run continues without video` });
      return null;
    }
  }

  private async stopRecording(runId: string, recording: ScreenRecording): Promise<string[]> {
    try {
      const { files, note } = await recording.stop();
      if (note) this.store.trace(runId, { kind: 'note', text: `recording: ${note}` });
      return files;
    } catch (e) {
      this.store.trace(runId, { kind: 'note', text: `recording did not stop cleanly: ${(e as Error).message}` });
      return [];
    }
  }

  /** Raw capture -> video.mp4 + preview.gif, timed as recordMs. Never throws. */
  private async convertRecording(runId: string, raw: string[], runDir: string): Promise<void> {
    const t0 = monotonic();
    try {
      const out = await transcode(raw, runDir);
      const cur = this.store.get(runId)!;
      this.store.update(runId, {
        artifacts: {
          ...cur.artifacts,
          ...(out.video ? { video: out.video } : {}),
          ...(out.preview ? { preview: out.preview } : {}),
        },
      });
      for (const note of out.notes) this.store.trace(runId, { kind: 'note', text: `recording: ${note}` });
    } catch (e) {
      this.store.trace(runId, { kind: 'note', text: `recording could not be converted: ${(e as Error).message}` });
    }
    mergeTimings(this.store, runId, { recordMs: elapsedMs(t0, monotonic()) });
  }
}
