import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Config } from './config.js';
import { logger } from './log.js';
import { nowIso } from './util.js';

const log = logger('oauth');

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');

/* ------------------------------------------------------------- persistence */

interface Persisted {
  version: 1;
  clients: OAuthClientInformationFull[];
  /** Refresh tokens, stored hashed. Access tokens stay in memory only. */
  refresh: { hash: string; clientId: string; scopes: string[]; issuedAt: string }[];
  /** Hashed, short-lived. On disk because `simcheck pair` runs in a
   *  different process from the server and both must see it. */
  pairing?: { hash: string; expiresAt: number } | null;
  /** In-flight consent tickets and authorization codes. On disk so that a
   *  restart mid-flow does not silently invalidate an authorization the user
   *  is part-way through -- which reads to them as a spurious expiry. */
  codes?: Record<string, PendingCode>;
  /** Access tokens, hashed, so a redeploy does not sign the connector out. */
  access?: Record<string, AccessToken>;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface AccessToken {
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

/**
 * A single-tenant OAuth 2.1 authorization server, just large enough for one
 * person to connect Claude to their own machine.
 *
 * The consent step is deliberately not a password. This endpoint is on the
 * public internet, so instead of a credential that can be guessed or phished,
 * authorization requires a short-lived pairing code that is only printed on the
 * Mac itself (`simcheck pair`). Possession of the machine is the proof.
 */
export class SimcheckOAuth implements OAuthServerProvider {
  private file: string;
  private data: Persisted = { version: 1, clients: [], refresh: [], pairing: null };

  private get codes(): Record<string, PendingCode> {
    this.data.codes ??= {};
    return this.data.codes;
  }

  private get access(): Record<string, AccessToken> {
    this.data.access ??= {};
    return this.data.access;
  }

  readonly accessTtlSec = 3600;

  constructor(private cfg: Config, private defaultScopes: string[]) {
    this.file = path.join(cfg.home, 'oauth.json');
    this.load();
    // Expired codes and tokens are worthless but shouldn't accumulate.
    setInterval(() => this.sweep(), 60_000).unref();
  }

  /* ------------------------------------------------------------- pairing -- */

  /** Mint a pairing code. Printed on the Mac, entered on the consent page. */
  issuePairingCode(ttlSec = 600): { code: string; expiresAt: string } {
    // Ambiguous characters removed: this gets typed on a phone.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const raw = Array.from(crypto.randomBytes(8))
      .map((b) => alphabet[b % alphabet.length])
      .join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const expiresAt = Date.now() + ttlSec * 1000;
    this.load();                       // do not clobber a concurrent write
    this.data.pairing = { hash: sha256(code), expiresAt };
    this.save();
    log.info(`pairing code issued, valid ${ttlSec}s`);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Constant-time check. Single-use: a correct code is consumed. */
  redeemPairingCode(given: string): boolean {
    // Re-read: the code was almost certainly minted by the CLI, not by us.
    this.load();
    const pairing = this.data.pairing;
    if (!pairing || Date.now() > pairing.expiresAt) return false;

    const a = Buffer.from(sha256(given.trim().toUpperCase()), 'hex');
    const b = Buffer.from(pairing.hash, 'hex');
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    // Consume on success, and on failure too: one guess per printed code.
    this.data.pairing = null;
    this.save();
    return ok;
  }

  hasPairingCode(): boolean {
    this.load();
    const p = this.data.pairing;
    return Boolean(p && Date.now() <= p.expiresAt);
  }

  /* ------------------------------------------------------------- clients -- */

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.data.clients.find((c) => c.client_id === clientId),

      // Dynamic client registration: Claude registers itself when you add the
      // connector. Registration alone grants nothing -- every authorization
      // still needs a pairing code typed from the Mac.
      registerClient: (client) => {
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: `shc_${crypto.randomBytes(12).toString('hex')}`,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.data.clients.push(full);
        this.save();
        log.info(`registered OAuth client ${full.client_id} (${full.client_name ?? 'unnamed'})`);
        return full;
      },
    };
  }

  /* --------------------------------------------------------- authorize -- */

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Render consent rather than redirecting: the pairing code is entered here.
    const pending = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes?.length ? params.scopes : this.defaultScopes,
      ...(params.resource ? { resource: params.resource.href } : {}),
    };
    const ticket = b64url(crypto.randomBytes(18));
    this.load();
    this.codes[`pending:${ticket}`] = { ...pending, expiresAt: Date.now() + 600_000 };
    this.save();

    res.status(200).type('html').send(consentPage({
      ticket,
      clientName: client.client_name ?? client.client_id,
      scopes: pending.scopes,
      state: params.state ?? '',
      hasCode: this.hasPairingCode(),
    }));
  }

  /**
   * Second leg of consent: the pairing code is checked and a real
   * authorization code is issued, then the browser is sent back to the client.
   */
  approve(ticket: string, pairingCode: string, state: string): { redirect: string } | { error: string } {
    this.load();
    const pending = this.codes[`pending:${ticket}`];
    // Distinguish the two failures: they need different fixes, and conflating
    // them sent people hunting for a timeout that had not happened.
    if (!pending) {
      return { error: 'This authorization request is no longer on file, usually because the server restarted. Start again from Claude.' };
    }
    if (Date.now() > pending.expiresAt) {
      return { error: 'This authorization request expired after 10 minutes. Start again from Claude.' };
    }
    if (!this.redeemPairingCode(pairingCode)) {
      return { error: 'That pairing code is wrong or already used. Run `simcheck pair` on the Mac for a new one.' };
    }
    this.load();
    delete this.codes[`pending:${ticket}`];

    const code = b64url(crypto.randomBytes(24));
    this.codes[code] = { ...pending, expiresAt: Date.now() + 60_000 };
    this.save();

    const url = new URL(pending.redirectUri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    log.info(`authorization approved for ${pending.clientId}`);
    return { redirect: url.href };
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    this.load();
    const pending = this.codes[authorizationCode];
    if (!pending) throw new Error('invalid authorization code');
    return pending.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull, authorizationCode: string,
    _codeVerifier?: string, redirectUri?: string,
  ): Promise<OAuthTokens> {
    this.load();
    const pending = this.codes[authorizationCode];
    if (!pending || Date.now() > pending.expiresAt) throw new Error('invalid or expired authorization code');
    // Single use, whatever happens next.
    delete this.codes[authorizationCode];
    this.save();

    if (pending.clientId !== client.client_id) throw new Error('authorization code was issued to a different client');
    if (redirectUri && redirectUri !== pending.redirectUri) throw new Error('redirect_uri does not match the authorization request');

    return this.issueTokens(client.client_id, pending.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull, refreshToken: string, scopes?: string[],
  ): Promise<OAuthTokens> {
    this.load();
    const hash = sha256(refreshToken);
    const record = this.data.refresh.find((r) => r.hash === hash);
    if (!record) throw new Error('invalid refresh token');
    if (record.clientId !== client.client_id) throw new Error('refresh token was issued to a different client');

    // Rotate: the presented refresh token is retired as it is used.
    this.data.refresh = this.data.refresh.filter((r) => r.hash !== hash);
    // Narrowing is allowed, widening is not.
    const granted = scopes?.length ? scopes.filter((s) => record.scopes.includes(s)) : record.scopes;
    return this.issueTokens(client.client_id, granted);
  }

  private issueTokens(clientId: string, scopes: string[]): OAuthTokens {
    const accessToken = `sha_${b64url(crypto.randomBytes(32))}`;
    const refreshToken = `shr_${b64url(crypto.randomBytes(32))}`;

    this.access[sha256(accessToken)] = {
      clientId, scopes, expiresAt: Date.now() + this.accessTtlSec * 1000,
    };
    this.data.refresh.push({ hash: sha256(refreshToken), clientId, scopes, issuedAt: nowIso() });
    this.save();

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTtlSec,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.access[sha256(token)];
    if (!record) throw new InvalidTokenError('invalid access token');
    if (Date.now() > record.expiresAt) {
      delete this.access[sha256(token)];
      this.save();
      throw new InvalidTokenError('access token has expired');
    }
    return {
      token, clientId: record.clientId, scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = sha256(request.token);
    delete this.access[hash];
    this.data.refresh = this.data.refresh.filter((r) => r.hash !== hash);
    this.save();
  }

  /** Drop one connector and its tokens -- a lost phone, or a stale client. */
  revokeClient(clientId: string): boolean {
    this.load();
    const before = this.data.clients.length;
    this.data.clients = this.data.clients.filter((c) => c.client_id !== clientId);
    if (this.data.clients.length === before) return false;

    this.data.refresh = this.data.refresh.filter((r) => r.clientId !== clientId);
    for (const [k, v] of Object.entries(this.access)) {
      if (v.clientId === clientId) delete this.access[k];
    }
    for (const [k, v] of Object.entries(this.codes)) {
      if (v.clientId === clientId) delete this.codes[k];
    }
    this.save();
    log.info(`revoked client ${clientId}`);
    return true;
  }

  /** Registered connectors, for `simcheck remote clients`. */
  listClients(): { clientId: string; name: string; issuedAt: string | null }[] {
    this.load();
    return this.data.clients.map((c) => ({
      clientId: c.client_id,
      name: c.client_name ?? '(unnamed)',
      issuedAt: c.client_id_issued_at ? new Date(c.client_id_issued_at * 1000).toISOString() : null,
    }));
  }

  /** Drop every issued credential, e.g. after losing a phone. */
  revokeAll(): void {
    this.data.access = {};
    this.data.codes = {};
    this.data.refresh = [];
    this.data.clients = [];
    this.data.pairing = null;
    this.save();
    log.warn('revoked all OAuth clients and tokens');
  }

  status(): { clients: number; refreshTokens: number; activeAccessTokens: number } {
    return {
      clients: this.data.clients.length,
      refreshTokens: this.data.refresh.length,
      activeAccessTokens: Object.keys(this.access).length,
    };
  }

  /* -------------------------------------------------------------- store -- */

  private sweep(): void {
    const now = Date.now();
    this.load();
    let changed = false;
    for (const [k, v] of Object.entries(this.codes)) {
      if (now > v.expiresAt) { delete this.codes[k]; changed = true; }
    }
    for (const [k, v] of Object.entries(this.access)) {
      if (now > v.expiresAt) { delete this.access[k]; changed = true; }
    }
    if (this.data.pairing && now > this.data.pairing.expiresAt) {
      this.data.pairing = null; changed = true;
    }
    if (changed) this.save();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Persisted; }
    catch (e) { log.warn('oauth state unreadable, starting empty', (e as Error).message); }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/* ------------------------------------------------------------ consent UI -- */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function consentPage(o: { ticket: string; clientName: string; scopes: string[]; state: string; hasCode: boolean }): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to simcheck</title>
<style>
:root{color-scheme:light dark;--bg:#f4f4f5;--card:#fff;--text:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#2563eb}
@media(prefers-color-scheme:dark){:root{--bg:#111113;--card:#1c1c1f;--text:#f4f4f5;--muted:#8b8b93;--border:#2a2a2f;--accent:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);
font:16px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;padding:24px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px;max-width:420px;width:100%}
h1{font-size:1.25rem;margin:0 0 6px;letter-spacing:-.02em}
p{color:var(--muted);font-size:.92rem;margin:0 0 16px}
ul{margin:0 0 20px;padding-left:20px;font-size:.9rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;background:var(--bg);
border:1px solid var(--border);padding:1px 5px;border-radius:5px}
input{width:100%;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.4rem;
text-align:center;letter-spacing:.12em;text-transform:uppercase;padding:12px;border-radius:10px;
border:1px solid var(--border);background:var(--bg);color:var(--text);margin-bottom:14px}
button{width:100%;font:inherit;font-weight:600;padding:12px;border-radius:10px;border:0;
background:var(--accent);color:#fff;cursor:pointer}
.warn{border-left:3px solid var(--accent);padding:10px 14px;background:var(--bg);border-radius:0 8px 8px 0;
font-size:.85rem;color:var(--muted);margin-bottom:18px}
</style></head><body>
<form class="card" method="POST" action="/oauth/approve">
  <h1>Connect ${esc(o.clientName)}</h1>
  <p>to simcheck on your Mac</p>
  <ul>${o.scopes.map((s) => `<li><code>${esc(s)}</code></li>`).join('')}</ul>
  <div class="warn">Run <code>simcheck pair</code> on the Mac and enter the code it prints.
  ${o.hasCode ? '' : 'No pairing code is currently active.'}</div>
  <input name="pairing" placeholder="XXXX-XXXX" autocomplete="off"
         autocapitalize="characters" autocorrect="off" spellcheck="false" required autofocus>
  <input type="hidden" name="ticket" value="${esc(o.ticket)}">
  <input type="hidden" name="state" value="${esc(o.state)}">
  <button type="submit">Approve</button>
</form></body></html>`;
}

export function messagePage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
font:16px/1.5 -apple-system,system-ui,sans-serif;padding:24px;text-align:center}
div{max-width:380px}h1{font-size:1.15rem;margin:0 0 8px}p{color:#71717a;font-size:.92rem}</style>
</head><body><div><h1>${esc(title)}</h1><p>${esc(body)}</p></div></body></html>`;
}
