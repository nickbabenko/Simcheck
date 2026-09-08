import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSqliteStore } from '../dist/env/drivers/sqlite-store.js'
import { createService } from '../dist/env/service.js'
import { createReconciler } from '../dist/env/reconcile.js'
import { fakeRuntime, fakeIngress, fakeImages } from './env-fakes.mjs'

const QUOTA = { maxConcurrentEnvs: 20, maxTtlSeconds: 3600, defaultTtlSeconds: 600, maxMemoryMbPerEnv: 1024, maxReservations: 20 }
const P = { tokenId: 't', ownerId: 'o1', scopes: ['admin'] }
const spec = () => ({ image: { kind: 'tag', tag: 'app:1' }, port: 8080 })

const OPTS = (holder) => ({
  holder, leaseMs: 60_000, tickMs: 1000,
  minFreeDiskGb: 0, minFreeMemoryMb: 0, provisionTimeoutMs: 5000,
})

/**
 * Two reconcilers, two independent SQLite connections to one database file, one
 * shared runtime standing in for the container host. This is the arrangement two
 * daemon replicas would actually be in — the lease is the only thing stopping
 * them both provisioning the same env.
 */
function twoReplicas() {
  const path = join(tmpdir(), `envcheck-replicas-${randomUUID()}.db`)
  const runtime = fakeRuntime()
  const ingress = fakeIngress()
  const mk = (holder) => {
    const store = createSqliteStore(path)
    const d = { store, runtime, ingress, images: fakeImages() }
    return { store, d, rec: createReconciler(d, OPTS(holder)) }
  }
  const a = mk('replica-A')
  const b = mk('replica-B')
  return { a, b, runtime, ingress, service: createService(a.d, QUOTA) }
}

test('two replicas provision each env exactly once', async () => {
  const h = twoReplicas()
  const envs = []
  for (let i = 0; i < 6; i++) envs.push(await h.service.provision(P, spec()))

  const now = Date.now()
  // Deliberately concurrent: this is the race the lease exists to prevent.
  await Promise.all([h.a.rec.tick(now), h.b.rec.tick(now)])

  for (const e of envs) {
    assert.equal((await h.a.store.get(e.id)).state, 'ready', `${e.id} not ready`)
  }
  // One app container per env, not two.
  const appRuns = h.runtime.calls.filter((c) => c === 'run:app').length
  assert.equal(appRuns, envs.length, `expected ${envs.length} app containers, got ${appRuns}`)
})

test('work is shared between replicas rather than one taking everything', async () => {
  const h = twoReplicas()
  for (let i = 0; i < 8; i++) await h.service.provision(P, spec())

  const now = Date.now()
  const [aTouched, bTouched] = await Promise.all([h.a.rec.tick(now), h.b.rec.tick(now)])
  // Each tick claims at most 4, so 8 envs cannot be handled by one replica.
  assert.ok(aTouched.length > 0 && bTouched.length > 0, 'both replicas should get work')
  const overlap = aTouched.filter((id) => bTouched.includes(id))
  assert.deepEqual(overlap, [], 'no env may be claimed by both replicas')
})

test('a replica that dies mid-provision does not strand the env', async () => {
  const h = twoReplicas()
  const env = await h.service.provision(P, spec())

  // A claims the work and then vanishes without releasing the lease.
  const claimed = await h.a.store.claimWork('replica-A', Date.now(), 60_000, 4)
  assert.equal(claimed.length, 1)

  // B cannot touch it while the lease is live — that is the point.
  await h.b.rec.tick(Date.now())
  assert.equal((await h.b.store.get(env.id)).state, 'pending')

  // Once the lease expires, B picks it up and finishes the job.
  await h.b.rec.tick(Date.now() + 61_000)
  assert.equal((await h.b.store.get(env.id)).state, 'ready')
})

test('concurrent teardown does not double-destroy', async () => {
  const h = twoReplicas()
  const env = await h.service.provision(P, spec())
  await h.a.rec.tick(Date.now())

  const later = Date.now() + 700_000            // past the TTL
  await Promise.all([h.a.rec.tick(later), h.b.rec.tick(later)])

  assert.equal((await h.a.store.get(env.id)).state, 'destroyed')
  const destroys = h.runtime.calls.filter((c) => c.startsWith('destroy:')).length
  assert.equal(destroys, 1, `expected one destroy, got ${destroys}`)
})
