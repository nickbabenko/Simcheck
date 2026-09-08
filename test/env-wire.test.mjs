import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { demux, tarFile } from '../dist/env/drivers/docker-http.js'
import { newSlug } from '../dist/env/slug.js'

function frame(type, text) {
  const body = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(8)
  head[0] = type
  head.writeUInt32BE(body.length, 4)
  return Buffer.concat([head, body])
}

test('demux separates stdout from stderr', () => {
  const buf = Buffer.concat([frame(1, 'out1'), frame(2, 'err1'), frame(1, 'out2')])
  assert.deepEqual(demux(buf), { stdout: 'out1out2', stderr: 'err1' })
})

test('demux does not leak frame headers into the output', () => {
  // The failure this guards: without demuxing, the 8-byte headers survive as
  // control characters inside the text and quietly corrupt any parsing of it.
  const { stdout } = demux(frame(1, 'clean'))
  assert.equal(stdout, 'clean')
  const hasControl = [...stdout].some((c) => c.codePointAt(0) < 0x20)
  assert.equal(hasControl, false)
})

test('demux stops on a truncated frame instead of spinning', () => {
  const head = Buffer.alloc(8)
  head[0] = 1
  head.writeUInt32BE(9999, 4)                    // claims far more than follows
  const { stdout } = demux(Buffer.concat([head, Buffer.from('short')]))
  assert.equal(stdout, 'short')
})

test('tarFile produces an archive GNU tar accepts', () => {
  // Hand-rolled ustar headers fail in ways that stay invisible until a real tar
  // reads them, so assert against the system tar rather than our own parser.
  const dir = mkdtempSync(join(tmpdir(), 'envcheck-tar-'))
  const path = join(dir, 'a.tar')
  writeFileSync(path, tarFile('seed.sql', Buffer.from('SELECT 1;\n')))
  const listing = execFileSync('tar', ['-tf', path], { encoding: 'utf8' }).trim()
  assert.equal(listing, 'seed.sql')
  const body = execFileSync('tar', ['-xOf', path, 'seed.sql'], { encoding: 'utf8' })
  assert.equal(body, 'SELECT 1;\n')
})

test('tarFile handles content that is an exact block multiple', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envcheck-tar2-'))
  const path = join(dir, 'b.tar')
  const content = Buffer.alloc(1024, 0x41)       // exactly two 512-byte blocks
  writeFileSync(path, tarFile('big.sql', content))
  const out = execFileSync('tar', ['-xOf', path, 'big.sql'])
  assert.equal(out.length, 1024)
})

test('slugs are 16 chars from the expected alphabet', () => {
  const s = newSlug()
  assert.equal(s.length, 16)
  assert.match(s, /^[0-9abcdefghjkmnpqrstvwxyz]{16}$/)
})

test('slugs do not collide across a large sample', () => {
  const seen = new Set()
  for (let i = 0; i < 20000; i++) seen.add(newSlug())
  assert.equal(seen.size, 20000)
})

test('slug alphabet excludes digit lookalikes', () => {
  // i/l/o/u are absent by design: a slug gets copied by hand out of a terminal.
  const all = Array.from({ length: 2000 }, () => newSlug()).join('')
  for (const ch of 'ilou') assert.equal(all.includes(ch), false, `found '${ch}'`)
})
