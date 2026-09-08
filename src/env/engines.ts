// Per-database-engine behaviour.
//
// An adapter table rather than branching inside provisionEnv: adding an engine
// should be a matter of filling in one entry, and the shape of the entry makes
// the required pieces obvious. It also keeps the ordering rule — seed before the
// app starts — in one place regardless of engine.

import type { ContainerSpec } from './drivers/index.js'

export interface EngineContext {
  database: string
  user: string
  password: string
  /** Superuser password, where the engine distinguishes one. */
  rootPassword: string
}

export interface Engine {
  defaultVersion: string
  image(version: string): string
  /** Container environment that creates the user and database on first boot. */
  env(c: EngineContext): Record<string, string>
  healthcheck(c: EngineContext): NonNullable<ContainerSpec['healthcheck']>
  /** Connection string as seen from inside the env network. */
  url(c: EngineContext): string
  /** Command that prints 't' when the seed marker table exists. */
  seedMarkerCheck(c: EngineContext, marker: string): string[]
  createMarker(c: EngineContext, marker: string): string[]
  /** Apply a .sql file already uploaded to the container. */
  applySqlFile(c: EngineContext, path: string): string[]
  /** Restore a dump, or undefined if the engine has no distinct dump format. */
  applyDump?(c: EngineContext, path: string): string[]
  cloneTemplate?(c: EngineContext, template: string, target: string): string[]
  /** Exit codes that mean "worked, with warnings". pg_restore in particular
   *  exits non-zero over roles the fresh instance does not have. */
  dumpWarningsAreFatal?: boolean
}

export const POSTGRES: Engine = {
  defaultVersion: '17-alpine',
  image: (v) => `postgres:${v}`,
  env: (c) => ({ POSTGRES_USER: c.user, POSTGRES_PASSWORD: c.password, POSTGRES_DB: c.database }),
  healthcheck: (c) => ({
    test: ['CMD-SHELL', `pg_isready -U ${c.user} -d ${c.database}`],
    intervalMs: 1000,
    retries: 30,
  }),
  url: (c) => `postgres://${c.user}:${c.password}@db:5432/${c.database}`,
  // The official image's pg_hba grants trust over the local socket, so no
  // password has to be passed on an exec command line where it would be visible
  // in the container's process list.
  seedMarkerCheck: (c, m) => ['psql', '-U', c.user, '-d', c.database, '-tAc', `SELECT to_regclass('${m}') IS NOT NULL`],
  createMarker: (c, m) => ['psql', '-U', c.user, '-d', c.database, '-c', `CREATE TABLE IF NOT EXISTS ${m} (at timestamptz DEFAULT now())`],
  applySqlFile: (c, p) => ['psql', '-v', 'ON_ERROR_STOP=1', '-U', c.user, '-d', c.database, '-f', p],
  applyDump: (c, p) => ['pg_restore', '-U', c.user, '-d', c.database, '--no-owner', p],
  cloneTemplate: (c, t, target) => ['createdb', '-U', c.user, '-T', t, target],
  dumpWarningsAreFatal: false,
}

export const MYSQL: Engine = {
  defaultVersion: '8',
  image: (v) => `mysql:${v}`,
  env: (c) => ({
    MYSQL_ROOT_PASSWORD: c.rootPassword,
    MYSQL_DATABASE: c.database,
    MYSQL_USER: c.user,
    MYSQL_PASSWORD: c.password,
  }),
  // Passwords are read from the environment inside the container rather than
  // written on the command line, which would expose them in `ps` to anything
  // else in the same container.
  healthcheck: () => ({
    test: ['CMD-SHELL', 'mysqladmin ping -h 127.0.0.1 -u root -p"$MYSQL_ROOT_PASSWORD" --silent'],
    intervalMs: 2000,
    retries: 45,
  }),
  url: (c) => `mysql://${c.user}:${c.password}@db:3306/${c.database}`,
  seedMarkerCheck: (c, m) => [
    'sh', '-c',
    `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B -e "SELECT IF(COUNT(*)>0,'t','f') FROM information_schema.tables WHERE table_schema='${c.database}' AND table_name='${m}'"`,
  ],
  createMarker: (c, m) => [
    'sh', '-c',
    `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" ${c.database} -e "CREATE TABLE IF NOT EXISTS ${m} (at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"`,
  ],
  applySqlFile: (c, p) => ['sh', '-c', `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" ${c.database} < ${p}`],
  // mysqldump output is plain SQL, so a dump and a script are the same thing.
  applyDump: (c, p) => ['sh', '-c', `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" ${c.database} < ${p}`],
  dumpWarningsAreFatal: true,
}

export const ENGINES = { postgres: POSTGRES, mysql: MYSQL } as const

/** MySQL has no cheap CREATE DATABASE ... TEMPLATE equivalent, so `template`
 *  seeding is Postgres-only and says so rather than silently doing nothing. */
export function supportsTemplate(engine: keyof typeof ENGINES): boolean {
  return Boolean(ENGINES[engine].cloneTemplate)
}
