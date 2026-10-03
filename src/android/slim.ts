import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../log.js';

const log = logger('avd');

/**
 * Hardware and services an AVD created by `avdmanager` switches on by default
 * and a headless UI-test emulator never uses.
 *
 * avdmanager derives config.ini from the device profile (pixel_7), which
 * describes a phone someone holds -- cameras, GPS, a modem, nine sensors, an
 * SD card. Each emulated peripheral is a backend qemu starts and Android
 * probes on boot, so switching them off cuts both boot time and resident
 * memory. None of them are reachable from a simcheck scenario anyway.
 *
 * Deliberately left alone:
 *   hw.battery      some apps read charge state on launch and misbehave at 0
 *   hw.lcd.*        screenshots are the product; resolution and density stay
 *   hw.ramSize      below ~2G the system_server starts being OOM-killed
 *   vm.heapSize     the per-app limit, not an allocation
 */
export const SLIM_CONFIG: Record<string, string> = {
  // Peripherals with no scenario-level API surface.
  'hw.audioInput': 'no',
  'hw.audioOutput': 'no',
  'hw.camera.back': 'none',
  'hw.camera.front': 'none',
  'hw.gps': 'no',
  'hw.gsmModem': 'no',
  'hw.sdCard': 'no',
  'hw.dPad': 'no',
  'hw.trackBall': 'no',
  'hw.rotaryInput': 'no',

  // Sensors. Android starts a listener thread per enabled sensor.
  'hw.accelerometer': 'no',
  'hw.accelerometer_uncalibrated': 'no',
  'hw.gyroscope': 'no',
  'hw.sensors.gyroscope_uncalibrated': 'no',
  'hw.sensors.humidity': 'no',
  'hw.sensors.light': 'no',
  'hw.sensors.magnetic_field': 'no',
  'hw.sensors.magnetic_field_uncalibrated': 'no',
  'hw.sensors.orientation': 'no',
  'hw.sensors.pressure': 'no',
  'hw.sensors.proximity': 'no',
  'hw.sensors.temperature': 'no',

  // Headless: there is no window to draw a frame around.
  'showDeviceFrame': 'no',

  // The pool's contract is that a recycled device is clean, so a snapshot is
  // never read back. Writing one would only cost disk and shutdown time.
  'fastboot.forceColdBoot': 'yes',
  'fastboot.forceFastBoot': 'no',
  'firstboot.saveToLocalSnapshot': 'no',
  'firstboot.bootFromLocalSnapshot': 'no',
  'firstboot.bootFromDownloadableSnapshot': 'no',
};

/** Keys that are removed outright rather than set to a value. */
const DROP = ['sdcard.size'];

const avdHome = (): string =>
  process.env['ANDROID_AVD_HOME'] || path.join(os.homedir(), '.android', 'avd');

export const configPath = (name: string): string =>
  path.join(avdHome(), `${name}.avd`, 'config.ini');

/**
 * Merge the slim settings into an AVD's config.ini, preserving key order and
 * every key we do not own.
 *
 * `dataPartitionMb` sizes userdata. avdmanager's 6G default is a ceiling, not
 * an allocation -- the qcow2 is sparse -- but Android will happily grow into
 * it, and a long-lived pool device does: the measured case reached 5.4G of
 * real blocks. A smaller ceiling bounds that. It only takes effect on a
 * wiped or freshly created AVD, since the partition already exists otherwise.
 */
export function applySlimConfig(name: string, dataPartitionMb: number): boolean {
  const file = configPath(name);
  let original: string;
  try { original = fs.readFileSync(file, 'utf8'); }
  catch { log.warn(`no config.ini for AVD ${name}; left stock`); return false; }

  const wanted: Record<string, string> = { ...SLIM_CONFIG };
  if (dataPartitionMb > 0) wanted['disk.dataPartition.size'] = `${dataPartitionMb}M`;

  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of original.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0 || line.startsWith('#')) { out.push(line); continue; }
    const key = line.slice(0, eq).trim();
    if (DROP.includes(key)) continue;
    if (key in wanted) {
      seen.add(key);
      out.push(`${key}=${wanted[key]}`);
      continue;
    }
    out.push(line);
  }

  // Keys the profile never wrote still need to be present.
  const missing = Object.keys(wanted).filter((k) => !seen.has(k)).sort();
  if (missing.length) {
    const tail = out[out.length - 1] === '' ? out.pop() : undefined;
    for (const k of missing) out.push(`${k}=${wanted[k]}`);
    if (tail !== undefined) out.push(tail);
  }

  const next = out.join('\n');
  if (next === original) return false;
  fs.writeFileSync(file, next);
  log.info(
    `slimmed AVD ${name}: peripherals and sensors off, cold boot, ` +
    `userdata capped at ${dataPartitionMb}M`);
  return true;
}
