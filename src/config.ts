import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PlatformId } from './device.js';
import type { GuestFirewallMode } from './android/firewall.js';

export interface Config {
  /** Where runs, artifacts, the token and the pool state live. */
  home: string;
  host: string;
  port: number;
  /**
   * Which platforms this daemon serves. A platform listed here whose toolchain
   * is missing is reported as unavailable rather than blocking startup.
   */
  platforms: PlatformId[];
  /** Platform for a run that names none and whose app does not imply one. */
  defaultPlatform: PlatformId;
  /**
   * How many pre-booted devices to keep ready, of `deviceType`/`runtime` on
   * `defaultPlatform`. Ignored when `pool` is set.
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
  pool: { platform?: PlatformId; deviceType?: string; runtime?: string; count?: number }[];
  /** Default Android device profile for pooled emulators, e.g. "pixel_7". */
  androidDeviceType: string;
  /**
   * Default Android system image. Empty means "newest installed". Give either
   * an API level ("35"), a package ("system-images;android-35;google_apis;arm64-v8a")
   * or a label ("Android 15").
   */
  androidRuntime: string;
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
  /** 'relaunch' is opt-in: see RunRequest.resetPolicy. */
  defaultResetPolicy: 'uninstall' | 'erase' | 'relaunch';
  /** 'auto' picks the Anthropic API when a key is present, else the claude CLI. */
  llmBackend: 'auto' | 'anthropic' | 'claude-cli' | 'none';
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Retain at most this many completed runs on disk. */
  retainRuns: number;
  axeBin: string;
  /** Multi-touch driver. Optional: only pinch/pan/double_tap need it. */
  baguetteBin: string;
  adbBin: string;
  emulatorBin: string;
  avdmanagerBin: string;
  /**
   * Android SDK root. Empty means "work it out" -- ANDROID_HOME, then
   * ANDROID_SDK_ROOT, then the usual install locations.
   */
  androidSdk: string;
  /**
   * Where the built multi-touch driver APKs live. Empty means "the driver/
   * directory beside this install". Without them the multi-touch steps fail
   * with an explanation; everything else works.
   */
  androidDriverDir: string;
  /** Emulator GPU mode. swiftshader_indirect is the reliable headless choice;
   *  host is faster but does not always survive -no-window. */
  androidGpu: string;
  /** How long to wait for an emulator to boot before giving up. */
  androidBootTimeoutMs: number;
  /**
   * Inside every emulator, 10.0.2.2 is the host's loopback: an app can reach
   * the host's adb server (no authentication, so a shell on every other
   * emulator) and simcheck's own API. At every boot the harness installs a
   * guest firewall refusing that, and checks it from inside the guest.
   *  - 'required'     an emulator where it cannot be verified goes offline (default)
   *  - 'best-effort'  try, and log a warning when it fails
   *  - 'off'          skip it: only for a machine that runs nobody's apps but yours
   * Needs a google_apis system image: _playstore images refuse `adb root`.
   */
  androidGuestFirewall: GuestFirewallMode;
  /**
   * Extra emulator flags, appended to the harness's own (-no-window,
   * -no-snapshot-save, -gpu ...). For -dns-server when the host resolver is
   * not reachable from the guest, or -cores / -memory tuning.
   */
  androidEmulatorArgs: string[];
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

  /* ------------------------------------------------------- environments */
  /** Disposable backend environments. Off unless a container runtime is
   *  configured, since the daemon must stay useful on a Mac without one. */
  envEnabled: boolean;
  /** Environments publish at <slug>.<envBaseDomain>. */
  envBaseDomain: string;
  /** Docker Engine API socket or tcp address. podman and OrbStack both serve it. */
  envDockerHost: string;
  envCaddyAdmin: string;
  envIngressListen: string[];
  /** Wildcard certificate for *.<envBaseDomain>. A per-env certificate would be
   *  published to Certificate Transparency logs and make every slug
   *  enumerable, so this is a wildcard or nothing. */
  envTlsCert: string;
  envTlsKey: string;
  /** Registry to push built images to. Empty keeps images local. */
  envRegistry: string;
  /** Deliberately low. Each environment competes with the simulator pool for
   *  the same RAM on this one Mac. */
  envMaxConcurrent: number;
  /** Reservations hold a URL, not a slot, so this is far higher than
   *  envMaxConcurrent -- it is only a backstop against a runaway loop. */
  envMaxReservations: number;
  envDefaultTtlSeconds: number;
  envMaxTtlSeconds: number;
  envMaxMemoryMb: number;
  envMinFreeMemoryMb: number;
  envProvisionTimeoutMs: number;
}

const HOME = process.env.SIMCHECK_HOME || path.join(os.homedir(), '.simcheck');

const DEFAULTS: Config = {
  home: HOME,
  host: '127.0.0.1',
  port: 8829,
  platforms: ['ios', 'android'],
  defaultPlatform: 'ios',
  poolSize: 3,
  pool: [],
  autoProvision: true,
  maxPoolDevices: 3,
  minFreeDiskGb: 6,
  deviceType: 'iPhone 17 Pro',
  runtime: '',                 // '' = newest available iOS runtime
  androidDeviceType: 'pixel_7',
  androidRuntime: '',          // '' = newest installed system image
  devicePrefix: 'simcheck',
  defaultTimeoutMs: 10 * 60_000,
  defaultMaxActions: 60,
  defaultResetPolicy: 'uninstall',
  llmBackend: 'auto',
  model: 'claude-opus-5',
  effort: 'high',
  retainRuns: 200,
  axeBin: 'axe',
  baguetteBin: 'baguette',
  adbBin: 'adb',
  emulatorBin: 'emulator',
  avdmanagerBin: 'avdmanager',
  androidSdk: '',
  androidDriverDir: '',
  androidGpu: 'swiftshader_indirect',
  androidBootTimeoutMs: 300_000,
  androidGuestFirewall: 'required',
  androidEmulatorArgs: [],
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

  envEnabled: false,
  envBaseDomain: 'env.localhost',
  envDockerHost: '/var/run/docker.sock',
  envCaddyAdmin: 'http://127.0.0.1:2019',
  envIngressListen: [':8080'],
  envTlsCert: '',
  envTlsKey: '',
  envRegistry: '',
  envMaxConcurrent: 2,
  envMaxReservations: 20,
  envDefaultTtlSeconds: 900,
  envMaxTtlSeconds: 14400,
  envMaxMemoryMb: 1024,
  envMinFreeMemoryMb: 1024,
  envProvisionTimeoutMs: 180_000,
};

const LIST = new Set(['cloudflareAud', 'trustedProxies', 'allowedBuildHosts', 'platforms', 'envIngressListen',
  'androidEmulatorArgs']);
const BOOLEAN = new Set(['edgeAllowLoopback', 'autoProvision', 'envEnabled']);
const NUMERIC = new Set(['port', 'poolSize', 'defaultTimeoutMs', 'defaultMaxActions', 'retainRuns',
  'maxArtifactBytes', 'artifactRetentionDays', 'remotePort', 'maxPoolDevices', 'minFreeDiskGb',
  'androidBootTimeoutMs', 'envMaxConcurrent', 'envMaxReservations', 'envDefaultTtlSeconds', 'envMaxTtlSeconds',
  'envMaxMemoryMb', 'envMinFreeMemoryMb', 'envProvisionTimeoutMs']);

/** Precedence: env > ~/.simcheck/config.json > defaults. */
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
    const env = process.env[`SIMCHECK_${camelToSnake(key)}`];
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

/** The pool's default device type and runtime for one platform. */
export const platformDefaults = (cfg: Config, platform: PlatformId): { deviceType: string; runtime: string } =>
  platform === 'android'
    ? { deviceType: cfg.androidDeviceType, runtime: cfg.androidRuntime }
    : { deviceType: cfg.deviceType, runtime: cfg.runtime };

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
  if (process.env.SIMCHECK_TOKEN) return process.env.SIMCHECK_TOKEN;
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').trim() || null;
}

export const baseUrl = (cfg: Config) => `http://${cfg.host}:${cfg.port}`;
