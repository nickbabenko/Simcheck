import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { paths } from './config.js';
import type { DeviceRequest, PooledDevice } from './types.js';
import { statfsSync } from 'node:fs';
import * as simctl from './simctl.js';
import { Axe } from './axe.js';
import { logger } from './log.js';
import { nowIso, sleep } from './util.js';

const log = logger('pool');

/**
 * Keeps a set of simulators pre-booted and hands them out one run at a time.
 *
 * Devices enter as `pending` -- either because the pool is filling to its
 * target size or because someone added one explicitly -- and stay pending
 * until the reconcile loop picks them up and boots them to `ready`.
 *
 * Safety: the pool only ever boots, erases or deletes simulators whose name
 * starts with `cfg.devicePrefix`. Simulators you use in Xcode are untouched.
 */
export class Pool {
  private devices = new Map<string, PooledDevice>();
  private reconciling = false;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private cfg: Config) {}

  async start(): Promise<void> {
    this.load();
    await this.adopt();
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 5_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  list(): PooledDevice[] {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(udid: string): PooledDevice | undefined { return this.devices.get(udid); }

  /** Devices that could eventually serve a request, ignoring current status.
   *  Used to reject impossible requests instead of queuing them forever. */
  private matches(d: PooledDevice, req?: DeviceRequest): boolean {
    if (!req) return true;
    if (req.udid && d.udid !== req.udid) return false;
    if (req.name && d.deviceType.toLowerCase() !== req.name.toLowerCase()) return false;
    if (req.runtime) {
      const want = req.runtime.toLowerCase().replace(/^ios\s*/, '');
      if (!d.runtime.toLowerCase().replace(/^ios\s*/, '').startsWith(want)) return false;
    }
    return true;
  }

  canEverSatisfy(req?: DeviceRequest): boolean {
    return this.list().some((d) => d.status !== 'offline' && this.matches(d, req));
  }

  /** Requests we are already building a device for, so we do it once. */
  private provisioning = new Set<string>();

  private static key(req?: DeviceRequest): string {
    return `${req?.name ?? '*'}::${req?.runtime ?? '*'}`;
  }

  atCapacity(): boolean {
    return this.list().filter((d) => d.status !== 'offline').length >= this.cfg.maxPoolDevices;
  }

  /** Free space on the volume holding the simulators, in GB. */
  private freeDiskGb(): number {
    try {
      const st = statfsSync(this.cfg.home);
      return (st.bavail * st.bsize) / 1e9;
    } catch {
      return Number.POSITIVE_INFINITY;   // unknown: do not block on it
    }
  }

  /**
   * Would creating another simulator take free space below the floor?
   *
   * The check has to subtract what the new device will cost, not just look at
   * what is free now -- otherwise a floor of 6GB still permits a create at
   * 6.5GB free, and a ~3.5GB device lands you at 3GB.
   */
  /**
   * Measured, not guessed: creating and first-booting a device on a fresh
   * runtime consumed ~8GB, far more than the ~3GB a settled device reports as
   * `dataPathSize`. Most of it is transient and APFS reclaims it lazily, but
   * the peak is what matters when deciding whether there is room.
   */
  private static readonly DEVICE_COST_GB = 8;

  private diskTooTight(): string | null {
    const free = this.freeDiskGb();
    const after = free - Pool.DEVICE_COST_GB;
    if (after >= this.cfg.minFreeDiskGb) return null;
    return `${free.toFixed(1)}GB free; a booted simulator needs about ` +
      `${Pool.DEVICE_COST_GB}GB, which would leave ${Math.max(0, after).toFixed(1)}GB ` +
      `— below the ${this.cfg.minFreeDiskGb}GB floor. Free some space, lower minFreeDiskGb, ` +
      `or remove a pooled device with sim_pool_remove.`;
  }

  /**
   * Create a device for a request the pool cannot currently serve.
   *
   * Returns a note explaining what is happening, or null if it will not do it.
   * Pinning to a specific UDID is never provisionable -- that device either
   * exists or it does not.
   */
  async provisionFor(req: DeviceRequest | undefined): Promise<string | null> {
    if (!this.cfg.autoProvision || req?.udid) return null;
    const key = Pool.key(req);
    if (this.provisioning.has(key)) return null;
    if (this.atCapacity()) {
      log.warn(`not provisioning ${key}: at maxPoolDevices (${this.cfg.maxPoolDevices})`);
      return null;
    }
    const tight = this.diskTooTight();
    if (tight) {
      log.warn(`not provisioning ${key}: ${tight}`);
      return null;
    }

    this.provisioning.add(key);
    try {
      const created = await this.add({
        ...(req?.name ? { deviceType: req.name } : {}),
        ...(req?.runtime ? { runtime: req.runtime } : {}),
        count: 1,
      });
      const d = created[0]!;
      log.info(`provisioned ${d.name} (${d.deviceType} / ${d.runtime}) on demand`);
      return `no warm ${d.deviceType} on ${d.runtime} was pooled, so one is being created and booted -- this run will start slower than usual`;
    } catch (e) {
      log.error(`could not provision for ${key}`, (e as Error).message);
      return null;
    } finally {
      this.provisioning.delete(key);
    }
  }

  /** Take a ready device for a run, or null if none is free right now. */
  lease(runId: string, req?: DeviceRequest): PooledDevice | null {
    for (const d of this.list()) {
      if (d.status !== 'ready' || !this.matches(d, req)) continue;
      d.status = 'leased';
      d.currentRunId = runId;
      this.save();
      log.info(`leased ${d.name} (${d.deviceType}) to ${runId}`);
      return d;
    }
    return null;
  }

  /** Return a device to the pool, resetting it to a clean state first. */
  async release(udid: string, opts: {
    bundleId?: string;
    /** False when the app was already on the device and is not ours to remove. */
    uninstall: boolean;
    policy: 'uninstall' | 'erase';
  }): Promise<void> {
    const d = this.devices.get(udid);
    if (!d) return;
    d.status = 'recycling';
    delete d.currentRunId;
    this.save();
    try {
      if (opts.policy === 'erase') {
        await simctl.shutdown(udid);
        await simctl.erase(udid);
        await simctl.boot(udid);
      } else if (opts.bundleId) {
        await simctl.terminate(udid, opts.bundleId);
        if (opts.uninstall) {
          await simctl.uninstall(udid, opts.bundleId);
          await simctl.resetPrivacy(udid, opts.bundleId);
        }
      }
      // Uninstalling an app does not dismiss a system alert it left on screen
      // -- that sheet belongs to SpringBoard and would greet the next run.
      if (opts.policy !== 'erase') await this.sanitize(udid, d.name);
      d.status = 'ready';
      d.readyAt = nowIso();
      delete d.lastError;
      log.info(`recycled ${d.name} (${opts.policy})`);
    } catch (e) {
      d.status = 'offline';
      d.lastError = (e as Error).message;
      log.error(`recycling ${d.name} failed, marking offline`, d.lastError);
    }
    this.save();
  }

  /**
   * Return the device to a neutral home screen.
   *
   * Escalates: press home, then dismiss any stray modal, then reboot. A device
   * that is still dirty after that is marked offline rather than handed out,
   * because a leftover sheet silently breaks the next run's taps.
   */
  private async sanitize(udid: string, name: string): Promise<void> {
    const axe = new Axe(this.cfg.axeBin, udid);

    const strayModal = async (): Promise<string | null> => {
      const screen = await axe.describe().catch(() => null);
      if (!screen) return null;   // cannot read it; do not block recycling on that
      const modal = screen.elements.find((e) => e.type === 'Sheet' || e.type === 'Alert');
      return modal ? (modal.label ?? modal.type) : null;
    };

    await axe.button('home').catch(() => {});
    await sleep(400);

    for (let attempt = 0; attempt < 3; attempt++) {
      const modal = await strayModal();
      if (!modal) return;

      const screen = await axe.describe().catch(() => null);
      const buttons = (screen?.elements ?? []).filter((e) => e.type === 'Button' && e.label);
      // Prefer the declining option -- never silently grant a permission.
      const choice = DISMISS_LABELS
        .map((want) => buttons.find((b) => b.label!.toLowerCase().includes(want)))
        .find(Boolean);
      if (!choice) break;

      log.info(`${name}: dismissing leftover modal "${modal}" via "${choice.label}"`);
      await axe.tap({ label: choice.label! }).catch(() => {});
      await sleep(800);
    }

    if (!(await strayModal())) return;

    log.warn(`${name}: modal survived dismissal, rebooting the device`);
    await simctl.shutdown(udid);
    await simctl.boot(udid);
    await sleep(1500);

    const remaining = await strayModal();
    if (remaining) throw new Error(`device still shows "${remaining}" after a reboot`);
  }

  /** Register an extra simulator. It lands as `pending` and the reconcile loop
   *  boots it. `deviceType` defaults to the pool's configured type. */
  async add(spec: { deviceType?: string; runtime?: string; count?: number } = {}): Promise<PooledDevice[]> {
    const count = Math.max(1, spec.count ?? 1);
    const tight = this.diskTooTight();
    if (tight) throw new Error(`refusing to create a simulator: ${tight}`);
    const runtime = await simctl.resolveRuntime(spec.runtime ?? this.cfg.runtime);
    const deviceType = await simctl.resolveDeviceType(spec.deviceType ?? this.cfg.deviceType, runtime);
    const created: PooledDevice[] = [];
    for (let i = 0; i < count; i++) {
      const name = this.nextName();
      const udid = await simctl.create(name, deviceType.identifier, runtime.identifier);
      const d: PooledDevice = {
        udid, name,
        deviceType: deviceType.name,
        runtime: runtime.name || `iOS ${runtime.version}`,
        status: 'pending',
        addedAt: nowIso(),
        managed: true,
      };
      this.devices.set(udid, d);
      created.push(d);
      log.info(`added ${name} (${deviceType.name} / ${d.runtime}) -- pending`);
    }
    this.save();
    void this.reconcile();
    return created;
  }

  /** Remove a device from the pool. Refuses while it is running a job unless forced. */
  async remove(udid: string, force = false): Promise<void> {
    const d = this.devices.get(udid);
    if (!d) throw new Error(`no pooled device ${udid}`);
    if (d.status === 'leased' && !force) {
      throw new Error(`${d.name} is running ${d.currentRunId}; pass force to remove anyway`);
    }
    this.devices.delete(udid);
    this.save();
    if (d.managed) {
      await simctl.shutdown(udid).catch(() => {});
      await simctl.deleteDevice(udid).catch((e) => log.warn(`delete ${d.name} failed`, String(e)));
    }
    log.info(`removed ${d.name}`);
  }

  /* ---------------------------------------------------------------- internals */

  /** Re-attach to simulators we created in a previous daemon lifetime, and drop
   *  records for ones that have since been deleted out from under us. */
  private async adopt(): Promise<void> {
    const live = new Map((await simctl.listDevices()).map((d) => [d.udid, d]));

    for (const [udid, d] of this.devices) {
      const actual = live.get(udid);
      if (!actual || !actual.isAvailable) {
        log.warn(`pooled device ${d.name} no longer exists, dropping`);
        this.devices.delete(udid);
        continue;
      }
      // A lease cannot survive a restart -- the run that held it is gone.
      d.status = actual.state === 'Booted' ? 'ready' : 'pending';
      delete d.currentRunId;
    }

    // Pick up strays from a crashed run: our prefix, ours to manage.
    for (const [udid, d] of live) {
      if (this.devices.has(udid) || !d.isAvailable) continue;
      if (!d.name.startsWith(this.cfg.devicePrefix + '-')) continue;
      this.devices.set(udid, {
        udid,
        name: d.name,
        deviceType: d.deviceTypeIdentifier.split('.').pop()!.replace(/-/g, ' '),
        runtime: runtimeLabel(d.runtimeIdentifier),
        status: d.state === 'Booted' ? 'ready' : 'pending',
        addedAt: nowIso(),
        managed: true,
      });
      log.info(`adopted orphaned ${d.name}`);
    }
    this.save();
  }

  /** How many warm devices the pool is aiming for, summed across its specs.
   * Not `cfg.poolSize` -- that is only the fallback when no `pool` specs are
   * set, so reporting it directly shows a target the pool will never fill. */
  targetCount(): number {
    return this.desired().reduce((n, spec) => n + spec.count, 0);
  }

  /** The pool's desired shape, as a list of specs. */
  private desired(): { deviceType: string; runtime: string; count: number }[] {
    if (this.cfg.pool.length) {
      return this.cfg.pool.map((p) => ({
        deviceType: p.deviceType ?? this.cfg.deviceType,
        runtime: p.runtime ?? this.cfg.runtime,
        count: Math.max(0, p.count ?? 1),
      }));
    }
    return [{ deviceType: this.cfg.deviceType, runtime: this.cfg.runtime, count: this.cfg.poolSize }];
  }

  /** Does this device satisfy that spec? Runtime compared loosely (26.3 ~ iOS 26.3). */
  private satisfies(d: PooledDevice, spec: { deviceType: string; runtime: string }): boolean {
    if (d.deviceType.toLowerCase() !== spec.deviceType.toLowerCase()) return false;
    if (!spec.runtime) return true;
    const want = spec.runtime.toLowerCase().replace(/^ios\s*/, '');
    return d.runtime.toLowerCase().replace(/^ios\s*/, '').startsWith(want);
  }

  /** Fill to the target size and boot anything still pending. */
  private async reconcile(): Promise<void> {
    if (this.reconciling || this.stopped) return;
    this.reconciling = true;
    try {
      // Detect drift before acting on our own record of the world. A device can
      // be shut down outside the harness -- by `simctl erase`, by Xcode, or by a
      // crash -- and trusting a stale `ready` would hand out a dead simulator.
      await this.detectDrift();

      // Each spec is filled independently, so a shortfall on one runtime is
      // not masked by a surplus on another.
      const alive = this.list().filter((d) => d.status !== 'offline');
      for (const spec of this.desired()) {
        const have = alive.filter((d) => this.satisfies(d, spec)).length;
        if (have < spec.count && !this.atCapacity() && !this.diskTooTight()) {
          await this.add({
            deviceType: spec.deviceType,
            runtime: spec.runtime,
            count: spec.count - have,
          }).catch((e) => log.error(`could not grow the pool for ${spec.deviceType}/${spec.runtime || 'newest'}`, (e as Error).message));
        }
      }
      const pending = this.list().filter((d) => d.status === 'pending');
      // Boot serially: several concurrent simulator boots thrash the machine.
      for (const d of pending) {
        if (this.stopped) break;
        d.status = 'booting';
        this.save();
        try {
          await simctl.boot(d.udid);
          // Give SpringBoard a moment before declaring the device usable.
          await sleep(1500);
          // A device adopted after a crash may still show the old run's alert.
          await this.sanitize(d.udid, d.name);
          d.status = 'ready';
          d.readyAt = nowIso();
          delete d.lastError;
          log.info(`${d.name} ready`);
        } catch (e) {
          d.status = 'offline';
          d.lastError = (e as Error).message;
          log.error(`boot ${d.name} failed`, d.lastError);
        }
        this.save();
      }
    } finally {
      this.reconciling = false;
    }
  }

  /** Re-sync pool state against what the simulators are actually doing. */
  private async detectDrift(): Promise<void> {
    let live: Map<string, string>;
    try {
      live = new Map((await simctl.listDevices()).map((d) => [d.udid, d.state]));
    } catch (e) {
      log.warn('could not read simulator states', (e as Error).message);
      return;
    }
    let changed = false;
    for (const d of this.list()) {
      const state = live.get(d.udid);
      if (!state) {
        // Deleted out from under us; drop it and let the pool refill.
        log.warn(`${d.name} no longer exists, removing from the pool`);
        this.devices.delete(d.udid);
        changed = true;
        continue;
      }
      // Only correct idle devices: a leased one is mid-run and its own
      // lifecycle owns it, and a booting one is expected to be Shutdown.
      if (d.status === 'ready' && state !== 'Booted') {
        log.warn(`${d.name} is ${state} but the pool thought it was ready -- rebooting`);
        d.status = 'pending';
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private nextName(): string {
    const used = new Set(this.list().map((d) => d.name));
    for (let i = 1; i < 1000; i++) {
      const name = `${this.cfg.devicePrefix}-${String(i).padStart(2, '0')}`;
      if (!used.has(name)) return name;
    }
    throw new Error('exhausted pool device names');
  }

  private load(): void {
    const p = paths(this.cfg).pool;
    if (!fs.existsSync(p)) return;
    try {
      for (const d of JSON.parse(fs.readFileSync(p, 'utf8')) as PooledDevice[]) this.devices.set(d.udid, d);
    } catch (e) {
      log.warn('pool state unreadable, starting empty', (e as Error).message);
    }
  }

  private save(): void {
    const p = paths(this.cfg).pool;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(this.list(), null, 2));
  }
}

/** Dismissive button labels, most-preferred first. iOS uses a curly apostrophe. */
const DISMISS_LABELS = [
  "don't allow", '\u2019t allow', 'not now', 'no thanks', 'cancel',
  'dismiss', 'close', 'later', 'skip', 'ok',
];

const runtimeLabel = (identifier: string): string => {
  const m = identifier.match(/SimRuntime\.(\w+)-([\d-]+)$/);
  return m ? `${m[1]} ${m[2]!.replace(/-/g, '.')}` : identifier;
};
