import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSqliteStore } from '../dist/env/drivers/sqlite-store.js'

/** The table as it shipped before host_port and reserved_until existed. */
const OLD_SCHEMA = `
CREATE TABLE envs (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL,
  spec TEXT NOT NULL, state TEXT NOT NULL, url TEXT,
  internal_db_url TEXT, internal_cache_url TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, error TEXT,
  lease_holder TEXT, lease_expires_at INTEGER
);`

test('an existing database gains new columns instead of erroring', async () => {
  // This is the real failure: every test passed because tests start from an
  // empty file, and the daemon broke on the database it had been using.
  const path = join(tmpdir(), `envcheck-migrate-${randomUUID()}.db`)
  const old = new DatabaseSync(path)
  old.exec(OLD_SCHEMA)
  old.prepare(
    `INSERT INTO envs (id, slug, owner_id, spec, state, created_at, expires_at)
     VALUES ('e1','oldslug','o1','{"port":80}','ready',1000,9000000)`,
  ).run()
  old.close()

  const store = createSqliteStore(path)
  const existing = await store.get('e1')
  assert.equal(existing.slug, 'oldslug', 'existing rows must survive')
  assert.equal('reservedUntil' in existing, false)

  // And the new columns must actually be writable.
  await store.create({
    id: 'e2', slug: 'newslug', ownerId: 'o1',
    spec: { image: { kind: 'tag', tag: 'x' }, port: 80, ownerId: 'o1' },
    state: 'reserved', createdAt: 2000, expiresAt: 9_000_000,
    reservedUntil: 8_000_000, hostPort: 40404,
  })
  const fresh = await store.get('e2')
  assert.equal(fresh.reservedUntil, 8_000_000)
  assert.equal(fresh.hostPort, 40404)
  store.close()
})

test('migrating twice is a no-op', async () => {
  const path = join(tmpdir(), `envcheck-migrate2-${randomUUID()}.db`)
  createSqliteStore(path).close()
  const again = createSqliteStore(path)
  assert.equal((await again.list()).length, 0)
  again.close()
})
