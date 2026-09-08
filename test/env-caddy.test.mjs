// Integration tests against a live Caddy admin API.
//
// These exist because both bugs in this driver were in Caddy's admin-API
// semantics, not in our logic — the kind of thing no unit test with a mocked
// fetch would ever have caught, because the mock would encode the same wrong
// assumption the code did.
//
// Skipped when no Caddy is running, so `npm test` stays green without one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createCaddyIngress } from '../dist/env/drivers/caddy.js'

const ADMIN = process.env.ENVCHECK_TEST_CADDY ?? 'http://127.0.0.1:2019'

async function reachable() {
  try {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), 1500)
    const r = await fetch(`${ADMIN}/config/`, { signal: c.signal })
    clearTimeout(t)
    return r.ok
  } catch { return false }
}

function selfSigned(dir, org) {
  mkdirSync(dir, { recursive: true })
  const certFile = join(dir, 'c.crt')
  const keyFile = join(dir, 'c.key')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-keyout', keyFile, '-out', certFile,
    '-subj', `/CN=*.t.localhost/O=${org}`,
    '-addext', 'subjectAltName=DNS:*.t.localhost',
  ], { stdio: 'ignore' })
  return { certFile, keyFile }
}

const cleanup = async (name) => { await fetch(`${ADMIN}/config/apps/http/servers/${name}`, { method: 'DELETE' }) }

if (await reachable()) {
  test('attach is idempotent and detach removes only its own route', async (t) => {
    const name = `test${randomUUID().slice(0, 8)}`
    t.after(() => cleanup(name))
    const ing = createCaddyIngress({ adminUrl: ADMIN, baseDomain: 't.localhost', serverName: name, listen: [':9601'] })

    await ing.attach('aaaa', { host: '127.0.0.1', port: 1111 })
    await ing.attach('aaaa', { host: '127.0.0.1', port: 2222 })   // re-attach must replace
    await ing.attach('bbbb', { host: '127.0.0.1', port: 3333 })
    assert.deepEqual((await ing.listSlugs()).sort(), ['aaaa', 'bbbb'])

    await ing.detach('aaaa')
    assert.deepEqual(await ing.listSlugs(), ['bbbb'])
    await ing.detach('nosuch')                                    // must not throw
  })

  test('the catch-all is present and never reported as a slug', async (t) => {
    const name = `test${randomUUID().slice(0, 8)}`
    t.after(() => cleanup(name))
    const ing = createCaddyIngress({ adminUrl: ADMIN, baseDomain: 't.localhost', serverName: name, listen: [':9602'] })
    await ing.attach('cccc', { host: '127.0.0.1', port: 1111 })

    const res = await fetch(`${ADMIN}/config/apps/http/servers/${name}/routes`)
    const routes = await res.json()
    // The env route must come FIRST: the catch-all is terminal and would
    // otherwise swallow every env.
    assert.equal(routes[0]['@id'], 'envcheck-env-cccc')
    assert.equal(routes.at(-1)['@id'], 'envcheck-catchall')
    assert.equal(routes.at(-1).handle[0].status_code, 404)
    assert.deepEqual(await ing.listSlugs(), ['cccc'])
  })

  test('reloadCert works both when tls is absent and when it already exists', async (t) => {
    const name = `test${randomUUID().slice(0, 8)}`
    t.after(() => cleanup(name))
    const dir = mkdtempSync(join(tmpdir(), 'envcheck-caddy-'))
    const first = selfSigned(join(dir, 'a'), 'FIRST')
    const ing = createCaddyIngress({
      adminUrl: ADMIN, baseDomain: 't.localhost', serverName: name, listen: [':9603'], tls: first,
    })

    // First call may create the tls app; a PUT is required on an empty config
    // because POST cannot traverse into a parent that does not exist.
    await ing.reloadCert(first)
    const loaded = async () => (await (await fetch(`${ADMIN}/config/apps/tls/certificates`)).json()).load_files

    assert.equal((await loaded())[0].certificate, first.certFile)

    // Second call must REPLACE, not 409. A PUT here answered
    // "key already exists: tls" and the renewal silently did nothing.
    const second = selfSigned(join(dir, 'b'), 'SECOND')
    await ing.reloadCert(second)
    assert.equal((await loaded())[0].certificate, second.certFile)
    assert.equal((await loaded()).length, 1, 'certificates must be replaced, not accumulated')
  })
} else {
  test('caddy integration (skipped: no admin API at ENVCHECK_TEST_CADDY)', { skip: true }, () => {})
}
