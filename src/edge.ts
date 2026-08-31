import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import type { Config } from './config.js';
import { logger } from './log.js';

const log = logger('edge');

/**
 * Identity asserted by whatever sits in front of the daemon.
 *
 * This is a *gate*, not a grant: it decides whether a request is allowed to
 * reach the token layer at all. Capabilities still come from the bearer token,
 * so a stolen edge credential on its own buys nothing.
 */
export interface EdgeIdentity {
  /** 'cloudflare-access' | 'trusted-proxy' | 'loopback' */
  via: string;
  /** Email for a human, service-token common name for a machine. */
  subject: string;
  /** True when the caller is a service token rather than a person. */
  service: boolean;
  raw?: Record<string, unknown>;
}

export class EdgeAuthError extends Error {
  constructor(message: string) { super(message); }
}

export interface EdgeVerifier {
  readonly mode: string;
  verify(req: http.IncomingMessage, remote: string): Promise<EdgeIdentity>;
  describe(): string;
}

/* ------------------------------------------------------------------ none -- */

class LoopbackOnly implements EdgeVerifier {
  readonly mode = 'none';
  async verify(_req: http.IncomingMessage, remote: string): Promise<EdgeIdentity> {
    if (!isLoopback(remote)) {
      throw new EdgeAuthError(
        `refusing a request from ${remote}: edgeAuth is "none", so only loopback callers are accepted. ` +
        `Set edgeAuth to "cloudflare-access" or "trusted-proxy" before exposing this daemon.`);
    }
    return { via: 'loopback', subject: 'local', service: true };
  }
  describe(): string { return 'loopback only'; }
}

/* ------------------------------------------------- cloudflare access (JWT) -- */

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }

/**
 * Verifies the JWT Cloudflare Access stamps on every authorised request.
 *
 * Checking this in the origin — rather than trusting that traffic arrived via
 * the tunnel — is what stops someone who reaches the origin by another route
 * from walking straight past Access.
 */
export class CloudflareAccessVerifier implements EdgeVerifier {
  readonly mode = 'cloudflare-access';
  private keys = new Map<string, crypto.KeyObject>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private teamDomain: string, private audTags: string[], private allowLoopback: boolean) {
    if (!teamDomain) throw new Error('edgeAuth "cloudflare-access" needs cloudflareTeamDomain, e.g. "yourteam.cloudflareaccess.com"');
    if (!audTags.length) throw new Error('edgeAuth "cloudflare-access" needs cloudflareAud (the Application Audience tag from the Access app)');
  }

  private get issuer(): string { return `https://${this.teamDomain}`; }
  private get certsUrl(): string { return `${this.issuer}/cdn-cgi/access/certs`; }

  describe(): string { return `Cloudflare Access (${this.teamDomain}, aud ${this.audTags.map((a) => a.slice(0, 8) + '...').join(', ')})`; }

  async verify(req: http.IncomingMessage, remote: string): Promise<EdgeIdentity> {
    if (this.allowLoopback && isLoopback(remote)) {
      return { via: 'loopback', subject: 'local', service: true };
    }
    const token = String(req.headers['cf-access-jwt-assertion'] ?? '')
      || cookie(req.headers.cookie, 'CF_Authorization');
    if (!token) {
      throw new EdgeAuthError(
        'missing the Cf-Access-Jwt-Assertion header. Requests must arrive through Cloudflare Access; ' +
        'a client authenticates with CF-Access-Client-Id and CF-Access-Client-Secret.');
    }
    const claims = await this.verifyJwt(token);

    // A service token has a common_name and an empty sub; a person has an email.
    const commonName = typeof claims['common_name'] === 'string' ? claims['common_name'] : '';
    const email = typeof claims['email'] === 'string' ? claims['email'] : '';
    const subject = commonName || email;
    if (!subject) throw new EdgeAuthError('Access JWT carries neither common_name nor email');

    return { via: this.mode, subject, service: Boolean(commonName), raw: claims };
  }

  private async verifyJwt(token: string): Promise<Record<string, unknown>> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new EdgeAuthError('Access JWT is malformed');
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    const header = decodeJson(headerB64);
    if (header['alg'] !== 'RS256') throw new EdgeAuthError(`unexpected JWT algorithm ${String(header['alg'])}; expected RS256`);
    const kid = String(header['kid'] ?? '');
    if (!kid) throw new EdgeAuthError('Access JWT has no kid');

    let key = await this.key(kid);
    if (!key) {
      // Cloudflare rotates signing keys; a miss means refresh, not reject.
      await this.refresh(true);
      key = await this.key(kid);
    }
    if (!key) throw new EdgeAuthError(`no Cloudflare signing key matches kid ${kid}`);

    const ok = crypto.createVerify('RSA-SHA256')
      .update(`${headerB64}.${payloadB64}`)
      .verify(key, Buffer.from(sigB64, 'base64url'));
    if (!ok) throw new EdgeAuthError('Access JWT signature is not valid');

    const claims = decodeJson(payloadB64);
    const now = Math.floor(Date.now() / 1000);
    const skew = 60;

    if (typeof claims['exp'] === 'number' && claims['exp'] + skew < now) throw new EdgeAuthError('Access JWT has expired');
    if (typeof claims['nbf'] === 'number' && claims['nbf'] - skew > now) throw new EdgeAuthError('Access JWT is not yet valid');
    if (claims['iss'] !== this.issuer) throw new EdgeAuthError(`Access JWT issuer ${String(claims['iss'])} is not ${this.issuer}`);

    const aud = Array.isArray(claims['aud']) ? claims['aud'].map(String) : [String(claims['aud'] ?? '')];
    if (!aud.some((a) => this.audTags.includes(a))) {
      // A JWT for a *different* Access app in the same team would otherwise pass.
      throw new EdgeAuthError('Access JWT audience does not match this application');
    }
    return claims;
  }

  private async key(kid: string): Promise<crypto.KeyObject | undefined> {
    if (Date.now() - this.fetchedAt > 3_600_000) await this.refresh(false);
    return this.keys.get(kid);
  }

  /** Fetch the JWKS, coalescing concurrent refreshes into one request. */
  private async refresh(force: boolean): Promise<void> {
    if (!force && Date.now() - this.fetchedAt < 60_000) return;
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      const res = await fetch(this.certsUrl, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new EdgeAuthError(`could not fetch ${this.certsUrl} (${res.status})`);
      const body = await res.json() as { keys?: Jwk[] };
      const next = new Map<string, crypto.KeyObject>();
      for (const jwk of body.keys ?? []) {
        if (jwk.kty !== 'RSA' || !jwk.kid) continue;
        try {
          next.set(jwk.kid, crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: 'jwk' }));
        } catch (e) {
          log.warn(`skipping unusable JWK ${jwk.kid}`, (e as Error).message);
        }
      }
      if (!next.size) throw new EdgeAuthError(`${this.certsUrl} returned no usable RSA keys`);
      this.keys = next;
      this.fetchedAt = Date.now();
      log.info(`loaded ${next.size} Cloudflare Access signing keys`);
    })().finally(() => { this.inflight = null; });

    return this.inflight;
  }

  /** Called at startup so a misconfigured team domain fails loudly, not on first use. */
  async preflight(): Promise<void> { await this.refresh(true); }
}

/* ------------------------------------------------------- trusted proxy -- */

/**
 * For a ZTNA broker or reverse proxy that terminates the connection itself --
 * a Netskope Private Access publisher, an internal load balancer, Caddy.
 *
 * Such brokers give reachability and policy but do not reliably stamp a signed
 * identity, so this mode authenticates the *hop*, by source address, and leaves
 * authorisation entirely to the bearer token. An optional header, honoured only
 * from a trusted hop, is recorded for the audit log.
 */
export class TrustedProxyVerifier implements EdgeVerifier {
  readonly mode = 'trusted-proxy';
  private nets: Cidr[];

  constructor(cidrs: string[], private identityHeader: string, private allowLoopback: boolean) {
    if (!cidrs.length) {
      throw new Error('edgeAuth "trusted-proxy" needs trustedProxies, e.g. ["192.168.4.0/24"] -- the address your publisher or proxy connects from');
    }
    this.nets = cidrs.map(parseCidr);
  }

  describe(): string { return `trusted proxy (${this.nets.map((n) => n.text).join(', ')})`; }

  async verify(req: http.IncomingMessage, remote: string): Promise<EdgeIdentity> {
    if (this.allowLoopback && isLoopback(remote)) {
      return { via: 'loopback', subject: 'local', service: true };
    }
    if (!this.nets.some((n) => inCidr(remote, n))) {
      throw new EdgeAuthError(`${remote} is not a trusted proxy address`);
    }
    const asserted = this.identityHeader
      ? String(req.headers[this.identityHeader.toLowerCase()] ?? '').trim()
      : '';
    return { via: this.mode, subject: asserted || remote, service: !asserted };
  }
}

/* ---------------------------------------------------------------- factory -- */

export async function createEdgeVerifier(cfg: Config): Promise<EdgeVerifier> {
  switch (cfg.edgeAuth) {
    case 'cloudflare-access': {
      const v = new CloudflareAccessVerifier(cfg.cloudflareTeamDomain, cfg.cloudflareAud, cfg.edgeAllowLoopback);
      await v.preflight();
      return v;
    }
    case 'trusted-proxy':
      return new TrustedProxyVerifier(cfg.trustedProxies, cfg.identityHeader, cfg.edgeAllowLoopback);
    case 'none':
      return new LoopbackOnly();
    default:
      throw new Error(`unknown edgeAuth "${cfg.edgeAuth}" (use none, cloudflare-access or trusted-proxy)`);
  }
}

/* ---------------------------------------------------------------- helpers -- */

const decodeJson = (b64: string): Record<string, unknown> => {
  try { return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as Record<string, unknown>; }
  catch { throw new EdgeAuthError('Access JWT contains invalid JSON'); }
};

function cookie(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

/** ::ffff:127.0.0.1 is how a v4 loopback arrives on a dual-stack socket. */
export function isLoopback(addr: string): boolean {
  const a = addr.replace(/^::ffff:/i, '');
  return a === '127.0.0.1' || a.startsWith('127.') || a === '::1' || a === 'localhost';
}

interface Cidr { text: string; base: bigint; mask: bigint; v6: boolean }

export function parseCidr(text: string): Cidr {
  const [addr, bitsRaw] = text.split('/');
  if (!addr) throw new Error(`invalid CIDR "${text}"`);
  const v6 = addr.includes(':');
  const width = v6 ? 128 : 32;
  const bits = bitsRaw === undefined ? width : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) throw new Error(`invalid prefix length in "${text}"`);
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
  return { text, base: toBigInt(addr) & mask, mask, v6 };
}

export function inCidr(addr: string, net: Cidr): boolean {
  const plain = addr.replace(/^::ffff:/i, '');
  if (plain.includes(':') !== net.v6) return false;
  try { return (toBigInt(plain) & net.mask) === net.base; }
  catch { return false; }
}

function toBigInt(addr: string): bigint {
  if (!addr.includes(':')) {
    const parts = addr.split('.');
    if (parts.length !== 4) throw new Error(`invalid IPv4 address "${addr}"`);
    return parts.reduce((acc, p) => {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`invalid IPv4 address "${addr}"`);
      return (acc << 8n) | BigInt(n);
    }, 0n);
  }
  // Expand :: then parse the eight groups.
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail !== undefined ? (tail ? tail.split(':').filter(Boolean) : []) : null;
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) throw new Error(`invalid IPv6 address "${addr}"`);
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16) || 0), 0n);
}

/** Corporate TLS interception check, for Netskope and friends. */
export function caBundleStatus(cfg: Config): { configured: string | null; active: string | null; ok: boolean } {
  const configured = cfg.caBundle || null;
  const active = process.env['NODE_EXTRA_CA_CERTS'] || null;
  if (configured && !fs.existsSync(configured)) return { configured, active, ok: false };
  // NODE_EXTRA_CA_CERTS is read once at process start, so setting it later is useless.
  return { configured, active, ok: !configured || active === configured };
}
