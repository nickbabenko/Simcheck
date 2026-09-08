// The API the daemon, CLI and MCP server all sit on top of.
//
// Nothing here talks to Docker or Caddy directly — it writes desired state and
// lets the reconciler converge. `provision` therefore returns immediately with
// an id, which is also the honest shape: pulling an image and seeding a database
// takes longer than any caller should hold a request open for.
//
// Every method takes a Principal. Making it the first parameter rather than an
// optional trailing one means an unauthenticated call is a type error, not a
// silently permitted one.

import { randomUUID } from 'node:crypto'
import type { Drivers } from './drivers/index.js'
import type { EnvRecord, EnvSpec, Quota } from './types.js'
import { newSlug } from './slug.js'
import { assertOwns, requireScope, type Principal } from './principal.js'
import { packContext } from './context.js'

import { NotFoundError, QuotaError } from './errors.js'
export { NotFoundError, QuotaError } from './errors.js'

/** An hour: long enough for any cloud build, short enough that a forgotten
 *  reservation does not linger. Costs a row either way. */
const DEFAULT_RESERVATION_SECONDS = 3600

/** The caller describes what it wants; it does not get to say whose it is.
 *  ownerId comes from the token, or one tenant could provision into another. */
export type EnvRequest = Omit<EnvSpec, 'ownerId'>

export interface Service {
  /**
   * Allocate a URL and nothing else.
   *
   * For the case where something slow has to be told the URL before the
   * environment can usefully exist -- a cloud build that bakes it in, and takes
   * minutes doing it. Provisioning first would burn the runtime TTL and hold a
   * concurrency slot for the whole build, so a reservation holds neither.
   */
  reserve(p: Principal, req: EnvRequest, reservationSeconds?: number): Promise<EnvRecord>
  /** Provision fresh, or materialise a reservation by passing its envId. */
  provision(p: Principal, req: EnvRequest, envId?: string): Promise<EnvRecord>
  get(p: Principal, id: string): Promise<EnvRecord>
  list(p: Principal): Promise<EnvRecord[]>
  extend(p: Principal, id: string, seconds: number): Promise<EnvRecord>
  destroy(p: Principal, id: string): Promise<void>
  logs(p: Principal, id: string, opts?: { role?: string; tail?: number }): Promise<string>
  exec(p: Principal, id: string, cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>
  waitFor(p: Principal, id: string, timeoutMs: number): Promise<EnvRecord>
  buildImage(p: Principal, o: BuildRequest): Promise<{ image: string; warning?: string }>
  listImages(p: Principal): Promise<Array<{ tag: string; sizeBytes: number; createdAt: number }>>
}

export interface BuildRequest {
  contextPath: string
  tag: string
  dockerfile?: string
  buildArgs?: Record<string, string>
}

export function createService(d: Drivers, quota: Quota): Service {
  /** Look up and authorise in one step, so no call site can do one without the
   *  other. Returns the same error for "not yours" as for "does not exist". */
  async function owned(p: Principal, id: string): Promise<EnvRecord> {
    const rec = await d.store.get(id)
    // Byte-identical to the message assertOwns throws. Including the id here
    // made a cross-tenant hit distinguishable from a genuine miss, which is
    // the enumeration leak the shared message exists to prevent.
    if (!rec) throw new NotFoundError('no such env')
    assertOwns(p, rec.ownerId)
    return rec
  }

  return {
    async reserve(p, req, reservationSeconds) {
      requireScope(p, 'env:write')
      // Deliberately no countActive check: a reservation is not a slot. If it
      // counted, a queue of builds waiting on CI would block the machine from
      // running the very tests those builds are for.
      const held = (await d.store.list({ ownerId: p.ownerId, states: ['reserved'] })).length
      if (held >= quota.maxReservations) {
        throw new QuotaError(`holding ${held} reservations, limit is ${quota.maxReservations}`)
      }
      const now = Date.now()
      const until = now + (reservationSeconds ?? DEFAULT_RESERVATION_SECONDS) * 1000
      const slug = newSlug()
      const rec: EnvRecord = {
        id: randomUUID(),
        slug,
        ownerId: p.ownerId,
        spec: { ...req, ownerId: p.ownerId },
        state: 'reserved',
        url: d.ingress.urlFor(slug),
        createdAt: now,
        // Mirrors reservedUntil so any generic expiry logic behaves sensibly;
        // the real runtime clock is set when it is provisioned.
        expiresAt: until,
        reservedUntil: until,
      }
      await d.store.create(rec)
      return rec
    },

    async provision(p, req, envId) {
      requireScope(p, 'env:write')
      const active = await d.store.countActive(p.ownerId)
      if (active >= quota.maxConcurrentEnvs) {
        throw new QuotaError(
          `at the concurrent env limit (${active}/${quota.maxConcurrentEnvs}); destroy one or raise ENVCHECK_MAX_ENVS`,
        )
      }
      const ttl = Math.min(req.ttlSeconds ?? quota.defaultTtlSeconds, quota.maxTtlSeconds)
      if (req.resources?.memoryMb && req.resources.memoryMb > quota.maxMemoryMbPerEnv) {
        throw new QuotaError(`requested ${req.resources.memoryMb} MB, limit is ${quota.maxMemoryMbPerEnv} MB`)
      }

      const now = Date.now()

      // Materialising a reservation: keep its id and slug, because the URL has
      // already been handed out and possibly compiled into a build.
      if (envId) {
        const held = await owned(p, envId)
        if (held.state !== 'reserved') {
          throw new Error(`env ${envId} is ${held.state}, not a reservation`)
        }
        const started: EnvRecord = {
          ...held,
          spec: { ...req, ownerId: p.ownerId, ttlSeconds: ttl },
          state: 'pending',
          expiresAt: now + ttl * 1000,
          reservedUntil: undefined,
        }
        await d.store.update(envId, {
          state: 'pending',
          expiresAt: started.expiresAt,
          reservedUntil: undefined,
          spec: started.spec,
        })
        return started
      }

      const rec: EnvRecord = {
        id: randomUUID(),
        slug: newSlug(),
        ownerId: p.ownerId,
        spec: { ...req, ownerId: p.ownerId, ttlSeconds: ttl },
        state: 'pending',
        createdAt: now,
        // The clock starts now, not when the env becomes ready. A slow image
        // pull should not buy extra lifetime.
        expiresAt: now + ttl * 1000,
      }
      await d.store.create(rec)
      return rec
    },

    async get(p, id) {
      requireScope(p, 'env:read')
      return owned(p, id)
    },

    async list(p) {
      requireScope(p, 'env:read')
      // Admin sees everything; a tenant sees only its own, and the filter is
      // applied in the query rather than after, so nothing else is ever loaded.
      return d.store.list(p.scopes.includes('admin') ? undefined : { ownerId: p.ownerId })
    },

    async extend(p, id, seconds) {
      requireScope(p, 'env:write')
      const rec = await owned(p, id)
      const from = Math.max(rec.expiresAt, Date.now())
      const capped = Math.min(from + seconds * 1000, rec.createdAt + quota.maxTtlSeconds * 1000)
      await d.store.update(id, { expiresAt: capped })
      return { ...rec, expiresAt: capped }
    },

    /** Marks the env expired; the reconciler tears it down. Returning before
     *  teardown finishes is deliberate — the caller does not need to wait, and
     *  the loop retries if the daemon dies mid-destroy. */
    async destroy(p, id) {
      requireScope(p, 'env:write')
      const rec = await owned(p, id)
      if (rec.state !== 'destroyed') await d.store.update(id, { state: 'expired' })
    },

    async logs(p, id, opts) {
      requireScope(p, 'env:read')
      await owned(p, id)
      return d.runtime.logs(id, opts)
    },

    async exec(p, id, cmd) {
      // A separate scope from write: running arbitrary commands inside a
      // container is a bigger grant than being able to start and stop one.
      requireScope(p, 'env:exec')
      const rec = await owned(p, id)
      if (rec.state !== 'ready') throw new Error(`env is ${rec.state}, not ready`)
      return d.runtime.exec({ id: `envcheck-${rec.id}-app`, hostname: 'app' }, cmd)
    },

    /**
     * Pack a directory and build it.
     *
     * Returns whatever reference the runtime can actually run: a local tag when
     * no registry is configured, and a pushed registry ref when there is one.
     * The caller passes that straight to provision without caring which.
     */
    async buildImage(p, o) {
      requireScope(p, 'env:write')
      const packed = await packContext(o.contextPath)
      const image = await d.images.build(packed.tar, {
        tag: o.tag,
        ...(o.dockerfile ? { dockerfile: o.dockerfile } : {}),
        ...(o.buildArgs ? { buildArgs: o.buildArgs } : {}),
      })
      return { image, ...(packed.warning ? { warning: packed.warning } : {}) }
    },

    async listImages(p) {
      requireScope(p, 'env:read')
      return d.images.list()
    },

    /** Polls the store rather than the runtime: the reconciler is the only thing
     *  that writes state, so the store is the authoritative view of progress. */
    async waitFor(p, id, timeoutMs) {
      requireScope(p, 'env:read')
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const rec = await owned(p, id)
        if (rec.state === 'ready' || rec.state === 'failed' || rec.state === 'destroyed') return rec
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${id} (state: ${rec.state})`)
        await new Promise((r) => setTimeout(r, 250))
      }
    },
  }
}
