import type { Config } from './config.js';
import type { Pool } from './pool.js';
import type { Store } from './store.js';
import type { Runner } from './runner.js';
import { logger } from './log.js';
import { nowIso } from './util.js';

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
    this.ticking = true;
    try {
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
        const device = this.pool.lease(run.id, run.request.device);
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
}
