/**
 * One run's attachment to the in-app probe: the per-run port and token, the
 * check that the app which answered is the one we launched, and the evidence
 * pulled from it as the run goes.
 *
 * The token lives only here, in memory. It never reaches the trace, the run
 * record or a log line, and `close()` drops it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ProbeClient, probeLaunchEnv, type ProbeNetworkRequest } from './probe.js';
import { logger } from '../log.js';

const log = logger('probe');

/** How long a launched app has to answer before the run gives up on it. */
const READY_TIMEOUT_MS = 5_000;
/** Consecutive probe errors after which the run stops asking. */
const MAX_FAILURES = 2;

export const NETWORK_FILE = 'network.json';
export const CONSOLE_FILE = 'console.log';

/** A request as network.json records it: the probe's own record, plus which
 *  step was running when it started and which launch of the app made it. */
export type NetworkEntry = ProbeNetworkRequest & { step: number | null; launch: number };

export class ProbeSession {
  readonly client: ProbeClient;
  private token: string;
  private attachedTo = 0;
  private detachedReason: string | null = null;
  private failures = 0;
  /** Launches of the app so far; each restarts the probe's sequence numbers. */
  private launches = 0;
  private networkCursor = 0;
  private consoleCursor = 0;
  private readonly network = new Map<string, NetworkEntry>();
  private wroteConsole = false;

  constructor(
    private readonly dylibPath: string,
    readonly port: number,
    token: string,
    private readonly runDir: string,
  ) {
    this.token = token;
    this.client = new ProbeClient(port, token);
  }

  /** Talking to a probe right now. */
  get attached(): boolean { return this.attachedTo > 0 && !this.detachedReason; }

  /** Why the run stopped using the probe, once it has. */
  get detached(): string | null { return this.detachedReason; }

  /** The pid the probe answered from, for crash attribution. */
  get pid(): number { return this.attachedTo; }

  /** Env that injects the probe into the next launch. Empty once detached:
   *  a probe that misbehaved is not put back into the app. */
  launchEnv(): Record<string, string> {
    if (this.detachedReason) return {};
    return probeLaunchEnv(this.dylibPath, this.port, this.token);
  }

  /**
   * After a launch: wait for the probe to answer, and check it answered from
   * the app we launched. The port is on the host's shared loopback, so
   * another simulator's app could have won it. Returns null when attached,
   * else the reason the run carries on without it.
   */
  async afterLaunch(appId: string, pid: number): Promise<string | null> {
    if (this.detachedReason) return this.detachedReason;

    try {
      const hello = await this.client.waitUntilReady(READY_TIMEOUT_MS);
      const sameApp = hello.bundleId === appId && (pid === 0 || hello.pid === pid);
      if (!sameApp) {
        throw new Error(`port ${this.port} answered for ${hello.bundleId} (pid ${hello.pid}), not ${appId} (pid ${pid})`);
      }

      this.attachedTo = hello.pid;
      this.launches += 1;
      this.networkCursor = 0;
      this.consoleCursor = 0;
      this.failures = 0;
      return null;
    } catch (e) {
      this.detach((e as Error).message);
      return this.detachedReason;
    }
  }

  /** The app was terminated on purpose: nothing to talk to until relaunch. */
  appStopped(): void {
    this.attachedTo = 0;
  }

  detach(reason: string): void {
    this.detachedReason ??= reason;
    this.attachedTo = 0;
  }

  /** Count a failed call; two in a row and the run stops asking. */
  failed(reason: string): void {
    this.failures += 1;
    if (this.failures >= MAX_FAILURES) this.detach(`${MAX_FAILURES} probe calls in a row failed (last: ${reason})`);
  }

  succeeded(): void { this.failures = 0; }

  /**
   * Pull what is new from the probe into network.json and console.log.
   * `stepAt` maps a request's start time to the step running then.
   *
   * The probe numbers each request when it starts and never renumbers it, so
   * a request still running at the last pull is fetched again from its own
   * sequence number until it finishes. Never throws: evidence is best-effort.
   */
  async pullEvidence(stepAt: (startedAtMs: number) => number | null): Promise<void> {
    if (!this.attached) return;

    try {
      const stillRunning = [...this.network.values()]
        .filter((entry) => entry.launch === this.launches && entry.state === 'running')
        .map((entry) => entry.seq);
      const since = stillRunning.length ? Math.min(...stillRunning) - 1 : this.networkCursor;
      const fetched = await this.client.network(since);

      this.absorb(fetched.requests, stepAt);
      this.networkCursor = Math.max(this.networkCursor, fetched.cursor);

      const lines = await this.client.console(this.consoleCursor);
      if (lines.lines.length) {
        const text = lines.lines
          .map((line) => `${new Date(line.at).toISOString()} ${line.stream} ${line.line}`)
          .join('\n');
        fs.appendFileSync(path.join(this.runDir, CONSOLE_FILE), `${text}\n`);
        this.wroteConsole = true;
      }
      this.consoleCursor = Math.max(this.consoleCursor, lines.cursor);
    } catch (e) {
      log.warn('could not pull probe evidence', (e as Error).message);
    }
  }

  /** Upsert requests fetched elsewhere (assert_request polls the log too). */
  absorb(requests: ProbeNetworkRequest[], stepAt: (startedAtMs: number) => number | null): void {
    for (const request of requests) {
      const key = `${this.launches}:${request.seq}`;
      const known = this.network.get(key);
      this.network.set(key, { ...request, step: known?.step ?? stepAt(request.startedAt), launch: this.launches });
    }
    this.writeNetwork();
  }

  /** Which evidence files exist, relative to the run directory. */
  evidence(): { networkLog?: string; consoleLog?: string } {
    return {
      ...(this.network.size ? { networkLog: NETWORK_FILE } : {}),
      ...(this.wroteConsole ? { consoleLog: CONSOLE_FILE } : {}),
    };
  }

  /** Last pull, then forget the token. */
  async close(stepAt: (startedAtMs: number) => number | null): Promise<void> {
    await this.pullEvidence(stepAt);
    this.detach('the run finished');
    this.token = '';
  }

  private writeNetwork(): void {
    if (!this.network.size) return;
    const requests = [...this.network.values()].sort((a, b) => a.launch - b.launch || a.seq - b.seq);
    fs.writeFileSync(path.join(this.runDir, NETWORK_FILE), JSON.stringify({ requests }, null, 2));
  }
}
