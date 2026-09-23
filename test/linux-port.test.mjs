/**
 * S3-S8 of docs/28: the small assumptions that only held on a Mac. Install
 * hints per platform, the ABI hint naming the host's ABI, and extra emulator
 * flags from config reaching the emulator's command line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installHints, noMatchingAbiHint, preferredAbi } from '../dist/android/hints.js';
import { bootEmulator } from '../dist/android/avd.js';
import { tempHome } from './sim-fakes.mjs';

test('install hints: Homebrew on macOS, apt and sdkmanager elsewhere', () => {
  const mac = installHints('darwin');
  assert.match(mac.jdk, /brew install openjdk@21/);
  assert.match(mac.adb, /brew install --cask android-platform-tools/);

  const linux = installHints('linux');
  for (const hint of Object.values(linux)) assert.doesNotMatch(hint, /brew/);
  assert.match(linux.jdk, /apt install openjdk-21-jdk-headless/);
  assert.match(linux.adb, /sdkmanager "platform-tools"/);
  assert.match(linux.sdk, /\/opt\/android-sdk/);
});

test('the no-matching-ABI hint names the host\'s ABI, and ARM translation on x86_64', () => {
  assert.equal(preferredAbi('arm64'), 'arm64-v8a');
  assert.equal(preferredAbi('x64'), 'x86_64');
  assert.match(noMatchingAbiHint('x64'), /x86_64.*ARM translation/s);
  assert.doesNotMatch(noMatchingAbiHint('x64'), /Apple silicon/);
  assert.match(noMatchingAbiHint('arm64'), /arm64-v8a slice/);
});

test('androidEmulatorArgs are appended to the emulator command line', async () => {
  const home = tempHome();
  const argsFile = path.join(home, 'args.txt');
  const emulator = path.join(home, 'emulator');
  fs.writeFileSync(emulator, `#!/bin/sh\necho "$@" > ${argsFile}\n`, { mode: 0o755 });

  const adb = {
    async serialForOrNull() { return 'emulator-5600'; },
    async rawTry() { return { code: 0, stdout: '', stderr: '' }; },
    async shellTry(serial, command) {
      return { code: 0, out: command.includes('boot_completed') ? '1\n' : 'stopped\n' };
    },
  };
  const attached = [];
  await bootEmulator({ emulator, env: {} }, adb, 'avd-x', {
    logDir: home, wipeData: true, gpu: 'swiftshader_indirect', bootTimeoutMs: 30_000,
    extraArgs: ['-dns-server', '1.1.1.1', '-cores', '2'],
    onAttached: async (serial) => { attached.push(serial); },
  });

  const argv = fs.readFileSync(argsFile, 'utf8').trim();
  assert.match(argv, /-no-snapshot-save/);
  assert.match(argv, /-wipe-data -dns-server 1\.1\.1\.1 -cores 2$/, 'after the harness\'s own flags');
  assert.deepEqual(attached, ['emulator-5600'], 'the firewall hook runs once the emulator attaches');
});
