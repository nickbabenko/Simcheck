// One specification, run against every Store implementation.
//
// The whole premise of the Store seam is that SQLite and Postgres are
// interchangeable. Two separate test files would drift, and the first sign would
// be a production-only bug. So the tests live here and each backend runs them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const rec = (over = {}) => ({
  id: randomUUID(),
  slug: randomUUID().slice(0, 12),
  ownerId: 'o1',
  spec: { image: { kind: 'tag', tag: 'x' }, port: 80, ownerId: 'o1' },
  state: 'pending',
  createdAt: 1000,
  expiresAt: 9_000_000,
  ...over,
})

/**
 * @param name  backend label, used in test titles
 * @param open  async () => ({ store, cleanup })  — a fresh, empty store
 */
export function conformance(name, open) {
  const withStore = async (fn) => {
    const { store, cleanup } = await open()
    try { await fn(store) } finally { await cleanup() }
  }

  test(`[${name}] round-trips a record without inventing fields`, () => withStore(async (s) => {
    const r = rec()
    await s.create(r)
    const got = await s.get(r.id)
    assert.equal(got.slug, r.slug)
    assert.equal(got.state, 'pending')
    assert.deepEqual(got.spec, r.spec)
    // Absent optionals must stay absent rather than becoming null, or callers
    // that check `if (rec.url)` start seeing a value that is not a URL.
    assert.equal('url' in got, false)
    assert.equal('error' in got, false)
    assert.equal('hostPort' in got, false)
  }))

  test(`[${name}] timestamps come back as numbers, not strings`, () => withStore(async (s) => {
    // Postgres returns BIGINT as a string by default. Left unconverted, every
    // expiry comparison silently becomes a string comparison and TTLs misfire.
    const r = rec({ createdAt: 1_700_000_000_000, expiresAt: 1_700_000_900_000 })
    await s.create(r)
    const got = await s.get(r.id)
    assert.equal(typeof got.createdAt, 'number')
    assert.equal(typeof got.expiresAt, 'number')
    assert.ok(got.expiresAt > got.createdAt)
  }))

  test(`[${name}] get and getBySlug agree, and misses are undefined`, () => withStore(async (s) => {
    const r = rec()
    await s.create(r)
    assert.deepEqual(await s.getBySlug(r.slug), await s.get(r.id))
    assert.equal(await s.get('nope'), undefined)
    assert.equal(await s.getBySlug('nope'), undefined)
  }))

  test(`[${name}] update writes every mapped column`, () => withStore(async (s) => {
    const r = rec()
    await s.create(r)
    await s.update(r.id, {
      state: 'ready', url: 'http://x', hostPort: 40404,
      internalDbUrl: 'postgres://a', internalCacheUrl: 'redis://c', error: 'e', expiresAt: 5000,
    })
    const got = await s.get(r.id)
    assert.equal(got.state, 'ready')
    assert.equal(got.url, 'http://x')
    assert.equal(got.hostPort, 40404)
    assert.equal(got.internalDbUrl, 'postgres://a')
    assert.equal(got.internalCacheUrl, 'redis://c')
    assert.equal(got.error, 'e')
    assert.equal(got.expiresAt, 5000)
  }))

  test(`[${name}] update ignores unknown keys instead of throwing`, () => withStore(async (s) => {
    const r = rec()
    await s.create(r)
    await s.update(r.id, { notAColumn: 1, state: 'ready' })
    assert.equal((await s.get(r.id)).state, 'ready')
  }))

  test(`[${name}] list filters by owner and by state`, () => withStore(async (s) => {
    await s.create(rec({ ownerId: 'a', state: 'ready' }))
    await s.create(rec({ ownerId: 'a', state: 'failed' }))
    await s.create(rec({ ownerId: 'b', state: 'ready' }))
    assert.equal((await s.list()).length, 3)
    assert.equal((await s.list({ ownerId: 'a' })).length, 2)
    assert.equal((await s.list({ states: ['ready'] })).length, 2)
    assert.equal((await s.list({ ownerId: 'a', states: ['ready'] })).length, 1)
  }))

  test(`[${name}] claimWork will not hand one env to two holders`, () => withStore(async (s) => {
    await s.create(rec())
    assert.equal((await s.claimWork('A', 1000, 60_000, 10)).length, 1)
    assert.equal((await s.claimWork('B', 1000, 60_000, 10)).length, 0)
  }))

  test(`[${name}] a holder can re-claim its own lease`, () => withStore(async (s) => {
    // The reconciler releases leases on completion, but a crash in between must
    // not lock the env out of its own replica for a full lease period.
    await s.create(rec())
    assert.equal((await s.claimWork('A', 1000, 60_000, 10)).length, 1)
    assert.equal((await s.claimWork('A', 2000, 60_000, 10)).length, 1)
  }))

  test(`[${name}] an expired lease is reclaimable by anyone`, () => withStore(async (s) => {
    await s.create(rec())
    await s.claimWork('A', 1000, 5_000, 10)
    assert.equal((await s.claimWork('B', 7_000, 60_000, 10)).length, 1)
  }))

  test(`[${name}] claimWork respects its limit and takes the oldest first`, () => withStore(async (s) => {
    for (let i = 0; i < 5; i++) await s.create(rec({ createdAt: 1000 + i }))
    const got = await s.claimWork('A', 9999, 60_000, 2)
    assert.equal(got.length, 2)
    assert.deepEqual(got.map((r) => r.createdAt), [1000, 1001])
  }))

  test(`[${name}] terminal states are never claimed as work`, () => withStore(async (s) => {
    for (const state of ['ready', 'failed', 'destroyed']) await s.create(rec({ state }))
    assert.equal((await s.claimWork('A', 1000, 60_000, 10)).length, 0)
  }))

  test(`[${name}] every in-progress state is claimable`, () => withStore(async (s) => {
    const states = ['pending', 'provisioning', 'seeding', 'expired', 'destroying']
    for (const state of states) await s.create(rec({ state }))
    assert.equal((await s.claimWork('A', 1000, 60_000, 10)).length, states.length)
  }))

  test(`[${name}] a lease can be cleared back to absent`, () => withStore(async (s) => {
    const r = rec()
    await s.create(r)
    await s.claimWork('A', 1000, 60_000, 10)
    await s.update(r.id, { leaseHolder: undefined, leaseExpiresAt: undefined })
    const got = await s.get(r.id)
    assert.equal('leaseHolder' in got, false)
    assert.equal('leaseExpiresAt' in got, false)
  }))

  test(`[${name}] countActive counts teardown but not terminal states`, () => withStore(async (s) => {
    await s.create(rec({ state: 'ready' }))
    await s.create(rec({ state: 'destroying' }))   // resources are still real
    await s.create(rec({ state: 'destroyed' }))
    await s.create(rec({ state: 'failed' }))
    await s.create(rec({ ownerId: 'other', state: 'ready' }))
    assert.equal(await s.countActive('o1'), 2)
    assert.equal(await s.countActive('other'), 1)
    assert.equal(await s.countActive('nobody'), 0)
  }))

  test(`[${name}] concurrent claims never overlap`, () => withStore(async (s) => {
    for (let i = 0; i < 12; i++) await s.create(rec({ createdAt: 1000 + i }))
    // Four replicas going for the same queue at the same instant.
    const batches = await Promise.all(
      ['A', 'B', 'C', 'D'].map((h) => s.claimWork(h, 9999, 60_000, 3)),
    )
    const ids = batches.flat().map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length, 'an env was claimed by more than one holder')
  }))
}
