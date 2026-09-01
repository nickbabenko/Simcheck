#!/usr/bin/env node
/**
 * Remote MCP entry point, for Claude connectors (including the phone app).
 *
 * Unlike the stdio server, Claude's *cloud* connects here, not your device --
 * so this has to be publicly reachable and must authenticate for itself. It is
 * an OAuth 2.1 authorization server plus the MCP endpoint as a resource server.
 *
 * Two things keep the blast radius small:
 *  - authorization needs a pairing code printed on the Mac, so nobody who
 *    merely finds the URL can complete a flow;
 *  - it talks to the daemon with a capability-scoped token (default `remote`),
 *    so even a total auth bypass cannot build from a local path, which is the
 *    only route to arbitrary code execution.
 */
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { randomBytes } from 'node:crypto';
import { loadConfig, readToken, type Config } from './config.js';
import { Client } from './client.js';
import { createMcpServer } from './mcp-server.js';
import { SimcheckOAuth, messagePage } from './oauth.js';
import { logger, logToFile } from './log.js';
import path from 'node:path';

const log = logger('remote');

export const SCOPES = ['simcheck:read', 'simcheck:run'];

export function createRemoteApp(cfg: Config, oauth: SimcheckOAuth, publicUrl: URL): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // cloudflared / tailscale funnel connect over loopback, so exactly one local
  // hop is trusted. `true` would let any client spoof X-Forwarded-For, and
  // express-rate-limit (used by the auth router) refuses to run with it.
  app.set('trust proxy', 'loopback');

  // The connector token is separate from the local one: scope it down in
  // ~/.simcheck/config.json via remoteToken, or it falls back to the local token.
  const client = new Client(cfg, cfg.remoteToken || undefined);
  const daemonBase = `http://${cfg.host}:${cfg.port}`;

  // Only the OAuth consent form is urlencoded. Uploads must skip the parser
  // entirely: it would buffer the body and reject a build as "payload too
  // large" before the auth check ever ran, which is a baffling error for CI.
  const formParser = express.urlencoded({ extended: false });
  app.use((req, res, next) => (req.path.startsWith('/upload') ? next() : formParser(req, res, next)));

  // A CORS preflight carries no credentials, so it must be answered before the
  // bearer check -- otherwise any browser-mediated leg of the flow sees a 401.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, www-authenticate');
    if (req.method === 'OPTIONS') return void res.sendStatus(204);
    next();
  });

  /* --------------------------------------------------------------- OAuth -- */
  app.use(mcpAuthRouter({
    provider: oauth,
    issuerUrl: publicUrl,
    baseUrl: publicUrl,
    scopesSupported: SCOPES,
    resourceName: 'simcheck',
    resourceServerUrl: new URL('/mcp', publicUrl),
  }));

  // Second leg of the consent screen: verify the pairing code, then bounce back.
  app.post('/oauth/approve', (req, res) => {
    const { ticket, pairing, state } = req.body as Record<string, string>;
    if (!ticket || !pairing) {
      return void res.status(400).type('html').send(messagePage('Missing details', 'Go back and enter the pairing code.'));
    }
    const result = oauth.approve(ticket, pairing, state ?? '');
    if ('error' in result) {
      log.warn('consent rejected', result.error);
      return void res.status(400).type('html').send(messagePage('Not approved', result.error));
    }
    res.redirect(302, result.redirect);
  });

  // RFC 9728 puts the document for resource /mcp at
  // /.well-known/oauth-protected-resource/mcp, and mcpAuthRouter serves that.
  // Clients vary though: some probe the bare well-known path, and the SSE
  // endpoint is a distinct resource needing its own document. Serve both
  // rather than let a client give up at a 404.
  const protectedResource = (resourcePath: string) => ({
    resource: new URL(resourcePath, publicUrl).href,
    authorization_servers: [publicUrl.href],
    scopes_supported: SCOPES,
    resource_name: 'simcheck',
  });
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(protectedResource('/mcp')));
  app.get('/.well-known/oauth-protected-resource/sse', (_req, res) => res.json(protectedResource('/sse')));

  /* ----------------------------------------------------------------- MCP -- */
  const requireAuth = requireBearerAuth({
    verifier: oauth,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL('/mcp', publicUrl)),
  });

  // Stateless: one transport per request. Simpler than session affinity, and
  // correct behind a tunnel that may land requests on any connection.
  app.all('/mcp', requireAuth, async (req, res) => {
    // Stateless: no session id, so each request stands alone. A session would
    // not survive here anyway -- the transport is per-request, and a tunnel can
    // land consecutive requests on different connections.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(client, { createUploadUrl });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log.error('MCP request failed', (e as Error).message);
      if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
    }
  });

  /* ------------------------------------------------------- upload tickets -- */
  /**
   * Short-lived, single-use upload URLs.
   *
   * An agent that already holds an OAuth session can mint one of these, then
   * PUT a build to it over ordinary HTTP -- which is how a 40MB binary gets in
   * without passing through a tool call. The ticket *is* the authorisation, so
   * nothing long-lived has to be handed to CI or held by the agent.
   *
   * Deliberately in memory: they live for minutes and are used seconds after
   * being issued. A restart invalidates outstanding tickets, and the caller
   * simply asks for another.
   */
  interface Ticket { expiresAt: number; label?: string; used: boolean }
  const tickets = new Map<string, Ticket>();
  const TICKET_TTL_SEC = 900;

  setInterval(() => {
    const now = Date.now();
    for (const [k, t] of tickets) if (now > t.expiresAt || t.used) tickets.delete(k);
  }, 60_000).unref();

  const createUploadUrl = (label?: string) => {
    const id = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + TICKET_TTL_SEC * 1000;
    tickets.set(id, { expiresAt, used: false, ...(label ? { label } : {}) });
    log.info(`issued an upload ticket${label ? ` for "${label}"` : ''}, valid ${TICKET_TTL_SEC}s`);
    return {
      url: new URL(`/upload/${id}`, publicUrl).href,
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInSeconds: TICKET_TTL_SEC,
    };
  };

  /** Stream a request body into the daemon's artifact store. */
  const proxyUpload = async (
    req: express.Request, res: express.Response,
    authorization: string, label?: string,
  ): Promise<void> => {
    const query = new URLSearchParams();
    const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
    const finalLabel = q('label') ?? label;
    if (finalLabel) query.set('label', finalLabel);
    if (q('gitSha')) query.set('gitSha', q('gitSha')!);

    try {
      const upstream = await fetch(`${daemonBase}/v1/artifacts?${query}`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/zip',
          ...(req.header('content-length') ? { 'content-length': req.header('content-length')! } : {}),
        },
        body: req as unknown as ReadableStream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      const text = await upstream.text();
      res.status(upstream.status).type('application/json').send(text);
      if (upstream.ok) log.info(`artifact received (${req.header('content-length') ?? '?'} bytes)`);
    } catch (e) {
      log.error('upload proxy failed', (e as Error).message);
      res.status(502).json({ error: `could not reach the daemon: ${(e as Error).message}` });
    }
  };

  // Redeem a ticket. No Authorization header: the ticket is the credential,
  // and the daemon call is made with the harness's own scoped token.
  app.post('/upload/:ticket', async (req, res) => {
    const t = tickets.get(req.params.ticket);
    if (!t) {
      return void res.status(404).json({ error: 'unknown or already-used upload URL -- request a new one with create_upload_url' });
    }
    if (t.used) {
      tickets.delete(req.params.ticket);
      return void res.status(409).json({ error: 'this upload URL has already been used -- request a new one' });
    }
    if (Date.now() > t.expiresAt) {
      tickets.delete(req.params.ticket);
      return void res.status(410).json({ error: 'this upload URL has expired -- request a new one' });
    }
    // Burn it before reading the body, so a retry cannot reuse it.
    t.used = true;
    const token = cfg.remoteToken || readToken(cfg);
    if (!token) return void res.status(500).json({ error: 'no daemon token configured' });
    await proxyUpload(req, res, `Bearer ${token}`, t.label);
  });

  /* -------------------------------------------------------------- upload -- */
  /**
   * Public upload endpoint, so CI can push a build straight in.
   *
   * This is the inverse of `app.url`: instead of the harness reaching out to a
   * CI provider (needing a stored provider token, and opening an outbound
   * request surface), CI pushes to us. Per-repo setup collapses to one curl,
   * and it works with any CI, not just GitHub.
   *
   * Authenticated with an ordinary simcheck token rather than OAuth --
   * a CI job cannot run a browser consent flow. The token is passed straight
   * through to the daemon, which does the capability check, so there is no
   * second copy of the auth logic here.
   */
  app.post('/upload', async (req, res) => {
    const auth = req.header('authorization');
    if (!auth) {
      return void res.status(401).json({
        error: 'missing Authorization header -- use a simcheck token with the artifacts:write capability',
      });
    }
    await proxyUpload(req, res, auth);
  });

  /* ------------------------------------------------------------- SSE -- */
  // Older MCP clients speak the HTTP+SSE transport rather than Streamable
  // HTTP: a long-lived GET for server messages, and POSTs for client ones.
  // Kept as a compatibility path -- same tools, same auth.
  const sseSessions = new Map<string, SSEServerTransport>();

  app.get('/sse', requireAuth, async (_req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    const server = createMcpServer(client, { createUploadUrl });
    sseSessions.set(transport.sessionId, transport);
    res.on('close', () => {
      sseSessions.delete(transport.sessionId);
      void server.close();
    });
    try {
      await server.connect(transport);
      log.info(`SSE session ${transport.sessionId} opened`);
    } catch (e) {
      log.error('SSE connect failed', (e as Error).message);
      sseSessions.delete(transport.sessionId);
    }
  });

  app.post('/messages', requireAuth, async (req, res) => {
    const sessionId = String(req.query['sessionId'] ?? '');
    const transport = sseSessions.get(sessionId);
    if (!transport) {
      return void res.status(404).json({ error: `no SSE session ${sessionId || '(none given)'}` });
    }
    await transport.handlePostMessage(req, res);
  });

  /* -------------------------------------------------------------- health -- */
  app.get('/health', async (_req, res) => {
    const daemon = await client.health().catch(() => null);
    res.json({
      ok: Boolean(daemon),
      mcp: new URL('/mcp', publicUrl).href,
      sse: new URL('/sse', publicUrl).href,
      upload: new URL('/upload', publicUrl).href,
      oauth: oauth.status(),
      pairingActive: oauth.hasPairingCode(),
      daemon: daemon ?? 'unreachable',
    });
  });

  app.get('/', (_req, res) => {
    res.type('html').send(messagePage(
      'simcheck',
      `Remote MCP endpoint. Add ${new URL('/mcp', publicUrl).href} as a custom connector in Claude `
      + `(or ${new URL('/sse', publicUrl).href} if it expects the older SSE transport).`));
  });

  return app;
}

/* ---------------------------------------------------------------- main -- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  logToFile(path.join(cfg.home, 'remote.log'));

  if (!cfg.publicUrl) {
    log.error('set publicUrl in ~/.simcheck/config.json to the https address Claude will reach, e.g. https://sim.example.com');
    process.exit(1);
  }
  const publicUrl = new URL(cfg.publicUrl);
  if (publicUrl.protocol !== 'https:' && publicUrl.hostname !== 'localhost') {
    log.error(`publicUrl must be https (got ${publicUrl.protocol}//) -- OAuth redirect URIs are rejected otherwise`);
    process.exit(1);
  }

  const oauth = new SimcheckOAuth(cfg, SCOPES);
  const app = createRemoteApp(cfg, oauth, publicUrl);

  // Bind loopback: cloudflared connects locally, so the port is never exposed.
  app.listen(cfg.remotePort, '127.0.0.1', () => {
    log.info(`remote MCP on http://127.0.0.1:${cfg.remotePort}, published at ${publicUrl.href}`);
    log.info(`connector URL: ${new URL('/mcp', publicUrl).href}`);
    log.info(`token scope: ${cfg.remoteToken ? 'remoteToken from config' : 'local token (consider a scoped one)'}`);
  });
}
