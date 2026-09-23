/**
 * iOS's "Open in '<App>'?" consent sheet: `open_url` answers it, and recycling
 * clears any that were left stacked up. The sheet's shape is the one AXe's
 * describe-ui reports on an iOS 26.3 simulator.
 * Run with: npm run build && node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findOpenInSheet, acceptOpenIn } from '../dist/ios/consent.js';
import { StepExecutor } from '../dist/steps.js';
import { Store } from '../dist/store.js';
import { Pool } from '../dist/pool.js';
import { tempHome, testConfig, fakeBackend, fakeUi, fakePlatforms, device, run } from './sim-fakes.mjs';

const el = (type, label, x, y, width, height) => ({
  type, label, enabled: true, depth: 0,
  frame: { x, y, width, height }, center: { x: x + width / 2, y: y + height / 2 },
});

/** The home screen with the consent sheet on top, as describe() flattens it. */
function sheetScreen(title = 'Open in “Greyfix”?', labels = ['Cancel', 'Open']) {
  return {
    width: 402, height: 874, units: 'pt', truncated: 0,
    elements: [
      el('Button', 'Books', 30, 100, 64, 64),        // an icon behind the sheet
      el('Sheet', title, 41, 388, 320, 126),
      el('StaticText', title, 71, 409, 260, 20),
      el('Button', labels[0], 57, 450, 140, 48),
      el('Button', labels[1], 205, 450, 140, 48),
      el('Button', 'Open', 150, 780, 100, 40),       // outside the sheet
    ],
  };
}
const emptyScreen = { width: 402, height: 874, units: 'pt', truncated: 0, elements: [] };

/** A UI whose screen is a scripted sequence; the last entry repeats. Each
 *  entry is a Screen or an Error to throw. Taps are recorded. */
function scriptedUi(sequence) {
  const ui = fakeUi();
  const taps = [];
  let i = 0;
  ui.taps = taps;
  ui.describe = async () => {
    const s = sequence[Math.min(i++, sequence.length - 1)];
    if (s instanceof Error) throw s;
    return s;
  };
  ui.tap = async (sel) => { taps.push(sel); };
  return ui;
}

test('finds the sheet and its Open button by frame, not by label alone', () => {
  const sheet = findOpenInSheet(sheetScreen());
  assert.ok(sheet);
  assert.equal(sheet.title, 'Open in “Greyfix”?');
  assert.deepEqual(sheet.open.center, { x: 275, y: 474 }, 'the Open inside the sheet');
  assert.equal(sheet.cancel.label, 'Cancel');
});

test('falls back to the right-hand (default) button when Open is relabelled', () => {
  const sheet = findOpenInSheet(sheetScreen('Open in “Greyfix”?', ['Abbrechen', 'Öffnen']));
  assert.equal(sheet.open.label, 'Öffnen');
  assert.equal(sheet.cancel.label, 'Abbrechen');
});

test('an app\'s own sheet of the same shape is left alone', () => {
  assert.equal(findOpenInSheet(sheetScreen('Delete “Draft”?', ['Cancel', 'Delete'])), null);
  assert.equal(findOpenInSheet(emptyScreen), null);
});

test('acceptOpenIn retries a read that fails while the sheet animates in', async () => {
  const ui = scriptedUi([
    new Error('No translation object returned for simulator'),
    emptyScreen,
    sheetScreen(),
  ]);
  const title = await acceptOpenIn(ui, { windowMs: 2000, pollMs: 1 });
  assert.equal(title, 'Open in “Greyfix”?');
  assert.deepEqual(ui.taps, [{ x: 275, y: 474 }], 'tapped Open by its point, once');
});

test('acceptOpenIn gives up quietly when no sheet comes (http links)', async () => {
  const ui = scriptedUi([emptyScreen]);
  assert.equal(await acceptOpenIn(ui, { windowMs: 30, pollMs: 5 }), null);
  assert.equal(ui.taps.length, 0);
});

function executor(ui, backend = fakeBackend()) {
  const home = tempHome();
  const cfg = testConfig(home);
  const store = new Store(cfg);
  const runDir = path.join(home, 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  store.create(run('r1', { status: 'running' }));
  const exec = new StepExecutor(ui, backend, store, {
    runId: 'r1', udid: 'U1', app: { appId: 'dev.simbase.greyfix', executable: 'Fixture' },
    runDir, launchArgs: [], launchEnv: {}, signal: new AbortController().signal,
  }, undefined);
  exec.consentWindowMs = 50;
  return { exec, store, backend };
}

test('open_url answers the consent sheet and says so in the trace', async () => {
  const ui = scriptedUi([sheetScreen(), emptyScreen]);
  const { exec, store, backend } = executor(ui);
  await exec.run({ action: 'open_url', url: 'greyfix://detail/1' });

  assert.ok(backend.calls.includes('openUrl:U1:greyfix://detail/1'));
  assert.deepEqual(ui.taps, [{ x: 275, y: 474 }]);
  const trace = store.get('r1').trace;
  const note = trace.find((t) => t.kind === 'note');
  assert.match(note.text, /Open in “Greyfix”\?/);
  assert.match(note.text, /tapped Open/);
  const step = trace.find((t) => t.kind === 'step');
  assert.match(step.text, /consent sheet/);
});

test('open_url with no sheet taps nothing and notes nothing', async () => {
  const ui = scriptedUi([emptyScreen]);
  const { exec, store } = executor(ui);
  await exec.run({ action: 'open_url', url: 'https://example.com/x' });
  assert.equal(ui.taps.length, 0);
  assert.equal(store.get('r1').trace.filter((t) => t.kind === 'note').length, 0);
});

test('open_url on Android does not look for the iOS sheet', async () => {
  const ui = scriptedUi([sheetScreen()]);
  const backend = { ...fakeBackend(), platform: 'android' };
  const { exec } = executor(ui, backend);
  await exec.run({ action: 'open_url', url: 'app://x' });
  assert.equal(ui.taps.length, 0);
});

test('recycling dismisses every stacked consent sheet via Cancel, without a reboot', async () => {
  let stacked = 6;
  const ui = fakeUi();
  const taps = [];
  ui.describe = async () => (stacked > 0 ? sheetScreen() : emptyScreen);
  ui.tap = async (sel) => { taps.push(sel); stacked--; };
  const platforms = fakePlatforms({ ui });

  const home = tempHome();
  fs.writeFileSync(path.join(home, 'pool.json'), JSON.stringify([device('A', { status: 'leased', currentRunId: 'r1' })]));
  const pool = new Pool(testConfig(home), platforms);
  pool.load();
  pool.settleMs = 1;

  await pool.release('A', { bundleId: 'com.x', uninstall: true, policy: 'uninstall' });
  assert.equal(stacked, 0, 'all six sheets answered');
  assert.equal(taps.length, 6);
  assert.ok(taps.every((t) => t.x === 127 && t.y === 474), 'always Cancel -- never let a stale link through');
  assert.equal(pool.get('A').status, 'ready');
  assert.ok(!platforms.backend.calls.some((c) => c.startsWith('shutdown:')), 'no reboot needed');
});
