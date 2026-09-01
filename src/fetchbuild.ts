import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { Readable } from 'node:stream';
import type { Config } from './config.js';
import type { ArtifactStore, Artifact } from './artifacts.js';
import { parseCidr, inCidr, isLoopback } from './edge.js';
import { HttpError } from './util.js';
import { logger } from './log.js';

const log = logger('fetch');

/**
 * Address ranges a build must never be fetched from.
 *
 * Without this, `app.url` is a server-side request forgery primitive: a caller
 * holding only a scoped remote token could make the daemon fetch this Mac's
 * LAN, the Proxmox host, or cloud metadata, and read the response through the
 * error message.
 */
const BLOCKED = [
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',   // RFC1918
  '127.0.0.0/8', '0.0.0.0/8', '169.254.0.0/16',      // loopback, link-local (incl. cloud metadata)
  '100.64.0.0/10',                                    // CGNAT -- also the Tailscale range
  '192.0.0.0/24', '198.18.0.0/15',
].map(parseCidr);
const BLOCKED_V6 = ['::1/128', 'fc00::/7', 'fe80::/10'].map(parseCidr);

/** Reject a host that resolves anywhere private. Checked on every redirect. */
export async function assertPublic(url: URL, cfg: Config): Promise<void> {
  if (url.protocol !== 'https:') {
    throw new HttpError(400, `build URL must be https (got ${url.protocol}//)`);
  }
  if (cfg.allowedBuildHosts.length) {
    const listed = cfg.allowedBuildHosts.some((h) =>
      url.hostname === h || url.hostname.endsWith(`.${h}`));
    if (!listed) {
      throw new HttpError(403,
        `${url.hostname} is not in allowedBuildHosts (${cfg.allowedBuildHosts.join(', ')})`);
    }
    // Naming a host explicitly is a deliberate statement of trust, so it also
    // overrides the private-address block. That is what makes it possible to
    // host builds on your own LAN or tailnet without disabling the guard for
    // every other destination.
    return;
  }
  if (isLoopback(url.hostname)) throw new HttpError(400, `refusing to fetch a build from ${url.hostname}`);

  let addresses: string[];
  try {
    addresses = (await dns.lookup(url.hostname, { all: true })).map((a) => a.address);
  } catch (e) {
    throw new HttpError(400, `could not resolve ${url.hostname}: ${(e as Error).message}`);
  }
  for (const addr of addresses) {
    const blocked = addr.includes(':')
      ? BLOCKED_V6.some((n) => inCidr(addr, n))
      : BLOCKED.some((n) => inCidr(addr, n));
    if (blocked || isLoopback(addr)) {
      throw new HttpError(400,
        `refusing to fetch a build from ${url.hostname}: it resolves to the private address ${addr}`);
    }
  }
}

/**
 * Download a zipped simulator .app and register it as an artifact.
 *
 * This is the path for a caller that cannot upload a binary -- an MCP client
 * passing JSON, or a cloud agent whose CI produced the build. Results are
 * content-addressed, so re-running the same build costs one HTTP request and
 * no disk.
 */
export async function fetchBuild(
  cfg: Config, artifacts: ArtifactStore,
  spec: { url: string; headers?: Record<string, string>; label?: string },
  signal?: AbortSignal,
): Promise<Artifact> {
  let url: URL;
  try { url = new URL(spec.url); }
  catch { throw new HttpError(400, `not a valid URL: ${spec.url}`); }

  // Follow redirects by hand: GitHub hands out a signed URL on another host,
  // and each hop needs the same private-address check as the first.
  let response: Response | undefined;
  let current = url;
  // Credentials configured for this host win over anything the caller sent:
  // the point is that the caller need not hold the secret at all.
  const configured = cfg.buildCredentials[url.hostname] ?? {};
  const headers: Record<string, string> = {
    ...(spec.headers ?? {}), ...configured, 'user-agent': 'simcheck',
  };
  if (Object.keys(configured).length) {
    log.info(`using configured credentials for ${url.hostname}`);
  }

  for (let hop = 0; hop < 6; hop++) {
    await assertPublic(current, cfg);
    log.info(`fetching build from ${current.hostname}${hop ? ` (hop ${hop})` : ''}`);

    const res: Response = await fetch(current, {
      headers,
      redirect: 'manual',
      ...(signal ? { signal } : {}),
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new HttpError(502, `${current.hostname} returned ${res.status} with no Location`);
      const next = new URL(location, current);
      // Credentials must not follow the redirect to a different origin.
      if (next.origin !== current.origin) delete (headers as Record<string, string>)['authorization'];
      current = next;
      continue;
    }
    response = res;
    break;
  }

  if (!response) throw new HttpError(502, 'too many redirects fetching the build');
  if (!response.ok) {
    const detail = response.status === 401 || response.status === 403
      ? ' -- if this is a private artifact, pass a token in app.urlHeaders'
      : '';
    throw new HttpError(502, `fetching the build returned ${response.status}${detail}`);
  }
  if (!response.body) throw new HttpError(502, 'the build response had no body');

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > cfg.maxArtifactBytes) {
    throw new HttpError(413, `build is ${(declared / 1e6).toFixed(0)}MB, over the ${(cfg.maxArtifactBytes / 1e6).toFixed(0)}MB limit`);
  }

  // Hand the stream straight to the artifact store: it hashes while writing,
  // enforces the size cap, unpacks and validates that a .app is really inside.
  return artifacts.accept(Readable.fromWeb(response.body as never), {
    uploadedBy: 'url-fetch',
    declaredBytes: cfg.maxArtifactBytes,
    ...(spec.label ? { label: spec.label } : { label: `fetched from ${url.hostname}` }),
  });
}

/**
 * Resolve a GitHub Actions artifact to its download URL.
 *
 * Artifact ids change on every run, so making the agent look one up would put
 * a GitHub token back in its context -- exactly what `buildCredentials` avoids.
 * Resolving here keeps the credential on this machine.
 */
export async function resolveGithubArtifact(
  cfg: Config,
  spec: { repo: string; artifact?: string; runId?: number; branch?: string },
): Promise<{ url: string; label: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(spec.repo)) {
    throw new HttpError(400, `app.github.repo must look like "owner/repo" (got "${spec.repo}")`);
  }
  const auth = cfg.buildCredentials['api.github.com'];
  if (!auth || !Object.keys(auth).length) {
    throw new HttpError(400,
      'no credentials configured for api.github.com. Two ways forward, and the second needs ' +
      'no credentials at all:\n' +
      '  1. Add them to buildCredentials in ~/.simcheck/config.json: ' +
      '{"api.github.com": {"Authorization": "Bearer <token>"}}\n' +
      '  2. Upload the build directly: call `get_upload_command` for a single-use presigned URL, ' +
      'download the artifact yourself, POST it there, and submit the returned artifactId. ' +
      'No GitHub token ever reaches the harness, and it works for IP-restricted repos ' +
      'that cannot be reached from here at all.');
  }

  const base = spec.runId
    ? `https://api.github.com/repos/${spec.repo}/actions/runs/${spec.runId}/artifacts`
    : `https://api.github.com/repos/${spec.repo}/actions/artifacts?per_page=100`;

  const res = await fetch(base, {
    headers: { ...auth, accept: 'application/vnd.github+json', 'user-agent': 'simcheck' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new HttpError(502,
      `listing artifacts for ${spec.repo} returned ${res.status}` +
      (res.status === 401 || res.status === 403 ? ' -- the configured token needs actions:read on that repo' : ''));
  }

  const body = await res.json() as {
    artifacts?: { id: number; name: string; expired: boolean; created_at: string;
                  archive_download_url: string; workflow_run?: { head_branch?: string } }[];
  };
  let candidates = (body.artifacts ?? []).filter((a) => !a.expired);
  if (spec.artifact) candidates = candidates.filter((a) => a.name === spec.artifact);
  if (spec.branch) candidates = candidates.filter((a) => a.workflow_run?.head_branch === spec.branch);

  if (!candidates.length) {
    const what = [spec.artifact && `named "${spec.artifact}"`, spec.branch && `on ${spec.branch}`]
      .filter(Boolean).join(' ');
    throw new HttpError(404,
      `no unexpired artifact ${what} in ${spec.repo}. Artifacts expire (90 days by default) and a ` +
      `failed build produces none.`);
  }
  // Newest first -- "test the latest build" is what a caller almost always means.
  candidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const hit = candidates[0]!;
  return {
    url: hit.archive_download_url,
    label: `${spec.repo} ${hit.name} @ ${hit.created_at.slice(0, 19).replace('T', ' ')}`,
  };
}

/** Scrub header values before anything is written to a log or a run record. */
export const redactHeaders = (h?: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.keys(h ?? {}).map((k) => [k, '<redacted>']));
