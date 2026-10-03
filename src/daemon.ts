#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, paths } from './config.js';
import type { Config } from './config.js';
import { Pool } from './pool.js';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { Scheduler } from './scheduler.js';
import { createServer } from './server.js';
import { createLlm } from './llm.js';
import { TokenStore } from './auth.js';
import { AuditLog } from './audit.js';
import { ArtifactStore } from './artifacts.js';
import { createEdgeVerifier, caBundleStatus } from './edge.js';
import { loadPlatforms } from './platforms.js';
import { createEnvSubsystem, describeEnvRuntime } from './env/index.js';
import { androidManifestReader } from './android/index.js';
import { logger, logToFile } from './log.js';

const log = logger('daemon');

/**
 * Truncate oversized logs in place.
 *
 * caddy.log and podman.log are launchd StandardOutPath targets, and launchd
 * neither rotates them nor reopens them on rename -- renaming would leave the
 * writer holding an unlinked inode and silently lose every later line. So the
 * file is truncated in place and the offset left alone: the next write lands
 * at the old offset, which APFS stores as a hole rather than real blocks.
 */
function rotateLogs(home: string, maxBytes: number): void {
  if (!maxBytes) return;
  let entries: string[];
  try { entries = fs.readdirSync(home); } catch { return; }

  for (const name of entries) {
    if (!name.endsWith('.log')) continue;
    const file = path.join(home, name);
    try {
      if (fs.statSync(file).size <= maxBytes) continue;
      fs.truncateSync(file, 0);
      log.info(`truncated ${name} (over ${(maxBytes / 1e6).toFixed(0)}MB)`);
    } catch { /* racing writer or vanished file: next pass picks it up */ }
  }
}

/** Recurring retention: artifact pruning plus log rotation. */
function startHousekeeping(cfg: Config, artifacts: ArtifactStore): NodeJS.Timeout {
  const sweep = (): void => {
    try { artifacts.prune(cfg.artifactRetentionDays); }
    catch (e) { log.warn('artifact prune failed', (e as Error).message); }
    rotateLogs(cfg.home, cfg.maxLogBytes);
  };
  sweep();
  const timer = setInterval(sweep, cfg.housekeepingIntervalMs);
  timer.unref();
  return timer;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  for (const dir of [cfg.home, paths(cfg).runs, paths(cfg).builds, paths(cfg).derived, paths(cfg).artifacts]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  logToFile(paths(cfg).log);

  // Each platform checks its own toolchain. One missing is a warning and a
  // clear refusal later; all missing is fatal, since no run could succeed.
  const platforms = await loadPlatforms(cfg);
  log.info(`platforms: ${platforms.available().join(', ')}`);

  const ca = caBundleStatus(cfg);
  if (ca.configured && !ca.ok) {
    log.warn(
      `caBundle is set to ${ca.configured} but NODE_EXTRA_CA_CERTS is ${ca.active ?? 'unset'}. ` +
      'Node reads that variable once at startup, so set it in the launchd plist (re-run ./install.sh) ' +
      'or outbound TLS will still fail behind an inspecting proxy.');
  } else if (ca.configured) {
    log.info(`trusting corporate CA bundle at ${ca.configured}`);
  }

  const tokens = new TokenStore(cfg);
  tokens.load();

  const audit = new AuditLog(cfg);
  audit.open();

  const artifacts = new ArtifactStore(cfg);
  artifacts.init();
  // An uploaded .apk is only identifiable if something can read its manifest,
  // and that is Android's business rather than the store's.
  if (platforms.has('android')) {
    const reader = androidManifestReader(cfg);
    if (reader) artifacts.setManifestReader('android', reader);
  }
  const store = new Store(cfg);
  store.load();

  // Retention has to be recurring, not a startup step. A daemon that stays up
  // for weeks -- the normal case -- would otherwise prune once and then let
  // `artifacts/` grow until the disk filled.
  const housekeeping = startHousekeeping(cfg, artifacts);

  const llm = await createLlm(cfg);
  const pool = new Pool(cfg, platforms);
  const runner = new Runner(cfg, pool, store, llm, artifacts, platforms);
  const scheduler = new Scheduler(cfg, pool, store, runner);

  const edge = await createEdgeVerifier(cfg);
  log.info(`edge auth: ${edge.describe()}`);

  // Environments are optional: a Mac with no container runtime is still a
  // perfectly good simulator harness, and failing to start over a missing
  // Docker socket would be a poor trade.
  const envs = cfg.envEnabled ? createEnvSubsystem(cfg, cfg.home) : undefined;
  if (envs) {
    log.info(`environments: ${await describeEnvRuntime(envs)} at *.${cfg.envBaseDomain}`);
  }

  const server = createServer({
    cfg, pool, store, runner, scheduler, tokens, audit, artifacts, edge, platforms,
    llmName: llm?.name ?? null, envs,
  });

  // Binding beyond loopback with no edge auth would publish an RCE surface.
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.edgeAuth === 'none') {
    throw new Error(
      `refusing to bind ${cfg.host} with edgeAuth "none". Anything that can reach the port could then ` +
      `submit builds, which means code execution on this Mac. Set edgeAuth to "cloudflare-access" or ` +
      `"trusted-proxy" first, or leave host as 127.0.0.1.`);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  log.info(`listening on http://${cfg.host}:${cfg.port}`);
  log.info(`local token at ${paths(cfg).token} (not printed); ${tokens.list().length} token(s) registered`);
  log.info(`audit log at ${audit.path()}`);

  // Serve requests immediately; the pool fills in the background.
  scheduler.start();
  // Must run here rather than in the MCP process: a stdio MCP server dies with
  // the client session, and TTLs would then only be honoured while an agent
  // happened to be connected.
  envs?.reconciler.start();
  pool.start().then(
    () => log.info(`pool warm: ${pool.list().filter((d) => d.status === 'ready').length}/${pool.targetCount()} ready`),
    (e) => log.error('pool failed to start', (e as Error).message),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    clearInterval(housekeeping);
    scheduler.stop();
    await envs?.reconciler.stop();
    await pool.stop();
    server.close();
    // Leave the simulators booted -- that is the point of a warm pool.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error('failed to start', (e as Error).message);
  process.exit(1);
});
