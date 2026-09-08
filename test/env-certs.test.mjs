import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  legoArgs, certPaths, timeToExpiry, describeCert, coversWildcard, createRenewer,
} from '../dist/env/certs.js'

/** A self-signed wildcard, so expiry logic is tested against a real X.509 file
 *  rather than a hand-built stub — and without contacting a CA or touching DNS. */
function makeCert(dir, baseDomain, days) {
  mkdirSync(join(dir, 'certificates'), { recursive: true })
  const { certFile, keyFile } = certPaths(dir, baseDomain)
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(days),
    '-keyout', keyFile, '-out', certFile,
    '-subj', `/CN=*.${baseDomain}`,
    '-addext', `subjectAltName=DNS:*.${baseDomain},DNS:${baseDomain}`,
  ], { stdio: 'ignore' })
  return { certFile, keyFile }
}

const REQ = {
  baseDomain: 'env.example.com', email: 'a@b.c',
  dnsProvider: 'cloudflare', dataDir: '/data',
}

test('lego is asked for the wildcard AND the apex', () => {
  // The wildcard does not cover the apex; omitting it means the dashboard or a
  // health endpoint on the bare domain fails TLS.
  const args = legoArgs(REQ)
  assert.ok(args.includes('*.env.example.com'))
  assert.ok(args.includes('env.example.com'))
  assert.equal(args.at(-1), 'run')
})

test('DNS-01 is always used, because HTTP-01 cannot validate a wildcard', () => {
  assert.deepEqual(legoArgs(REQ).slice(0, 6), ['--accept-tos', '--email', 'a@b.c', '--dns', 'cloudflare', '--path'])
})

test('staging targets the staging directory', () => {
  const args = legoArgs({ ...REQ, staging: true })
  assert.ok(args.includes('https://acme-staging-v02.api.letsencrypt.org/directory'))
  assert.equal(legoArgs(REQ).some((a) => a.includes('staging')), false)
})

test('renew uses the renew subcommand with an explicit window', () => {
  // Without --days, `renew` silently does nothing until nearly expired, which
  // makes failures show up only when they are urgent.
  const args = legoArgs({ ...REQ, renew: true })
  assert.equal(args.at(-2), '--days')
  assert.equal(args.at(-3), 'renew')
})

test('cert paths match how lego names wildcard output', () => {
  const p = certPaths('/data', 'env.example.com')
  assert.equal(p.certFile, '/data/certificates/_.env.example.com.crt')
  assert.equal(p.keyFile, '/data/certificates/_.env.example.com.key')
})

test('expiry is read from the real certificate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcheck-cert-'))
  const { certFile } = makeCert(dir, 'env.example.com', 30)
  const ms = await timeToExpiry(certFile)
  const days = ms / 86_400_000
  assert.ok(days > 28 && days < 31, `expected ~30 days, got ${days.toFixed(1)}`)
  rmSync(dir, { recursive: true, force: true })
})

test('an already-expired certificate reports negative time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcheck-cert-'))
  const { certFile } = makeCert(dir, 'env.example.com', 1)
  const ms = await timeToExpiry(certFile, Date.now() + 5 * 86_400_000)
  assert.ok(ms < 0)
  rmSync(dir, { recursive: true, force: true })
})

test('a certificate that does not cover the wildcard is detectable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcheck-cert-'))
  const { certFile } = makeCert(dir, 'env.example.com', 10)
  const info = await describeCert(certFile)
  assert.ok(coversWildcard(info.sans, 'env.example.com'))
  // The exact failure this guards: a cert for the apex only would serve every
  // env with a name mismatch.
  assert.equal(coversWildcard(['env.example.com'], 'env.example.com'), false)
  rmSync(dir, { recursive: true, force: true })
})

function renewerHarness(dir, opts = {}) {
  const calls = []
  const reloads = []
  const r = createRenewer({
    baseDomain: 'env.example.com', email: 'a@b.c', dnsProvider: 'cloudflare',
    dataDir: dir, renewWithinDays: 30, checkIntervalMs: 86_400_000,
    issuer: async (req) => {
      calls.push(req)
      return makeCert(dir, 'env.example.com', 90)
    },
    onRenewed: async (p) => { reloads.push(p) },
    ...opts,
  })
  return { r, calls, reloads }
}

test('a fresh certificate is left alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcheck-ren-'))
  makeCert(dir, 'env.example.com', 90)
  const h = renewerHarness(dir)
  assert.equal(await h.r.checkOnce(), false)
  assert.equal(h.calls.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('a certificate inside the renewal window is renewed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcheck-ren-'))
  makeCert(dir, 'env.example.com', 10)
  const h = renewerHarness(dir)
  assert.equal(await h.r.checkOnce(), true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].renew, true, 'a live cert should be renewed, not re-issued')
  rmSync(dir, { recursive: true, force: true })
})

test('a missing certificate is issued, not renewed', async () => {
  // First run and recovery-from-deletion must take the same path; `lego renew`
  // against a non-existent cert fails.
  const dir = mkdtempSync(join(tmpdir(), 'envcheck-ren-'))
  const h = renewerHarness(dir)
  assert.equal(await h.r.checkOnce(), true)
  assert.equal(h.calls[0].renew, false)
  rmSync(dir, { recursive: true, force: true })
})

test('renewal pushes the new certificate into the proxy', async () => {
  // Without this the files on disk are fresh and the proxy still serves the
  // expired one — the failure is invisible until every env breaks at once.
  const dir = mkdtempSync(join(tmpdir(), 'envcheck-ren-'))
  makeCert(dir, 'env.example.com', 5)
  const h = renewerHarness(dir)
  await h.r.checkOnce()
  assert.equal(h.reloads.length, 1)
  assert.match(h.reloads[0].certFile, /_\.env\.example\.com\.crt$/)
  rmSync(dir, { recursive: true, force: true })
})

test('an issuer failure surfaces rather than being swallowed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcheck-ren-'))
  const h = renewerHarness(dir, { issuer: async () => { throw new Error('dns provider rejected') } })
  await assert.rejects(() => h.r.checkOnce(), /dns provider rejected/)
  rmSync(dir, { recursive: true, force: true })
})
