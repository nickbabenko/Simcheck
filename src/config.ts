import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface Config {
  /** Where runs, artifacts, the token and the pool state live. */
  home: string;
  host: string;
  port: number;
  /**
   * How many pre-booted simulators to keep ready, of `deviceType`/`runtime`.
   * Ignored when `pool` is set.
   */
  poolSize: number;
  deviceType: string;
  /**
   * Default runtime for any device created without one. Empty means "newest
   * installed" -- which will happily pick a runtime your SDK cannot build for,
   * so pin it when the newest is ahead of your Xcode.
   */
  runtime: string;
  /**
   * A heterogeneous pool. Use this to keep devices on more than one runtime --
   * e.g. one the SDK can build for, and one matching what you ship. A run
   * picks with `device: { runtime, name }`.
   *   [{ "deviceType": "iPhone 17 Pro", "runtime": "26.3", "count": 2 },
   *    { "deviceType": "iPhone 17 Pro", "runtime": "27.0", "count": 1 }]
   */
  pool: { deviceType?: string; runtime?: string; count?: number }[];
  /**
   * Create a simulator on demand when a run asks for a device the pool does
   * not hold. The run waits for a cold boot instead of failing -- slower, but
   * it means the pool need not be configured ahead of every combination.
   */
  autoProvision: boolean;
  /** Hard ceiling on pooled devices, however they were created. */
  maxPoolDevices: number;
  /**
   * Refuse to create a simulator when free disk would drop below this, in GB.
   * A booted device grows to roughly 3GB, and filling the disk takes the whole
   * machine down with it -- not just the run that asked for it.
   */
  minFreeDiskGb: number;
  /** Simulators the harness creates are named `<prefix>-NN`. It will never
   *  touch a simulator whose name does not start with this prefix. */
  devicePrefix: string;
  defaultTimeoutMs: number;
  defaultMaxActions: number;
  defaultResetPolicy: 'uninstall' | 'erase';
  /** 'auto' picks the Anthropic API when a key is present, else the claude CLI. */
  llmBackend: 'auto' | 'anthropic' | 'claude-cli' | 'none';
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Retain at most this many completed runs on disk. */
  retainRuns: number;
  axeBin: string;
  /** Multi-touch driver. Optional: only pinch/pan/double_tap need it. */
  baguetteBin: string;
  /**
   * Who is allowed to reach the daemon at all, before token checks:
   *  - 'none'              loopback only (default, and correct on a dev machine)
   *  - 'cloudflare-access' verify the Cf-Access-Jwt-Assertion JWT in-process
   *  - 'trusted-proxy'     accept only a configured source range (ZTNA broker,
   *                        internal reverse proxy such as a Netskope publisher)
   */
  edgeAuth: 'none' | 'cloudflare-access' | 'trusted-proxy';
  /** Keep accepting local callers when an edge mode is on. */
  edgeAllowLoopback: boolean;
  cloudflareTeamDomain: string;
  /** Application Audience tags from the Access app. */
  cloudflareAud: string[];
  /** Source ranges permitted in trusted-proxy mode. */
  trustedProxies: string[];
  /** Header the proxy stamps the user into, if any. Advisory: audit only. */
  identityHeader: string;
  /**
   * Restrict which bearer tokens an edge identity may present, e.g.
   * { "svc-cloud.access": ["cloud"] }. Empty means no restriction.
   */
  identityBindings: Record<string, string[]>;
  /** Corporate root CA bundle, for networks that inspect TLS. */
  caBundle: string;
  /** Public https address the remote MCP server is published at. */
  publicUrl: string;
  /** Loopback port the remote MCP server listens on; cloudflared fronts it. */
  remotePort: number;
  /** Token the remote MCP server uses against the daemon. Scope it down --
   *  a `remote` preset token cannot build from a local path. */
  remoteToken: string;
  /**
   * Credentials the daemon attaches when fetching a build, keyed by host.
   * Keeping them here rather than in `app.urlHeaders` means a calling agent
   * never handles the secret -- it passes only a reference to the artifact.
   *   { "api.github.com": { "Authorization": "Bearer ghp_..." } }
   */
  buildCredentials: Record<string, Record<string, string>>;
  /** Hostnames a build may be fetched from. Empty allows any public https
   *  host; private and loopback addresses are refused either way. */
  allowedBuildHosts: string[];
  /** Largest accepted .app zip upload. */
  maxArtifactBytes: number;
  /** Delete uploaded artifacts older than this. 0 keeps them forever. */
  artifactRetentionDays: number;
}

const HOME = process.env.SIM_HARNESS_HOME || path.join(os.homedir(), '.sim-harness');

const DEFAULTS: Config = {
  home: HOME,
  host: '127.0.0.1',
  port: 8829,
  poolSize: 3,
  pool: [],
  autoProvision: true,
  maxPoolDevices: 3,
  minFreeDiskGb: 6,
  deviceType: 'iPhone 17 Pro',
  runtime: '',                 // '' = newest available iOS runtime
  devicePrefix: 'sim-harness',
  defaultTimeoutMs: 10 * 60_000,
  defaultMaxActions: 60,
  defaultResetPolicy: 'uninstall',
  llmBackend: 'auto',
  model: 'claude-opus-5',
  effort: 'high',
  retainRuns: 200,
  axeBin: 'axe',
  baguetteBin: 'baguette',
  edgeAuth: 'none',
  edgeAllowLoopback: true,
  cloudflareTeamDomain: '',
  cloudflareAud: [],
  trustedProxies: [],
  identityHeader: '',
  identityBindings: {},
  caBundle: '',
  publicUrl: '',
  remotePort: 8830,
  remoteToken: '',
  buildCredentials: {},
  allowedBuildHosts: [],
  maxArtifactBytes: 1_073_741_824,   // 1 GiB
  artifactRetentionDays: 14,
};

const LIST = new Set(['cloudflareAud', 'trustedProxies', 'allowedBuildHosts']);
const BOOLEAN = new Set(['edgeAllowLoopback', 'autoProvision']);
const NUMERIC = new Set(['port', 'poolSize', 'defaultTimeoutMs', 'defaultMaxActions', 'retainRuns',
  'maxArtifactBytes', 'artifactRetentionDays', 'remotePort', 'maxPoolDevices', 'minFreeDiskGb']);

/** Precedence: env > ~/.sim-harness/config.json > defaults. */
export function loadConfig(): Config {
  const cfg: Config = { ...DEFAULTS };
  const file = path.join(HOME, 'config.json');
  if (fs.existsSync(file)) {
    try {
      Object.assign(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      throw new Error(`config at ${file} is not valid JSON: ${(e as Error).message}`);
    }
  }
  for (const key of Object.keys(DEFAULTS) as (keyof Config)[]) {
    const env = process.env[`SIM_HARNESS_${camelToSnake(key)}`];
    if (env === undefined) continue;
    (cfg as unknown as Record<string, unknown>)[key] = NUMERIC.has(key) ? Number(env)
      : LIST.has(key) ? env.split(',').map((v) => v.trim()).filter(Boolean)
      : BOOLEAN.has(key) ? env !== 'false' && env !== '0'
      : env;
  }
  cfg.home = HOME;
  return cfg;
}

const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

export const paths = (cfg: Config) => ({
  runs: path.join(cfg.home, 'runs'),
  builds: path.join(cfg.home, 'builds'),
  derived: path.join(cfg.home, 'derived-data'),
  pool: path.join(cfg.home, 'pool.json'),
  artifacts: path.join(cfg.home, 'artifacts'),
  tokens: path.join(cfg.home, 'tokens.json'),
  token: path.join(cfg.home, 'token'),
  log: path.join(cfg.home, 'daemon.log'),
});

/** Reads the shared bearer token, minting one on first use. Never logged. */
export function ensureToken(cfg: Config): string {
  const p = paths(cfg).token;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) {
    const existing = fs.readFileSync(p, 'utf8').trim();
    if (existing) return existing;
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(p, token + '\n', { mode: 0o600 });
  return token;
}

export function readToken(cfg: Config): string | null {
  const p = paths(cfg).token;
  if (process.env.SIM_HARNESS_TOKEN) return process.env.SIM_HARNESS_TOKEN;
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').trim() || null;
}

export const baseUrl = (cfg: Config) => `http://${cfg.host}:${cfg.port}`;
