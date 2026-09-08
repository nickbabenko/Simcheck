import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSqliteStore } from '../dist/env/drivers/sqlite-store.js'
import { createReconciler } from '../dist/env/reconcile.js'
import { createService } from '../dist/env/service.js'
import { fakeRuntime, fakeIngress, fakeImages } from './env-fakes.mjs'

const P = { tokenId: 't', ownerId: 'o1', scopes: ['admin'] }

const QUOTA = { maxConcurrentEnvs: 2, maxTtlSeconds: 3600, defaultTtlSeconds: 600, maxMemoryMbPerEnv: 1024, maxReservations: 20 }
const OPTS = {
  holder: 'test', leaseMs: 60_000, tickMs: 1000,
  minFreeDiskGb: 1, minFreeMemoryMb: 128, provisionTimeoutMs: 5000,
}

function harness(runtimeOpts) {
  const store = createSqliteStore(join(tmpdir(), `envcheck-rec-${randomUUID()}.db`))
  const runtime = fakeRuntime(runtimeOpts)
  const ingress = fakeIngress()
  const d = { store, runtime, ingress, images: fakeImages() }
  return { d, store, runtime, ingress, service: createService(d, QUOTA), rec: createReconciler(d, OPTS) }
}

const spec = (over = {}) => ({ image: { kind: 'tag', tag: 'app:1' }, port: 8080, ...over })

test('provisions to ready and attaches a route', async () => {
  const h = harness()
  const env = await h.service.provision(P, spec())
  await h.rec.tick(Date.now())
  const got = await h.store.get(env.id)
  assert.equal(got.state, 'ready')
  assert.ok(got.url)
  assert.deepEqual([...h.ingress.routes.keys()], [env.id ? got.slug : null])
})

test('the database is started and seeded before the app', async () => {
  // The ordering is the whole reason `seeding` is a distinct state: an app that
  // starts first races its migrations against an empty schema.
  const h = harness()
  await h.service.provision(P, spec({ db: { engine: 'postgres', seed: { kind: 'sql', sql: 'SELECT 1' } } }))
  await h.rec.tick(Date.now())
  const order = h.runtime.calls.filter((c) => c.startsWith('run:'))
  assert.deepEqual(order, ['run:db', 'run:app'])
})

test('expiry tears down containers and the route', async () => {
  const h = harness()
  const env = await h.service.provision(P, spec({ ttlSeconds: 1 }))
  await h.rec.tick(Date.now())
  assert.equal((await h.store.get(env.id)).state, 'ready')

  await h.rec.tick(Date.now() + 5000)          // past the deadline
  const got = await h.store.get(env.id)
  assert.equal(got.state, 'destroyed')
  assert.equal(h.ingress.routes.size, 0)
  assert.deepEqual(await h.runtime.listEnvIds(), [])
})

test('a failed provision records a readable error rather than retrying forever', async () => {
  const h = harness({ failRole: 'app' })
  const env = await h.service.provision(P, spec())
  await h.rec.tick(Date.now())
  const got = await h.store.get(env.id)
  assert.equal(got.state, 'failed')
  assert.match(got.error, /boom: app/)
})

test('containers the store does not know about are collected', async () => {
  const h = harness()
  h.runtime.injectOrphan('ghost-env')
  await h.rec.tick(Date.now())
  assert.deepEqual(await h.runtime.listEnvIds(), [], 'orphan should be destroyed')
})

test('a route lost to a proxy restart is restored, not just cleaned up', async () => {
  const h = harness()
  const env = await h.service.provision(P, spec())
  await h.rec.tick(Date.now())
  const slug = (await h.store.get(env.id)).slug

  h.ingress.routes.clear()                      // proxy restarted, config empty
  await h.rec.tick(Date.now())
  assert.deepEqual([...h.ingress.routes.keys()], [slug], 'ready env must be re-attached')
})

test('provisioning is refused below the disk floor', async () => {
  const h = harness()
  h.runtime.setCapacity({ freeDiskGb: 0.5 })
  const env = await h.service.provision(P, spec())
  await h.rec.tick(Date.now())
  const got = await h.store.get(env.id)
  assert.equal(got.state, 'failed')
  assert.match(got.error, /refusing to provision/)
})

test('the quota refuses a third concurrent env', async () => {
  const h = harness()
  await h.service.provision(P, spec())
  await h.service.provision(P, spec())
  await assert.rejects(() => h.service.provision(P, spec()), /concurrent env limit/)
})

test('ttl is capped at the configured maximum', async () => {
  const h = harness()
  const env = await h.service.provision(P, spec({ ttlSeconds: 999_999 }))
  assert.equal(env.spec.ttlSeconds, QUOTA.maxTtlSeconds)
})

test('a ready env whose containers vanished is failed, not left advertising a dead URL', async () => {
  // The reboot case: the container runtime restarts and takes every container
  // with it. Without this the env sits in `ready` until its TTL, and the only
  // symptom a caller sees is connection refused.
  const h = harness()
  const env = await h.service.provision(P, spec())
  await h.rec.tick(Date.now())
  assert.equal((await h.store.get(env.id)).state, 'ready')

  await h.runtime.destroy(env.id)          // as a runtime restart would
  await h.rec.tick(Date.now())

  const got = await h.store.get(env.id)
  assert.equal(got.state, 'failed')
  assert.match(got.error, /no longer running/)
})

test('a vanished env does not get its route restored', async () => {
  // Re-attaching from the pre-update list is how a dead URL stays published.
  const h = harness()
  const env = await h.service.provision(P, spec())
  await h.rec.tick(Date.now())
  const slug = (await h.store.get(env.id)).slug

  await h.runtime.destroy(env.id)
  h.ingress.routes.clear()                 // proxy restarted too
  await h.rec.tick(Date.now())

  assert.equal(h.ingress.routes.has(slug), false, 'must not republish a dead environment')
})

test('an unreachable runtime does not mark working envs failed', async () => {
  // "The containers are gone" and "I cannot ask" look identical from here.
  // Marking envs failed on a transient socket blip would destroy working ones.
  const h = harness()
  const env = await h.service.provision(P, spec())
  await h.rec.tick(Date.now())
  assert.equal((await h.store.get(env.id)).state, 'ready')

  h.runtime.setUnreachable(true)
  await h.rec.tick(Date.now())
  assert.equal((await h.store.get(env.id)).state, 'ready', 'must not fail an env it cannot see')

  h.runtime.setUnreachable(false)
  await h.rec.tick(Date.now())
  assert.equal((await h.store.get(env.id)).state, 'ready', 'and must not fail it once back either')
})

test('expiry still runs while the runtime is unreachable', async () => {
  // Expiry is bookkeeping; wedging it behind a runtime outage means nothing
  // ages out until the runtime returns.
  const h = harness()
  const env = await h.service.provision(P, spec({ ttlSeconds: 1 }))
  await h.rec.tick(Date.now())
  h.runtime.setUnreachable(true)
  await h.rec.tick(Date.now() + 5000)
  assert.notEqual((await h.store.get(env.id)).state, 'ready', 'expiry must not be blocked by the runtime')
})

test('a runtime outage is announced once, not once per tick', async () => {
  // A two-second error loop buries the log it is written into.
  const notices = []
  const store = createSqliteStore(join(tmpdir(), `envcheck-rec-${randomUUID()}.db`))
  const runtime = fakeRuntime()
  const d = { store, runtime, ingress: fakeIngress(), images: fakeImages() }
  const rec = createReconciler(d, { ...OPTS, onNotice: (m) => notices.push(m) })

  runtime.setUnreachable(true)
  for (let i = 0; i < 5; i++) await rec.tick(Date.now())
  assert.equal(notices.length, 1, `expected one notice, got ${notices.length}`)
  assert.match(notices[0], /unreachable/)

  runtime.setUnreachable(false)
  for (let i = 0; i < 3; i++) await rec.tick(Date.now())
  assert.equal(notices.length, 2)
  assert.match(notices[1], /reachable again/)
})

test('a ready env whose containers are merely STOPPED is failed too', async () => {
  // The actual reboot case. Restarting the container host leaves every
  // container present but dead, so a presence check would call this healthy and
  // keep publishing a URL that refuses connections.
  const h = harness()
  const env = await h.service.provision(P, spec())
  await h.rec.tick(Date.now())
  const slug = (await h.store.get(env.id)).slug
  assert.equal((await h.store.get(env.id)).state, 'ready')

  h.runtime.stopAll()                       // containers still exist, not running
  await h.rec.tick(Date.now())

  const got = await h.store.get(env.id)
  assert.equal(got.state, 'failed')
  assert.match(got.error, /no longer running/)
  assert.equal(h.ingress.routes.has(slug), false, 'its route must be withdrawn')
})
