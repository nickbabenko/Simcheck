/**
 * Pinch fidelity: that a requested scale reaches the driver as distinct
 * geometry, that scale < 1 closes rather than spreads, and that a step naming
 * an unimplemented parameter fails instead of being silently dropped.
 * Run with: node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePinch, validateSteps } from '../dist/steps.js';

const SCREEN = { width: 402, height: 874 };   // iPhone 17 Pro, points

test('distinct scales produce distinct geometry', () => {
  const seen = new Set();
  for (const scale of [3.0, 1.5, 0.4]) {
    const r = resolvePinch({ scale }, SCREEN);
    seen.add(`${Math.round(r.startSpread)}->${Math.round(r.endSpread)}`);
  }
  assert.equal(seen.size, 3, 'each scale must drive a different spread');
});

test('scale is honoured as the end/start ratio', () => {
  for (const scale of [3.0, 1.5, 2.0]) {
    const r = resolvePinch({ scale }, SCREEN);
    assert.ok(Math.abs(r.effectiveScale - scale) < 0.01, `${scale} came out as ${r.effectiveScale}`);
  }
});

test('scale below 1 closes the fingers instead of spreading them', () => {
  const r = resolvePinch({ scale: 0.4 }, SCREEN);
  assert.ok(r.endSpread < r.startSpread, 'an inward pinch must end narrower than it started');
  assert.ok(Math.abs(r.effectiveScale - 0.4) < 0.01);
  assert.ok(r.startSpread <= SCREEN.width, 'the wide start must still fit on screen');
});

test('explicit distances override scale', () => {
  const r = resolvePinch({ scale: 3, startSpread: 100, endSpread: 200 }, SCREEN);
  assert.equal(r.startSpread, 100);
  assert.equal(r.endSpread, 200);
});

test('an impossible scale is clamped and says so', () => {
  const r = resolvePinch({ scale: 0.01 }, SCREEN);
  assert.equal(r.clamped, true, 'clamping must be reported, not hidden');
  assert.equal(r.requestedScale, 0.01);
  assert.ok(r.effectiveScale > 0.01, 'the effective ratio differs once clamped');
  assert.ok(r.startSpread <= SCREEN.width);
});

test('both contacts stay on screen', () => {
  for (const scale of [1, 3, 8, 0.1]) {
    const r = resolvePinch({ scale }, SCREEN);
    for (const s of [r.startSpread, r.endSpread]) {
      assert.ok(r.cx - s / 2 >= 0, `left contact off screen at scale ${scale}`);
      assert.ok(r.cx + s / 2 <= SCREEN.width, `right contact off screen at scale ${scale}`);
    }
  }
});

test('an unimplemented parameter is rejected, not dropped', () => {
  assert.throws(() => validateSteps([{ action: 'pinch', zoomFactor: 3 }]),
    /unsupported key "zoomFactor"/, 'the offending key must be named');
  assert.throws(() => validateSteps([{ action: 'nope' }]), /unknown action "nope"/);
  assert.doesNotThrow(() => validateSteps([
    { action: 'pinch', scale: 0.4 },
    { action: 'two_finger_press', cx: 200, cy: 400, gap: 90, holdMs: 1200 },
  ]));
});

test('a missing required parameter is caught at submit, not as NaN downstream', () => {
  assert.throws(() => validateSteps([{ action: 'swipe', x1: 10, y1: 20 }]),
    /unsupported keys "x1", "y1"/, 'wrong key names must be named');
  assert.throws(() => validateSteps([{ action: 'swipe', startX: 10 }]),
    /missing required keys "startY", "endX", "endY".*swipe needs/s);
  assert.throws(() => validateSteps([{ action: 'swipe', startX: 'a', startY: 0, endX: 1, endY: 2 }]),
    /"startX" must be a finite number/);
  assert.throws(() => validateSteps([{ action: 'tap' }]), /at least one of/);
});
