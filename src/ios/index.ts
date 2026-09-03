import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { Config } from '../config.js';
import type {
  DeviceBackend, DeviceTarget, ExistingDevice, LaunchTarget, LogStream,
  NativeTestContext, NativeTestOutcome, PlatformSupport, PrepareAppContext,
  PreparedApp, TouchDriver,
} from '../device.js';
import type { AppSpec, XcTestSpec } from '../types.js';
import { logger } from '../log.js';
import { exec } from '../util.js';
import * as simctl from './simctl.js';
import { Axe } from './axe.js';
import { Baguette } from './baguette.js';
import { prepareApp } from './build.js';
import { runXcTest } from './xctest.js';

const log = logger('ios');

/**
 * Measured, not guessed: creating and first-booting a simulator on a fresh
 * runtime consumed ~8GB, far more than the ~3GB a settled device reports as
 * `dataPathSize`. Most of it is transient and APFS reclaims it lazily, but
 * the peak is what matters when deciding whether there is room.
 */
const DISK_COST_GB = 8;

const runtimeLabel = (identifier: string): string => {
  const m = identifier.match(/SimRuntime\.(\w+)-([\d-]+)$/);
  return m ? `${m[1]} ${m[2]!.replace(/-/g, '.')}` : identifier;
};

class IosDevices implements DeviceBackend {
  readonly platform = 'ios' as const;
  readonly deviceNoun = 'simulator';
  readonly diskCostGb = DISK_COST_GB;

  constructor(private cfg: Config) {}

  async preflight(): Promise<string> {
    const xcode = await exec('xcrun', ['simctl', 'help'], { timeoutMs: 30_000 });
    if (xcode.code !== 0) {
      throw new Error('xcrun simctl is unavailable. Install Xcode and run: sudo xcode-select -s /Applications/Xcode.app');
    }
    const version = await Axe.available(this.cfg.axeBin);
    if (!version) {
      throw new Error(
        `the AXe CLI ("${this.cfg.axeBin}") is not on PATH. It drives taps and typing on the simulator.\n` +
        '  brew tap cameroncooke/axe && brew trust cameroncooke/axe && brew install axe');
    }
    return `axe ${version}`;
  }

  async resolveTarget(deviceType: string, runtime: string): Promise<DeviceTarget> {
    const rt = await simctl.resolveRuntime(runtime);
    const dt = await simctl.resolveDeviceType(deviceType, rt);
    return {
      deviceType: dt.name,
      runtime: rt.name || `iOS ${rt.version}`,
      deviceTypeId: dt.identifier,
      runtimeId: rt.identifier,
    };
  }

  create(name: string, target: DeviceTarget): Promise<string> {
    return simctl.create(name, target.deviceTypeId, target.runtimeId);
  }

  async list(): Promise<ExistingDevice[]> {
    return (await simctl.listDevices()).map((d) => ({
      id: d.udid,
      name: d.name,
      deviceType: d.deviceTypeIdentifier.split('.').pop()!.replace(/-/g, ' '),
      runtime: runtimeLabel(d.runtimeIdentifier),
      booted: d.state === 'Booted',
      available: d.isAvailable,
    }));
  }

  boot = (id: string) => simctl.boot(id);
  shutdown = (id: string) => simctl.shutdown(id);
  erase = (id: string) => simctl.erase(id);
  destroy = (id: string) => simctl.deleteDevice(id);

  install = (id: string, appPath: string) => simctl.install(id, appPath);
  uninstall = (id: string, appId: string) => simctl.uninstall(id, appId);
  isInstalled = (id: string, appId: string) => simctl.isInstalled(id, appId);
  launch = (id: string, app: LaunchTarget, args: string[], env: Record<string, string>) =>
    simctl.launch(id, app.appId, args, env);
  terminate = (id: string, appId: string) => simctl.terminate(id, appId);
  openUrl = (id: string, url: string) => simctl.openUrl(id, url);
  setAppearance = (id: string, mode: 'light' | 'dark') => simctl.setAppearance(id, mode);
  setPermission = (id: string, grant: boolean, service: string, appId: string) =>
    simctl.setPrivacy(id, grant, service, appId);
  resetPermissions = (id: string, appId: string) => simctl.resetPrivacy(id, appId);
  screenshot = (id: string, outPath: string) => simctl.screenshot(id, outPath);

  streamLog(id: string, app: LaunchTarget, outPath: string): LogStream | null {
    try {
      const out = fs.openSync(outPath, 'a');
      const child = spawn('xcrun', [
        'simctl', 'spawn', id, 'log', 'stream',
        '--style', 'compact', '--level', 'default',
        '--predicate', `process == "${app.executable}"`,
      ], { stdio: ['ignore', out, out] });
      child.on('error', () => {});
      return { kill: () => { try { child.kill('SIGTERM'); } catch { /* gone */ } try { fs.closeSync(out); } catch { /* closed */ } } };
    } catch (e) {
      log.warn('app log stream unavailable', (e as Error).message);
      return null;
    }
  }
}

/**
 * Assemble iOS support, probing the optional multi-touch driver once at
 * startup rather than per run. Throws if the required toolchain is missing --
 * the caller decides whether that is fatal or just means "no iOS today".
 */
export async function createIosPlatform(cfg: Config): Promise<PlatformSupport> {
  const devices = new IosDevices(cfg);
  const version = await devices.preflight();
  log.info(version);

  const touchVersion = await Baguette.available(cfg.baguetteBin);
  log.info(touchVersion
    ? `multi-touch via baguette ${touchVersion}`
    : 'multi-touch unavailable (no baguette on PATH) -- pinch/pan/double_tap will fail with an install hint');

  return {
    id: 'ios',
    devices,
    ui: (deviceId: string) => new Axe(cfg.axeBin, deviceId),
    touch: (deviceId: string): TouchDriver | undefined =>
      touchVersion ? new Baguette(cfg.baguetteBin, deviceId) : undefined,
    prepareApp: (spec: AppSpec, ctx: PrepareAppContext): Promise<PreparedApp> =>
      prepareApp(cfg, spec, ctx),
    runNativeTests: (spec: unknown, ctx: NativeTestContext): Promise<NativeTestOutcome> =>
      runXcTest(spec as XcTestSpec, ctx),
  };
}
