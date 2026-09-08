import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planRepository } from '../dist/env/registry-gc.js'

const t = (tag, digest, createdAt) => ({ tag, digest, ...(createdAt === undefined ? {} : { createdAt }) })

test('keeps the newest N and drops the rest', () => {
  const plan = planRepository('app', [
    t('v1', 'sha256:a', 1000), t('v2', 'sha256:b', 2000),
    t('v3', 'sha256:c', 3000), t('v4', 'sha256:d', 4000),
  ], 2)
  assert.deepEqual(plan.keep.map((k) => k.tag), ['v4', 'v3'])
  assert.deepEqual(plan.deleteDigests.sort(), ['sha256:a', 'sha256:b'])
})

test('never deletes a digest that a kept tag also points at', () => {
  // Deletion is by digest, so removing this would take the kept tag with it —
  // the single most damaging way to get registry GC wrong.
  const plan = planRepository('app', [
    t('latest', 'sha256:same', 5000),
    t('v9', 'sha256:same', 4999),
    t('old', 'sha256:old', 1000),
  ], 1)
  assert.deepEqual(plan.keep.map((k) => k.tag), ['latest'])
  assert.deepEqual(plan.deleteDigests, ['sha256:old'])
  assert.deepEqual(plan.retainedBySharedDigest, ['v9'])
})

test('a digest appearing twice among dropped tags is deleted once', () => {
  const plan = planRepository('app', [
    t('keep', 'sha256:k', 9000),
    t('a', 'sha256:dup', 2000), t('b', 'sha256:dup', 1000),
  ], 1)
  assert.deepEqual(plan.deleteDigests, ['sha256:dup'])
})

test('tags with unknown creation time are kept, not guessed at', () => {
  // An operation with no undo should not delete what it cannot reason about.
  const plan = planRepository('app', [
    t('mystery', 'sha256:m'), t('old', 'sha256:o', 1000), t('new', 'sha256:n', 5000),
  ], 1)
  assert.deepEqual(plan.keep.map((k) => k.tag), ['mystery'])
  assert.equal(plan.deleteDigests.includes('sha256:m'), false)
})

test('a repo within the limit loses nothing', () => {
  const plan = planRepository('app', [t('a', 'sha256:a', 1), t('b', 'sha256:b', 2)], 5)
  assert.equal(plan.keep.length, 2)
  assert.deepEqual(plan.deleteDigests, [])
})

test('an empty repo is handled without error', () => {
  const plan = planRepository('app', [], 3)
  assert.deepEqual(plan.keep, [])
  assert.deepEqual(plan.deleteDigests, [])
})

test('keep=0 still respects shared digests', () => {
  const plan = planRepository('app', [t('a', 'sha256:x', 1)], 0)
  assert.deepEqual(plan.deleteDigests, ['sha256:x'])
})
