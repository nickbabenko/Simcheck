import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSqliteStore } from '../dist/env/drivers/sqlite-store.js'
import { createService } from '../dist/env/service.js'
import { createReconciler } from '../dist/env/reconcile.js'
import { normaliseServices, serviceSlug, allSlugs, internalEnv } from '../dist/env/services.js'
import { fakeRuntime, fakeIngress, fakeImages } from './env-fakes.mjs'

const QUOTA = { maxConcurrentEnvs: 4, maxTtlSeconds: 3600, defaultTtlSeconds: 600, maxMemoryMbPerEnv: 1024, maxReservations: 20 }
const P = { tokenId: 't', ownerId: 'o1', scopes: ['admin'] }
const img = (t) => ({ kind: 'tag', tag: t })

const STACK = {
  services: {
    layout: { image: img('layout-service:dev'), port: 8080, primary: true },
    admin: { image: img('admin-api:dev'), port: 3000 },
  },
  db: { engine: 'postgres' },
  cache: { engine: 'redis' },
}

function harness() {
  const store = createSqliteStore(join(tmpdir(), `envcheck-svc-${randomUUID()}.db`))
  const runtime = fakeRuntime()
  const ingress = fakeIngress()
  const d = { store, runtime, ingress, images: fakeImages() }
  return {
    store, runtime, ingress,
    service: createService(d, QUOTA),
    rec: createReconciler(d, {
      holder: 't', leaseMs: 60_000, tickMs: 1000,
      minFreeDiskGb: 0, minFreeMemoryMb: 0, provisionTimeoutMs: 5000,
    }),
  }
}

test('the single-image shorthand becomes one service called app', () => {
  const svcs = normaliseServices({ image: img('x'), port: 80, ownerId: 'o' })
  assert.deepEqual(svcs.map((s) => [s.name, s.primary]), [['app', true]])
})

test('secondary services get <slug>-<name>, never <name>.<slug>', () => {
  // A wildcard certificate covers exactly one label: *.env.example.com matches
  // abc-admin.env.example.com but NOT admin.abc.env.example.com. The nested
  // form works over plain http and fails TLS on a real device.
  const svcs = normaliseServices({ ...STACK, ownerId: 'o' })
  const layout = svcs.find((s) => s.name === 'layout')
  const admin = svcs.find((s) => s.name === 'admin')
  assert.equal(serviceSlug('abc123', layout), 'abc123')
  assert.equal(serviceSlug('abc123', admin), 'abc123-admin')
  for (const s of allSlugs('abc123', { ...STACK, ownerId: 'o' })) {
    assert.equal(s.split('.').length, 1, `${s} must be a single hostname label`)
  }
})

test('an ambiguous primary is refused rather than guessed', () => {
  // Guessing would silently move the bare hostname between deploys, and that is
  // the one address most likely to be written down somewhere.
  const two = { services: { a: { image: img('x'), port: 1 }, b: { image: img('y'), port: 2 } }, ownerId: 'o' }
  assert.throws(() => normaliseServices(two), /exactly one service must be marked primary/)
  const both = { services: { a: { image: img('x'), port: 1, primary: true }, b: { image: img('y'), port: 2, primary: true } }, ownerId: 'o' }
  assert.throws(() => normaliseServices(both), /exactly one service must be marked primary/)
})

test('service names must be usable in a hostname', () => {
  const bad = { services: { 'Admin API': { image: img('x'), port: 1, primary: true } }, ownerId: 'o' }
  assert.throws(() => normaliseServices(bad), /not usable in a hostname/)
})

test('an empty spec is refused', () => {
  assert.throws(() => normaliseServices({ ownerId: 'o' }), /needs either image\+port or a services map/)
})

test('services are told how to reach each other internally', () => {
  const env = internalEnv(normaliseServices({ ...STACK, ownerId: 'o' }))
  assert.equal(env.SERVICE_LAYOUT_URL, 'http://layout:8080')
  assert.equal(env.SERVICE_ADMIN_URL, 'http://admin:3000')
})

test('a stack provisions every service and returns a URL for each', async () => {
  const h = harness()
  const env = await h.service.provision(P, STACK)
  await h.rec.tick(Date.now())
  const got = await h.store.get(env.id)

  assert.equal(got.state, 'ready')
  assert.deepEqual(Object.keys(got.urls).sort(), ['admin', 'layout'])
  assert.equal(got.url, got.urls.layout, 'the bare URL is the primary')
  assert.match(got.urls.admin, /-admin\./)
  assert.deepEqual(h.runtime.calls.filter((c) => c.startsWith('run:')), ['run:db', 'run:cache', 'run:layout', 'run:admin'])
  assert.equal(h.ingress.routes.size, 2, 'both services routed')
})

test('reserving a stack hands out every URL before anything runs', async () => {
  // The reason this exists: the build needs layoutServiceUrl AND adminApiUrl
  // compiled in, minutes before either container starts.
  const h = harness()
  const held = await h.service.reserve(P, STACK)
  assert.equal(held.state, 'reserved')
  assert.deepEqual(Object.keys(held.urls).sort(), ['admin', 'layout'])
  assert.deepEqual(await h.runtime.listEnvIds(), [])
  assert.equal(h.ingress.routes.size, 0)

  await h.service.provision(P, STACK, held.id)
  await h.rec.tick(Date.now())
  const ready = await h.store.get(held.id)
  assert.deepEqual(ready.urls, held.urls, 'every URL must survive provisioning')
})

test('destroying a stack withdraws every hostname, not just the primary', async () => {
  const h = harness()
  const env = await h.service.provision(P, STACK)
  await h.rec.tick(Date.now())
  assert.equal(h.ingress.routes.size, 2)

  await h.service.destroy(P, env.id)
  await h.rec.tick(Date.now())
  assert.equal(h.ingress.routes.size, 0, 'a secondary hostname must not outlive its container')
})

test('a proxy restart restores every service route', async () => {
  const h = harness()
  const env = await h.service.provision(P, STACK)
  await h.rec.tick(Date.now())
  const before = new Set(h.ingress.routes.keys())

  h.ingress.routes.clear()
  await h.rec.tick(Date.now())
  assert.deepEqual(new Set(h.ingress.routes.keys()), before)
})

test('a malformed stack fails before anything is created', async () => {
  const h = harness()
  const bad = { services: { a: { image: img('x'), port: 1 }, b: { image: img('y'), port: 2 } } }
  await assert.rejects(() => h.service.provision(P, bad), /exactly one service/)
  await assert.rejects(() => h.service.reserve(P, bad), /exactly one service/)
  assert.deepEqual(await h.store.list(), [], 'nothing should have been recorded')
})
