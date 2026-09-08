// The four seams. Everything host-specific implements one of these.
//
// The rule: core code (lifecycle, seeding order, TTL, reconciliation) may import
// these interfaces and nothing else. If the core ever needs to know whether it is
// running on a laptop or in a cloud region, a seam is in the wrong place.

import type { EnvRecord, EnvSpec, ImageRef, Resources } from '../types.js'

/** Label applied to every container. The labels — not the store — are the
 *  authoritative answer to "what actually exists", so a crashed daemon cannot
 *  leak an env the store has forgotten about. */
export const ENV_LABEL = 'envcheck.env'
export const OWNER_LABEL = 'envcheck.owner'

export interface ContainerSpec {
  envId: string
  /** Role within the env: 'app' | 'db' | 'cache'. Part of the container name. */
  role: string
  image: string
  env?: Record<string, string>
  cmd?: string[]
  networkId: string
  resources?: Resources
  /** Container-level healthcheck. The reconciler waits on this rather than
   *  sleeping, so a slow-starting app is not mistaken for a broken one. */
  healthcheck?: { test: string[]; intervalMs: number; retries: number }
  /**
   * Publish this container port to an ephemeral host port.
   *
   * Only the app container sets this. On macOS the container network is not
   * routable from the host, so a proxy running on the host can only reach a
   * published port — whereas the database deliberately publishes nothing and
   * stays reachable only from inside the env network.
   *
   * A deployment that runs the proxy as a container on the env network would
   * skip publishing entirely. That difference is exactly why it lives behind
   * this seam.
   */
  publish?: number
}

export interface ContainerHandle {
  id: string
  /** DNS name of this container on the env network. */
  hostname: string
  /** Assigned host port, when `publish` was set. */
  hostPort?: number
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface Capacity {
  freeMemoryMb: number
  freeDiskGb: number
  runningEnvs: number
}

/**
 * Runs containers. Implemented against the Docker Engine HTTP API, which podman,
 * OrbStack, Docker Desktop and a plain dockerd on a cloud VM all speak — so one
 * driver covers local development and a lift-and-shift deployment unchanged.
 *
 * A future Kubernetes or Fargate driver implements this same interface.
 */
export interface RuntimeDriver {
  /** Per-env bridge network. Envs must not be able to reach each other. */
  createNetwork(envId: string): Promise<string>
  run(spec: ContainerSpec): Promise<ContainerHandle>
  waitHealthy(handle: ContainerHandle, timeoutMs: number): Promise<void>
  exec(handle: ContainerHandle, cmd: string[]): Promise<ExecResult>
  /** Upload a file into a running container. Used to deliver seed SQL, which is
   *  too large and too quote-hostile to pass as a shell argument. */
  putFile(handle: ContainerHandle, dir: string, name: string, content: Buffer): Promise<void>
  logs(envId: string, opts?: { role?: string; tail?: number }): Promise<string>
  /** Idempotent: destroying an env that is already gone must succeed. */
  destroy(envId: string): Promise<void>
  /** Every env the runtime knows of, running or not. Used to spot orphans. */
  listEnvIds(): Promise<string[]>
  /**
   * Envs whose containers are actually running.
   *
   * Distinct from listEnvIds because a stopped container is still a container:
   * restarting the container host leaves every one of them present but dead, so
   * presence is not liveness and an env checked the lenient way would keep
   * advertising a URL that refuses connections.
   */
  runningEnvIds(): Promise<string[]>
  capacity(): Promise<Capacity>
}

/**
 * Turns a slug into a reachable URL.
 *
 * Locally this drives the Caddy admin API against a wildcard certificate. A
 * wildcard matters for more than convenience: per-name certificates are
 * published to Certificate Transparency logs within seconds, which would make
 * every env hostname publicly enumerable and defeat the point of an unguessable
 * slug.
 */
export interface IngressDriver {
  /**
   * The URL a slug will be published at, without publishing it.
   *
   * Needed so a reservation can hand out its URL before anything is running.
   * Until attach() is called the hostname resolves but the proxy answers 404,
   * which is the honest response: the environment genuinely is not there yet.
   */
  urlFor(slug: string): string
  /** Idempotent. Returns the externally reachable URL. */
  attach(slug: string, upstream: { host: string; port: number }): Promise<string>
  /** Idempotent: detaching an unknown slug must succeed. */
  detach(slug: string): Promise<void>
  /** Attached slugs, for reconciliation against the store. */
  listSlugs(): Promise<string[]>
  /** Point the proxy at a renewed certificate. Optional: an ingress that does
   *  not terminate TLS has nothing to do here. Without it a renewal updates the
   *  files on disk while the proxy keeps serving the expired one. */
  reloadCert?(paths: { certFile: string; keyFile: string }): Promise<void>
}

/**
 * Makes an image available to the runtime.
 *
 * Locally this is close to a no-op: the image was built by the same daemon that
 * will run it. Once build host and run host differ, this is the seam that moves
 * the bits — which is why it exists before it is strictly needed.
 */
export interface ImageDriver {
  /** Returns a tag the runtime can pull or already has. */
  resolve(ref: ImageRef): Promise<string>
  /** Accepts a packed context in memory or a path to one on disk. */
  build(contextTar: Buffer | string, opts: { dockerfile?: string; buildArgs?: Record<string, string>; tag: string }): Promise<string>
  list(): Promise<Array<{ tag: string; sizeBytes: number; createdAt: number }>>
}

/** Desired state. SQLite locally, Postgres in a deployment. */
export interface Store {
  create(rec: EnvRecord): Promise<void>
  get(id: string): Promise<EnvRecord | undefined>
  getBySlug(slug: string): Promise<EnvRecord | undefined>
  list(filter?: { ownerId?: string; states?: EnvRecord['state'][] }): Promise<EnvRecord[]>
  update(id: string, patch: Partial<EnvRecord>): Promise<void>
  /** Atomically claim envs needing work, so replicas do not collide. */
  claimWork(holder: string, now: number, leaseMs: number, limit: number): Promise<EnvRecord[]>
  countActive(ownerId: string): Promise<number>
}

export interface Drivers {
  runtime: RuntimeDriver
  ingress: IngressDriver
  images: ImageDriver
  store: Store
}

/** Re-exported for driver implementations. */
export type { EnvRecord, EnvSpec, ImageRef, Resources }
