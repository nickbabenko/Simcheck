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
    const live = (await d.store.list()).filter((r) => r.state !== 'destroyed' && r.state !== 'failed')
    const knownIds = new Set(live.map((r) => r.id))
    for (const envId of await d.runtime.listEnvIds()) {
      if (!knownIds.has(envId)) await d.runtime.destroy(envId)
    }

    const attached = new Set(await d.ingress.listSlugs())
    const knownSlugs = new Set(live.map((r) => r.slug))
    for (const slug of attached) {
      if (!knownSlugs.has(slug)) await d.ingress.detach(slug)
    }
    for (const rec of live) {
      if (rec.state === 'ready' && rec.hostPort && !attached.has(rec.slug)) {
        await d.ingress.attach(rec.slug, { host: '127.0.0.1', port: rec.hostPort })
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
