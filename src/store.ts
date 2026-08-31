import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { paths } from './config.js';
import type { Run, RunStatus, TraceEntry } from './types.js';
import { isTerminal } from './types.js';
import { logger, } from './log.js';
import { nowIso } from './util.js';

const log = logger('store');

type Listener = (run: Run) => void;

/**
 * Runs live in memory and are written through to
 * `~/.sim-harness/runs/<id>/run.json` so they survive a daemon restart and can
 * be inspected by hand. Artifacts sit alongside in the same directory.
 */
export class Store {
  private runs = new Map<string, Run>();
  private listeners = new Set<Listener>();
  /**
   * Per-run secrets, held in memory only and never written anywhere.
   *
   * They cannot live on the Run: that object is persisted on every status
   * change and trace line, so anything attached to it reaches disk.
   */
  private secrets = new Map<string, Record<string, string>>();

  constructor(private cfg: Config) {}

  load(): void {
    const dir = paths(this.cfg).runs;
    if (!fs.existsSync(dir)) return;
    for (const id of fs.readdirSync(dir)) {
      const file = path.join(dir, id, 'run.json');
      if (!fs.existsSync(file)) continue;
      try {
        const run = JSON.parse(fs.readFileSync(file, 'utf8')) as Run;
        // Anything mid-flight when the daemon died is not coming back.
        if (!isTerminal(run.status)) {
          run.status = 'error';
          run.error = 'daemon restarted while this run was in flight';
          run.finishedAt = nowIso();
        }
        this.runs.set(run.id, run);
      } catch (e) {
        log.warn(`skipping unreadable run ${id}`, (e as Error).message);
      }
    }
    log.info(`loaded ${this.runs.size} runs`);
  }

  dir(runId: string): string { return path.join(paths(this.cfg).runs, runId); }

  create(run: Run): Run {
    fs.mkdirSync(path.join(this.dir(run.id), 'screenshots'), { recursive: true });
    this.runs.set(run.id, run);
    this.persist(run);
    this.prune();
    return run;
  }

  get(id: string): Run | undefined { return this.runs.get(id); }

  setSecret(runId: string, value: Record<string, string>): void {
    this.secrets.set(runId, value);
  }

  /** Read and forget: a build is fetched once. */
  takeSecret(runId: string): Record<string, string> | undefined {
    const v = this.secrets.get(runId);
    this.secrets.delete(runId);
    return v;
  }

  forgetSecret(runId: string): void { this.secrets.delete(runId); }

  list(filter?: { status?: RunStatus; limit?: number }): Run[] {
    let all = [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (filter?.status) all = all.filter((r) => r.status === filter.status);
    return filter?.limit ? all.slice(0, filter.limit) : all;
  }

  /** Runs waiting on a device, oldest first -- this is the scheduler queue. */
  pending(): Run[] {
    return [...this.runs.values()]
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  update(id: string, patch: Partial<Run>): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error(`no such run ${id}`);
    Object.assign(run, patch);
    this.persist(run);
    for (const fn of this.listeners) {
      try { fn(run); } catch (e) { log.warn('listener threw', (e as Error).message); }
    }
    return run;
  }

  trace(id: string, entry: Omit<TraceEntry, 'at'>): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.trace.push({ at: nowIso(), ...entry });
    this.persist(run);
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  persist(run: Run): void {
    const file = path.join(this.dir(run.id), 'run.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename so a reader never sees a half-written file.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(run, null, 2));
    fs.renameSync(tmp, file);
  }

  /** Drop the oldest finished runs once we exceed the retention limit. */
  private prune(): void {
    const finished = [...this.runs.values()]
      .filter((r) => isTerminal(r.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const excess = finished.length - this.cfg.retainRuns;
    for (let i = 0; i < excess; i++) {
      const run = finished[i]!;
      this.runs.delete(run.id);
      fs.rmSync(this.dir(run.id), { recursive: true, force: true });
    }
  }
}
