import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { exec, execOk } from '../util.js';
import { logger } from '../log.js';

const log = logger('adb');

export interface AttachedDevice {
  serial: string;
  /** device | offline | unauthorized | bootloader */
  state: string;
}

/**
 * Talks to emulators through adb, keyed by AVD name rather than serial.
 *
 * An emulator's serial (`emulator-5554`) is assigned from whichever console
 * port was free at boot, so it does not survive a restart -- which makes it
 * useless as the pool's stable identity. The AVD name does survive, so that is
 * what the harness stores and what every method here takes. Mapping one to the
 * other costs an `emu avd name` per attached emulator, so it is cached and
 * invalidated whenever the attached set changes.
 */
export class Adb {
  /** avd name -> serial, for emulators seen attached. */
  private serials = new Map<string, string>();
  /** The attached set the cache was built from, to spot changes cheaply. */
  private lastSeen = '';

  constructor(private bin: string, private env: NodeJS.ProcessEnv = {}) {}

  /** Every attached device, emulator or otherwise. */
  async devices(): Promise<AttachedDevice[]> {
    const out = await execOk(this.bin, ['devices'], { timeoutMs: 30_000, env: this.env });
    return out.split('\n')
      .slice(1)                                  // drop "List of devices attached"
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial, state] = l.split(/\s+/);
        return { serial: serial!, state: state ?? 'unknown' };
      })
      .filter((d) => d.serial.startsWith('emulator-'));
  }

  /** The AVD an attached emulator was booted from, or null if it will not say. */
  async avdName(serial: string): Promise<string | null> {
    const r = await exec(this.bin, ['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: 15_000, env: this.env });
    if (r.code !== 0) return null;
    // Replies with the name, then a bare "OK" acknowledgement line.
    const first = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0];
    return first && first !== 'OK' ? first : null;
  }

  /** Rebuild the avd->serial map from what is attached right now. */
  async refresh(): Promise<Map<string, string>> {
    const attached = (await this.devices()).filter((d) => d.state === 'device');
    const key = attached.map((d) => d.serial).sort().join(',');
    if (key === this.lastSeen && this.serials.size) return this.serials;

    const fresh = new Map<string, string>();
    for (const d of attached) {
      const name = await this.avdName(d.serial);
      if (name) fresh.set(name, d.serial);
    }
    this.serials = fresh;
    this.lastSeen = key;
    return fresh;
  }

  /** The serial for a booted AVD, or null when it is not running. */
  async serialForOrNull(avd: string): Promise<string | null> {
    const cached = this.serials.get(avd);
    if (cached) {
      // Trust the cache only while that serial is still attached and is still
      // this AVD -- a restarted emulator can take a serial another one had.
      const attached = await this.devices();
      if (attached.some((d) => d.serial === cached && d.state === 'device')
          && (await this.avdName(cached)) === avd) {
        return cached;
      }
      this.serials.delete(avd);
      this.lastSeen = '';
    }
    return (await this.refresh()).get(avd) ?? null;
  }

  async serialFor(avd: string): Promise<string> {
    const serial = await this.serialForOrNull(avd);
    if (!serial) throw new Error(`emulator "${avd}" is not running (no attached device reports that AVD name)`);
    return serial;
  }

  /** Forget a mapping, e.g. after killing an emulator. */
  forget(avd: string): void {
    this.serials.delete(avd);
    this.lastSeen = '';
  }

  /* ------------------------------------------------------------- plumbing -- */

  /** Raw adb call against one serial. */
  async raw(serial: string, args: string[], opts: { timeoutMs?: number; signal?: AbortSignal; input?: string } = {}): Promise<string> {
    return execOk(this.bin, ['-s', serial, ...args], { timeoutMs: 60_000, env: this.env, ...opts });
  }

  /** Raw adb call that is allowed to fail; the caller reads the code. */
  rawTry(serial: string, args: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    return exec(this.bin, ['-s', serial, ...args], { timeoutMs: 60_000, env: this.env, ...opts });
  }

  /**
   * Run a shell command on the device.
   *
   * adb has propagated the remote exit status since platform-tools 24, so a
   * failing command surfaces as a non-zero exit rather than as empty output.
   * Line endings are normalised: the shell hands back CRLF, and a stray \r
   * turns an exact string comparison into a mystery.
   */
  async shell(serial: string, command: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
    const out = await this.raw(serial, ['shell', command], opts);
    return out.replace(/\r\n/g, '\n');
  }

  async shellTry(serial: string, command: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ code: number; out: string }> {
    const r = await this.rawTry(serial, ['shell', command], opts);
    return { code: r.code, out: (r.stdout + r.stderr).replace(/\r\n/g, '\n') };
  }

  /**
   * Stream a binary adb response straight to a file.
   *
   * `exec-out` exists precisely so binary payloads bypass the pty that would
   * otherwise translate 0x0a into 0x0d0a and corrupt a PNG. Capturing it as a
   * string would undo that, so it never becomes a JS string at all.
   */
  execOutToFile(serial: string, args: string[], outPath: string, timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(outPath);
      const child = spawn(this.bin, ['-s', serial, 'exec-out', ...args], {
        env: { ...process.env, ...this.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
      child.stdout.pipe(out);
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (e) => { clearTimeout(timer); out.close(); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        out.close(() => {
          if (code === 0) resolve();
          else reject(new Error(`adb exec-out ${args.join(' ')} exited ${code}: ${stderr.trim().slice(0, 500)}`));
        });
      });
    });
  }

  /** Version string, or null when adb is not usable. */
  async version(): Promise<string | null> {
    const r = await exec(this.bin, ['--version'], { timeoutMs: 15_000, env: this.env });
    if (r.code !== 0) return null;
    return r.stdout.split('\n')[0]?.trim() ?? 'adb';
  }
}

/** Wait until the device answers and Android says it has finished booting. */
export async function waitForBoot(
  adb: Adb, serial: string, timeoutMs: number, signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await adb.rawTry(serial, ['wait-for-device'], { timeoutMs, ...(signal ? { signal } : {}) });

  for (;;) {
    if (signal?.aborted) throw new Error('cancelled while waiting for the emulator to boot');
    // sys.boot_completed goes to 1 before the launcher is drawn; bootanim
    // stopping is the signal that the shell is actually usable, and taps
    // before that land on the boot animation and do nothing.
    const booted = await adb.shellTry(serial, 'getprop sys.boot_completed', { timeoutMs: 15_000 });
    const anim = await adb.shellTry(serial, 'getprop init.svc.bootanim', { timeoutMs: 15_000 });
    if (booted.out.trim() === '1' && anim.out.trim() === 'stopped') return;
    if (Date.now() >= deadline) {
      throw new Error(
        `emulator ${serial} did not finish booting within ${Math.round(timeoutMs / 1000)}s ` +
        `(sys.boot_completed=${booted.out.trim() || 'unset'}, bootanim=${anim.out.trim() || 'unknown'})`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export { log as adbLog };
