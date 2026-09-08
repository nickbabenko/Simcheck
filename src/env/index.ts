// Wiring for the environments subsystem.
//
// Replaces what was a standalone daemon: simcheck already has a long-lived
// process under launchd, an authenticated HTTP surface and a token store, so
// this contributes a service and a reconciler and borrows the rest.
//
// The reconciler living in the daemon rather than the MCP process matters.
// A stdio MCP server is spawned per client session and dies with it; TTLs would
// then only be honoured while an agent happened to be connected, and an
// environment left behind by a closed session would run until the machine
// rebooted.

import type { Config } from '../config.js';
import { logger } from '../log.js';
import { createSqliteStore } from './drivers/sqlite-store.js';
import { createDockerRuntime } from './drivers/docker-runtime.js';
import { createCaddyIngress, createNullIngress } from './drivers/caddy.js';
import { createImageDriver } from './drivers/images.js';
import { createReconciler, type Reconciler } from './reconcile.js';
import { createService, type Service } from './service.js';
import type { Drivers } from './drivers/index.js';
import path from 'node:path';

const log = logger('envs');

export interface EnvSubsystem {
  drivers: Drivers;
  service: Service;
  reconciler: Reconciler;
}

/** Present only when envEnabled; every call site must handle its absence, so a
 *  Mac with no container runtime keeps working as a plain simulator harness. */
export function createEnvSubsystem(cfg: Config, home: string): EnvSubsystem {
  const store = createSqliteStore(path.join(home, 'envs.db'));
  const runtime = createDockerRuntime({ dockerHost: cfg.envDockerHost, diskPath: home });

  // Without TLS files there is nothing to serve https with, and an ingress that
  // silently downgraded to http would fail on a real device under ATS rather
  // than here, with a clearer message.
  const ingress = cfg.envCaddyAdmin
    ? createCaddyIngress({
        adminUrl: cfg.envCaddyAdmin,
        baseDomain: cfg.envBaseDomain,
        listen: cfg.envIngressListen,
        ...(cfg.envTlsCert && cfg.envTlsKey
          ? { tls: { certFile: cfg.envTlsCert, keyFile: cfg.envTlsKey } }
          : {}),
      })
    : createNullIngress();

  const images = createImageDriver({
    dockerHost: cfg.envDockerHost,
    ...(cfg.envRegistry ? { registryUrl: cfg.envRegistry } : {}),
  });

  const drivers: Drivers = { store, runtime, ingress, images };

  const service = createService(drivers, {
    maxConcurrentEnvs: cfg.envMaxConcurrent,
    maxTtlSeconds: cfg.envMaxTtlSeconds,
    defaultTtlSeconds: cfg.envDefaultTtlSeconds,
    maxMemoryMbPerEnv: cfg.envMaxMemoryMb,
    maxReservations: cfg.envMaxReservations,
  });

  const reconciler = createReconciler(drivers, {
    holder: `simcheck:${process.pid}`,
    tickMs: 2000,
    leaseMs: 60_000,
    // Shares the floor the pool already respects: an environment that fills the
    // disk breaks simulator runs, and that failure is far harder to read than
    // a refusal here.
    minFreeDiskGb: cfg.minFreeDiskGb,
    minFreeMemoryMb: cfg.envMinFreeMemoryMb,
    provisionTimeoutMs: cfg.envProvisionTimeoutMs,
    onError: (envId, err) => log.error(`reconcile ${envId}`, String(err)),
    onNotice: (message) => log.warn(message),
  });

  return { drivers, service, reconciler };
}

/** One-line readiness summary for the daemon log, so a misconfigured runtime is
 *  visible at startup rather than at the first provision. */
export async function describeEnvRuntime(sub: EnvSubsystem): Promise<string> {
  try {
    const cap = await sub.drivers.runtime.capacity();
    return `ready (${cap.runningEnvs} running, ${cap.freeDiskGb.toFixed(1)} GB free)`;
  } catch (e) {
    return `unavailable: ${(e as Error).message}`;
  }
}
