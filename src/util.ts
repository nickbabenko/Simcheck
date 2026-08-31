import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

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

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Filesystem-safe slug for screenshot names. */
export const slug = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'shot';
