/**
 * R3a, the warm app: the pure decisions behind the installed-app cache.
 *
 * Kept free of I/O so every branch is testable without a simulator. The
 * runner and pool do what these functions say; they do not re-derive it.
 *
 * The rules, in one place:
 *  - A device remembers the build it was left holding (`installed`) and whose
 *    build last ran on it (`tenant`).
 *  - A run that installs a build onto a device last used by another tenant --
 *    or one whose contents are unknown after a crash (`dirty`) -- erases the
 *    device first. iOS keeps permission grants past an uninstall, and keychain
 *    items and the general pasteboard are not app-scoped, so an uninstall is
 *    not a tenant boundary. Erase is the only reset the harness trusts.
 *  - The install is skipped only when this run asked for `relaunch`, and the
 *    device holds this exact build (content hash) for this tenant.
 *  - A run that ends error/timeout/cancelled never leaves its app behind.
 */
import type { PooledDevice, ResetPolicy, Run, RunStatus } from './types.js';

/**
 * The tenant a run belongs to. A caller-supplied `tenant` is namespaced under
 * the submitting token, so one token can never claim another's warm device or
 * dodge its erase by naming the other token's tenant.
 */
export function tenantOf(run: Pick<Run, 'submittedBy' | 'request'>): string {
  const token = run.submittedBy?.tokenId ?? 'local';
  return run.request.tenant ? `${token}/${run.request.tenant}` : token;
}

export type DeviceCacheState = Pick<PooledDevice, 'installed' | 'tenant' | 'dirty'>;

export interface InstallDecision {
  /** reuse: skip install. install: uninstall + install. */
  action: 'reuse' | 'install';
  /** Erase the device before doing anything else. */
  erase: boolean;
  reason: string;
}

export function decideInstall(opts: {
  device: DeviceCacheState;
  bundleId: string;
  /** Undefined for a build with no cheap content identity. */
  appHash: string | undefined;
  tenant: string;
  resetPolicy: ResetPolicy;
}): InstallDecision {
  const { device, bundleId, appHash, tenant, resetPolicy } = opts;
  if (device.dirty) {
    return { action: 'install', erase: true, reason: 'device came back from a daemon crash with unknown contents; erasing before install' };
  }
  if (device.tenant && device.tenant !== tenant) {
    return { action: 'install', erase: true, reason: 'device last ran another tenant\'s build; erasing before install' };
  }
  if (resetPolicy !== 'relaunch') {
    return { action: 'install', erase: false, reason: `resetPolicy "${resetPolicy}" always installs fresh` };
  }
  if (!appHash) {
    return { action: 'install', erase: false, reason: 'this build has no content hash (source build or bare .app), so it cannot be matched' };
  }
  const have = device.installed;
  if (!have) return { action: 'install', erase: false, reason: 'nothing cached on this device yet' };
  if (have.bundleId !== bundleId) return { action: 'install', erase: false, reason: `device holds ${have.bundleId}, not ${bundleId}` };
  if (have.appHash !== appHash) return { action: 'install', erase: false, reason: 'device holds a different build of this app' };
  if ((have.tenant ?? tenant) !== tenant) {
    return { action: 'install', erase: true, reason: 'cached build belongs to another tenant; erasing before install' };
  }
  return { action: 'reuse', erase: false, reason: 'device already holds this exact build for this tenant' };
}

const DIRTY: readonly RunStatus[] = ['error', 'timeout', 'cancelled'];

/**
 * The reset policy actually used when a run hands its device back. `relaunch`
 * is only honoured after a clean finish (passed, or failed -- a failed
 * assertion is a verdict, not a harness fault), and only when there is a build
 * worth keeping.
 */
export function decideRelease(opts: {
  requested: ResetPolicy;
  status: RunStatus;
  /** The harness installed (or reused) the app on this device. */
  ours: boolean;
  appHash: string | undefined;
}): ResetPolicy {
  const { requested, status, ours, appHash } = opts;
  if (requested !== 'relaunch') return requested;
  if (DIRTY.includes(status)) return 'uninstall';
  if (ours && !appHash) return 'uninstall';
  return 'relaunch';
}

/**
 * How well a ready device suits a run, higher is better. Used to break ties
 * between several ready devices, never to wait for a busy one: affinity that
 * queues a run behind its own warm device would strand capacity.
 *   3 -- holds this build for this tenant (install skipped)
 *   2 -- last used by this tenant (no erase)
 *   1 -- clean: no tenant recorded (no erase)
 *   0 -- another tenant's, or dirty (costs an erase)
 */
export function leaseScore(device: DeviceCacheState, want: { tenant: string; appHash?: string | undefined }): number {
  if (device.dirty) return 0;
  if (device.tenant && device.tenant !== want.tenant) return 0;
  if (want.appHash && device.installed?.appHash === want.appHash
      && (device.installed.tenant ?? want.tenant) === want.tenant) return 3;
  if (device.tenant === want.tenant) return 2;
  return 1;
}
