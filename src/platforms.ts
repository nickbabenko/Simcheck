import type { Config } from './config.js';
import type { PlatformId, PlatformSupport } from './device.js';
import { PLATFORMS } from './device.js';
import { createIosPlatform } from './ios/index.js';
import { logger } from './log.js';

const log = logger('platforms');

type Factory = (cfg: Config) => Promise<PlatformSupport>;

const FACTORIES: Record<PlatformId, Factory> = {
  ios: createIosPlatform,
  // android: createAndroidPlatform,
} as Record<PlatformId, Factory>;

/**
 * Which platforms this daemon can actually serve.
 *
 * A platform whose toolchain is missing is recorded as unavailable with the
 * reason, not treated as fatal: a Mac with Xcode but no Android SDK should
 * still run iOS, and say clearly why an Android run was refused. Only having
 * *no* usable platform is a startup failure.
 */
export class Platforms {
  private byId = new Map<PlatformId, PlatformSupport>();
  private failures = new Map<PlatformId, string>();

  constructor(private fallback: PlatformId) {}

  register(id: PlatformId, support: PlatformSupport): void { this.byId.set(id, support); }
  recordFailure(id: PlatformId, reason: string): void { this.failures.set(id, reason); }

  has(id: PlatformId): boolean { return this.byId.has(id); }
  available(): PlatformId[] { return [...this.byId.keys()]; }

  /** Why a platform is not usable here, for an error a caller can act on. */
  reason(id: PlatformId): string {
    return this.failures.get(id)
      ?? (FACTORIES[id] ? 'not enabled in this daemon\'s `platforms` config' : 'not supported by this build');
  }

  get(id: PlatformId): PlatformSupport {
    const support = this.byId.get(id);
    if (!support) {
      throw new Error(
        `this daemon cannot run ${id} tests: ${this.reason(id)}. ` +
        `Available: ${this.available().join(', ') || 'none'}.`);
    }
    return support;
  }

  /** The platform a request that names none should get. */
  default(): PlatformId {
    if (this.byId.has(this.fallback)) return this.fallback;
    const first = this.available()[0];
    if (!first) throw new Error('no platform is available on this machine');
    return first;
  }
}

export async function loadPlatforms(cfg: Config): Promise<Platforms> {
  const platforms = new Platforms(cfg.defaultPlatform);

  for (const id of PLATFORMS) {
    if (!cfg.platforms.includes(id)) {
      platforms.recordFailure(id, 'not enabled in this daemon\'s `platforms` config');
      continue;
    }
    const factory = FACTORIES[id];
    if (!factory) {
      platforms.recordFailure(id, 'not supported by this build');
      continue;
    }
    try {
      platforms.register(id, await factory(cfg));
      log.info(`${id} ready`);
    } catch (e) {
      const why = (e as Error).message;
      platforms.recordFailure(id, why);
      log.warn(`${id} unavailable`, why);
    }
  }

  if (!platforms.available().length) {
    throw new Error(
      'no platform toolchain is usable on this machine, so no run could ever succeed. ' +
      PLATFORMS.map((p) => `${p}: ${platforms.reason(p)}`).join('  |  '));
  }
  return platforms;
}
