import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import type { Config } from './config.js';
import { paths } from './config.js';
import { execOk, nowIso, HttpError } from './util.js';
import { logger } from './log.js';

const log = logger('artifacts');

export interface Artifact {
  id: string;              // content-addressed: the sha256 of the upload
  bundleId: string;
  appName: string;
  bytes: number;
  uploadedAt: string;
  uploadedBy: string;      // token name
  label?: string;
  gitSha?: string;
  /** Absolute path to the unpacked .app. */
  appPath: string;
}

/**
 * Content-addressed store of uploaded simulator .app bundles.
 *
 * Uploading the same build twice costs one hash and no disk, which is what
 * makes "build locally, test from elsewhere" cheap to repeat.
 */
export class ArtifactStore {
  private root: string;

  constructor(private cfg: Config) {
    this.root = path.join(cfg.home, 'artifacts');
  }

  init(): void { fs.mkdirSync(this.root, { recursive: true }); }

  dir(id: string): string { return path.join(this.root, id); }

  get(id: string): Artifact | null {
    if (!/^[a-f0-9]{16,64}$/.test(id)) return null;      // never let an id become a path
    const meta = path.join(this.dir(id), 'artifact.json');
    if (!fs.existsSync(meta)) return null;
    try { return JSON.parse(fs.readFileSync(meta, 'utf8')) as Artifact; }
    catch { return null; }
  }

  list(): Artifact[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root)
      .map((id) => this.get(id))
      .filter((a): a is Artifact => a !== null)
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  /**
   * Stream a zipped .app to disk, hash it, unpack it and read its Info.plist.
   * Hashing while streaming avoids holding a 200MB upload in memory.
   */
  async accept(body: Readable, opts: {
    uploadedBy: string; label?: string; gitSha?: string; declaredBytes?: number;
  }): Promise<Artifact> {
    this.init();
    const staging = path.join(this.root, `.incoming-${crypto.randomBytes(6).toString('hex')}.zip`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;

    try {
      await pipeline(
        body,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            bytes += chunk.length;
            if (bytes > opts.declaredBytes!) throw new HttpError(413, 'upload exceeds the configured size limit');
            hash.update(chunk);
            yield chunk;
          }
        },
        fs.createWriteStream(staging),
      );

      if (bytes === 0) throw new HttpError(400, 'empty upload -- send a zip of a simulator .app bundle');
      const id = hash.digest('hex').slice(0, 32);
      const dest = this.dir(id);

      // Identical build already here: reuse the stored copy, but refresh the
      // caller's metadata. Returning a stale label would misreport which branch
      // or commit the build under test came from.
      const existing = this.get(id);
      if (existing) {
        const refreshed: Artifact = {
          ...existing,
          uploadedAt: nowIso(),
          uploadedBy: opts.uploadedBy,
          ...(opts.label ? { label: opts.label } : {}),
          ...(opts.gitSha ? { gitSha: opts.gitSha } : {}),
        };
        fs.writeFileSync(path.join(this.dir(id), 'artifact.json'), JSON.stringify(refreshed, null, 2));
        log.info(`artifact ${id} already stored, reusing (metadata refreshed)`);
        return refreshed;
      }

      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      await execOk('/usr/bin/ditto', ['-x', '-k', staging, path.join(dest, 'unpacked')], { timeoutMs: 600_000 });

      let appPath = findApp(path.join(dest, 'unpacked'));

      // GitHub Actions re-zips whatever you upload and drops the executable
      // bit, so the usual recipe is to `ditto` the .app into a zip first --
      // which arrives here as a zip inside a zip. Unwrap one more level rather
      // than making every CI pipeline special-case it.
      if (!appPath) {
        const inner = findZip(path.join(dest, 'unpacked'));
        if (inner) {
          log.info(`no .app at the top level; unwrapping nested ${path.basename(inner)}`);
          await execOk('/usr/bin/ditto', ['-x', '-k', inner, path.join(dest, 'nested')], { timeoutMs: 600_000 });
          appPath = findApp(path.join(dest, 'nested'));
        }
      }
      if (!appPath) {
        fs.rmSync(dest, { recursive: true, force: true });
        throw new HttpError(400, 'no .app bundle found inside the uploaded zip');
      }
      if (fs.existsSync(path.join(appPath, 'embedded.mobileprovision'))) {
        fs.rmSync(dest, { recursive: true, force: true });
        throw new HttpError(400,
          'that is a device build -- it carries an embedded provisioning profile. ' +
          'Simulator builds come from a "platform=iOS Simulator" destination.');
      }

      const bundleId = plist(appPath, 'CFBundleIdentifier');
      if (!bundleId) {
        fs.rmSync(dest, { recursive: true, force: true });
        throw new HttpError(400, `could not read CFBundleIdentifier from ${path.basename(appPath)}/Info.plist`);
      }

      const artifact: Artifact = {
        id, bundleId, appPath,
        appName: path.basename(appPath),
        bytes,
        uploadedAt: nowIso(),
        uploadedBy: opts.uploadedBy,
        ...(opts.label ? { label: opts.label } : {}),
        ...(opts.gitSha ? { gitSha: opts.gitSha } : {}),
      };
      fs.writeFileSync(path.join(dest, 'artifact.json'), JSON.stringify(artifact, null, 2));
      log.info(`stored artifact ${id} (${artifact.appName}, ${(bytes / 1e6).toFixed(1)}MB) from ${opts.uploadedBy}`);
      return artifact;
    } finally {
      fs.rmSync(staging, { force: true });
    }
  }

  /** Drop artifacts older than the retention window, newest always kept. */
  prune(days: number): void {
    if (!days) return;
    const cutoff = Date.now() - days * 86_400_000;
    for (const a of this.list().slice(1)) {
      if (Date.parse(a.uploadedAt) < cutoff) {
        fs.rmSync(this.dir(a.id), { recursive: true, force: true });
        log.info(`pruned artifact ${a.id} (${a.appName})`);
      }
    }
  }
}

/** A single .zip inside the unpacked tree, for the nested case above. */
function findZip(dir: string, depth = 0): string | null {
  if (depth > 3) return null;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.zip') && !e.name.startsWith('.')) {
      return path.join(dir, e.name);
    }
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === '__MACOSX') continue;
    const hit = findZip(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

function findApp(dir: string, depth = 0): string | null {
  if (depth > 4) return null;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isDirectory() && e.name.endsWith('.app')) return path.join(dir, e.name);
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === '__MACOSX') continue;
    const hit = findApp(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

function plist(appPath: string, key: string): string | undefined {
  const r = spawnSync('/usr/libexec/PlistBuddy',
    ['-c', `Print :${key}`, path.join(appPath, 'Info.plist')], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).trim() || undefined : undefined;
}
