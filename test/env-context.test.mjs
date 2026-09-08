import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packContext, dockerignoreToExcludes } from '../dist/env/context.js'

function ctx(files) {
  const dir = mkdtempSync(join(tmpdir(), 'envcheck-ctx-'))
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

const entries = (tar) => {
  const p = join(mkdtempSync(join(tmpdir(), 'envcheck-out-')), 'c.tar')
  writeFileSync(p, tar)
  return execFileSync('tar', ['-tf', p], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.replace(/^\.\//, ''))
    .filter((l) => l && !l.endsWith('/'))
}

test('packs a directory into a tar the system tar can read', async () => {
  const { tar } = await packContext(ctx({ Dockerfile: 'FROM scratch\n', 'src/a.txt': 'a' }))
  assert.deepEqual(entries(tar).sort(), ['Dockerfile', 'src/a.txt'])
})

test('.dockerignore entries are excluded', async () => {
  const dir = ctx({
    Dockerfile: 'FROM scratch\n',
    'keep.txt': 'k',
    'node_modules/big.js': 'x',
    '.dockerignore': 'node_modules\n',
  })
  const { tar, excluded } = await packContext(dir)
  assert.deepEqual(excluded, ['node_modules'])
  assert.equal(entries(tar).some((e) => e.startsWith('node_modules')), false)
  assert.ok(entries(tar).includes('keep.txt'))
})

test('comments and blank lines in .dockerignore are ignored', async () => {
  const dir = ctx({ Dockerfile: 'x', '.dockerignore': '# a comment\n\n  \nlogs\n' })
  assert.deepEqual(await dockerignoreToExcludes(dir), ['logs'])
})

test('a .dockerignore using negation sends the full context and says so', async () => {
  // Honouring the exclusions but dropping the re-inclusions would silently omit
  // files Docker would have kept — a build failing for invisible reasons.
  const dir = ctx({
    Dockerfile: 'x',
    'node_modules/keep.js': 'k',
    '.dockerignore': 'node_modules\n!node_modules/keep.js\n',
  })
  assert.equal(await dockerignoreToExcludes(dir), undefined)
  const { tar, warning } = await packContext(dir)
  assert.match(warning, /negation/)
  assert.ok(entries(tar).includes('node_modules/keep.js'), 'must not drop a re-included file')
})

test('a missing .dockerignore is not an error', async () => {
  assert.deepEqual(await dockerignoreToExcludes(ctx({ Dockerfile: 'x' })), [])
})

test('a context that is not a directory is refused clearly', async () => {
  const dir = ctx({ Dockerfile: 'x' })
  await assert.rejects(() => packContext(join(dir, 'Dockerfile')), /not a directory/)
  await assert.rejects(() => packContext(join(dir, 'nope')), /not a directory/)
})
