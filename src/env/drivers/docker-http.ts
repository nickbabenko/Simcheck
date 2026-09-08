// Minimal Docker Engine API client over a unix socket or TCP.
//
// No dependency and no `docker` subprocess: the Engine API is the portable
// surface, spoken by podman, OrbStack, Docker Desktop and a plain dockerd alike.
// Shelling out would mean parsing CLI output that differs between those.

import http from 'node:http'
import type { Duplex } from 'node:stream'

/** Pinned rather than defaulting to "latest the daemon offers", so a daemon
 *  upgrade cannot silently change response shapes underneath us. 1.41 is old
 *  enough that podman's Docker-compat API supports it. */
const API_VERSION = 'v1.41'

export interface DockerError extends Error {
  statusCode?: number
}

function requestOptions(dockerHost: string, path: string, method: string): http.RequestOptions {
  const base: http.RequestOptions = { method, path: `/${API_VERSION}${path}` }
  if (dockerHost.startsWith('tcp://') || dockerHost.startsWith('http://')) {
    const u = new URL(dockerHost.replace(/^tcp:\/\//, 'http://'))
    return { ...base, host: u.hostname, port: u.port || 2375 }
  }
  return { ...base, socketPath: dockerHost.replace(/^unix:\/\//, '') }
}

export class Docker {
  constructor(private readonly dockerHost: string) {}

  /** JSON in, JSON out. Throws with the daemon's own message on non-2xx — the
   *  daemon explains failures far better than a generic status code would. */
  async json<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const { buf, status } = await this.raw(method, path, body)
    const text = buf.toString('utf8')
    if (status >= 400) {
      let message = text
      try { message = (JSON.parse(text) as { message?: string }).message ?? text } catch { /* not JSON */ }
      const err: DockerError = new Error(`docker ${method} ${path}: ${status} ${message}`)
      err.statusCode = status
      throw err
    }
    // Trim before testing for emptiness: several endpoints (image tag, container
    // start) answer 2xx with a bare newline, which is truthy and blows up
    // JSON.parse with a message that says nothing about which call failed.
    const trimmed = text.trim()
    return trimmed ? (JSON.parse(trimmed) as T) : (undefined as T)
  }

  async raw(
    method: string,
    path: string,
    body?: unknown,
    rawBody?: Buffer,
    extraHeaders?: Record<string, string>,
  ): Promise<{ buf: Buffer; status: number }> {
    return new Promise((resolve, reject) => {
      const opts = requestOptions(this.dockerHost, path, method)
      const payload = rawBody ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)))
      opts.headers = {
        ...(payload ? { 'Content-Length': String(payload.length) } : {}),
        'Content-Type': rawBody ? 'application/x-tar' : 'application/json',
        ...extraHeaders,
      }
      const req = http.request(opts, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ buf: Buffer.concat(chunks), status: res.statusCode ?? 0 }))
      })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  /** Hijacked bidirectional stream, used by exec. */
  async hijack(path: string, body: unknown): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const opts = requestOptions(this.dockerHost, path, 'POST')
      const payload = Buffer.from(JSON.stringify(body))
      opts.headers = {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
        Connection: 'Upgrade',
        Upgrade: 'tcp',
      }
      const req = http.request(opts)
      req.on('upgrade', (_res, socket) => resolve(socket as Duplex))
      // Some daemons answer exec-start with a plain 200 stream rather than a
      // protocol upgrade. Both are valid; handle each.
      req.on('response', (res) => resolve(res as unknown as Duplex))
      req.on('error', reject)
      req.write(payload)
      req.end()
    })
  }
}

/**
 * Docker multiplexes stdout and stderr into one stream with an 8-byte header per
 * frame: [stream type, 0, 0, 0, big-endian uint32 length]. Without demuxing,
 * those headers land in the middle of the output as control-character garbage.
 *
 * A TTY-enabled stream is *not* framed; callers must not demux that.
 */
export function demux(buf: Buffer): { stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  let off = 0
  while (off + 8 <= buf.length) {
    const type = buf[off]
    const len = buf.readUInt32BE(off + 4)
    const start = off + 8
    const end = Math.min(start + len, buf.length)
    const chunk = buf.subarray(start, end).toString('utf8')
    if (type === 2) stderr += chunk
    else stdout += chunk
    off = end
    // A frame claiming more bytes than arrived means a truncated stream; stop
    // rather than spinning on a header that will never complete.
    if (end < start + len) break
  }
  return { stdout, stderr }
}

export async function readStream(s: Duplex): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of s) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

/**
 * Minimal ustar writer for a single file.
 *
 * Seed SQL is uploaded to the database container as a file rather than passed as
 * a shell argument. Interpolating arbitrary SQL into `sh -c` is both a quoting
 * minefield and an injection hazard, and argv has a length limit a real dump
 * would blow past immediately.
 */
export function tarFile(name: string, content: Buffer, mode = 0o644): Buffer {
  const header = Buffer.alloc(512)
  const write = (s: string, off: number, len: number) => header.write(s.slice(0, len - 1), off, 'utf8')
  write(name, 0, 100)
  write(mode.toString(8).padStart(7, '0'), 100, 8)
  write('0'.padStart(7, '0'), 108, 8)          // uid
  write('0'.padStart(7, '0'), 116, 8)          // gid
  write(content.length.toString(8).padStart(11, '0'), 124, 12)
  write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 136, 12)
  header.write('        ', 148, 8, 'utf8')     // checksum placeholder: spaces
  header.write('0', 156, 1, 'utf8')            // type: regular file
  header.write('ustar\0', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')

  let sum = 0
  for (const b of header) sum += b
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8')

  const pad = Buffer.alloc((512 - (content.length % 512)) % 512)
  // Two zero blocks terminate the archive.
  return Buffer.concat([header, content, pad, Buffer.alloc(1024)])
}
