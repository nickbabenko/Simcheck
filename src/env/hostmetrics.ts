// Free-memory measurement, per platform.
//
// os.freemem() is the obvious call and the wrong one. On macOS it returns only
// wholly free pages — 140 MB on a 16 GB machine with gigabytes of reclaimable
// cache — so a floor built on it either refuses everything or has to be set so
// low it never fires. On Linux it maps to MemFree, which excludes the page cache
// the kernel would happily evict.
//
// What a provisioning decision actually wants is "memory obtainable without
// swapping", which is MemAvailable on Linux and a vm_stat sum on macOS.

import os from 'node:os'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Parse /proc/meminfo. MemAvailable is the kernel's own estimate and accounts
 *  for reclaimable slab and page cache, which no hand-rolled sum gets right. */
export function parseMemAvailable(meminfo: string): number | undefined {
  const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)
  return m?.[1] ? Number(m[1]) / 1024 : undefined
}

/**
 * Parse `vm_stat`. Sums the page classes macOS can hand to a new allocation
 * without paging out: free, inactive, speculative and purgeable.
 *
 * The page size is read from the header rather than assumed — it is 16 KB on
 * Apple Silicon and 4 KB on Intel, and hardcoding either gives an answer wrong
 * by 4x on the other.
 */
export function parseVmStat(out: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096)
  const pages = (label: string): number => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, 'm').exec(out)
    return m?.[1] ? Number(m[1]) : 0
  }
  const total = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')
  if (total === 0) return undefined
  return (total * pageSize) / 1024 ** 2
}

/** Available memory in MB. Falls back to os.freemem() only when the platform
 *  path fails — a wrong-but-present number beats refusing to provision. */
export async function availableMemoryMb(): Promise<number> {
  try {
    if (process.platform === 'linux') {
      const v = parseMemAvailable(await readFile('/proc/meminfo', 'utf8'))
      if (v !== undefined) return Math.round(v)
    } else if (process.platform === 'darwin') {
      const { stdout } = await run('vm_stat', [], { timeout: 3000 })
      const v = parseVmStat(stdout)
      if (v !== undefined) return Math.round(v)
    }
  } catch {
    // Fall through to the portable approximation.
  }
  return Math.round(os.freemem() / 1024 ** 2)
}
