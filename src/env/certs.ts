// Wildcard certificate issuance and renewal.
//
// Scope note: envcheck does not implement ACME. It drives `lego`, which is a
// single static binary, and watches the resulting files. Re-implementing ACME
// to avoid a 20 MB dependency would be a poor trade in a component whose
// failure mode is "every env is unreachable until someone notices".
//
// The certificate MUST be a wildcard for *.<baseDomain>. A per-env certificate
// is published to Certificate Transparency logs within seconds, which would make
// every slug publicly enumerable and defeat the unguessable hostname entirely.
// That is also why DNS-01 is the only challenge type here: HTTP-01 cannot
// validate a wildcard at all.

import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface CertPaths {
  certFile: string
  keyFile: string
}

export interface IssueRequest {
  /** Base domain; the wildcard and the apex are both requested. */
  baseDomain: string
  email: string
  /** lego DNS provider id, e.g. "cloudflare". */
  dnsProvider: string
  /** Directory lego writes into. */
  dataDir: string
  /** Let's Encrypt staging. Worth using while wiring this up — production has
   *  rate limits that lock you out for a week. */
  staging?: boolean
  /** Renew rather than issue. lego distinguishes the two subcommands. */
  renew?: boolean
}

/**
 * Build the lego argv.
 *
 * Pure and exported so the exact command can be asserted in tests without
 * running it — issuance touches real DNS and a real CA, which is not something
 * a test suite should do as a side effect.
 */
export function legoArgs(r: IssueRequest): string[] {
  const args = [
    '--accept-tos',
    '--email', r.email,
    '--dns', r.dnsProvider,
    '--path', r.dataDir,
    // Both: the wildcard does not cover the apex, and the dashboard or a health
    // endpoint usually wants the apex too.
    '--domains', `*.${r.baseDomain}`,
    '--domains', r.baseDomain,
  ]
  if (r.staging) args.push('--server', 'https://acme-staging-v02.api.letsencrypt.org/directory')
  args.push(r.renew ? 'renew' : 'run')
  // Without this, `renew` is a no-op until the certificate is nearly expired,
  // which makes the whole path untestable and hides failures until it is urgent.
  if (r.renew) args.push('--days', '30')
  return args
}

export function certPaths(dataDir: string, baseDomain: string): CertPaths {
  // lego names wildcard output after the domain with the star stripped.
  return {
    certFile: join(dataDir, 'certificates', `_.${baseDomain}.crt`),
    keyFile: join(dataDir, 'certificates', `_.${baseDomain}.key`),
  }
}

/** Milliseconds until the certificate expires; negative if already expired. */
export async function timeToExpiry(certFile: string, now = Date.now()): Promise<number> {
  const pem = await readFile(certFile)
  const cert = new X509Certificate(pem)
  const validTo = Date.parse(cert.validTo)
  if (Number.isNaN(validTo)) throw new Error(`could not parse notAfter from ${certFile}`)
  return validTo - now
}

export async function describeCert(certFile: string): Promise<{ subject: string; sans: string[]; expiresAt: number }> {
  const cert = new X509Certificate(await readFile(certFile))
  const sans = (cert.subjectAltName ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^DNS:/, ''))
    .filter(Boolean)
  return { subject: cert.subject, sans, expiresAt: Date.parse(cert.validTo) }
}

/** A certificate that does not actually cover *.<baseDomain> will serve every
 *  env with a name mismatch — worth catching at issuance, not in a browser. */
export function coversWildcard(sans: string[], baseDomain: string): boolean {
  return sans.includes(`*.${baseDomain}`)
}

export type Issuer = (r: IssueRequest) => Promise<CertPaths>

/** Drives the real `lego` binary. */
export const legoIssuer: Issuer = async (r) => {
  try {
    await run('lego', legoArgs(r), { timeout: 300_000 })
  } catch (err) {
    const e = err as { stderr?: string; message?: string; code?: string }
    if (e.code === 'ENOENT') throw new Error('lego is not installed (brew install lego)')
    throw new Error(`lego failed: ${(e.stderr || e.message || '').slice(0, 800)}`)
  }
  return certPaths(r.dataDir, r.baseDomain)
}

export interface RenewerOptions extends IssueRequest {
  /** Renew when fewer than this many days remain. */
  renewWithinDays: number
  /** How often to check. Daily is plenty for a 90-day certificate. */
  checkIntervalMs: number
  issuer: Issuer
  /** Called after a successful issue or renew, to push the new files into the
   *  proxy. Without this the certificate on disk is fresh and the one being
   *  served is still the old one. */
  onRenewed?: (paths: CertPaths) => Promise<void>
  onError?: (err: unknown) => void
}

export interface Renewer {
  start(): void
  stop(): void
  /** One check. Returns true if it renewed. Exposed so tests drive it
   *  deterministically instead of waiting a day. */
  checkOnce(now?: number): Promise<boolean>
}

export function createRenewer(o: RenewerOptions): Renewer {
  let timer: NodeJS.Timeout | undefined
  const paths = certPaths(o.dataDir, o.baseDomain)

  async function checkOnce(now = Date.now()): Promise<boolean> {
    let remaining: number
    try {
      remaining = await timeToExpiry(paths.certFile, now)
    } catch {
      // Missing or unreadable: treat as "needs issuing" rather than an error, so
      // first run and recovery-from-deletion take the same path.
      remaining = -1
    }
    if (remaining > o.renewWithinDays * 86_400_000) return false

    const issued = await o.issuer({ ...o, renew: remaining > 0 })
    await o.onRenewed?.(issued)
    return true
  }

  return {
    start() {
      if (timer) return
      const tick = () => void checkOnce().catch((e) => o.onError?.(e))
      timer = setInterval(tick, o.checkIntervalMs)
      timer.unref?.()
      tick()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    checkOnce,
  }
}
