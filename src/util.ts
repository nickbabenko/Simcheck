import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }

export interface ExecOpts {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Abort the child when this signal fires (used for run cancellation). */
  signal?: AbortSignal;
  maxBuffer?: number;
}

/** Run a command, capture stdio, never throw on a non-zero exit. */
export function exec(cmd: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult> {
  const { timeoutMs = 120_000, maxBuffer = 32 * 1024 * 1024 } = opts;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    let len = 0;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    const onAbort = () => { timedOut = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (d: Buffer) => {
      len += d.length;
      if (len < maxBuffer) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => { stderr += String(e); finish(-1); });
    child.on('close', (code) => finish(code ?? -1));

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Like exec, but a non-zero exit becomes an Error with the stderr attached. */
export async function execOk(cmd: string, args: string[], opts: ExecOpts = {}): Promise<string> {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) {
    const why = r.timedOut ? 'timed out' : `exited ${r.code}`;
    throw new Error(`${cmd} ${args.join(' ')} ${why}: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
  }
  return r.stdout;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });

/** Sortable, human-scannable run id: r-<base36 time>-<random>. */
export const newId = (prefix = 'r'): string =>
  `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

export const nowIso = () => new Date().toISOString();

/**
 * Machine-readable detail on a refusal, sent alongside the human `error`
 * string so an agent can act on it without pattern-matching prose.
 */
export interface ErrorDetail {
  /** Stable tag, e.g. "max_concurrent_runs", "max_runs_per_hour". */
  code: string;
  limit?: number;
  current?: number;
  /** Only where it can be computed honestly. */
  retryAfterSeconds?: number;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public detail?: ErrorDetail) { super(message); }
}

/** Filesystem-safe slug for screenshot names. */
export const slug = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'shot';

/**
 * Unpack a zip into `dest`.
 *
 * On macOS, ditto: it keeps what a simulator .app needs from the archive
 * (extended attributes, resource forks, symlinks inside frameworks). ditto
 * does not exist on Linux, where Android runs, so there it is Info-ZIP's
 * unzip, which refuses entries that climb out of `dest`. unzip exits 1 for
 * "warnings, but everything that could be extracted was", such as a skipped
 * `../` entry; only 2 and above is a failure.
 */
export async function unzipArchive(
  archive: string, dest: string,
  opts: { timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 600_000;

  if ((opts.platform ?? process.platform) === 'darwin') {
    await execOk('/usr/bin/ditto', ['-x', '-k', archive, dest], { timeoutMs });
    return;
  }

  // ditto creates missing parents; unzip creates only the last level.
  fs.mkdirSync(dest, { recursive: true });
  const r = await exec('unzip', ['-q', '-o', archive, '-d', dest], { timeoutMs });
  if (r.code === 0 || r.code === 1) return;

  const why = r.timedOut ? 'timed out'
    : r.code === -1 ? 'could not be run (install it: apt install unzip)'
    : `exited ${r.code}`;
  throw new Error(`unzip ${archive} ${why}: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
}
