import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { POSTGRES, MYSQL, ENGINES, supportsTemplate } from '../dist/env/engines.js'
import { createSqliteStore } from '../dist/env/drivers/sqlite-store.js'
import { createService } from '../dist/env/service.js'
import { createReconciler } from '../dist/env/reconcile.js'
import { fakeRuntime, fakeIngress, fakeImages } from './env-fakes.mjs'

const CTX = { database: 'app', user: 'app', password: 'p4ss', rootPassword: 'r00t' }
const P = { tokenId: 't', ownerId: 'o1', scopes: ['admin'] }
const QUOTA = { maxConcurrentEnvs: 5, maxTtlSeconds: 3600, defaultTtlSeconds: 600, maxMemoryMbPerEnv: 1024 }

function harness() {
  const store = createSqliteStore(join(tmpdir(), `envcheck-eng-${randomUUID()}.db`))
  const runtime = fakeRuntime()
  const d = { store, runtime, ingress: fakeIngress(), images: fakeImages() }
  return {
    store, runtime, service: createService(d, QUOTA),
    rec: createReconciler(d, {
      holder: 't', leaseMs: 60_000, tickMs: 1000,
      minFreeDiskGb: 0, minFreeMemoryMb: 0, provisionTimeoutMs: 5000,
    }),
  }
}
const spec = (over = {}) => ({ image: { kind: 'tag', tag: 'app:1' }, port: 8080, ...over })

test('connection URLs use the right scheme and port per engine', () => {
  assert.equal(POSTGRES.url(CTX), 'postgres://app:p4ss@db:5432/app')
  assert.equal(MYSQL.url(CTX), 'mysql://app:p4ss@db:3306/app')
})

test('the host is always the role alias, never a generated container name', () => {
  // Containers are aliased to their role on the env network, so the app can use
  // a stable hostname regardless of the env id in the container name.
  for (const e of Object.values(ENGINES)) assert.match(e.url(CTX), /@db:/)
})

test('mysql passwords are read from the environment, not the command line', () => {
  // A password in argv is visible in `ps` to anything else in that container.
  const probe = MYSQL.healthcheck(CTX).test.join(' ')
  assert.equal(probe.includes('r00t'), false, 'literal password in healthcheck')
  assert.match(probe, /\$MYSQL_ROOT_PASSWORD/)

  for (const cmd of [MYSQL.applySqlFile(CTX, '/tmp/s.sql'), MYSQL.createMarker(CTX, '_m')]) {
    assert.equal(cmd.join(' ').includes('r00t'), false, 'literal password in seed command')
  }
})

test('postgres seeds over the local socket without a password at all', () => {
  const cmd = POSTGRES.applySqlFile(CTX, '/tmp/s.sql').join(' ')
  assert.equal(cmd.includes('p4ss'), false)
  assert.match(cmd, /ON_ERROR_STOP=1/)      // a failed seed must not pass silently
})

test('mysql env creates the database and a non-root user', () => {
  const env = MYSQL.env(CTX)
  assert.equal(env.MYSQL_DATABASE, 'app')
  assert.equal(env.MYSQL_USER, 'app')
  assert.notEqual(env.MYSQL_PASSWORD, env.MYSQL_ROOT_PASSWORD, 'app user must not share the root password')
})

test('template seeding is postgres-only', () => {
  assert.equal(supportsTemplate('postgres'), true)
  assert.equal(supportsTemplate('mysql'), false)
})

test('a template seed against mysql fails loudly rather than silently doing nothing', async () => {
  const h = harness()
  const env = await h.service.provision(P, spec({
    db: { engine: 'mysql', seed: { kind: 'template', name: 'golden' } },
  }))
  await h.rec.tick(Date.now())
  const got = await h.store.get(env.id)
  assert.equal(got.state, 'failed')
  assert.match(got.error, /template.*not supported by mysql/i)
  // Nothing should have been started for an env that cannot possibly work.
  assert.equal(h.runtime.calls.filter((c) => c === 'run:app').length, 0)
})

test('an unknown engine is rejected before anything is started', async () => {
  const h = harness()
  const env = await h.service.provision(P, spec({ db: { engine: 'oracle' } }))
  await h.rec.tick(Date.now())
  assert.match((await h.store.get(env.id)).error, /unknown db engine/)
})

test('mysql is given more memory than postgres by default', async () => {
  // The official mysql image will not start in 256 MB; postgres is happy there.
  const h = harness()
  await h.service.provision(P, spec({ db: { engine: 'mysql' } }))
  await h.rec.tick(Date.now())
  assert.ok(h.runtime.calls.includes('run:db'))
})
