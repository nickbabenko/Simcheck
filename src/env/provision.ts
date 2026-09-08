// The provisioning path.
//
// Runs to completion inside one claimed lease rather than being spread across
// reconciler ticks. Resumption then needs no persisted handles: if this crashes
// half way, the lease expires, the next tick re-claims, and every step below is
// written to be safely re-runnable.

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ContainerHandle, Drivers } from './drivers/index.js'
import type { EnvRecord, EnvState, SeedSpec } from './types.js'
import { ENGINES, supportsTemplate, type Engine, type EngineContext } from './engines.js'
import { internalEnv, normaliseServices, serviceSlug } from './services.js'

const DEFAULT_REDIS = '7-alpine'

/** Marks a database as already seeded, so a retry after a partial failure does
 *  not replay a seed script that is not itself idempotent. */
const SEED_MARKER = '_envcheck_seeded'

export interface ProvisionResult {
  /** The primary service's URL. */
  url: string
  hostPort: number
  urls: Record<string, string>
  hostPorts: Record<string, number>
  internalDbUrl?: string
  internalCacheUrl?: string
}

export interface ProvisionDeps {
  provisionTimeoutMs: number
  /** Reports progress so `get_env` shows something more useful than "pending"
   *  during the minute a cold image pull takes. */
  onState?: (s: EnvState) => Promise<void>
}

export async function provisionEnv(d: Drivers, rec: EnvRecord, o: ProvisionDeps): Promise<ProvisionResult> {
  const { spec } = rec
  const timeout = o.provisionTimeoutMs
  await o.onState?.('provisioning')

  const network = await d.runtime.createNetwork(rec.id)

  let internalDbUrl: string | undefined
  let internalCacheUrl: string | undefined

  // --- database ------------------------------------------------------------
  if (spec.db) {
    const engine: Engine | undefined = ENGINES[spec.db.engine]
    if (!engine) throw new Error(`unknown db engine '${spec.db.engine}'`)
    if (spec.db.seed?.kind === 'template' && !supportsTemplate(spec.db.engine)) {
      // Better to refuse than to start an env whose data silently never arrived.
      throw new Error(`'template' seeding is not supported by ${spec.db.engine}; use 'dump' or 'sql'`)
    }

    // Random per env. These credentials never leave the env network, but a
    // shared default password across every env stops being harmless the moment
    // one env is exposed.
    const ctx: EngineContext = {
      database: spec.db.database ?? 'app',
      user: 'app',
      password: randomBytes(18).toString('base64url'),
      rootPassword: randomBytes(18).toString('base64url'),
    }

    const db = await d.runtime.run({
      envId: rec.id,
      role: 'db',
      image: engine.image(spec.db.version ?? engine.defaultVersion),
      networkId: network,
      env: engine.env(ctx),
      healthcheck: engine.healthcheck(ctx),
      resources: { memoryMb: spec.db.engine === 'mysql' ? 512 : 256 },
    })
    // Waiting on the engine's own readiness probe rather than sleeping is what
    // stops the app racing its migrations against a half-initialised database.
    await d.runtime.waitHealthy(db, timeout)

    if (spec.db.seed) {
      await o.onState?.('seeding')
      await applySeed(d, db, engine, ctx, spec.db.seed)
    }
    internalDbUrl = engine.url(ctx)
  }

  // --- cache ---------------------------------------------------------------
  if (spec.cache) {
    const cache = await d.runtime.run({
      envId: rec.id,
      role: 'cache',
      image: `redis:${spec.cache.version ?? DEFAULT_REDIS}`,
      networkId: network,
      healthcheck: { test: ['CMD', 'redis-cli', 'ping'], intervalMs: 1000, retries: 15 },
      resources: { memoryMb: 64 },
    })
    await d.runtime.waitHealthy(cache, timeout)
    internalCacheUrl = 'redis://cache:6379'
  }

  // --- services ------------------------------------------------------------
  // Started only now: after the database exists and the seed has been applied.
  // Every service shares the database, the cache and the network, which is what
  // makes them one stack rather than several environments that happen to agree.
  const services = normaliseServices(spec)
  const shared = {
    ...(internalDbUrl ? { DATABASE_URL: internalDbUrl } : {}),
    ...(internalCacheUrl ? { REDIS_URL: internalCacheUrl } : {}),
    ...internalEnv(services),
    ...spec.env,
  }

  const urls: Record<string, string> = {}
  const hostPorts: Record<string, number> = {}
  let primaryUrl: string | undefined
  let primaryPort: number | undefined

  for (const svc of services) {
    const image = await d.images.resolve(svc.image)
    const container = await d.runtime.run({
      envId: rec.id,
      // The role doubles as the network alias, so one service reaches another
      // at http://<name>:<port> without knowing any public hostname.
      role: svc.name,
      image,
      networkId: network,
      publish: svc.port,
      env: { ...shared, PORT: String(svc.port), ...svc.env },
      ...(svc.resources ?? spec.resources ? { resources: svc.resources ?? spec.resources! } : {}),
    })
    await d.runtime.waitHealthy(container, timeout)
    if (!container.hostPort) throw new Error(`service '${svc.name}' published no host port`)

    const url = await d.ingress.attach(serviceSlug(rec.slug, svc), {
      host: '127.0.0.1', port: container.hostPort,
    })
    urls[svc.name] = url
    hostPorts[svc.name] = container.hostPort
    if (svc.primary) {
      primaryUrl = url
      primaryPort = container.hostPort
    }
  }

  if (!primaryUrl || primaryPort === undefined) throw new Error('no primary service was started')

  const result: ProvisionResult = { url: primaryUrl, hostPort: primaryPort, urls, hostPorts }
  if (internalDbUrl) result.internalDbUrl = internalDbUrl
  if (internalCacheUrl) result.internalCacheUrl = internalCacheUrl
  return result
}

async function applySeed(
  d: Drivers,
  db: ContainerHandle,
  engine: Engine,
  ctx: EngineContext,
  seed: SeedSpec,
): Promise<void> {
  // Already seeded? A crash between "seed applied" and "state written" would
  // otherwise replay a script that may well not be idempotent.
  const marker = await d.runtime.exec(db, engine.seedMarkerCheck(ctx, SEED_MARKER))
  if (marker.stdout.trim() === 't') return

  const fail = (what: string, r: { stdout: string; stderr: string }) =>
    new Error(`${what} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`)

  switch (seed.kind) {
    case 'sql':
    case 'sqlFile': {
      const content = seed.kind === 'sql' ? Buffer.from(seed.sql, 'utf8') : await readFile(seed.path)
      await d.runtime.putFile(db, '/tmp', 'seed.sql', content)
      const res = await d.runtime.exec(db, engine.applySqlFile(ctx, '/tmp/seed.sql'))
      if (res.exitCode !== 0) throw fail('seed', res)
      break
    }
    case 'dump': {
      if (!engine.applyDump) throw new Error('this engine has no dump restore path')
      await d.runtime.putFile(db, '/tmp', 'seed.dump', await readFile(seed.path))
      const res = await d.runtime.exec(db, engine.applyDump(ctx, '/tmp/seed.dump'))
      // pg_restore exits non-zero over roles a fresh instance does not have,
      // which is routine for a dump taken from a real database.
      if (res.exitCode !== 0 && (engine.dumpWarningsAreFatal || /error/i.test(res.stderr))) {
        throw fail('restore', res)
      }
      break
    }
    case 'template': {
      if (!engine.cloneTemplate) throw new Error('this engine has no template clone path')
      // A file copy rather than a replay — seconds instead of minutes once the
      // dataset is large enough to matter.
      const res = await d.runtime.exec(db, engine.cloneTemplate(ctx, seed.name, `${ctx.database}_seeded`))
      if (res.exitCode !== 0) throw fail('template clone', res)
      break
    }
  }

  const mark = await d.runtime.exec(db, engine.createMarker(ctx, SEED_MARKER))
  if (mark.exitCode !== 0) throw fail('seed marker', mark)
}
