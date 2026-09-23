/**
 * R1 measurement: per-phase timings on a run, and the arithmetic `simcheck
 * bench` does over many of them. Dependency-free apart from types, so it can
 * be tested without a pool, a store on disk, or a simulator.
 */
import type { PhaseKey, Run, RunTimings } from './types.js';

export type Clock = () => bigint;
export const monotonic: Clock = () => process.hrtime.bigint();

/** Milliseconds between two monotonic readings. */
export const elapsedMs = (from: bigint, to: bigint): number => Math.round(Number(to - from) / 1e6);

/** The two store methods a phase needs. A narrow seam so tests can fake it. */
export interface TimingStore {
  get(id: string): Pick<Run, 'timings' | 'timingsIncomplete'> | undefined;
  update(id: string, patch: Partial<Run>): unknown;
}

/**
 * Merge one phase into a run's timings. Store.update() is a shallow
 * Object.assign, so writing `{ timings: { installMs } }` on its own would erase
 * every phase recorded before it -- hence the spread.
 */
export function recordPhase(
  store: TimingStore, runId: string, key: PhaseKey, ms: number, complete = true,
): void {
  const run = store.get(runId);
  if (!run) return;
  const incomplete = (run.timingsIncomplete ?? []).filter((k) => k !== key);
  if (!complete) incomplete.push(key);
  store.update(runId, {
    timings: { ...run.timings, [key]: ms },
    ...(incomplete.length || run.timingsIncomplete ? { timingsIncomplete: incomplete } : {}),
  });
}

/** Merge arbitrary timing fields (queue, occupancy, total). */
export function mergeTimings(store: TimingStore, runId: string, patch: RunTimings): void {
  const run = store.get(runId);
  if (!run) return;
  store.update(runId, { timings: { ...run.timings, ...patch } });
}

/**
 * Time `fn` as one phase of a run. A phase whose `fn` rejects is still
 * recorded -- the time was genuinely spent -- but marked incomplete, and the
 * rejection propagates unchanged.
 *
 * Caveat: `sleep()` resolves rather than rejects on abort, so a phase ending
 * in a settle-sleep can read complete on a run that was aborted during it.
 * Cross-check against the run's status.
 */
export async function phase<T>(
  store: TimingStore, runId: string, key: PhaseKey, fn: () => Promise<T>, clock: Clock = monotonic,
): Promise<T> {
  const t0 = clock();
  let complete = true;
  try {
    return await fn();
  } catch (e) {
    complete = false;
    throw e;
  } finally {
    recordPhase(store, runId, key, elapsedMs(t0, clock()), complete);
  }
}

/* ------------------------------------------------------------------ bench -- */

/** Nearest-rank percentile: index ceil(p/100 * n) - 1, clamped. No
 *  interpolation, so it is easy to check by hand against the sorted list. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** Median by nearest rank, i.e. the lower middle for an even count. */
export const median = (values: readonly number[]): number | undefined => percentile(values, 50);

export interface PhaseStats { p50: number; p90: number; mean: number; n: number }

/** Row order for tables; the derived totals come last. */
export const BENCH_ROWS: readonly (keyof RunTimings)[] = [
  'queueMs', 'prepareMs', 'preResetMs', 'installMs', 'launchMs', 'stepsMs', 'nativeTestMs',
  'screenshotMs', 'resetMs', 'occupancyMs', 'totalMs', 'recordMs',
];

export interface BenchSummary {
  iterations: number;
  statuses: Record<string, number>;
  phases: Partial<Record<keyof RunTimings, PhaseStats>>;
  /** Runs whose install was skipped by the warm-app cache. */
  cacheHits: number;
  /** Runs whose queue wait included creating and booting a device. */
  coldProvisions: number;
  /** (prepare + preReset + install) / occupancy, by medians. The number that
   *  decides whether the warm-app work is worth it. */
  installShare?: number;
}

type BenchRun = Pick<Run, 'status' | 'timings' | 'warm' | 'trace'>;

export function summariseBench(runs: readonly BenchRun[]): BenchSummary {
  const phases: BenchSummary['phases'] = {};
  for (const key of BENCH_ROWS) {
    const values = runs.map((r) => r.timings?.[key]).filter((v): v is number => typeof v === 'number');
    if (!values.length) continue;
    phases[key] = {
      p50: percentile(values, 50)!,
      p90: percentile(values, 90)!,
      mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
      n: values.length,
    };
  }
  const statuses: Record<string, number> = {};
  for (const r of runs) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  const occ = phases.occupancyMs?.p50;
  const install = (phases.prepareMs?.p50 ?? 0) + (phases.preResetMs?.p50 ?? 0) + (phases.installMs?.p50 ?? 0);
  return {
    iterations: runs.length,
    statuses,
    phases,
    cacheHits: runs.filter((r) => r.warm?.cacheHit).length,
    // The scheduler's own note is the only signal that a queue wait was a
    // cold boot rather than a busy pool.
    coldProvisions: runs.filter((r) => r.trace.some((t) => /is being created and booted/.test(t.text))).length,
    ...(occ ? { installShare: Math.round((install / occ) * 100) / 100 } : {}),
  };
}

const LABELS: Record<string, string> = {
  queueMs: 'queue', prepareMs: 'prepare', preResetMs: 'pre-reset', installMs: 'install',
  launchMs: 'launch', stepsMs: 'steps', nativeTestMs: 'native test', screenshotMs: 'screenshot',
  resetMs: 'reset', occupancyMs: 'occupancy', totalMs: 'total', recordMs: 'transcode',
};

/** The human table `simcheck bench` prints. */
export function formatBench(s: BenchSummary): string {
  const ms = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
  const L: string[] = [];
  L.push(`  ${'phase'.padEnd(12)} ${'median'.padStart(9)} ${'p90'.padStart(9)} ${'mean'.padStart(9)} ${'n'.padStart(4)}`);
  for (const key of BENCH_ROWS) {
    const st = s.phases[key];
    if (!st) continue;
    if (key === 'occupancyMs') L.push(`  ${'-'.repeat(46)}`);
    L.push(`  ${LABELS[key]!.padEnd(12)} ${ms(st.p50).padStart(9)} ${ms(st.p90).padStart(9)} ${ms(st.mean).padStart(9)} ${String(st.n).padStart(4)}`);
  }
  L.push('');
  const statusLine = Object.entries(s.statuses).map(([k, v]) => `${v} ${k}`).join(', ');
  L.push(`  ${s.iterations} runs: ${statusLine}; ${s.cacheHits} warm-cache hit(s); ${s.coldProvisions} cold provision(s)`);
  if (s.installShare !== undefined) {
    L.push(`  prepare + install as a share of occupancy (medians): ${Math.round(s.installShare * 100)}%`);
  }
  L.push('  occupancy = device time billed: from lease to the device being reset and back in the pool');
  if (s.phases.recordMs) L.push('  transcode = video conversion after the device is released; not device time');
  if (s.iterations < 30) L.push(`  n=${s.iterations}: the shape of a run, not a capacity number`);
  return L.join('\n');
}
