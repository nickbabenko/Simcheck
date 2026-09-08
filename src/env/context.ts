// Packing a build context.
//
// Shells out to `tar` rather than implementing a directory walker: tar is
// present everywhere this runs, handles symlinks, permissions and long paths
// correctly, and streaming a large context through a hand-rolled packer is a lot
// of surface for no gain.

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 512 MB. A context larger than this is nearly always an unignored
 *  node_modules or .git, and sending it wastes minutes before the build fails. */
export const MAX_CONTEXT_BYTES = 512 * 1024 * 1024

export interface PackResult {
  tar: Buffer
  excluded: string[]
  /** Set when .dockerignore was present but deliberately not applied. */
  warning?: string
}

/**
 * Read .dockerignore into tar --exclude patterns.
 *
 * Returns undefined if the file uses negation (`!foo`). tar has no equivalent,
 * and honouring the exclusions while dropping the re-inclusions would silently
 * omit files Docker would have kept — a build that fails for reasons invisible
 * in the Dockerfile. Better to send the whole context and say so.
 */
export async function dockerignoreToExcludes(dir: string): Promise<string[] | undefined> {
  let text: string
  try {
    text = await readFile(join(dir, '.dockerignore'), 'utf8')
  } catch {
    return []
  }
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  if (lines.some((l) => l.startsWith('!'))) return undefined
  return lines
}

export async function packContext(dir: string): Promise<PackResult> {
  const info = await stat(dir).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`build context is not a directory: ${dir}`)

  const excludes = await dockerignoreToExcludes(dir)
  const warning = excludes === undefined
    ? '.dockerignore uses negation (!), which tar cannot express — the full context was sent'
    : undefined
  const args = [
    '-cf', '-',
    ...(excludes ?? []).flatMap((p) => ['--exclude', p]),
    '-C', dir, '.',
  ]

  const tar = await new Promise<Buffer>((resolve, reject) => {
    execFile('tar', args, { encoding: 'buffer', maxBuffer: MAX_CONTEXT_BYTES }, (err, stdout) => {
      if (err) {
        reject(new Error(
          /maxBuffer/i.test(String(err.message))
            ? `build context exceeds ${MAX_CONTEXT_BYTES / 1024 ** 2} MB — add a .dockerignore`
            : `tar failed: ${err.message}`,
        ))
        return
      }
      resolve(stdout as unknown as Buffer)
    })
  })

  return { tar, excluded: excludes ?? [], ...(warning ? { warning } : {}) }
}
