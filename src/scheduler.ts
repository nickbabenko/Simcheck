import type { Config } from './config.js';
import type { Pool } from './pool.js';
import type { Store } from './store.js';
import type { Runner } from './runner.js';
import type { Run } from './types.js';
import { logger } from './log.js';
import { nowIso } from './util.js';
import { median } from './timings.js';
import { tenantOf } from './warm.js';

const log = logger('scheduler');

/**
 * Matches queued runs to ready simulators, oldest run first.
 *
 * A run stays `pending` until a device that satisfies its `device` request is
 * free. Concurrency is therefore bounded by the pool size -- there is no
 * separate worker count to keep in sync.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** Runs we have already kicked off a provision for. */
  private provisioning = new Set<string>();

  constructor(
    private cfg: Config,
    private pool: Pool,
    private store: Store,
    private runner: Runner,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), 1000);
    // Kick straight away when a run is submitted rather than waiting a second.
    this.store.onChange((run) => { if (run.status === 'pending') this.tick(); });
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  tick(): void {
    if (this.ticking) return;
    // Before the pool has reloaded, an empty device list means "not loaded",
    // not "none exist" -- acting on it would provision needlessly, or fail a
    // run requeued across a restart.
    if (!this.pool.isStarted) return;
    this.ticking = true;
    try {
      // Fairness between tokens is deliberately not implemented: at a per-token
      // cap of 2 there is almost nothing for round-robin to redistribute. If
      // it is ever needed, group store.pending() by submittedBy.tokenId and
      // interleave here -- never in Store.pending(), whose oldest-first order
      // queuePosition() and the pool view rely on (docs/plans/r4 §5).
      for (const run of this.store.pending()) {
        if (!this.pool.canEverSatisfy(run.request.device)) {
          // Try to make what was asked for before giving up. The run keeps
          // waiting through a cold boot rather than failing, which is the
          // trade: slower first run, no pool configuration needed up front.
          if (!this.provisioning.has(run.id)) {
            this.provisioning.add(run.id);
            void this.pool.provisionFor(run.request.device)
              .then((note) => {
                if (note) {
                  this.store.trace(run.id, { kind: 'note', text: note });
                } else {
                  const want = JSON.stringify(run.request.device);
                  this.store.update(run.id, {
                    status: 'error',
                    error: `no pooled simulator matches ${want}, and one could not be created ` +
                      `(check the daemon log -- usually free disk or maxPoolDevices). ` +
                      `Pooled devices: ${this.pool.list().map((d) => `${d.deviceType}/${d.runtime}`).join(', ') || 'none'}`,
                    finishedAt: nowIso(),
                  });
                }
              })
              .finally(() => this.provisioning.delete(run.id));
          }
          continue;
        }
        // Prefer a device already warm for this build and tenant. The artifact
        // id is the content hash, so it is known before anything is fetched.
        const device = this.pool.lease(run.id, run.request.device, {
          tenant: tenantOf(run),
          appHash: run.request.app?.artifactId,
        });
        if (!device) continue;   // all busy; try again next tick

        log.info(`dispatching ${run.id} to ${device.name}`);
        void this.runner.execute(run, device).catch((e) => {
          log.error(`runner blew up on ${run.id}`, (e as Error).message);
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Where a run sits in the queue, 0 meaning next up. */
  queuePosition(runId: string): number {
    return this.store.pending().findIndex((r) => r.id === runId);
  }

  /**
   * Queue position that means something to the caller.
   *
   * The global position counts runs waiting for devices this run could never
   * use -- the scheduler leapfrogs those -- so it overstates the wait. This
   * counts only older pending runs whose requests overlap this run's devices.
   *
   * An ETA is given only when it can be honest: the devices are warm (no cold
   * boot pending, which the per-run arithmetic knows nothing about) and there
   * is measured occupancy for them from recent runs.
   */
  queueInfo(runId: string): QueueInfo | null {
    const pending = this.store.pending();
    const idx = pending.findIndex((r) => r.id === runId);
    if (idx < 0) return null;
    const run = pending[idx]!;
    const mine = this.pool.matchingUdids(run.request.device);
    const ahead = pending.slice(0, idx).filter((r) => {
      for (const u of this.pool.matchingUdids(r.request.device)) if (mine.has(u)) return true;
      return false;
    }).length;
    const warm = this.pool.warmCount(run.request.device);
    const info: QueueInfo = {
      queuePosition: idx,
      queuePositionForDevice: ahead,
      waitingFor: warm > 0 ? 'device' : 'device_boot',
    };
    if (warm > 0) {
      const samples = recentOccupancy(this.store.list({ limit: 200 }), mine, 20);
      const m = median(samples);
      if (m !== undefined) {
        // Everyone ahead, plus this run, shares `warm` devices; assume the
        // runs in flight have just started, so this errs long, not short.
        info.etaSeconds = Math.round((Math.ceil((ahead + 1) / warm) * m) / 1000);
        info.etaSamples = samples.length;
      }
    }
    return info;
  }
}

export interface QueueInfo {
  /** Index in the whole queue, oldest first; 0 is next. */
  queuePosition: number;
  /** Older queued runs competing for the same devices as this one. */
  queuePositionForDevice: number;
  /** `device_boot`: no matching device is booted yet, so the wait includes a
   *  cold boot and no ETA is given. */
  waitingFor: 'device' | 'device_boot';
  /** Seconds until a device is expected, from the median measured occupancy
   *  of recent runs on these devices. Absent when there is no honest basis. */
  etaSeconds?: number;
  etaSamples?: number;
}

/** occupancyMs of the most recent settled runs that used one of these devices. */
export function recentOccupancy(runsNewestFirst: readonly Run[], udids: Set<string>, max: number): number[] {
  const out: number[] = [];
  for (const r of runsNewestFirst) {
    if (out.length >= max) break;
    const occ = r.timings?.occupancyMs;
    if (occ === undefined || !r.device || !udids.has(r.device.udid)) continue;
    out.push(occ);
  }
  return out;
}
