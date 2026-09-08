import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSqliteStore } from '../dist/env/drivers/sqlite-store.js'
import { conformance } from './env-conformance.mjs'

conformance('sqlite', async () => {
  const store = createSqliteStore(join(tmpdir(), `envcheck-sqlite-${randomUUID()}.db`))
  return { store, cleanup: async () => store.close() }
})
