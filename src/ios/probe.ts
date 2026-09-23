/**
 * The in-app greybox probe (docs/23, @simbase/probe): an iOS-simulator dylib
 * injected with DYLD_INSERT_LIBRARIES that answers on 127.0.0.1 with the
 * app's own view of itself -- whether it has settled, what it fetched, what
 * it printed.
 *
 * simcheck vendors only the built dylib, by path (`probeDylib`), and speaks
 * the probe's small HTTP API itself. Everything the probe says is parsed, not
 * trusted: it runs inside a customer's app. Every call has a deadline,
 * because a probe inside a hung app accepts connections and never answers.
 *
 * The probe is an accelerator and a witness, never a judge. If it cannot be
 * reached, the run carries on exactly as it would have without it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { z } from 'zod';
import type { Config } from '../config.js';

/* ------------------------------------------------------------ wire shapes -- */

const Hello = z.looseObject({
  name: z.literal('simbase-probe'),
  version: z.string(),
  api: z.literal('v1'),
  pid: z.number().int(),
  bundleId: z.string(),
});
export type ProbeHello = z.infer<typeof Hello>;

const SettleResult = z.looseObject({
  settled: z.boolean(),
  elapsedMs: z.number(),
  settledAtMs: z.number().nullable(),
  busy: z.array(z.string()),
});
export type ProbeSettle = z.infer<typeof SettleResult>;

const NetworkRequest = z.looseObject({
  seq: z.number().int(),
  kind: z.string(),
  method: z.string(),
  url: z.string(),
  startedAt: z.number(),
  state: z.enum(['running', 'completed', 'failed', 'cancelled']),
  durationMs: z.number().optional(),
  status: z.number().int().optional(),
  error: z.string().optional(),
});
export type ProbeNetworkRequest = z.infer<typeof NetworkRequest>;

const NetworkLog = z.looseObject({
  requests: z.array(NetworkRequest),
  cursor: z.number().int(),
  dropped: z.number().int(),
});

const ConsoleLog = z.looseObject({
  lines: z.array(z.looseObject({
    seq: z.number().int(),
    at: z.number(),
    stream: z.string(),
    line: z.string(),
  })),
  cursor: z.number().int(),
  dropped: z.number().int(),
});
export type ProbeConsole = z.infer<typeof ConsoleLog>;

const OpenUrlResult = z.looseObject({
  opened: z.boolean(),
  timedOut: z.boolean(),
  error: z.string().optional(),
});

/* ----------------------------------------------------------------- client -- */

export class ProbeError extends Error {}

const REQUEST_TIMEOUT_MS = 10_000;
/** wait-settled blocks for up to its own timeout; allow for the round trip. */
const SETTLE_GRACE_MS = 5_000;

export class ProbeClient {
  private readonly baseUrl: string;

  constructor(readonly port: number, private readonly token: string, host = '127.0.0.1') {
    this.baseUrl = `http://${host}:${port}`;
  }

  hello(): Promise<ProbeHello> {
    return this.request(Hello, '/v1/hello');
  }

  /** Blocks until the app is settled or `timeoutMs` passes. A timeout is
   *  reported (`settled: false`), not thrown. */
  waitSettled(timeoutMs: number, quietMs = 200): Promise<ProbeSettle> {
    return this.request(SettleResult, '/v1/wait-settled', {
      query: { timeoutMs, quietMs },
      timeoutMs: timeoutMs + SETTLE_GRACE_MS,
    });
  }

  network(since = 0) {
    return this.request(NetworkLog, '/v1/network', { query: { since } });
  }

  console(since = 0) {
    return this.request(ConsoleLog, '/v1/console', { query: { since } });
  }

  openUrl(url: string) {
    return this.request(OpenUrlResult, '/v1/open-url', { method: 'POST', body: { url } });
  }

  /** Polls `hello` until the probe answers, straight after a launch. */
  async waitUntilReady(timeoutMs: number): Promise<ProbeHello> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        return await this.hello();
      } catch (e) {
        if (e instanceof ProbeError && /refused the token/.test(e.message)) throw e;
        lastError = e;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new ProbeError(`did not answer on port ${this.port} within ${timeoutMs}ms` +
      (lastError ? ` (${(lastError as Error).message})` : ''));
  }

  private async request<Schema extends z.ZodType>(
    schema: Schema, route: string,
    opts: { method?: 'GET' | 'POST'; query?: Record<string, number>; body?: unknown; timeoutMs?: number } = {},
  ): Promise<z.output<Schema>> {
    const url = new URL(route, this.baseUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, String(value));

    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = (e as Error).name === 'TimeoutError';
      throw new ProbeError(`${route} ${timedOut ? 'did not answer in time' : 'is unreachable'}`);
    }

    if (response.status === 401) throw new ProbeError(`${route} refused the token`);
    if (!response.ok) throw new ProbeError(`${route} answered ${response.status}`);

    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new ProbeError(`${route} returned an unexpected shape`);
    return parsed.data;
  }
}

/* --------------------------------------------------------------- the dylib -- */

/** The dylib a run would inject, or why there is none. Resolved once. */
export type ProbeAvailability = { dylibPath: string } | { unavailable: string };

/**
 * Where the probe dylib is, and whether it may be used.
 *
 * `probe: "off"` (SIMCHECK_PROBE=off) is the daemon's kill switch. The path
 * comes from `probeDylib` (SIMCHECK_PROBE_DYLIB). When a `<dylib>.sha256`
 * sits beside it, as native/build.sh writes, the file must match it: a dylib
 * that changed underneath the daemon is not injected into anyone's app.
 */
export function resolveProbe(cfg: Pick<Config, 'probe' | 'probeDylib'>): ProbeAvailability {
  if (cfg.probe === 'off') return { unavailable: 'the probe is switched off on this daemon (probe: "off")' };
  if (!cfg.probeDylib) return { unavailable: 'no probe dylib is configured (probeDylib)' };
  if (!cfg.probeDylib.startsWith('/') || !fs.existsSync(cfg.probeDylib)) {
    return { unavailable: `the probe dylib is not at ${cfg.probeDylib}` };
  }

  const sidecar = `${cfg.probeDylib}.sha256`;
  if (fs.existsSync(sidecar)) {
    const expected = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
    const actual = crypto.createHash('sha256').update(fs.readFileSync(cfg.probeDylib)).digest('hex');
    if (expected !== actual) {
      return { unavailable: `the probe dylib does not match ${sidecar} (sha256 ${actual.slice(0, 12)}...)` };
    }
  }
  return { dylibPath: cfg.probeDylib };
}

/** A per-run secret: 48 hex characters from the CSPRNG. Never persisted. */
export const generateProbeToken = (): string => crypto.randomBytes(24).toString('hex');

/** A free loopback port. Racy by nature; the launch binds it promptly. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * The app environment that attaches the probe, un-prefixed: simctl's launch
 * re-prefixes every key with SIMCTL_CHILD_. These are exactly the keys the
 * launch guard refuses from a caller, which is why they are added after it.
 */
export function probeLaunchEnv(dylibPath: string, port: number, token: string): Record<string, string> {
  return {
    DYLD_INSERT_LIBRARIES: dylibPath,
    SIMBASE_PROBE_PORT: String(port),
    SIMBASE_PROBE_TOKEN: token,
  };
}

/** `*` matches any run of characters; nothing else is special. A glob rather
 *  than a caller regex, so a pattern cannot be made to backtrack for ever. */
export function globMatches(pattern: string, text: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === text;

  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (!text.startsWith(first) || !text.endsWith(last) || text.length < first.length + last.length) return false;

  let at = first.length;
  const end = text.length - last.length;
  for (const middle of parts.slice(1, -1)) {
    const found = text.indexOf(middle, at);
    if (found < 0 || found + middle.length > end) return false;
    at = found + middle.length;
  }
  return true;
}
