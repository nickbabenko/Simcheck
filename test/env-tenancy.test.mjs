// Tenancy and scope, at the service level.
//
// Ported from the standalone project's auth suite, rebuilt on simcheck's
// capability model: the token store is simcheck's now, and the only thing left
// to prove here is that a capability maps to the right scope and that one
// token's environments are invisible to another's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSqliteStore } from '../dist/env/drivers/sqlite-store.js'
import { createService } from '../dist/env/service.js'
import { createReconciler } from '../dist/env/reconcile.js'
import { toPrincipal, requireScope, assertOwns } from '../dist/env/principal.js'
import { fakeRuntime, fakeIngress, fakeImages } from './env-fakes.mjs'

const QUOTA = { maxConcurrentEnvs: 5, maxTtlSeconds: 3600, defaultTtlSeconds: 600, maxMemoryMbPerEnv: 1024 }
const spec = (over = {}) => ({ image: { kind: 'tag', tag: 'app:1' }, port: 8080, ...over })

const identity = (name, capabilities) => ({
  id: `tok_${name}`, name, capabilities, maxConcurrentRuns: 1, maxRunsPerHour: 10,
})

function harness() {
  const store = createSqliteStore(join(tmpdir(), `simcheck-env-${randomUUID()}.db`))
  const d = { store, runtime: fakeRuntime(), ingress: fakeIngress(), images: fakeImages() }
  return {
    store,
    service: createService(d, QUOTA),
    rec: createReconciler(d, {
      holder: 't', leaseMs: 60_000, tickMs: 1000,
      minFreeDiskGb: 0, minFreeMemoryMb: 0, provisionTimeoutMs: 5000,
    }),
  }
}

test('capabilities map to scopes', () => {
  assert.deepEqual(toPrincipal(identity('a', ['envs:read'])).scopes, ['env:read'])
  assert.deepEqual(toPrincipal(identity('a', ['envs:read', 'envs:write', 'envs:exec'])).scopes,
    ['env:read', 'env:write', 'env:exec'])
  // Unrelated simcheck capabilities grant nothing here.
  assert.deepEqual(toPrincipal(identity('a', ['runs:read', 'pool:write'])).scopes, [])
})

test('tenancy is keyed on token name, so rotating a token keeps its envs', () => {
  // A new token issued to the same name must still see them; that is what
  // someone rotating a credential expects.
  const before = toPrincipal(identity('ci', ['envs:read']))
  const after = toPrincipal({ ...identity('ci', ['envs:read']), id: 'tok_rotated' })
  assert.equal(before.ownerId, after.ownerId)
  assert.notEqual(before.tokenId, after.tokenId)
})

test('a read-only token cannot provision', async () => {
  const h = harness()
  const reader = toPrincipal(identity('reader', ['envs:read']))
  await assert.rejects(() => h.service.provision(reader, spec()), /lacks required scope 'env:write'/)
})

test('exec needs its own capability, not just write', async () => {
  const h = harness()
  const writer = toPrincipal(identity('writer', ['envs:read', 'envs:write']))
  const env = await h.service.provision(writer, spec())
  await h.rec.tick(Date.now())
  await assert.rejects(() => h.service.exec(writer, env.id, ['ls']), /lacks required scope 'env:exec'/)
})

test('one token cannot see or destroy another token env', async () => {
  const h = harness()
  const alice = toPrincipal(identity('alice', ['envs:read', 'envs:write']))
  const bob = toPrincipal(identity('bob', ['envs:read', 'envs:write']))
  const env = await h.service.provision(alice, spec())

  await assert.rejects(() => h.service.get(bob, env.id), /no such env/)
  await assert.rejects(() => h.service.destroy(bob, env.id), /no such env/)
  await assert.rejects(() => h.service.logs(bob, env.id), /no such env/)
})

test('a cross-tenant miss is byte-identical to a genuine miss', async () => {
  // Any difference lets a caller probe which ids exist.
  const h = harness()
  const alice = toPrincipal(identity('alice', ['envs:read', 'envs:write']))
  const bob = toPrincipal(identity('bob', ['envs:read']))
  const env = await h.service.provision(alice, spec())
  const theirs = await h.service.get(bob, env.id).catch((e) => e.message)
  const nothing = await h.service.get(bob, 'no-such-id').catch((e) => e.message)
  assert.equal(theirs, nothing)
})

test('ownerId comes from the token, never the request body', async () => {
  const h = harness()
  const bob = toPrincipal(identity('bob', ['envs:write']))
  const env = await h.service.provision(bob, { ...spec(), ownerId: 'alice' })
  assert.equal(env.ownerId, 'bob')
})

test('quota is per tenant, not global', async () => {
  const store = createSqliteStore(join(tmpdir(), `simcheck-env-${randomUUID()}.db`))
  const d = { store, runtime: fakeRuntime(), ingress: fakeIngress(), images: fakeImages() }
  const svc = createService(d, { ...QUOTA, maxConcurrentEnvs: 1 })
  const alice = toPrincipal(identity('alice', ['envs:write']))
  const bob = toPrincipal(identity('bob', ['envs:write']))
  await svc.provision(alice, spec())
  await assert.rejects(() => svc.provision(alice, spec()), /concurrent env limit/)
  await svc.provision(bob, spec())
})

test('list is scoped to the tenant', async () => {
  const h = harness()
  const alice = toPrincipal(identity('alice', ['envs:read', 'envs:write']))
  const bob = toPrincipal(identity('bob', ['envs:read', 'envs:write']))
  await h.service.provision(alice, spec())
  await h.service.provision(bob, spec())
  assert.equal((await h.service.list(alice)).length, 1)
  assert.equal((await h.service.list(bob)).length, 1)
})

test('assertOwns and requireScope let admin through', () => {
  const admin = { tokenId: 'x', ownerId: 'root', scopes: ['admin'] }
  assertOwns(admin, 'someone-else')
  requireScope(admin, 'env:exec')
})
