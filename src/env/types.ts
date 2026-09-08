// Core domain types. Nothing here knows where the service runs — that is the
// point. Host-specific behaviour lives behind the driver interfaces in
// src/drivers/, so the same core runs on a laptop and in a cloud region.

/** Lifecycle. `seeding` is deliberately distinct from `provisioning`: the app
 *  container must not start until the database has been seeded, or it races its
 *  own migrations against an empty schema and fails intermittently. */
export type EnvState =
  /** A URL is allocated and nothing else. Costs a row and 80 bits of entropy,
   *  holds no containers, and deliberately does NOT count against the
   *  concurrency quota -- the whole point is to hand a build its URL before
   *  anything is running, while CI takes its minutes. */
  | 'reserved'
  | 'pending'
  | 'provisioning'
  | 'seeding'
  | 'ready'
  | 'failed'
  | 'expired'
  | 'destroying'
  | 'destroyed'

export const TERMINAL_STATES: ReadonlySet<EnvState> = new Set(['failed', 'destroyed'])

/** How the caller names the image to run.
 *
 *  `tag` resolves against whatever the runtime can already see, which locally
 *  means "the thing you just built". In a deployment where the build host and
 *  the run host differ, only `registry` and `build` are meaningful — the images
 *  driver is what closes that gap. */
export type ImageRef =
  | { kind: 'tag'; tag: string }
  | { kind: 'registry'; ref: string; auth?: RegistryAuth }
  | { kind: 'build'; contextTar: Buffer | string; dockerfile?: string; buildArgs?: Record<string, string> }

export interface RegistryAuth {
  username: string
  /** Never logged, never returned by the API. */
  secretRef: string
}

export type DbEngine = 'postgres' | 'mysql'

export interface DbSpec {
  engine: DbEngine
  /** Image tag suffix, e.g. '17-alpine'. Defaults per engine. */
  version?: string
  database?: string
  seed?: SeedSpec
}

/** Seed forms, cheapest last.
 *
 *  `template` is by far the fastest for a large dataset: restore once into a
 *  template database, then `CREATE DATABASE x TEMPLATE y` per env, which is a
 *  file copy rather than a replay. Worth it as soon as a dump takes minutes. */
export type SeedSpec =
  | { kind: 'sql'; sql: string }
  | { kind: 'sqlFile'; path: string }
  | { kind: 'dump'; path: string }
  | { kind: 'template'; name: string }

export interface CacheSpec {
  engine: 'redis'
  version?: string
}

export interface Resources {
  memoryMb?: number
  cpus?: number
}

/** One service within an environment. */
export interface ServiceSpec {
  image: ImageRef
  /** Container port this service listens on. */
  port: number
  env?: Record<string, string>
  resources?: Resources
  /**
   * The service that keeps the bare `<slug>` hostname; the others get
   * `<slug>-<name>`.
   *
   * That naming is not cosmetic. A wildcard certificate covers exactly one
   * label, so `*.env.example.com` matches `abc123-admin.env.example.com` but
   * NOT `admin.abc123.env.example.com`. The nested form works fine over plain
   * http and then fails TLS the first time a real device points at it.
   */
  primary?: boolean
}

/** What the caller asks for. */
export interface EnvSpec {
  /** Single-service shorthand. Equivalent to one service named "app". */
  image?: ImageRef
  port?: number
  /**
   * Several services sharing one database, one cache and one network, so they
   * reach each other by name. Use this when the app under test needs more than
   * one URL from the same stack.
   */
  services?: Record<string, ServiceSpec>
  env?: Record<string, string>
  db?: DbSpec
  cache?: CacheSpec
  ttlSeconds?: number
  resources?: Resources
  /** Present from day one even though there is one owner locally. Adding a
   *  tenancy scope later means revisiting every query and every auth check. */
  ownerId: string
}

/** What the service records. The store holds *desired* state; the runtime and
 *  ingress drivers are queried for *actual* state; the reconciler converges
 *  them. See src/reconcile.ts. */
export interface EnvRecord {
  id: string
  /** Unguessable subdomain label. Obscurity is not authentication — see README. */
  slug: string
  ownerId: string
  spec: EnvSpec
  state: EnvState
  /** The primary service's URL. Kept alongside `urls` because almost every
   *  caller wants exactly one address and should not have to pick. */
  url?: string
  /** Every service's public URL, keyed by service name. */
  urls?: Record<string, string> | undefined
  /** Host port the primary service publishes. */
  hostPort?: number
  /** Published host port per service. Persisted so every route can be rebuilt
   *  after a proxy restart without re-provisioning. */
  hostPorts?: Record<string, number> | undefined
  /** Reachable from inside the env network only; never the public URL. */
  internalDbUrl?: string
  internalCacheUrl?: string
  createdAt: number
  /** Runtime lifetime. Starts when the environment is *provisioned*, not when
   *  it was reserved, so a long cloud build does not eat the test's window. */
  expiresAt: number
  /**
   * When an unprovisioned reservation is given up.
   *
   * Separate from expiresAt and much more generous, because a reservation costs
   * nothing to hold. One clock would force a choice between "long enough for CI"
   * and "short enough not to strand containers"; two clocks need no compromise.
   */
  reservedUntil?: number | undefined
  /** Set when state is `failed`. Surfaced to the caller verbatim — a provisioning
   *  failure the caller cannot read is a support ticket. */
  error?: string
  /** Reconciler lease, so multiple replicas do not act on one env at once. */
  leaseHolder?: string | undefined
  leaseExpiresAt?: number | undefined
}

export interface Quota {
  /** Reservations are cheap but not free -- a runaway loop should not be able
   *  to fill the table. They expire on their own; this is only a backstop. */
  maxReservations: number
  maxConcurrentEnvs: number
  maxTtlSeconds: number
  defaultTtlSeconds: number
  maxMemoryMbPerEnv: number
}
