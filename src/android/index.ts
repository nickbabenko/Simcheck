import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { Config } from '../config.js';
import type {
  DeviceBackend, DeviceTarget, ExistingDevice, LaunchTarget, LogStream,
  NativeTestContext, NativeTestOutcome, PlatformSupport, PrepareAppContext,
  PreparedApp, ScreenRecording, TouchDriver,
} from '../device.js';
import type { AppSpec, InstrumentationSpec } from '../types.js';
import { logger } from '../log.js';
import { Adb } from './adb.js';
import { UiAutomator } from './uiautomator.js';
import { resolveTools, isToolsError, type AndroidTools } from './sdk.js';
import {
  bootEmulator, createAvd, deleteAvd, killEmulator, listAvds, listSystemImages,
  preferredAbi, resolveSystemImage,
} from './avd.js';
import { prepareApp } from './build.js';
import { runInstrumentation } from './instrument.js';
import { readApk } from './apk.js';
import { resolveDriverApks, installDriver, UiAutomatorTouch, type DriverApks } from './touch.js';
import { applyGuestFirewallEarly, ensureGuestFirewall } from './firewall.js';
import { installHints, noMatchingAbiHint } from './hints.js';

const log = logger('android');

/** 180s each: half an hour of recording before it stops following. */
const MAX_RECORD_SEGMENTS = 10;

/**
 * Measured, not guessed: creating and first-booting a pixel_7 on an
 * already-installed API 35 image consumed 1.07GB.
 *
 * The intuition that an emulator is a whole virtual machine and must therefore
 * be huge is wrong in the way that matters here. The system image is the large
 * part and it is shared between every AVD built from it -- a one-off
 * sdkmanager download, not a per-device cost -- and the userdata image is
 * sparse, so a fresh device barely dents the disk. The budget is set well
 * above the measurement because userdata does grow as builds are installed
 * and caches fill, but a first guess of 10GB blocked pool creation on any
 * machine with less than 14GB free, for no reason at all.
 */
const DISK_COST_GB = 4;

/**
 * Short names for the permissions people actually ask about, so a step reads
 * the same on both platforms. A fully-qualified name is passed through
 * untouched, which is what any less common permission needs.
 */
const PERMISSION_ALIASES: Record<string, string> = {
  camera: 'android.permission.CAMERA',
  microphone: 'android.permission.RECORD_AUDIO',
  location: 'android.permission.ACCESS_FINE_LOCATION',
  'coarse-location': 'android.permission.ACCESS_COARSE_LOCATION',
  contacts: 'android.permission.READ_CONTACTS',
  calendar: 'android.permission.READ_CALENDAR',
  photos: 'android.permission.READ_MEDIA_IMAGES',
  notifications: 'android.permission.POST_NOTIFICATIONS',
};

const qualifyPermission = (service: string): string =>
  service.includes('.') ? service : (PERMISSION_ALIASES[service.toLowerCase()] ?? `android.permission.${service.toUpperCase().replace(/-/g, '_')}`);

class AndroidDevices implements DeviceBackend {
  readonly platform = 'android' as const;
  readonly deviceNoun = 'emulator';
  readonly diskCostGb = DISK_COST_GB;

  /** AVDs whose next boot must wipe userdata. The emulator can only do this
   *  at start-up, so an erase is recorded here and honoured by boot(). */
  private pendingWipe = new Set<string>();

  constructor(
    private cfg: Config,
    private tools: AndroidTools,
    readonly adb: Adb,
    private driver: DriverApks | null,
  ) {}

  async preflight(): Promise<string> {
    const version = await this.adb.version();
    if (!version) {
      throw new Error(
        `adb ("${this.tools.adb}") is not usable. Install it: ${installHints().adb}`);
    }
    if (!fs.existsSync(this.tools.emulator)) {
      throw new Error(
        `no emulator binary at ${this.tools.emulator}. Install it with: sdkmanager "emulator"`);
    }
    const images = listSystemImages(this.tools.sdkRoot);
    if (!images.length) {
      throw new Error(
        `no Android system images installed under ${this.tools.sdkRoot}. Install one with: ` +
        `sdkmanager "system-images;android-35;google_apis;${preferredAbi()}"`);
    }
    if (!this.tools.javaHome) {
      throw new Error(
        `no JDK found, and avdmanager needs one to create an AVD. Install one: ${installHints().jdk}`);
    }
    return `${version}, ${images.length} system image(s), JDK at ${this.tools.javaHome}`;
  }

  async resolveTarget(deviceType: string, runtime: string): Promise<DeviceTarget> {
    const image = resolveSystemImage(this.tools.sdkRoot, runtime);
    const profile = deviceType || 'pixel_7';
    return {
      deviceType: profile,
      runtime: image.label,
      deviceTypeId: profile,
      runtimeId: image.packageId,
    };
  }

  async create(name: string, target: DeviceTarget): Promise<string> {
    await createAvd(this.tools, name, target);
    return name;                      // the AVD name is the stable identity
  }

  async list(): Promise<ExistingDevice[]> {
    const booted = new Set((await this.adb.refresh().catch(() => new Map())).keys());
    return listAvds(booted);
  }

  async boot(id: string): Promise<void> {
    const wipeData = this.pendingWipe.has(id);
    const firewall = this.cfg.androidGuestFirewall;
    const serial = await bootEmulator(this.tools, this.adb, id, {
      logDir: this.cfg.home,
      wipeData,
      gpu: this.cfg.androidGpu,
      bootTimeoutMs: this.cfg.androidBootTimeoutMs,
      extraArgs: this.cfg.androidEmulatorArgs ?? [],
      ...(firewall !== 'off' ? { onAttached: (s: string) => applyGuestFirewallEarly(this.adb, s) } : {}),
    });
    this.pendingWipe.delete(id);

    // Before anything else touches the device: an emulator whose apps can
    // reach the host's adb server is not handed out (in "required" mode, a
    // throw here marks it offline with the reason).
    await ensureGuestFirewall(this.adb, serial, firewall);

    // Espresso explicitly requires animations off, and says so in the failure
    // when they are not: a transition in flight leaves a view VISIBLE but
    // unlaid-out, and the click is refused for covering 0% of its own area.
    // It also steadies the outside-in driver, whose taps race the same
    // transitions. A pooled device exists to be predictable, so this belongs
    // at boot rather than in each caller's test setup.
    for (const scale of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
      await this.adb.shellTry(serial, `settings put global ${scale} 0`, { timeoutMs: 30_000 })
        .catch(() => log.warn(`could not disable ${scale} on ${id}`));
    }

    // The multi-touch driver is per-device state, so it goes on at boot rather
    // than being reinstalled before every gesture.
    if (this.driver) {
      await installDriver(this.adb, serial, this.driver)
        .catch((e) => log.warn(`could not install the multi-touch driver on ${id}`, (e as Error).message));
    }
  }

  async shutdown(id: string): Promise<void> {
    await killEmulator(this.adb, id);
  }

  /** Recorded, not performed: userdata can only be wiped as the emulator
   *  starts, and the pool always boots straight after erasing. */
  async erase(id: string): Promise<void> {
    this.pendingWipe.add(id);
  }

  async destroy(id: string): Promise<void> {
    await killEmulator(this.adb, id);
    await deleteAvd(this.tools, id);
    this.pendingWipe.delete(id);
  }

  async install(id: string, appPath: string): Promise<void> {
    const serial = await this.adb.serialFor(id);
    const r = await this.adb.rawTry(serial, ['install', '-r', '-t', appPath], { timeoutMs: 300_000 });
    const out = r.stdout + r.stderr;
    if (r.code !== 0 || /Failure|INSTALL_FAILED/i.test(out)) {
      throw new Error(`adb install failed: ${installHint(out)}`);
    }
  }

  async uninstall(id: string, appId: string): Promise<void> {
    const serial = await this.adb.serialForOrNull(id);
    if (!serial) return;
    // Not installed is fine -- that is the state we wanted.
    await this.adb.rawTry(serial, ['uninstall', appId], { timeoutMs: 120_000 });
  }

  async isInstalled(id: string, appId: string): Promise<boolean> {
    const serial = await this.adb.serialFor(id);
    const r = await this.adb.shellTry(serial, `pm list packages ${appId}`, { timeoutMs: 30_000 });
    return r.out.split('\n').some((l) => l.trim() === `package:${appId}`);
  }

  /**
   * Start the app and report its pid.
   *
   * `am start` names a component, so the launchable activity has to be known;
   * where it is not, monkey's launcher intent is the fallback that does not
   * need one. Environment variables have no Android equivalent, so
   * `launchEnv` becomes string intent extras -- which is the nearest true
   * thing, and is documented as such rather than silently dropped.
   */
  async launch(id: string, app: LaunchTarget, args: string[], env: Record<string, string>): Promise<number> {
    const serial = await this.adb.serialFor(id);
    if (args.length) {
      throw new Error(
        'launchArgs has no Android equivalent -- an app is started by intent, not with argv. ' +
        'Use launchEnv, which becomes string intent extras.');
    }

    // A launcher entry declared as an <activity-alias> never reaches the APK
    // manifest dump, so the device is asked instead -- PackageManager knows.
    let activity = app.activity;
    if (!activity) {
      activity = await this.resolveLauncherActivity(serial, app.appId);
      if (activity) log.info(`resolved ${app.appId} launcher activity on the device: ${activity}`);
    }

    let command: string;
    if (activity) {
      const extras = Object.entries(env)
        .map(([k, v]) => `--es ${shellQuote(k)} ${shellQuote(v)}`).join(' ');
      // -W waits for the launch to complete, so a screenshot straight after
      // is of the app rather than of whatever was on screen before it.
      command = `am start -W -n ${shellQuote(`${app.appId}/${activity}`)} ${extras}`.trim();
    } else {
      if (Object.keys(env).length) {
        throw new Error(
          `cannot pass launchEnv to ${app.appId}: its launchable activity could not be resolved, so ` +
          'the harness must start it with monkey, which cannot carry extras. Name the activity in the APK manifest, or drop launchEnv.');
      }
      command = `monkey -p ${shellQuote(app.appId)} -c android.intent.category.LAUNCHER 1`;
    }

    const started = await this.adb.shellTry(serial, command, { timeoutMs: 120_000 });
    if (started.code !== 0 || /Error:|Exception/.test(started.out)) {
      throw new Error(`launching ${app.appId} failed: ${started.out.trim().slice(0, 400)}`);
    }
    const pid = await this.adb.shellTry(serial, `pidof -s ${shellQuote(app.appId)}`, { timeoutMs: 30_000 });
    return Number(pid.out.trim()) || 0;
  }

  /**
   * Ask PackageManager which activity a launcher tap would start.
   *
   * The authoritative answer, and the only one that accounts for an
   * <activity-alias>. Returns undefined rather than throwing: monkey's
   * launcher intent is a perfectly good fallback.
   */
  private async resolveLauncherActivity(serial: string, pkg: string): Promise<string | undefined> {
    const r = await this.adb.shellTry(serial,
      `cmd package resolve-activity --brief ${shellQuote(pkg)}`, { timeoutMs: 30_000 });
    // The brief form prints "com.example/.MainActivity" on its last line.
    const line = r.out.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (!line || !line.includes('/')) return undefined;
    const [owner, activity] = line.split('/');
    if (owner !== pkg || !activity) return undefined;
    return activity.startsWith('.') ? `${pkg}${activity}` : activity;
  }

  async terminate(id: string, appId: string): Promise<void> {
    const serial = await this.adb.serialForOrNull(id);
    if (!serial) return;
    await this.adb.shellTry(serial, `am force-stop ${shellQuote(appId)}`, { timeoutMs: 60_000 });
  }

  async openUrl(id: string, url: string): Promise<void> {
    const serial = await this.adb.serialFor(id);
    const r = await this.adb.shellTry(serial,
      `am start -a android.intent.action.VIEW -d ${shellQuote(url)}`, { timeoutMs: 60_000 });
    if (/Error:/.test(r.out)) throw new Error(`opening ${url} failed: ${r.out.trim().slice(0, 300)}`);
  }

  async setAppearance(id: string, mode: 'light' | 'dark'): Promise<void> {
    const serial = await this.adb.serialFor(id);
    await this.adb.shell(serial, `cmd uimode night ${mode === 'dark' ? 'yes' : 'no'}`, { timeoutMs: 60_000 });
  }

  async setPermission(id: string, grant: boolean, service: string, appId: string): Promise<void> {
    const serial = await this.adb.serialFor(id);
    const permission = qualifyPermission(service);
    const r = await this.adb.shellTry(serial,
      `pm ${grant ? 'grant' : 'revoke'} ${shellQuote(appId)} ${permission}`, { timeoutMs: 60_000 });
    if (r.code !== 0 || /Operation not allowed|Unknown permission|SecurityException/i.test(r.out)) {
      throw new Error(
        `could not ${grant ? 'grant' : 'revoke'} ${permission} for ${appId}: ${r.out.trim().slice(0, 300)}. ` +
        'Only runtime permissions declared in the manifest can be changed this way.');
    }
  }

  /**
   * Nothing to do, and that is a real platform difference rather than a gap.
   *
   * Uninstalling on Android drops every grant with the package, so a fresh
   * install already prompts afresh. iOS keeps TCC grants past an uninstall,
   * which is why it needs an explicit reset.
   */
  async resetPermissions(): Promise<void> {}

  async screenshot(id: string, outPath: string): Promise<void> {
    const serial = await this.adb.serialFor(id);
    await this.adb.execOutToFile(serial, ['screencap', '-p'], outPath, 60_000);
  }

  /**
   * `adb shell screenrecord`, which Android caps at 180s per file. A segment
   * that ends on that cap is followed by the next, and `stop` pulls them all;
   * the transcoder joins them. A segment that dies within seconds means the
   * recorder does not work here, so it is not restarted in a loop.
   */
  async recordVideo(id: string, outPath: string): Promise<ScreenRecording> {
    const serial = await this.adb.serialFor(id);
    const tag = `simcheck-${Date.now().toString(36)}`;
    const remotes: string[] = [];
    let stopping = false;
    let current: ReturnType<typeof spawn> | null = null;
    let deadNote = '';

    const segment = (): void => {
      const remote = `/sdcard/${tag}-${remotes.length}.mp4`;
      remotes.push(remote);
      const began = Date.now();
      const child = spawn(this.tools.adb, ['-s', serial, 'shell', 'screenrecord',
        '--time-limit', '180', '--bit-rate', '4000000', remote], {
        stdio: 'ignore', env: { ...process.env, ...this.tools.env },
      });
      current = child;
      child.on('error', (e) => { deadNote = `screenrecord failed to start: ${e.message}`; });
      child.once('exit', () => {
        if (stopping) return;
        if (Date.now() - began < 5_000) { deadNote ||= 'screenrecord exited within seconds of starting'; return; }
        if (remotes.length < MAX_RECORD_SEGMENTS) segment();
      });
    };
    segment();

    const exited = (c: ReturnType<typeof spawn> | null): Promise<void> => new Promise((resolve) => {
      if (!c || c.exitCode !== null || c.signalCode !== null) return resolve();
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 15_000);
      c.once('exit', () => { clearTimeout(t); resolve(); });
    });

    return {
      stop: async () => {
        stopping = true;
        // Interrupt on the device, so the mp4's index is written.
        await this.adb.shellTry(serial, 'pkill -INT screenrecord', { timeoutMs: 10_000 }).catch(() => undefined);
        await exited(current);
        await new Promise((r) => setTimeout(r, 500));
        const files: string[] = [];
        for (const [i, remote] of remotes.entries()) {
          const local = outPath.replace(/\.mp4$/, '') + `.${i}.mp4`;
          await this.adb.rawTry(serial, ['pull', remote, local], { timeoutMs: 120_000 });
          await this.adb.shellTry(serial, `rm -f ${remote}`, { timeoutMs: 10_000 }).catch(() => undefined);
          try { if (fs.statSync(local).size > 1024) files.push(local); else fs.rmSync(local, { force: true }); } catch { /* not pulled */ }
        }
        return files.length ? { files } : { files, note: deadNote || 'screenrecord produced no usable file' };
      },
    };
  }

  /**
   * Follow the app's logcat output.
   *
   * logcat can filter by pid but not by a process that has not started yet,
   * and this is called before launch. So the wait happens on the device: a
   * short shell loop blocks until the process exists, then hands its pid to
   * logcat. Bounded, so a never-launching app does not leave a spinner behind.
   */
  streamLog(id: string, app: LaunchTarget, outPath: string): LogStream | null {
    try {
      const serial = this.adb.cachedSerial(id);
      if (!serial) return null;
      const out = fs.openSync(outPath, 'a');
      const pkg = shellQuote(app.appId);
      const script =
        `for i in $(seq 1 150); do p=$(pidof -s ${pkg}); ` +
        `if [ -n "$p" ]; then logcat -v threadtime --pid=$p; exit 0; fi; sleep 0.2; done; ` +
        `echo "simcheck: ${app.appId} never started, so no app log was captured"`;

      const child = spawn(this.tools.adb, ['-s', serial, 'shell', script], {
        stdio: ['ignore', out, out],
        env: { ...process.env, ...this.tools.env },
      });
      child.on('error', () => {});
      return {
        kill: () => {
          try { child.kill('SIGTERM'); } catch { /* gone */ }
          try { fs.closeSync(out); } catch { /* closed */ }
        },
      };
    } catch (e) {
      log.warn('app log stream unavailable', (e as Error).message);
      return null;
    }
  }
}

/** Single-quote for the device shell, closing and reopening around any quote. */
const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Turn the common install failures into something actionable. */
function installHint(out: string): string {
  const trimmed = out.trim().slice(0, 500);
  if (/INSTALL_FAILED_NO_MATCHING_ABIS/.test(out)) {
    return `${trimmed}\n${noMatchingAbiHint()}`;
  }
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(out)) {
    return `${trimmed}\nA different build of this package is already installed; the pool will uninstall it between runs, but a leftover from outside the harness has to go by hand.`;
  }
  if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/.test(out)) {
    return `${trimmed}\nThe emulator's data partition is full. Recycle it with resetPolicy "erase".`;
  }
  return trimmed;
}

/**
 * Assemble Android support, probing the toolchain and the optional multi-touch
 * driver once at startup. Throws if the required pieces are missing -- the
 * caller decides whether that is fatal or just means "no Android today".
 */
export async function createAndroidPlatform(cfg: Config): Promise<PlatformSupport> {
  const tools = resolveTools(cfg);
  if (isToolsError(tools)) throw new Error(tools.error);

  const adb = new Adb(tools.adb, tools.env);
  const driver = resolveDriverApks(cfg);
  const devices = new AndroidDevices(cfg, tools, adb, driver);

  const version = await devices.preflight();
  log.info(version);
  log.info(driver
    ? 'multi-touch via the simcheck driver APK'
    : 'multi-touch unavailable (driver APK not built) -- run ./driver/build.sh; pinch/pan/double_tap will fail with a hint');

  return {
    id: 'android',
    devices,
    ui: (deviceId: string) => new UiAutomator(adb, deviceId),
    touch: (deviceId: string): TouchDriver | undefined =>
      driver ? new UiAutomatorTouch(adb, deviceId, driver) : undefined,
    prepareApp: (spec: AppSpec, ctx: PrepareAppContext): Promise<PreparedApp> =>
      prepareApp(cfg, tools, adb, spec, ctx),
    runNativeTests: (spec: unknown, ctx: NativeTestContext): Promise<NativeTestOutcome> =>
      runInstrumentation(tools, adb, spec as InstrumentationSpec, ctx),
  };
}

/** Read a package name out of an APK, for the artifact store. */
export function androidManifestReader(cfg: Config): ((apkPath: string) => Promise<string>) | null {
  const tools = resolveTools(cfg);
  if (isToolsError(tools)) return null;
  return async (apkPath: string) => (await readApk(tools, apkPath)).packageName;
}
