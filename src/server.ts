import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { Pool } from './pool.js';
import type { Store } from './store.js';
import { validateSteps } from './steps.js';
import type { Runner } from './runner.js';
import type { Scheduler } from './scheduler.js';
import type { AppSpec, Run, RunRequest, Step } from './types.js';
import { isTerminal } from './types.js';
import type { PlatformId } from './device.js';
import type { Platforms } from './platforms.js';
import { HttpError, newId, nowIso } from './util.js';
import { logger } from './log.js';
import { TokenStore, AuthError, PRESETS, CAPABILITIES, type Identity, type Capability } from './auth.js';
import type { AuditLog } from './audit.js';
import type { ArtifactStore } from './artifacts.js';
import { redactHeaders, assertPublic } from './fetchbuild.js';
import { EdgeAuthError, type EdgeVerifier, type EdgeIdentity } from './edge.js';

const log = logger('api');

interface Deps {
  cfg: Config; pool: Pool; store: Store; runner: Runner; scheduler: Scheduler;
  tokens: TokenStore; audit: AuditLog; artifacts: ArtifactStore; llmName: string | null;
  edge: EdgeVerifier; platforms: Platforms;
}

export function createServer(d: Deps): http.Server {
  return http.createServer((req, res) => {
    handle(d, req, res).catch((e) => {
      const status = e instanceof EdgeAuthError ? 403
        : e instanceof HttpError || e instanceof AuthError ? (e as { status: number }).status
        : 500;
      if (status === 401 || status === 403 || status === 429) {
        // Edge rejections carry no token, so record them under the source.
        const who = e instanceof AuthError ? e.identity : undefined;
        d.audit.record({
          token: who?.name ?? 'unknown', tokenId: who?.id ?? '-',
          action: `${req.method} ${req.url?.split('?')[0]}`,
          outcome: 'denied', remote: remoteAddr(req), detail: { reason: (e as Error).message },
        });
      }
      if (status >= 500) log.error(`${req.method} ${req.url}`, (e as Error).stack ?? String(e));
      send(res, status, { error: (e as Error).message });
    });
  });
}

const remoteAddr = (req: http.IncomingMessage): string =>
  String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0]!.trim();

async function handle(d: Deps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  // Unauthenticated liveness probe, so `simcheck status` can tell
  // "daemon down" from "wrong token".
  const remote = remoteAddr(req);

  // Liveness is unauthenticated but still gated by the edge, so a public
  // hostname does not leak the daemon's existence to unauthorised callers.
  const edge = await d.edge.verify(req, remote);

  if (method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      ok: true, version: 4, llm: d.llmName, pool: d.pool.list().length, edge: d.edge.mode,
      platforms: d.platforms.available(),
    });
  }

  const who = d.tokens.verify(bearer(req));
  bindIdentity(d, edge, who, remote);

  if (seg[0] !== 'v1') throw new HttpError(404, `no route for ${url.pathname}`);
  const [, resource, id, sub, ...rest] = seg;

  /* ------------------------------------------------------------- whoami */
  // Lets a caller discover what its own token may do, instead of guessing.
  if (resource === 'whoami' && method === 'GET') {
    return send(res, 200, {
      token: who.name,
      capabilities: who.capabilities,
      limits: { maxConcurrentRuns: who.maxConcurrentRuns, maxRunsPerHour: who.maxRunsPerHour },
    });
  }

  /* ---------------------------------------------------------- artifacts */
  if (resource === 'artifacts') {
    if (method === 'POST' && !id) {
      d.tokens.require(who, 'artifacts:write');
      const artifact = await d.artifacts.accept(req, {
        uploadedBy: who.name,
        declaredBytes: d.cfg.maxArtifactBytes,
        ...(url.searchParams.get('label') ? { label: url.searchParams.get('label')! } : {}),
        ...(url.searchParams.get('gitSha') ? { gitSha: url.searchParams.get('gitSha')! } : {}),
      });
      d.audit.record({
        token: who.name, tokenId: who.id, action: 'artifacts.upload', outcome: 'ok',
        remote,
        detail: { artifactId: artifact.id, appName: artifact.appName, bundleId: artifact.bundleId, bytes: artifact.bytes },
      });
      // appPath is a local filesystem detail; remote callers have no use for it.
      const { appPath, ...safe } = artifact;
      return send(res, 201, safe);
    }
    if (method === 'GET' && !id) {
      d.tokens.require(who, 'runs:read');
      return send(res, 200, { artifacts: d.artifacts.list().map(({ appPath, ...a }) => a) });
    }
    if (method === 'GET' && id) {
      d.tokens.require(who, 'runs:read');
      const artifact = d.artifacts.get(id);
      if (!artifact) throw new HttpError(404, `no artifact ${id}`);
      const { appPath, ...safe } = artifact;
      return send(res, 200, safe);
    }
    throw new HttpError(404, `no route for ${method} ${url.pathname}`);
  }

  /* ------------------------------------------------------------- tokens */
  // Managing tokens is a local-only concern: it requires pool:write, which no
  // remote preset grants.
  if (resource === 'tokens') {
    d.tokens.require(who, 'pool:write');
    if (method === 'GET' && !id) {
      return send(res, 200, { tokens: d.tokens.list(), presets: PRESETS, capabilities: CAPABILITIES });
    }
    if (method === 'POST' && !id) {
      const body = await readJson<{
        name: string; preset?: string; capabilities?: Capability[]; note?: string;
        maxConcurrentRuns?: number; maxRunsPerHour?: number;
      }>(req);
      const created = d.tokens.create(body);
      d.audit.record({
        token: who.name, tokenId: who.id, action: 'tokens.create', outcome: 'ok',
        remote, detail: { name: created.record.name, capabilities: created.record.capabilities },
      });
      return send(res, 201, created);
    }
    if (method === 'POST' && id && sub === 'grant') {
      const { capability } = await readJson<{ capability: Capability }>(req);
      const record = d.tokens.grant(id, capability);
      d.audit.record({
        token: who.name, tokenId: who.id, action: 'tokens.grant', outcome: 'ok',
        remote, detail: { target: id, capability },
      });
      const { hash, ...safe } = record;
      return send(res, 200, safe);
    }
    if (method === 'DELETE' && id) {
      d.tokens.revoke(id);
      d.audit.record({
        token: who.name, tokenId: who.id, action: 'tokens.revoke', outcome: 'ok',
        remote, detail: { target: id },
      });
      return send(res, 200, { revoked: id, tokens: d.tokens.list() });
    }
    throw new HttpError(404, `no route for ${method} ${url.pathname}`);
  }

  /* ------------------------------------------------------------------ runs */
  if (resource === 'runs') {
    if (method === 'POST' && !id) {
      const body = await readJson<RunRequest>(req);
      const run = await submit(d, body, who, remote, edge);
      return send(res, 202, publicRun(d, run));
    }
    if (method === 'GET' && !id) {
      d.tokens.require(who, 'runs:read');
      const status = url.searchParams.get('status') as Run['status'] | null;
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const runs = d.store.list({ ...(status ? { status } : {}), limit });
      return send(res, 200, { runs: runs.map((r) => summarise(d, r)) });
    }
    if (!id) throw new HttpError(405, `${method} not allowed on /v1/runs`);

    d.tokens.require(who, method === 'DELETE' ? 'runs:cancel' : 'runs:read');
    const run = d.store.get(id);
    if (!run) throw new HttpError(404, `no run ${id}`);

    if (method === 'GET' && !sub) return send(res, 200, publicRun(d, run));

    if (method === 'DELETE' && !sub) {
      if (isTerminal(run.status)) return send(res, 200, publicRun(d, run));
      const stopped = d.runner.cancel(run.id);
      if (!stopped) {
        // Still queued: no device was ever leased, so just mark it done.
        d.store.update(run.id, { status: 'cancelled', finishedAt: nowIso(), error: 'cancelled before dispatch' });
      }
      return send(res, 200, publicRun(d, d.store.get(id)!));
    }

    // Long-poll: hold the connection until the run reaches a terminal state.
    if (method === 'GET' && sub === 'wait') {
      const timeoutMs = Math.min(Number(url.searchParams.get('timeoutMs') ?? 120_000), 600_000);
      const final = await waitForTerminal(d, run.id, timeoutMs);
      return send(res, 200, publicRun(d, final));
    }

    if (method === 'GET' && sub === 'report') {
      const file = path.join(d.store.dir(run.id), 'report.md');
      if (!fs.existsSync(file)) throw new HttpError(404, 'no report yet');
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return void res.end(fs.readFileSync(file));
    }

    if (method === 'GET' && sub === 'screenshots') {
      const name = rest.join('/');
      if (!name) {
        return send(res, 200, {
          screenshots: run.screenshots.map((s) => ({
            ...s, url: `/v1/runs/${run.id}/screenshots/${encodeURIComponent(s.name)}`,
          })),
        });
      }
      const shot = run.screenshots.find((s) => s.name === decodeURIComponent(name));
      if (!shot) throw new HttpError(404, `run ${run.id} has no screenshot "${name}"`);
      const file = safeJoin(d.store.dir(run.id), shot.file);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': fs.statSync(file).size });
      return void fs.createReadStream(file).pipe(res);
    }

    if (method === 'GET' && (sub === 'app.log' || sub === 'build.log')) {
      const file = safeJoin(d.store.dir(run.id), sub);
      if (!fs.existsSync(file)) throw new HttpError(404, `no ${sub} for this run`);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return void fs.createReadStream(file).pipe(res);
    }
    throw new HttpError(404, `no route for ${method} ${url.pathname}`);
  }

  /* ------------------------------------------------------------------ pool */
  if (resource === 'pool') {
    if (method === 'GET' && !id) {
      d.tokens.require(who, 'pool:read');
      return send(res, 200, poolView(d));
    }
    if (method === 'POST' && id === 'devices') {
      d.tokens.require(who, 'pool:write');
      const body = await readJson<{ platform?: PlatformId; deviceType?: string; runtime?: string; count?: number }>(req).catch(() => ({}));
      const added = await d.pool.add(body);
      // Newly added devices are `pending` here and become `ready` once the
      // pool loop has booted them.
      return send(res, 202, { added, pool: poolView(d) });
    }
    if (method === 'DELETE' && id === 'devices' && sub) {
      d.tokens.require(who, 'pool:write');
      await d.pool.remove(sub, url.searchParams.get('force') === 'true');
      return send(res, 200, poolView(d));
    }
    throw new HttpError(404, `no route for ${method} ${url.pathname}`);
  }

  /* --------------------------------------------------------------- devices */
  // Live accessibility tree of a pooled device -- handy when authoring steps.
  if (resource === 'inspect' && method === 'GET' && id) {
    d.tokens.require(who, 'inspect');
    const device = d.pool.get(id) ?? d.pool.list().find((x) => x.name === id);
    if (!device) throw new HttpError(404, `no pooled device ${id}`);
    const screen = await d.platforms.get(device.platform).ui(device.udid).describe();
    return send(res, 200, { device: device.name, platform: device.platform, ...screen });
  }

  throw new HttpError(404, `no route for ${method} ${url.pathname}`);
}

/* --------------------------------------------------------------- helpers -- */

/**
 * Refuse a bearer token the edge identity is not bound to.
 *
 * Without this, edge auth and token auth are two independent doors: whoever
 * gets through Access could use any token they happen to have. Binding makes
 * the two credentials only useful together.
 */
function bindIdentity(d: Deps, edge: EdgeIdentity, who: Identity, remote: string): void {
  const allowed = d.cfg.identityBindings[edge.subject];
  if (!allowed || edge.via === 'loopback') return;
  if (allowed.includes(who.name)) return;
  d.audit.record({
    token: who.name, tokenId: who.id, action: 'auth.binding', outcome: 'denied', remote,
    detail: { edgeSubject: edge.subject, allowed },
  });
  throw new HttpError(403,
    `edge identity "${edge.subject}" is not permitted to use the "${who.name}" token`);
}

/**
 * Work out from an app spec which platform it is for, or null when it says
 * nothing either way. Only unambiguous signals count -- a wrong guess would
 * lease the wrong kind of device and fail deep in an install.
 */
function inferPlatform(d: Deps, app?: AppSpec): PlatformId | null {
  if (!app) return null;
  if (app.module || app.variant) return 'android';
  if (app.scheme || app.workspace || app.configuration) return 'ios';
  if (app.artifactId) {
    const artifact = d.artifacts.get(app.artifactId);
    if (artifact?.platform) return artifact.platform;
  }
  for (const named of [app.path, app.url]) {
    if (!named) continue;
    if (/\.apk($|[?#])/i.test(named)) return 'android';
    if (/\.(app|ipa)($|[?#])/i.test(named)) return 'ios';
  }
  if (app.project) return /\.xcodeproj$/i.test(app.project) ? 'ios' : 'android';
  return null;
}

/** The platform a run will use, settled once at submit so the scheduler and
 *  the runner cannot disagree about it. */
function resolvePlatform(d: Deps, body: RunRequest): PlatformId {
  if (body.device?.platform) return body.device.platform;
  if (body.device?.udid) {
    const pinned = d.pool.get(body.device.udid);
    if (pinned) return pinned.platform;
  }
  if (body.instrumentation) return 'android';
  if (body.xctest) return 'ios';
  return inferPlatform(d, body.app) ?? d.platforms.default();
}

async function submit(d: Deps, body: RunRequest, who: Identity, remote: string, edge: EdgeIdentity): Promise<Run> {
  validate(d, body);

  const platform = resolvePlatform(d, body);
  if (!d.platforms.has(platform)) {
    throw new HttpError(503,
      `this daemon cannot run ${platform} tests: ${d.platforms.reason(platform)}. ` +
      `Available: ${d.platforms.available().join(', ') || 'none'}.`);
  }
  if (platform === 'ios' && body.instrumentation) {
    throw new HttpError(400, '`instrumentation` is an Android suite; an iOS run wants `xctest`');
  }
  if (platform === 'android' && body.xctest) {
    throw new HttpError(400, '`xctest` is an iOS suite; an Android run wants `instrumentation`');
  }
  // Pin it onto the request so the pool leases the right kind of device even
  // when the caller left `device` off entirely.
  body.device = { ...body.device, platform };

  // Resolve the build host now rather than at run time: a caller should learn
  // straight away that a URL is unreachable, instead of polling a run that was
  // doomed the moment it leased a simulator.
  if (body.app.url) await assertPublic(new URL(body.app.url), d.cfg);

  // The capability needed depends on how the build was supplied. Naming a
  // local project means running its build phases, so it is gated separately.
  const needed: Capability = (body.xctest || body.instrumentation) ? 'runs:submit:local'
    : body.app.artifactId ? 'runs:submit:artifact'
    : (body.app.url || body.app.github) ? 'runs:submit:url'
    : (body.app.path || body.app.scheme) ? 'runs:submit:local'
    : 'runs:submit:installed';
  try {
    d.tokens.require(who, needed);
  } catch (e) {
    d.audit.record({
      token: who.name, tokenId: who.id, action: 'runs.submit', outcome: 'denied', remote,
      detail: { needed, label: body.label ?? null },
    });
    throw e;
  }

  if (who.maxConcurrentRuns) {
    const mine = d.store.list().filter(
      (r) => r.submittedBy?.tokenId === who.id && !isTerminal(r.status)).length;
    if (mine >= who.maxConcurrentRuns) {
      throw new HttpError(429,
        `token "${who.name}" already has ${mine} runs in flight (limit ${who.maxConcurrentRuns}). Wait for one to finish.`);
    }
  }
  d.tokens.checkRate(who);

  // The run record is persisted on every status change and trace line, so a CI
  // token must never be attached to it. Redact it in the record and hand the
  // real value to the runner through an in-memory side channel.
  const secretHeaders = body.app.urlHeaders;
  const stored: RunRequest = secretHeaders
    ? { ...body, app: { ...body.app, urlHeaders: redactHeaders(secretHeaders) } }
    : body;

  const run: Run = {
    id: newId(),
    status: 'pending',
    request: stored,
    mode: body.xctest ? 'xctest'
      : body.instrumentation ? 'instrumentation'
      : body.steps?.length ? 'steps' : 'scenario',
    createdAt: nowIso(),
    submittedBy: { tokenId: who.id, tokenName: who.name },
    queuePositionAtSubmit: d.store.pending().length,
    executedSteps: [],
    screenshots: [],
    trace: [],
    artifacts: {},
  };
  d.store.create(run);
  if (secretHeaders) d.store.setSecret(run.id, secretHeaders);
  d.audit.record({
    token: who.name, tokenId: who.id, action: 'runs.submit', outcome: 'ok', remote, runId: run.id,
    detail: { mode: run.mode, platform, appMode: needed, label: body.label ?? null, edge: `${edge.via}:${edge.subject}` },
  });
  log.info(`queued ${run.id} (${run.mode}) for ${who.name}${body.label ? ` "${body.label}"` : ''}`);
  d.scheduler.tick();
  return run;
}

function validate(d: Deps, body: RunRequest): void {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
  if (body.xctest && body.instrumentation) {
    throw new HttpError(400, 'give either `xctest` (iOS) or `instrumentation` (Android), not both');
  }
  // The platform's own test runner builds, installs and launches the app, so
  // the caller need not describe one at all.
  if (!body.app && (body.xctest || body.instrumentation)) return;
  if (!body.app) throw new HttpError(400, 'app is required');
  const { path: appPath, scheme, project, workspace, bundleId, artifactId, url } = body.app;
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new HttpError(400, `app.url is not a valid URL: ${url}`); }
    if (parsed.protocol !== 'https:') throw new HttpError(400, 'app.url must be https');
    if (/\.ipa($|\?)/i.test(parsed.pathname)) {
      throw new HttpError(400,
        'that URL points at an .ipa. Those hold arm64 device slices and cannot run on a simulator -- ' +
        'build with -destination "generic/platform=iOS Simulator" and zip the resulting .app.');
    }
  }
  if (body.app.github && !body.app.github.repo) {
    throw new HttpError(400, 'app.github.repo is required, as "owner/repo"');
  }
  if (body.app.github && url) {
    throw new HttpError(400, 'give either app.url or app.github, not both');
  }
  if ((body.xctest || body.instrumentation) && !appPath && !scheme && !bundleId && !artifactId && !url && !body.app.github) {
    return;   // the platform test runner builds and installs the app itself
  }
  if (!appPath && !scheme && !bundleId && !artifactId && !url && !body.app.github) {
    throw new HttpError(400,
      'app needs one of: `github` (newest matching Actions artifact), `url` (a zipped simulator .app ' +
      'or an .apk the daemon downloads), `artifactId` (an uploaded build), ' +
      '`path` (a built .app/.apk or a zip of one), ' +
      '`scheme` plus `project`/`workspace` (build an iOS app from source), ' +
      '`project` plus `module` (build an Android app from Gradle), or `bundleId` alone ' +
      '(an app already installed on the pooled devices)');
  }
  if (artifactId && !d.artifacts.get(artifactId)) {
    throw new HttpError(404, `no uploaded artifact "${artifactId}" -- upload it first with POST /v1/artifacts`);
  }
  if (scheme && !project && !workspace && !appPath) {
    throw new HttpError(400, 'building from source needs app.project (.xcodeproj) or app.workspace (.xcworkspace)');
  }
  if (body.app.module && !project && !appPath) {
    throw new HttpError(400, 'building an Android app from source needs app.project (the Gradle project directory)');
  }
  if (body.instrumentation) {
    const t = body.instrumentation;
    if (!t.project && !t.testApk) {
      throw new HttpError(400, 'instrumentation needs `project` (a Gradle project to build from) or `testApk` plus `appApk` (pre-built)');
    }
    if (t.testApk && !t.appApk) {
      throw new HttpError(400, 'instrumentation with `testApk` also needs `appApk` -- a test APK instruments an app that must be installed alongside it');
    }
    if (body.scenario || body.steps?.length) {
      throw new HttpError(400, '`instrumentation` cannot be combined with `scenario` or `steps`');
    }
  } else if (body.xctest) {
    const x = body.xctest;
    if (!x.xctestrun && !x.scheme) {
      throw new HttpError(400, 'xctest needs `xctestrun` (a pre-built bundle) or `scheme` plus `project`/`workspace`');
    }
    if (!x.xctestrun && !x.project && !x.workspace) {
      throw new HttpError(400, 'xctest from source needs `project` (.xcodeproj) or `workspace` (.xcworkspace)');
    }
    if (body.scenario || body.steps?.length) {
      throw new HttpError(400, '`xctest` cannot be combined with `scenario` or `steps`');
    }
  } else if (!body.scenario && !body.steps?.length) {
    throw new HttpError(400,
      'provide `scenario` (natural language), `steps` (explicit actions), ' +
      '`xctest` (an XCUITest bundle) or `instrumentation` (an Android instrumentation suite)');
  }
  if (body.scenario && body.steps?.length) {
    throw new HttpError(400, '`scenario` and `steps` are mutually exclusive');
  }
  if (body.scenario && !d.llmName) {
    throw new HttpError(503, 'this daemon has no LLM backend, so natural-language scenarios are unavailable -- submit explicit `steps` instead, or set ANTHROPIC_API_KEY and restart');
  }
  // Reject a step naming something the harness does not implement, rather than
  // dropping the key and reporting a gesture that never happened.
  if (body.steps?.length) {
    try {
      validateSteps(body.steps as unknown[]);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  // Catch a mismatch at submit time rather than failing the run at the end.
  if (body.steps?.length && body.screenshots?.length) {
    const named = new Set(body.steps
      .filter((s): s is Extract<Step, { action: 'screenshot' }> => s.action === 'screenshot')
      .map((s) => s.name));
    const missing = body.screenshots.filter((w) => !named.has(w));
    if (missing.length) {
      throw new HttpError(400,
        `steps never capture the requested screenshot(s): ${missing.join(', ')}. ` +
        `Add a {"action":"screenshot","name":"..."} step for each.`);
    }
  }
}

function waitForTerminal(d: Deps, runId: string, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const current = d.store.get(runId)!;
    if (isTerminal(current.status)) return resolve(current);

    const done = (run: Run) => { cleanup(); resolve(run); };
    const off = d.store.onChange((run) => {
      if (run.id === runId && isTerminal(run.status)) done(run);
    });
    const timer = setTimeout(() => { cleanup(); resolve(d.store.get(runId)!); }, timeoutMs);
    function cleanup() { off(); clearTimeout(timer); }
  });
}

const poolView = (d: Deps) => {
  const devices = d.pool.list();
  const counts: Record<string, number> = {};
  for (const x of devices) counts[x.status] = (counts[x.status] ?? 0) + 1;
  return {
    target: d.pool.targetCount(),
    devices,
    counts,
    queued: d.store.pending().length,
    active: d.runner.active,
  };
};

/** Run plus the derived fields a polling client wants. */
function publicRun(d: Deps, run: Run) {
  const position = run.status === 'pending' ? d.scheduler.queuePosition(run.id) : -1;
  return {
    ...run,
    done: isTerminal(run.status),
    ...(position >= 0 ? { queuePosition: position } : {}),
    links: {
      self: `/v1/runs/${run.id}`,
      wait: `/v1/runs/${run.id}/wait`,
      report: `/v1/runs/${run.id}/report`,
      screenshots: run.screenshots.map((s) => ({
        name: s.name, url: `/v1/runs/${run.id}/screenshots/${encodeURIComponent(s.name)}`,
      })),
    },
    dir: d.store.dir(run.id),
  };
}

const summarise = (d: Deps, run: Run) => ({
  id: run.id,
  status: run.status,
  done: isTerminal(run.status),
  label: run.request.label ?? null,
  mode: run.mode,
  createdAt: run.createdAt,
  finishedAt: run.finishedAt ?? null,
  device: run.device?.name ?? null,
  screenshots: run.screenshots.length,
  summary: run.verdict?.summary ?? run.error ?? null,
});

function bearer(req: http.IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return String(req.headers['x-simcheck-token'] ?? '').trim();
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new HttpError(413, 'request body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {} as T;
  try { return JSON.parse(raw) as T; }
  catch (e) { throw new HttpError(400, `body is not valid JSON: ${(e as Error).message}`); }
}

/** Refuse any artifact path that escapes the run directory. */
function safeJoin(base: string, rel: string): string {
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) throw new HttpError(400, 'invalid artifact path');
  return full;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}
