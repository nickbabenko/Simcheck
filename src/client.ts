import fs from 'node:fs';
import type { Config } from './config.js';
import { baseUrl, readToken } from './config.js';
import type { PooledDevice, Run, RunRequest } from './types.js';

export interface RunView extends Run {
  done: boolean;
  queuePosition?: number;
  dir: string;
  links: { self: string; wait: string; report: string; screenshots: { name: string; url: string }[] };
}

export interface PoolView {
  target: number;
  devices: PooledDevice[];
  counts: Record<string, number>;
  queued: number;
  active: number;
}

export interface Artifact {
  id: string; bundleId: string; appName: string; bytes: number;
  uploadedAt: string; uploadedBy: string; label?: string; gitSha?: string;
}

export interface WhoAmI {
  token: string;
  capabilities: string[];
  limits: { maxConcurrentRuns: number; maxRunsPerHour: number };
}

export class DaemonDownError extends Error {
  constructor(url: string, cause: string) {
    super(`no sim-harness daemon at ${url} (${cause}). Start one with: sim-harness start`);
  }
}

/** Thin typed client over the daemon's HTTP API. Shared by the CLI and MCP server. */
export class Client {
  private base: string;
  private token: string | null;

  constructor(cfg: Config, token?: string) {
    this.base = baseUrl(cfg);
    this.token = token ?? readToken(cfg);
  }

  private async call<T>(method: string, route: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.token) throw new Error('no API token found. Start the daemon once to mint one, or set SIM_HARNESS_TOKEN.');
    let res: Response;
    try {
      res = await fetch(this.base + route, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new DaemonDownError(this.base, (e as Error).message);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* not JSON */ }
      throw new Error(`${method} ${route} -> ${res.status}: ${message}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  health(): Promise<{ ok: boolean; llm: string | null; pool: number }> {
    return this.call('GET', '/health');
  }

  whoami(): Promise<WhoAmI> {
    return this.call('GET', '/v1/whoami');
  }

  listTokens(): Promise<{ tokens: Record<string, unknown>[]; presets: Record<string, string[]>; capabilities: string[] }> {
    return this.call('GET', '/v1/tokens');
  }

  createToken(body: { name: string; preset?: string; note?: string; maxConcurrentRuns?: number; maxRunsPerHour?: number }):
    Promise<{ record: Record<string, unknown>; secret: string }> {
    return this.call('POST', '/v1/tokens', body);
  }

  grantToken(nameOrId: string, capability: string): Promise<unknown> {
    return this.call('POST', `/v1/tokens/${encodeURIComponent(nameOrId)}/grant`, { capability });
  }

  revokeToken(nameOrId: string): Promise<{ revoked: string }> {
    return this.call('DELETE', `/v1/tokens/${encodeURIComponent(nameOrId)}`);
  }

  listArtifacts(): Promise<{ artifacts: Artifact[] }> {
    return this.call('GET', '/v1/artifacts');
  }

  /** Stream a zipped .app to the daemon. Node needs duplex:'half' to stream a body. */
  async uploadArtifact(zipPath: string, meta: { label?: string; gitSha?: string } = {}): Promise<Artifact> {
    if (!this.token) throw new Error('no API token found');
    const query = new URLSearchParams();
    if (meta.label) query.set('label', meta.label);
    if (meta.gitSha) query.set('gitSha', meta.gitSha);
    const size = fs.statSync(zipPath).size;

    let res: Response;
    try {
      res = await fetch(`${this.base}/v1/artifacts?${query}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/zip',
          'content-length': String(size),
        },
        body: fs.createReadStream(zipPath) as unknown as ReadableStream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
    } catch (e) {
      throw new DaemonDownError(this.base, (e as Error).message);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* not JSON */ }
      throw new Error(`upload failed (${res.status}): ${message}`);
    }
    return JSON.parse(text) as Artifact;
  }

  submit(req: RunRequest): Promise<RunView> {
    return this.call('POST', '/v1/runs', req);
  }

  get(id: string): Promise<RunView> {
    return this.call('GET', `/v1/runs/${id}`);
  }

  list(limit = 20): Promise<{ runs: Record<string, unknown>[] }> {
    return this.call('GET', `/v1/runs?limit=${limit}`);
  }

  cancel(id: string): Promise<RunView> {
    return this.call('DELETE', `/v1/runs/${id}`);
  }

  /** One long-poll leg. Returns as soon as the run finishes, or on timeout. */
  waitOnce(id: string, timeoutMs = 120_000): Promise<RunView> {
    return this.call('GET', `/v1/runs/${id}/wait?timeoutMs=${timeoutMs}`, undefined, timeoutMs + 15_000);
  }

  /** Long-poll repeatedly until the run is done or the overall deadline passes. */
  async wait(id: string, overallMs: number, onTick?: (run: RunView) => void): Promise<RunView> {
    const deadline = Date.now() + overallMs;
    for (;;) {
      const leg = Math.min(60_000, Math.max(1_000, deadline - Date.now()));
      const run = await this.waitOnce(id, leg);
      onTick?.(run);
      if (run.done || Date.now() >= deadline) return run;
    }
  }

  pool(): Promise<PoolView> {
    return this.call('GET', '/v1/pool');
  }

  addDevices(spec: { deviceType?: string; runtime?: string; count?: number }): Promise<{ added: PooledDevice[]; pool: PoolView }> {
    return this.call('POST', '/v1/pool/devices', spec, 180_000);
  }

  removeDevice(udid: string, force = false): Promise<PoolView> {
    return this.call('DELETE', `/v1/pool/devices/${udid}?force=${force}`, undefined, 120_000);
  }

  inspect(device: string): Promise<{ device: string; width: number; height: number; elements: unknown[] }> {
    return this.call('GET', `/v1/inspect/${encodeURIComponent(device)}`, undefined, 60_000);
  }

  async report(id: string): Promise<string> {
    if (!this.token) throw new Error('no API token found');
    const res = await fetch(`${this.base}/v1/runs/${id}/report`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`report unavailable (${res.status})`);
    return res.text();
  }

  async screenshot(id: string, name: string): Promise<Buffer> {
    if (!this.token) throw new Error('no API token found');
    const res = await fetch(`${this.base}/v1/runs/${id}/screenshots/${encodeURIComponent(name)}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`screenshot "${name}" unavailable (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Read a run request from a JSON file, with a clear error if it is malformed. */
export function readRequestFile(file: string): RunRequest {
  const raw = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(raw) as RunRequest; }
  catch (e) { throw new Error(`${file} is not valid JSON: ${(e as Error).message}`); }
}
