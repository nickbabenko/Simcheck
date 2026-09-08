import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSqliteStore } from '../dist/env/drivers/sqlite-store.js'
import { createService } from '../dist/env/service.js'
import { createReconciler } from '../dist/env/reconcile.js'
import { fakeRuntime, fakeIngress, fakeImages } from './env-fakes.mjs'

const QUOTA = { maxConcurrentEnvs: 2, maxTtlSeconds: 3600, defaultTtlSeconds: 600, maxMemoryMbPerEnv: 1024, maxReservations: 5 }
const P = { tokenId: 't', ownerId: 'o1', scopes: ['admin'] }
const spec = (over = {}) => ({ image: { kind: 'tag', tag: 'layout-service:dev' }, port: 8080, ...over })

function harness(quota = QUOTA) {
  const store = createSqliteStore(join(tmpdir(), `envcheck-res-${randomUUID()}.db`))
  const runtime = fakeRuntime()
  const ingress = fakeIngress()
  const d = { store, runtime, ingress, images: fakeImages() }
  return {
    store, runtime, ingress,
    service: createService(d, quota),
    rec: createReconciler(d, {
      holder: 't', leaseMs: 60_000, tickMs: 1000,
      minFreeDiskGb: 0, minFreeMemoryMb: 0, provisionTimeoutMs: 5000,
    }),
  }
}

test('a reservation returns a URL and starts nothing', async () => {
  const h = harness()
  const held = await h.service.reserve(P, spec())
  assert.equal(held.state, 'reserved')
  assert.match(held.url, /^http:\/\/[0-9a-z]{16}\.test:8080$/)
  await h.rec.tick(Date.now())
  assert.deepEqual(await h.runtime.listEnvIds(), [], 'a reservation must start no containers')
  assert.equal(h.ingress.routes.size, 0, 'and publish no route')
})

test('reservations do not consume a concurrency slot', async () => {
  // The whole point. If they counted, a queue of builds waiting on CI would
  // block the machine from running the tests those builds are for.
  const h = harness()
  for (let i = 0; i < 5; i++) await h.service.reserve(P, spec())
  await h.service.provision(P, spec())
  await h.service.provision(P, spec())          // still allowed: limit is 2 live
  await assert.rejects(() => h.service.provision(P, spec()), /concurrent env limit/)
})

test('reservations are capped as a backstop against a runaway loop', async () => {
  const h = harness()
  for (let i = 0; i < 5; i++) await h.service.reserve(P, spec())
  await assert.rejects(() => h.service.reserve(P, spec()), /limit is 5/)
})

test('provisioning a reservation keeps the URL that was handed out', async () => {
  // A build may already have this compiled into it, so it cannot change.
  const h = harness()
  const held = await h.service.reserve(P, spec())
  const started = await h.service.provision(P, spec(), held.id)
  assert.equal(started.id, held.id)
  assert.equal(started.slug, held.slug)
  assert.equal(started.url, held.url)
  assert.equal(started.state, 'pending')

  await h.rec.tick(Date.now())
  const ready = await h.store.get(held.id)
  assert.equal(ready.state, 'ready')
  assert.equal(ready.url, held.url, 'the URL must survive provisioning')
})

test('the runtime TTL starts at provision, not at reservation', async () => {
  // Otherwise a long cloud build eats the window the test needs.
  const h = harness()
  const held = await h.service.reserve(P, spec(), 3600)
  const reservedExpiry = held.expiresAt
  const started = await h.service.provision(P, spec({ ttlSeconds: 600 }), held.id)
  assert.notEqual(started.expiresAt, reservedExpiry)
  assert.ok(started.expiresAt <= Date.now() + 600_000 + 1000)
  assert.equal(started.reservedUntil, undefined, 'reservation clock is cleared')
})

test('the spec supplied at provision replaces the one from reserve', async () => {
  const h = harness()
  const held = await h.service.reserve(P, spec({ port: 8080 }))
  await h.service.provision(P, spec({ port: 9999, cache: { engine: 'redis' } }), held.id)
  const got = await h.store.get(held.id)
  assert.equal(got.spec.port, 9999, 'spec must actually be persisted')
  assert.ok(got.spec.cache, 'and the whole spec replaced, not merged piecemeal')
})

test('an unprovisioned reservation is given up when its clock runs out', async () => {
  const h = harness()
  const held = await h.service.reserve(P, spec(), 60)
  await h.rec.tick(Date.now())
  assert.equal((await h.store.get(held.id)).state, 'reserved')

  await h.rec.tick(Date.now() + 61_000)
  await h.rec.tick(Date.now() + 61_000)
  assert.equal((await h.store.get(held.id)).state, 'destroyed')
})

test('a reservation is never claimed as reconciler work', async () => {
  // There is nothing to converge; claiming it would just churn a lease.
  const h = harness()
  await h.service.reserve(P, spec())
  assert.deepEqual(await h.store.claimWork('A', Date.now(), 60_000, 10), [])
})

test('provisioning something that is not a reservation is refused', async () => {
  const h = harness()
  const env = await h.service.provision(P, spec())
  await h.rec.tick(Date.now())
  await assert.rejects(() => h.service.provision(P, spec(), env.id), /is ready, not a reservation/)
})

test('one tenant cannot materialise another tenant reservation', async () => {
  const h = harness()
  const alice = { tokenId: 'a', ownerId: 'alice', scopes: ['env:read', 'env:write'] }
  const bob = { tokenId: 'b', ownerId: 'bob', scopes: ['env:read', 'env:write'] }
  const held = await h.service.reserve(alice, spec())
  await assert.rejects(() => h.service.provision(bob, spec(), held.id), /no such env/)
})
