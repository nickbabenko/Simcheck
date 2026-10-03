import type { Config } from '../config.js';
import { exec } from '../util.js';
import { logger } from '../log.js';

const log = logger('simslim');

/**
 * simslim disables the ~170 background daemons a simulator does not need for
 * UI testing -- Siri, Spotlight, photo analysis, iCloud, widgets -- which cuts
 * a booted simulator's resident memory roughly 4x. More of the pool fits in
 * RAM on the same Mac.
 *
 * It trades capability for that memory, and the harness cannot know which
 * capabilities a scenario under test needs. `simslimExcept` is what keeps a
 * category enabled; it defaults to ["web"] because that category owns
 * com.apple.swcd, and without swcd a universal link opens Safari instead of
 * the app under test -- a failure that looks like an app bug rather than a
 * harness setting.
 */

/** Whether simslim is on PATH. Cached: it cannot change under a live daemon. */
let available: boolean | null = null;

export async function isAvailable(bin: string): Promise<boolean> {
  if (available !== null) return available;
  const r = await exec(bin, ['version'], { timeoutMs: 15_000 });
  available = r.code === 0;
  return available;
}

const listFlags = (flag: string, values: string[]): string[] =>
  values.length ? [flag, values.join(',')] : [];

/**
 * Slim a booted simulator, repairing it only when it has drifted.
 *
 * `on` walks all ~160 daemons and costs ~18s even when every one is already
 * stopped, which the pool would otherwise pay on every boot. The overrides
 * persist, so a device that was slimmed once comes back slim; `verify` settles
 * that in ~1.4s. Erase is what resets them to stock, and that is exactly the
 * drift verify catches.
 *
 * `--no-reboot` rather than a persisting run: the pool boots devices itself,
 * and letting simslim reboot them would add a second boot cycle to a path that
 * has just finished one.
 */
export async function slim(cfg: Config, udid: string): Promise<void> {
  if (!cfg.simslim) return;
  if (!await isAvailable(cfg.simslimBin)) {
    log.warn(
      `simslim is enabled but "${cfg.simslimBin}" is not on PATH; booting stock. ` +
      'Install it with: brew install mobai-app/tap/simslim');
    return;
  }

  const profile = [
    ...listFlags('--except', cfg.simslimExcept),
    ...listFlags('--keep', cfg.simslimKeep),
  ];

  const check = await exec(cfg.simslimBin, ['verify', udid, ...profile], { timeoutMs: 60_000 });
  if (check.code === 0) return;                    // already slim, nothing to pay

  const r = await exec(cfg.simslimBin,
    ['on', udid, '--no-reboot', ...profile],
    { timeoutMs: cfg.simslimTimeoutMs });
  if (r.code !== 0) {
    // A stock simulator is slower and fatter but entirely usable, so this
    // must never fail a run.
    log.warn(`simslim on ${udid} exited ${r.code}; continuing stock`,
      (r.stderr || r.stdout).trim().slice(0, 300));
    return;
  }

  // Slimming is only safe if it left the features tests depend on alive, and
  // the categories/daemons interact -- `doctor` is the authoritative check.
  if (cfg.simslimRequires.length) {
    const d = await exec(cfg.simslimBin,
      ['doctor', udid, '--requires', cfg.simslimRequires.join(',')],
      { timeoutMs: 60_000 });
    if (d.code !== 0) {
      log.warn(
        `simslim disabled a feature this harness requires (${cfg.simslimRequires.join(', ')}) on ${udid}. ` +
        'Add the owning category to simslimExcept in ~/.simcheck/config.json.',
        (d.stdout || d.stderr).trim().slice(0, 300));
    }
  }
  log.info(`slimmed ${udid}${cfg.simslimExcept.length ? ` (kept: ${cfg.simslimExcept.join(', ')})` : ''}`);
}
