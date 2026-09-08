// The control loop.
//
// Provisioning is not "a function that creates things and a second that removes
// them". The store holds desired state, the runtime and ingress are queried for
// actual state, and this loop converges them. Every step is idempotent, so a
// retry after a partial failure converges rather than duplicating work — which
// is what allows more than one replica and survives a crash mid-provision.

import type { Drivers } from './drivers/index.js'
import type { EnvRecord } from './types.js'
import { provisionEnv } from './provision.js'

export interface ReconcilerOptions {
  /** Identifies this replica in leases. */
  holder: string
  leaseMs: number
  tickMs: number
  /** Refuse to provision below these. A runaway env should fail with a clear
   *  message rather than starve whatever else shares the machine — locally that
   *  includes the simulator pool, which fails confusingly when disk runs out. */
  minFreeDiskGb: number
  minFreeMemoryMb: number
  provisionTimeoutMs: number
  onError?: (envId: string, err: unknown) => void
  /** Notable transitions worth one log line, not one per tick. */
  onNotice?: (message: string) => void
}

export interface Reconciler {
  start(): void
  stop(): Promise<void>
  /** Run exactly one pass. Exposed so tests drive the loop deterministically
   *  instead of sleeping and hoping. */
  tick(now: number): Promise<string[]>
}

/** States that mean "provisioning has not finished". All route to the same
 *  re-runnable provisioning call; the distinction is for reporting only. */
const IN_PROGRESS = new Set(['pending', 'provisioning', 'seeding'])

export function createReconciler(d: Drivers, opts: ReconcilerOptions): Reconciler {
  let timer: NodeJS.Timeout | undefined
  // Latched so an outage logs once on the way down and once on the way back,
  // rather than every tick. A two-second error loop buries the log it is in.
  let runtimeDown = false
  let running = false
  let stopped = false

  async function tick(now: number): Promise<string[]> {
    const touched: string[] = []

    // 1. Expire. This only changes desired state; the destroy path does the work.
    for (const rec of await d.store.list({ states: ['ready', 'provisioning', 'seeding', 'pending'] })) {
      if (rec.expiresAt <= now) {
        await d.store.update(rec.id, { state: 'expired' })
        touched.push(rec.id)
      }
    }

    // 1b. Give up reservations nobody provisioned. They hold no containers, so
    //     this is only tidying the table -- but a URL handed out and forgotten
    //     should not stay allocated forever.
    for (const rec of await d.store.list({ states: ['reserved'] })) {
      if ((rec.reservedUntil ?? rec.expiresAt) <= now) {
        await d.store.update(rec.id, { state: 'expired' });
        touched.push(rec.id);
      }
    }

    // 2. Claim work under a lease, so two replicas cannot act on one env.
    for (const rec of await d.store.claimWork(opts.holder, now, opts.leaseMs, 4)) {
      try {
        await step(rec)
      } catch (err) {
        opts.onError?.(rec.id, err)
        // A failure the caller cannot read is a support ticket. Record it.
        await d.store.update(rec.id, { state: 'failed', error: String(err) })
      } finally {
        // Release the lease as soon as the step is done, success or not.
        // Holding it until it times out would stall the env's next transition
        // for a full lease period — an env that just became `expired` would sit
        // there for a minute before anything started tearing it down.
        await d.store.update(rec.id, { leaseHolder: undefined, leaseExpiresAt: undefined })
      }
      touched.push(rec.id)
    }

    // 3. Anything the runtime or ingress still holds that the store does not
    //    know about is a leak — from a crash that lost a store write, or a
    //    process killed mid-teardown.
    await collectOrphans()
    return touched
  }

  async function step(rec: EnvRecord): Promise<void> {
    if (IN_PROGRESS.has(rec.state)) {
      await ensureCapacity()
      const result = await provisionEnv(d, rec, {
        provisionTimeoutMs: opts.provisionTimeoutMs,
        onState: async (s) => d.store.update(rec.id, { state: s }),
      })
      await d.store.update(rec.id, {
        state: 'ready',
        url: result.url,
        hostPort: result.hostPort,
        ...(result.internalDbUrl ? { internalDbUrl: result.internalDbUrl } : {}),
        ...(result.internalCacheUrl ? { internalCacheUrl: result.internalCacheUrl } : {}),
      })
      return
    }

    if (rec.state === 'expired') {
      await d.store.update(rec.id, { state: 'destroying' })
      // Fall through: no reason to wait a whole tick to start tearing down.
    }

    if (rec.state === 'expired' || rec.state === 'destroying') {
      // Both idempotent, so a partial teardown retries cleanly.
      await d.ingress.detach(rec.slug)
      await d.runtime.destroy(rec.id)
      await d.store.update(rec.id, { state: 'destroyed', leaseHolder: undefined, leaseExpiresAt: undefined })
    }
  }

  async function ensureCapacity(): Promise<void> {
    const cap = await d.runtime.capacity()
    if (cap.freeDiskGb < opts.minFreeDiskGb) {
      throw new Error(
        `refusing to provision: ${cap.freeDiskGb.toFixed(1)} GB free, floor is ${opts.minFreeDiskGb} GB`,
      )
    }
    if (cap.freeMemoryMb < opts.minFreeMemoryMb) {
      throw new Error(
        `refusing to provision: ${cap.freeMemoryMb} MB free memory, floor is ${opts.minFreeMemoryMb} MB`,
      )
    }
  }

  /**
   * Converge ingress and runtime against desired state — in both directions.
   *
   * Removing orphans is the obvious half. Restoring *missing* routes is the half
   * that is easy to omit and matters just as much: a proxy restart drops every
   * route it was holding, and without this each running env would go quietly
   * unreachable while still reporting itself ready.
   */
  async function collectOrphans(): Promise<void> {
    const all = (await d.store.list()).filter((r) => r.state !== 'destroyed' && r.state !== 'failed');

    // Everything below is derived from what the runtime reports. If it cannot
    // be reached, we cannot tell "the containers are gone" from "we cannot ask"
    // -- and marking environments failed on a transient socket blip would
    // destroy working ones. So: leave all state alone and try again next tick.
    // Expiry bookkeeping has already run by this point and is unaffected.
    let alive: Set<string>;
    let running: Set<string>;
    try {
      alive = new Set(await d.runtime.listEnvIds());
      running = new Set(await d.runtime.runningEnvIds());
      if (runtimeDown) {
        runtimeDown = false;
        opts.onNotice?.('container runtime is reachable again');
      }
    } catch (err) {
      if (!runtimeDown) {
        runtimeDown = true;
        opts.onNotice?.(`container runtime is unreachable (${(err as Error).message}); ` +
          'leaving environment state untouched until it returns');
      }
      return;
    }

    // A ready environment the runtime does not know about -- the usual cause is
    // a host reboot, which takes every container with it. Left alone it would
    // sit in `ready` advertising a dead URL until its TTL ran out, and the
    // caller's only symptom would be connection refused.
    // Checked against *running*, not merely present: stopping the container
    // host leaves every container in place but dead, which is exactly what a
    // reboot does and exactly what this needs to catch.
    const vanished = all.filter((r) => r.state === 'ready' && !running.has(r.id));
    for (const rec of vanished) {
      await d.store.update(rec.id, {
        state: 'failed',
        error: 'containers are no longer running (the container host restarted); provision a new environment',
      });
    }

    // Work on what is still genuinely live. Reusing the pre-update list would
    // re-attach a route for an environment just marked failed, which is how a
    // dead URL stays published.
    const gone = new Set(vanished.map((r) => r.id));
    const live = all.filter((r) => !gone.has(r.id));
    const knownIds = new Set(live.map((r) => r.id));
    for (const envId of alive) {
      if (!knownIds.has(envId)) await d.runtime.destroy(envId);
    }

    const attached = new Set(await d.ingress.listSlugs());
    const knownSlugs = new Set(live.map((r) => r.slug));
    for (const slug of attached) {
      if (!knownSlugs.has(slug)) await d.ingress.detach(slug);
    }
    // Restoring routes matters as much as removing them: a proxy restart drops
    // every route it held, and without this each running environment would go
    // quietly unreachable while still reporting itself ready.
    for (const rec of live) {
      if (rec.state === 'ready' && rec.hostPort && !attached.has(rec.slug)) {
        await d.ingress.attach(rec.slug, { host: '127.0.0.1', port: rec.hostPort });
      }
    }
  }

  return {
    start() {
      if (timer) return
      const loop = async () => {
        if (stopped || running) return
        running = true
        try {
          await tick(Date.now())
        } catch (err) {
          opts.onError?.('(tick)', err)
        } finally {
          running = false
        }
      }
      timer = setInterval(loop, opts.tickMs)
      timer.unref?.()
      void loop()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = undefined
      // Let an in-flight pass finish rather than tearing out from under it.
      while (running) await new Promise((r) => setTimeout(r, 25))
    },
    tick,
  }
}
