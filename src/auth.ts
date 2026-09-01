import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config } from './config.js';
import { paths } from './config.js';
import { nowIso } from './util.js';
import { logger } from './log.js';

const log = logger('auth');

/** Every distinct thing a caller can be allowed to do. */
export const CAPABILITIES = [
  'runs:submit:local',      // name a path/project/workspace on this Mac -- implies code execution
  'runs:submit:artifact',   // run a previously uploaded .app
  'runs:submit:url',        // have the daemon download a build and run it
  'runs:submit:installed',  // run an app already on the simulator
  'runs:read',              // poll runs, fetch screenshots, reports and logs
  'runs:cancel',
  'artifacts:write',        // upload a .app zip
  'pool:read',
  'pool:write',             // add or remove simulators
  'inspect',                // read the live screen of a pooled simulator
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * `local` is for an agent running on this machine and is unrestricted.
 *
 * `remote` deliberately omits `runs:submit:local`: a caller that can name an
 * arbitrary .xcodeproj can run its build phases, which is arbitrary code
 * execution as you. A remote caller uploads a built .app instead, which is
 * only ever installed into a simulator.
 */
export const PRESETS: Record<string, Capability[]> = {
  full: [...CAPABILITIES],
  remote: ['runs:submit:artifact', 'runs:submit:url', 'runs:submit:installed', 'runs:read', 'runs:cancel', 'artifacts:write', 'pool:read'],
  readonly: ['runs:read', 'pool:read'],
};

export interface TokenRecord {
  id: string;
  name: string;
  /** sha256 of the secret. The secret itself is shown once, at creation. */
  hash: string;
  capabilities: Capability[];
  /** The preset this was minted from, if any. Recorded so that adding a
   *  capability to a preset propagates to existing tokens -- a preset is a
   *  named policy, not a snapshot taken at creation. */
  preset?: string;
  createdAt: string;
  lastUsedAt?: string;
  note?: string;
  /** 0 means unlimited. */
  maxConcurrentRuns: number;
  maxRunsPerHour: number;
  disabled?: boolean;
}

export interface Identity {
  id: string;
  name: string;
  capabilities: Capability[];
  maxConcurrentRuns: number;
  maxRunsPerHour: number;
}

export class AuthError extends Error {
  /** Set when the token was valid but lacked a capability, so the audit log
   *  can name who was refused rather than recording "unknown". */
  constructor(public status: number, message: string, public identity?: Identity) { super(message); }
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Token store. Secrets are kept as hashes; the plaintext of the bootstrap
 * `local` token is also written to ~/.simcheck/token so the CLI on this
 * machine works with no setup.
 */
export class TokenStore {
  private records: TokenRecord[] = [];
  private file: string;
  /** Sliding window of submit times, per token id. */
  private submissions = new Map<string, number[]>();

  constructor(private cfg: Config) {
    this.file = path.join(cfg.home, 'tokens.json');
  }

  load(): void {
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { tokens: TokenRecord[] };
        this.records = parsed.tokens ?? [];
      } catch (e) {
        throw new Error(`${this.file} is not valid JSON: ${(e as Error).message}`);
      }
    }
    this.bootstrap();
    this.refreshPresets();
  }

  /**
   * Re-expand preset-derived tokens against the current preset definitions.
   *
   * Without this, a token minted before a capability existed silently lacks it
   * for ever -- which surfaces as a confusing 403 on a feature that was just
   * added, rather than anything resembling a permissions decision.
   */
  private refreshPresets(): void {
    let changed = false;
    for (const t of this.records) {
      // The local token is unconditionally full access.
      const wanted = t.id === 'tok_local' ? PRESETS['full']
        : t.preset ? PRESETS[t.preset]
        : undefined;
      if (!wanted) continue;

      const missing = wanted.filter((c) => !t.capabilities.includes(c));
      if (!missing.length) continue;
      t.capabilities = [...wanted];
      changed = true;
      log.info(`token "${t.name}" gained ${missing.join(', ')} from the ${t.id === 'tok_local' ? 'full' : t.preset} preset`);
    }
    if (changed) this.save();
  }

  /** Add one capability to an existing token, for a token with no preset. */
  grant(nameOrId: string, capability: Capability): TokenRecord {
    if (!CAPABILITIES.includes(capability)) {
      throw new AuthError(400, `unknown capability "${capability}" (have: ${CAPABILITIES.join(', ')})`);
    }
    const t = this.records.find((r) => r.name === nameOrId || r.id === nameOrId);
    if (!t) throw new AuthError(404, `no token "${nameOrId}"`);
    if (!t.capabilities.includes(capability)) {
      t.capabilities.push(capability);
      this.save();
      log.info(`granted ${capability} to "${t.name}"`);
    }
    return t;
  }

  /** Ensure a full-access local token exists, adopting a pre-0.2 token file. */
  private bootstrap(): void {
    if (this.records.some((t) => t.name === 'local')) return;

    const legacy = paths(this.cfg).token;
    const secret = fs.existsSync(legacy)
      ? fs.readFileSync(legacy, 'utf8').trim() || crypto.randomBytes(24).toString('hex')
      : crypto.randomBytes(24).toString('hex');

    this.records.push({
      id: 'tok_local',
      name: 'local',
      hash: sha256(secret),
      capabilities: [...PRESETS['full']!],
      createdAt: nowIso(),
      note: 'Full access for agents running on this machine.',
      maxConcurrentRuns: 0,
      maxRunsPerHour: 0,
    });
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, secret + '\n', { mode: 0o600 });
    this.save();
    log.info('bootstrapped the local full-access token');
  }

  list(): Omit<TokenRecord, 'hash'>[] {
    return this.records.map(({ hash, ...rest }) => rest);
  }

  /** Mint a token. The plaintext is returned once and never stored. */
  create(opts: {
    name: string; preset?: string; capabilities?: Capability[]; note?: string;
    maxConcurrentRuns?: number; maxRunsPerHour?: number;
  }): { record: Omit<TokenRecord, 'hash'>; secret: string } {
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(opts.name)) {
      throw new AuthError(400, 'token name must be 1-32 chars of letters, digits, dot, dash or underscore');
    }
    if (this.records.some((t) => t.name === opts.name)) {
      throw new AuthError(409, `a token named "${opts.name}" already exists`);
    }
    const capabilities = opts.capabilities ?? PRESETS[opts.preset ?? 'remote'];
    if (!capabilities) {
      throw new AuthError(400, `unknown preset "${opts.preset}" (have: ${Object.keys(PRESETS).join(', ')})`);
    }
    const bad = capabilities.filter((c) => !CAPABILITIES.includes(c));
    if (bad.length) throw new AuthError(400, `unknown capabilities: ${bad.join(', ')}`);

    const secret = `shk_${crypto.randomBytes(24).toString('base64url')}`;
    const record: TokenRecord = {
      id: `tok_${crypto.randomBytes(4).toString('hex')}`,
      name: opts.name,
      hash: sha256(secret),
      capabilities: [...capabilities],
      // Only when the caller took the preset wholesale; a custom list is theirs.
      ...(opts.capabilities ? {} : { preset: opts.preset ?? 'remote' }),
      createdAt: nowIso(),
      ...(opts.note ? { note: opts.note } : {}),
      maxConcurrentRuns: opts.maxConcurrentRuns ?? (opts.preset === 'full' ? 0 : 2),
      maxRunsPerHour: opts.maxRunsPerHour ?? (opts.preset === 'full' ? 0 : 60),
    };
    this.records.push(record);
    this.save();
    log.info(`created token "${record.name}" (${record.id}) with ${record.capabilities.length} capabilities`);
    const { hash, ...rest } = record;
    return { record: rest, secret };
  }

  revoke(nameOrId: string): void {
    const before = this.records.length;
    this.records = this.records.filter((t) => t.name !== nameOrId && t.id !== nameOrId);
    if (this.records.length === before) throw new AuthError(404, `no token "${nameOrId}"`);
    if (!this.records.some((t) => t.name === 'local')) {
      throw new AuthError(400, 'refusing to revoke the last local token -- you would lock yourself out');
    }
    this.save();
    log.info(`revoked token "${nameOrId}"`);
  }

  /**
   * Resolve a presented secret. Compares against every record in constant time
   * per record so a wrong token cannot be distinguished by timing.
   */
  verify(presented: string): Identity {
    if (!presented) throw new AuthError(401, 'missing bearer token');
    const digest = Buffer.from(sha256(presented), 'hex');

    let found: TokenRecord | null = null;
    for (const record of this.records) {
      const candidate = Buffer.from(record.hash, 'hex');
      if (candidate.length === digest.length && crypto.timingSafeEqual(candidate, digest)) found = record;
    }
    if (!found) throw new AuthError(401, 'invalid bearer token');
    if (found.disabled) throw new AuthError(403, `token "${found.name}" is disabled`);

    found.lastUsedAt = nowIso();
    this.saveThrottled();
    return {
      id: found.id,
      name: found.name,
      capabilities: found.capabilities,
      maxConcurrentRuns: found.maxConcurrentRuns,
      maxRunsPerHour: found.maxRunsPerHour,
    };
  }

  /** Throw unless the identity holds the capability. */
  require(identity: Identity, capability: Capability): void {
    if (identity.capabilities.includes(capability)) return;
    throw new AuthError(403,
      `token "${identity.name}" lacks the "${capability}" capability (it has: ${identity.capabilities.join(', ') || 'none'})`,
      identity);
  }

  /** Sliding-window submit limit. Call only on an accepted submission. */
  checkRate(identity: Identity): void {
    if (!identity.maxRunsPerHour) return;
    const cutoff = Date.now() - 3_600_000;
    const window = (this.submissions.get(identity.id) ?? []).filter((t) => t > cutoff);
    if (window.length >= identity.maxRunsPerHour) {
      throw new AuthError(429,
        `token "${identity.name}" is limited to ${identity.maxRunsPerHour} runs per hour`, identity);
    }
    window.push(Date.now());
    this.submissions.set(identity.id, window);
  }

  private saveTimer?: NodeJS.Timeout;
  /** lastUsedAt changes on every request; batch those writes. */
  private saveThrottled(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.save(); }, 5_000);
    this.saveTimer.unref?.();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tokens: this.records }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
