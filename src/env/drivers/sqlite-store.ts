// Desired state, on SQLite.
//
// Uses node:sqlite (built in since Node 22) rather than better-sqlite3 so there
// is no native module to compile — one less thing to break on a Node upgrade or
// a different architecture. The Postgres implementation of this interface is a
// near-mechanical translation; the only interesting part is claimWork().

import { DatabaseSync } from 'node:sqlite'
import type { Store } from './index.js'
import type { EnvRecord, EnvState } from '../types.js'

/** States the reconciler must act on. `ready` is excluded — a ready env needs
 *  nothing until it expires, and expiry is handled by its own sweep. */
// 'reserved' is absent on purpose: a reservation has nothing to converge. It
// waits for someone to provision it, or for its own clock to run out.
const ACTIONABLE: EnvState[] = ['pending', 'provisioning', 'seeding', 'expired', 'destroying']

const SCHEMA = `
CREATE TABLE IF NOT EXISTS envs (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  owner_id         TEXT NOT NULL,
  spec             TEXT NOT NULL,
  state            TEXT NOT NULL,
  url              TEXT,
  host_port        INTEGER,
  internal_db_url  TEXT,
  internal_cache_url TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  reserved_until   INTEGER,
  urls             TEXT,
  host_ports       TEXT,
  error            TEXT,
  lease_holder     TEXT,
  lease_expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS envs_state ON envs (state);
CREATE INDEX IF NOT EXISTS envs_owner ON envs (owner_id, state);
`

type Row = {
  id: string; slug: string; owner_id: string; spec: string; state: string
  url: string | null; host_port: number | null; urls: string | null; host_ports: string | null; internal_db_url: string | null; internal_cache_url: string | null
  created_at: number; expires_at: number; reserved_until: number | null; error: string | null
  lease_holder: string | null; lease_expires_at: number | null
}

function toRecord(r: Row): EnvRecord {
  const rec: EnvRecord = {
    id: r.id,
    slug: r.slug,
    ownerId: r.owner_id,
    spec: JSON.parse(r.spec),
    state: r.state as EnvState,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }
  if (r.url !== null) rec.url = r.url
  if (r.host_port !== null) rec.hostPort = r.host_port
  if (r.urls !== null) rec.urls = JSON.parse(r.urls) as Record<string, string>
  if (r.host_ports !== null) rec.hostPorts = JSON.parse(r.host_ports) as Record<string, number>
  if (r.internal_db_url !== null) rec.internalDbUrl = r.internal_db_url
  if (r.internal_cache_url !== null) rec.internalCacheUrl = r.internal_cache_url
  if (r.reserved_until !== null) rec.reservedUntil = r.reserved_until
  if (r.error !== null) rec.error = r.error
  if (r.lease_holder !== null) rec.leaseHolder = r.lease_holder
  if (r.lease_expires_at !== null) rec.leaseExpiresAt = r.lease_expires_at
  return rec
}

/** Maps a record field to its column. Keeps update() honest about typos. */
const COLUMN: Record<string, string> = {
  slug: 'slug', ownerId: 'owner_id', state: 'state', url: 'url', hostPort: 'host_port',
  internalDbUrl: 'internal_db_url', internalCacheUrl: 'internal_cache_url',
  expiresAt: 'expires_at', reservedUntil: 'reserved_until', error: 'error', spec: 'spec',
  urls: 'urls', hostPorts: 'host_ports',
  leaseHolder: 'lease_holder', leaseExpiresAt: 'lease_expires_at',
}

/**
 * Columns added after the table first shipped.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
 * new column is invisible to every store created before it -- and every test
 * passes regardless, because tests always start from an empty file. The failure
 * only appears against a database someone has actually been using.
 */
const ADDED_COLUMNS: Array<[string, string]> = [
  ['host_port', 'INTEGER'],
  ['reserved_until', 'INTEGER'],
  ['urls', 'TEXT'],
  ['host_ports', 'TEXT'],
]

/** Columns holding JSON rather than a scalar. */
const JSON_COLUMNS = new Set(['spec', 'urls', 'host_ports'])

function migrate(db: DatabaseSync): void {
  const present = new Set(
    (db.prepare('PRAGMA table_info(envs)').all() as Array<{ name: string }>).map((c) => c.name),
  )
  for (const [name, type] of ADDED_COLUMNS) {
    // Nullable with no default, so adding one is instant and cannot fail on a
    // large table -- and absent reads back as "not set" rather than a wrong value.
    if (!present.has(name)) db.exec(`ALTER TABLE envs ADD COLUMN ${name} ${type}`)
  }
}

export function createSqliteStore(path: string): Store & { close(): void } {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  // Without this, two processes racing on claimWork get SQLITE_BUSY instead of
  // waiting, and the loser drops the tick entirely.
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  migrate(db)

  return {
    async create(rec) {
      db.prepare(
        `INSERT INTO envs (id, slug, owner_id, spec, state, url, host_port, internal_db_url,
           internal_cache_url, created_at, expires_at, reserved_until, error, lease_holder, lease_expires_at,
           urls, host_ports)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        rec.id, rec.slug, rec.ownerId, JSON.stringify(rec.spec), rec.state,
        rec.url ?? null, rec.hostPort ?? null, rec.internalDbUrl ?? null, rec.internalCacheUrl ?? null,
        rec.createdAt, rec.expiresAt, rec.reservedUntil ?? null, rec.error ?? null,
        rec.leaseHolder ?? null, rec.leaseExpiresAt ?? null,
        rec.urls ? JSON.stringify(rec.urls) : null,
        rec.hostPorts ? JSON.stringify(rec.hostPorts) : null,
      )
    },

    async get(id) {
      const row = db.prepare('SELECT * FROM envs WHERE id = ?').get(id) as Row | undefined
      return row ? toRecord(row) : undefined
    },

    async getBySlug(slug) {
      const row = db.prepare('SELECT * FROM envs WHERE slug = ?').get(slug) as Row | undefined
      return row ? toRecord(row) : undefined
    },

    async list(filter) {
      const where: string[] = []
      const args: unknown[] = []
      if (filter?.ownerId) { where.push('owner_id = ?'); args.push(filter.ownerId) }
      if (filter?.states?.length) {
        where.push(`state IN (${filter.states.map(() => '?').join(',')})`)
        args.push(...filter.states)
      }
      const sql = `SELECT * FROM envs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`
      return (db.prepare(sql).all(...(args as never[])) as Row[]).map(toRecord)
    },

    async update(id, patch) {
      const sets: string[] = []
      const args: unknown[] = []
      for (const [k, v] of Object.entries(patch)) {
        const col = COLUMN[k]
        if (!col) continue
        sets.push(`${col} = ?`)
        // spec is the one column that is not a scalar. Without this it would be
        // bound as an object, which SQLite rejects -- or worse, silently stored
        // as "[object Object]" by a driver that coerces.
        args.push(JSON_COLUMNS.has(col) ? JSON.stringify(v) : v === undefined ? null : v)
      }
      if (!sets.length) return
      args.push(id)
      db.prepare(`UPDATE envs SET ${sets.join(', ')} WHERE id = ?`).run(...(args as never[]))
    },

    /**
     * Atomically hand out work. BEGIN IMMEDIATE takes the write lock up front,
     * so two replicas cannot both read the same unclaimed row and then both
     * write a lease over it — which is exactly the race that would have two
     * daemons provisioning one env.
     */
    async claimWork(holder, now, leaseMs, limit) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const rows = db.prepare(
          `SELECT * FROM envs
            WHERE state IN (${ACTIONABLE.map(() => '?').join(',')})
              AND (lease_holder IS NULL OR lease_expires_at IS NULL
                   OR lease_expires_at < ? OR lease_holder = ?)
            ORDER BY created_at ASC
            LIMIT ?`,
        ).all(...(ACTIONABLE as never[]), now as never, holder as never, limit as never) as Row[]

        const upd = db.prepare('UPDATE envs SET lease_holder = ?, lease_expires_at = ? WHERE id = ?')
        for (const r of rows) upd.run(holder, now + leaseMs, r.id)
        db.exec('COMMIT')
        return rows.map((r) => ({ ...toRecord(r), leaseHolder: holder, leaseExpiresAt: now + leaseMs }))
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },

    /** Counts against quota. `destroying` still counts — the resources are real
     *  until teardown finishes, and not counting them lets a burst overshoot. */
    async countActive(ownerId) {
      const row = db.prepare(
        // 'reserved' excluded deliberately: a reservation holds a URL, not a
        // slot. Counting it would make a queue of pending builds block the
        // machine from running the tests those builds are for.
        `SELECT COUNT(*) AS n FROM envs
          WHERE owner_id = ? AND state NOT IN ('failed','destroyed','reserved')`,
      ).get(ownerId) as { n: number }
      return row.n
    },

    close() { db.close() },
  }
}
