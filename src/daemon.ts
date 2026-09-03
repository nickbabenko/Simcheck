#!/usr/bin/env node
import fs from 'node:fs';
import { loadConfig, paths } from './config.js';
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
import { androidManifestReader } from './android/index.js';
import { logger, logToFile } from './log.js';

const log = logger('daemon');

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
  artifacts.prune(cfg.artifactRetentionDays);

  const store = new Store(cfg);
  store.load();

  const llm = await createLlm(cfg);
  const pool = new Pool(cfg, platforms);
  const runner = new Runner(cfg, pool, store, llm, artifacts, platforms);
  const scheduler = new Scheduler(cfg, pool, store, runner);

  const edge = await createEdgeVerifier(cfg);
  log.info(`edge auth: ${edge.describe()}`);

  const server = createServer({
    cfg, pool, store, runner, scheduler, tokens, audit, artifacts, edge, platforms,
    llmName: llm?.name ?? null,
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
  pool.start().then(
    () => log.info(`pool warm: ${pool.list().filter((d) => d.status === 'ready').length}/${pool.targetCount()} ready`),
    (e) => log.error('pool failed to start', (e as Error).message),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    scheduler.stop();
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
