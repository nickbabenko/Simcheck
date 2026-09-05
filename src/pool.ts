import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { paths, platformDefaults } from './config.js';
import type { DeviceRequest, PooledDevice } from './types.js';
import type { ExistingDevice, PlatformId } from './device.js';
import type { Platforms } from './platforms.js';
import { statfsSync } from 'node:fs';
import { logger } from './log.js';
import { nowIso, sleep } from './util.js';

const log = logger('pool');

/** The pool's desired shape, as a list of specs. */
interface PoolSpec {
  platform: PlatformId;
  deviceType: string;
  runtime: string;
  count: number;
}

/**
 * Keeps a set of pre-booted devices -- iOS simulators, Android emulators, or
 * both -- and hands them out one run at a time.
 *
 * Devices enter as `pending` -- either because the pool is filling to its
 * target size or because someone added one explicitly -- and stay pending
 * until the reconcile loop picks them up and boots them to `ready`.
 *
 * Safety: the pool only ever boots, erases or deletes devices whose name
 * starts with `cfg.devicePrefix`. Simulators and AVDs you use by hand are
 * untouched.
 */
export class Pool {
  private devices = new Map<string, PooledDevice>();
  private reconciling = false;
  /** The last shortfall reason logged, so a standing cause is not repeated
   *  every reconcile pass. */
  private lastShortfall?: string;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private cfg: Config, private platforms: Platforms) {}

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
    if (req.platform && d.platform !== req.platform) return false;
    if (req.name && d.deviceType.toLowerCase() !== req.name.toLowerCase()) return false;
    if (req.runtime && !runtimeMatches(d.runtime, req.runtime)) return false;
    return true;
  }

  canEverSatisfy(req?: DeviceRequest): boolean {
    return this.list().some((d) => d.status !== 'offline' && this.matches(d, req));
  }

  /** Requests we are already building a device for, so we do it once. */
  private provisioning = new Set<string>();

  private static key(req?: DeviceRequest): string {
    return `${req?.platform ?? '*'}::${req?.name ?? '*'}::${req?.runtime ?? '*'}`;
  }

  atCapacity(): boolean {
    return this.list().filter((d) => d.status !== 'offline').length >= this.cfg.maxPoolDevices;
  }

  /** Free space on the volume holding the devices, in GB. */
  private freeDiskGb(): number {
    try {
      const st = statfsSync(this.cfg.home);
      return (st.bavail * st.bsize) / 1e9;
    } catch {
      return Number.POSITIVE_INFINITY;   // unknown: do not block on it
    }
  }

  /**
   * Would creating another device take free space below the floor?
   *
   * The check has to subtract what the new device will cost, not just look at
   * what is free now -- otherwise a floor of 6GB still permits a create at
   * 6.5GB free, and a ~3.5GB device lands you at 3GB. What one costs is the
   * platform's business: an emulator system image is far larger than a
   * simulator's shared runtime.
   */
  private diskTooTight(platform: PlatformId): string | null {
    const backend = this.platforms.get(platform).devices;
    const free = this.freeDiskGb();
    const after = free - backend.diskCostGb;
    if (after >= this.cfg.minFreeDiskGb) return null;
    return `${free.toFixed(1)}GB free; a booted ${backend.deviceNoun} needs about ` +
      `${backend.diskCostGb}GB, which would leave ${Math.max(0, after).toFixed(1)}GB ` +
      `— below the ${this.cfg.minFreeDiskGb}GB floor. Free some space, lower minFreeDiskGb, ` +
      `or remove a pooled device with sim_pool_remove.`;
  }

  /**
   * Create a device for a request the pool cannot currently serve.
   *
   * Returns a note explaining what is happening, or null if it will not do it.
   * Pinning to a specific id is never provisionable -- that device either
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
    const platform = req?.platform ?? this.platforms.default();
    if (!this.platforms.has(platform)) {
      log.warn(`not provisioning ${key}: ${this.platforms.reason(platform)}`);
      return null;
    }
    const tight = this.diskTooTight(platform);
    if (tight) {
      log.warn(`not provisioning ${key}: ${tight}`);
      return null;
    }

    this.provisioning.add(key);
    try {
      const created = await this.add({
        platform,
        ...(req?.name ? { deviceType: req.name } : {}),
        ...(req?.runtime ? { runtime: req.runtime } : {}),
        count: 1,
      });
      const d = created[0]!;
      const noun = this.platforms.get(platform).devices.deviceNoun;
      log.info(`provisioned ${d.name} (${d.deviceType} / ${d.runtime}) on demand`);
      return `no warm ${d.deviceType} on ${d.runtime} was pooled, so a ${noun} is being created and booted -- this run will start slower than usual`;
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
    const backend = this.platforms.get(d.platform).devices;
    d.status = 'recycling';
    delete d.currentRunId;
    this.save();
    try {
      if (opts.policy === 'erase') {
        await backend.shutdown(udid);
        await backend.erase(udid);
        await backend.boot(udid);
      } else if (opts.bundleId) {
        await backend.terminate(udid, opts.bundleId);
        if (opts.uninstall) {
          await backend.uninstall(udid, opts.bundleId);
          await backend.resetPermissions(udid, opts.bundleId);
        }
      }
      // Uninstalling an app does not dismiss a system alert it left on screen
      // -- that sheet belongs to the OS shell and would greet the next run.
      if (opts.policy !== 'erase') await this.sanitize(d);
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
  private async sanitize(d: PooledDevice): Promise<void> {
    const platform = this.platforms.get(d.platform);
    const ui = platform.ui(d.udid);
    const name = d.name;

    const strayModal = async (): Promise<string | null> => {
      const screen = await ui.describe().catch(() => null);
      if (!screen) return null;   // cannot read it; do not block recycling on that
      const modal = screen.elements.find((e) => e.type === 'Sheet' || e.type === 'Alert');
      return modal ? (modal.label ?? modal.type) : null;
    };

    await ui.button('home').catch(() => {});
    await sleep(400);

    for (let attempt = 0; attempt < 3; attempt++) {
      const modal = await strayModal();
      if (!modal) return;

      const screen = await ui.describe().catch(() => null);
      const buttons = (screen?.elements ?? []).filter((e) => e.type === 'Button' && e.label);
      // Prefer the declining option -- never silently grant a permission.
      const choice = DISMISS_LABELS
        .map((want) => buttons.find((b) => b.label!.toLowerCase().includes(want)))
        .find(Boolean);
      if (!choice) break;

      log.info(`${name}: dismissing leftover modal "${modal}" via "${choice.label}"`);
      await ui.tap({ label: choice.label! }).catch(() => {});
      await sleep(800);
    }

    if (!(await strayModal())) return;

    log.warn(`${name}: modal survived dismissal, rebooting the device`);
    await platform.devices.shutdown(d.udid);
    await platform.devices.boot(d.udid);
    await sleep(1500);

    const remaining = await strayModal();
    if (remaining) throw new Error(`device still shows "${remaining}" after a reboot`);
  }

  /** Register an extra device. It lands as `pending` and the reconcile loop
   *  boots it. `deviceType` defaults to the pool's type for that platform. */
  async add(spec: {
    platform?: PlatformId; deviceType?: string; runtime?: string; count?: number;
  } = {}): Promise<PooledDevice[]> {
    const platform = spec.platform ?? this.platforms.default();
    const backend = this.platforms.get(platform).devices;
    const count = Math.max(1, spec.count ?? 1);
    const tight = this.diskTooTight(platform);
    if (tight) throw new Error(`refusing to create a ${backend.deviceNoun}: ${tight}`);

    const fallback = platformDefaults(this.cfg, platform);
    const target = await backend.resolveTarget(
      spec.deviceType ?? fallback.deviceType,
      spec.runtime ?? fallback.runtime,
    );

    const created: PooledDevice[] = [];
    for (let i = 0; i < count; i++) {
      const name = this.nextName();
      const id = await backend.create(name, target);
      const d: PooledDevice = {
        udid: id, platform, name,
        deviceType: target.deviceType,
        runtime: target.runtime,
        status: 'pending',
        addedAt: nowIso(),
        managed: true,
      };
      this.devices.set(id, d);
      created.push(d);
      log.info(`added ${name} (${target.deviceType} / ${target.runtime}) -- pending`);
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
    if (d.managed && this.platforms.has(d.platform)) {
      const backend = this.platforms.get(d.platform).devices;
      await backend.shutdown(udid).catch(() => {});
      await backend.destroy(udid).catch((e) => log.warn(`delete ${d.name} failed`, String(e)));
    }
    log.info(`removed ${d.name}`);
  }

  /* ---------------------------------------------------------------- internals */

  /** Every device on this machine, across every usable platform. */
  private async survey(): Promise<Map<string, { platform: PlatformId; d: ExistingDevice }>> {
    const live = new Map<string, { platform: PlatformId; d: ExistingDevice }>();
    for (const platform of this.platforms.available()) {
      try {
        for (const d of await this.platforms.get(platform).devices.list()) {
          live.set(d.id, { platform, d });
        }
      } catch (e) {
        log.warn(`could not list ${platform} devices`, (e as Error).message);
      }
    }
    return live;
  }

  /** Re-attach to devices we created in a previous daemon lifetime, and drop
   *  records for ones that have since been deleted out from under us. */
  private async adopt(): Promise<void> {
    const live = await this.survey();

    for (const [udid, d] of this.devices) {
      const actual = live.get(udid);
      if (!actual || !actual.d.available) {
        // A platform that failed preflight lists nothing; that is not evidence
        // its devices are gone, so keep the record and let it go offline.
        if (!this.platforms.has(d.platform)) {
          d.status = 'offline';
          d.lastError = this.platforms.reason(d.platform);
          continue;
        }
        log.warn(`pooled device ${d.name} no longer exists, dropping`);
        this.devices.delete(udid);
        continue;
      }
      // A lease cannot survive a restart -- the run that held it is gone.
      d.status = actual.d.booted ? 'ready' : 'pending';
      delete d.currentRunId;
    }

    // Pick up strays from a crashed run: our prefix, ours to manage.
    for (const [udid, { platform, d }] of live) {
      if (this.devices.has(udid) || !d.available) continue;
      if (!d.name.startsWith(this.cfg.devicePrefix + '-')) continue;
      this.devices.set(udid, {
        udid, platform,
        name: d.name,
        deviceType: d.deviceType,
        runtime: d.runtime,
        status: d.booted ? 'ready' : 'pending',
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

  /** The pool's desired shape. Specs naming an unavailable platform are
   *  dropped: the pool cannot fill them, and pretending otherwise makes
   *  `targetCount` a number it will never reach. */
  private desired(): PoolSpec[] {
    const specs: PoolSpec[] = this.cfg.pool.length
      ? this.cfg.pool.map((p) => {
          const platform = p.platform ?? this.cfg.defaultPlatform;
          const fallback = platformDefaults(this.cfg, platform);
          return {
            platform,
            deviceType: p.deviceType ?? fallback.deviceType,
            runtime: p.runtime ?? fallback.runtime,
            count: Math.max(0, p.count ?? 1),
          };
        })
      : [{
          platform: this.cfg.defaultPlatform,
          ...platformDefaults(this.cfg, this.cfg.defaultPlatform),
          count: this.cfg.poolSize,
        }];
    return specs.filter((s) => this.platforms.has(s.platform));
  }

  /** Does this device satisfy that spec? Runtime compared loosely. */
  private satisfies(d: PooledDevice, spec: PoolSpec): boolean {
    if (d.platform !== spec.platform) return false;
    if (d.deviceType.toLowerCase() !== spec.deviceType.toLowerCase()) return false;
    if (!spec.runtime) return true;
    return runtimeMatches(d.runtime, spec.runtime);
  }

  /** Fill to the target size and boot anything still pending. */
  private async reconcile(): Promise<void> {
    if (this.reconciling || this.stopped) return;
    this.reconciling = true;
    try {
      // Detect drift before acting on our own record of the world. A device can
      // be shut down outside the harness -- by `simctl erase`, by Xcode, by
      // `adb emu kill`, or by a crash -- and trusting a stale `ready` would
      // hand out a dead device.
      await this.detectDrift();

      // Each spec is filled independently, so a shortfall on one runtime is
      // not masked by a surplus on another.
      const alive = this.list().filter((d) => d.status !== 'offline');
      for (const spec of this.desired()) {
        const have = alive.filter((d) => this.satisfies(d, spec)).length;
        if (have >= spec.count) continue;

        // Say why the pool is short rather than silently staying that way.
        // "target 2, ready 1" with no explanation is precisely the state a
        // reader cannot act on. Reconcile runs every few seconds, so the
        // reason is logged once per cause rather than on every pass.
        const blocked = this.atCapacity()
          ? `at maxPoolDevices (${this.cfg.maxPoolDevices})`
          : this.diskTooTight(spec.platform);
        if (blocked) {
          const key = `${spec.platform}/${spec.deviceType}: ${blocked}`;
          if (this.lastShortfall !== key) {
            this.lastShortfall = key;
            log.warn(`pool is ${spec.count - have} short of ${spec.deviceType} (${spec.platform})`, blocked);
          }
          continue;
        }
        delete this.lastShortfall;
        {
          await this.add({
            platform: spec.platform,
            deviceType: spec.deviceType,
            runtime: spec.runtime,
            count: spec.count - have,
          }).catch((e) => log.error(`could not grow the pool for ${spec.platform} ${spec.deviceType}/${spec.runtime || 'newest'}`, (e as Error).message));
        }
      }
      const pending = this.list().filter((d) => d.status === 'pending');
      // Boot serially: several concurrent boots thrash the machine, and an
      // emulator is a whole VM.
      for (const d of pending) {
        if (this.stopped) break;
        if (!this.platforms.has(d.platform)) continue;
        d.status = 'booting';
        this.save();
        try {
          await this.platforms.get(d.platform).devices.boot(d.udid);
          // Give the OS shell a moment before declaring the device usable.
          await sleep(1500);
          // A device adopted after a crash may still show the old run's alert.
          await this.sanitize(d);
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

  /** Re-sync pool state against what the devices are actually doing. */
  private async detectDrift(): Promise<void> {
    const live = await this.survey();
    let changed = false;
    for (const d of this.list()) {
      if (!this.platforms.has(d.platform)) continue;
      const actual = live.get(d.udid);
      if (!actual) {
        // Deleted out from under us; drop it and let the pool refill.
        log.warn(`${d.name} no longer exists, removing from the pool`);
        this.devices.delete(d.udid);
        changed = true;
        continue;
      }
      // Only correct idle devices: a leased one is mid-run and its own
      // lifecycle owns it, and a booting one is expected to be shut down.
      if (d.status === 'ready' && !actual.d.booted) {
        log.warn(`${d.name} is not booted but the pool thought it was ready -- rebooting`);
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
      for (const d of JSON.parse(fs.readFileSync(p, 'utf8')) as PooledDevice[]) {
        // Records written before the pool knew about platforms are iOS.
        this.devices.set(d.udid, { ...d, platform: d.platform ?? 'ios' });
      }
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

/**
 * Loose runtime comparison, so "26.3" matches "iOS 26.3" and "35" matches
 * "Android 15 (API 35)". Both platforms label a runtime differently from how
 * a caller naturally asks for one.
 */
function runtimeMatches(have: string, want: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/^(ios|android)\s*/, '').trim();
  const h = norm(have), w = norm(want);
  if (h.startsWith(w)) return true;
  // "Android 15 (API 35)" asked for as "35" or "android-35".
  const api = have.match(/api\s*(\d+)/i)?.[1];
  const wantApi = want.match(/(\d+)/)?.[1];
  return Boolean(api && wantApi && api === wantApi && /api|android/i.test(want + have));
}

/** Dismissive button labels, most-preferred first. iOS uses a curly apostrophe. */
const DISMISS_LABELS = [
  "don't allow", '’t allow', 'not now', 'no thanks', 'cancel',
  'dismiss', 'close', 'later', 'skip', 'ok', 'deny',
];
