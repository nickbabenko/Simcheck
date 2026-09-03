import { exec, execOk } from '../util.js';
import { logger } from '../log.js';
import type { TouchDriver } from '../device.js';

const log = logger('baguette');

/**
 * Multi-touch driver.
 *
 * AXe speaks a single HID contact -- `axe touch` takes one coordinate pair with
 * no finger index -- so pinch, spread and two-finger pan are not expressible
 * through it. baguette drives the same simulator HID layer with two contacts,
 * which is what makes a gesture claim assertable rather than perceptual.
 *
 * It is an optional dependency: without it, only the multi-touch actions fail,
 * and they fail with an install hint rather than something cryptic.
 */
export class Baguette implements TouchDriver {
  constructor(private bin: string, private udid: string) {}

  private async run(args: string[], signal?: AbortSignal): Promise<void> {
    const out = await execOk(this.bin, [...args, '--udid', this.udid], { timeoutMs: 60_000, ...(signal ? { signal } : {}) });
    // It reports failures as JSON on a zero exit, so the exit code is not enough.
    const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    if (line) {
      try {
        const parsed = JSON.parse(line) as { ok?: boolean; error?: string };
        if (parsed.ok === false) throw new Error(parsed.error ?? `${args[0]} failed`);
      } catch (e) {
        if (e instanceof SyntaxError) return;   // not JSON; treat as success
        throw e;
      }
    }
  }

  /**
   * Two-finger pinch or spread about a point. `startSpread`/`endSpread` are the
   * distance between the fingers in points: end > start spreads (zoom in).
   */
  async pinch(a: {
    cx: number; cy: number; startSpread: number; endSpread: number;
    width: number; height: number; durationMs?: number;
  }, signal?: AbortSignal): Promise<void> {
    await this.run([
      'pinch',
      '--cx', String(Math.round(a.cx)), '--cy', String(Math.round(a.cy)),
      '--start-spread', String(Math.round(a.startSpread)),
      '--end-spread', String(Math.round(a.endSpread)),
      '--width', String(Math.round(a.width)), '--height', String(Math.round(a.height)),
      '--duration', String((a.durationMs ?? 600) / 1000),
    ], signal);
  }

  /**
   * Two contacts placed and held without moving.
   *
   * `pan` with a zero translation is the only way to say this: the driver has
   * no hold primitive, and its `holdMs` field is accepted but ignored -- I
   * measured 0ms, 1500ms and 3000ms all taking ~0.7s. `duration` is what
   * actually keeps the fingers down.
   *
   * This isolates the moment the second finger lands, which a spreading pinch
   * cannot: if an app misreads that landing as a double tap, the zoom happens
   * here, with no travel to explain it away.
   */
  async twoFingerPress(a: {
    x1: number; y1: number; x2: number; y2: number;
    width: number; height: number; holdMs: number;
  }, signal?: AbortSignal): Promise<void> {
    await this.input({
      type: 'pan',
      x1: Math.round(a.x1), y1: Math.round(a.y1),
      x2: Math.round(a.x2), y2: Math.round(a.y2),
      dx: 0, dy: 0,
      width: Math.round(a.width), height: Math.round(a.height),
      duration: a.holdMs / 1000,
    }, signal);
  }

  /** One event through the newline-delimited JSON protocol, which reaches
   *  primitives the flag-based subcommands do not expose. */
  private async input(event: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const out = await execOk(this.bin, ['input', '--udid', this.udid], {
      timeoutMs: 60_000, input: JSON.stringify(event) + '\n',
      ...(signal ? { signal } : {}),
    });
    const ack = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    if (!ack) throw new Error(`the multi-touch driver acknowledged no ${event['type']} event`);
    const parsed = JSON.parse(ack) as { ok?: boolean; error?: string };
    if (parsed.ok === false) throw new Error(parsed.error ?? `${event['type']} was rejected`);
  }

  /** Two fingers moving in parallel -- a map drag, a two-finger scroll. */
  async pan(a: {
    startX: number; startY: number; endX: number; endY: number;
    width: number; height: number; durationMs?: number;
  }, signal?: AbortSignal): Promise<void> {
    await this.run([
      'pan',
      '--start-x', String(Math.round(a.startX)), '--start-y', String(Math.round(a.startY)),
      '--end-x', String(Math.round(a.endX)), '--end-y', String(Math.round(a.endY)),
      '--width', String(Math.round(a.width)), '--height', String(Math.round(a.height)),
      '--duration', String((a.durationMs ?? 600) / 1000),
    ], signal);
  }

  /** A real double tap, so UITapGestureRecognizer(count: 2) fires. */
  async doubleTap(x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.run(['double-tap', '--x', String(Math.round(x)), '--y', String(Math.round(y))], signal);
  }

  static async available(bin: string): Promise<string | null> {
    const r = await exec(bin, ['--version'], { timeoutMs: 15_000 });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  static missingMessage(bin: string): string {
    return `multi-touch needs the "${bin}" CLI, which is not on PATH. Install it with: brew install baguette` +
      ' (Apple Silicon, Xcode 26+). AXe drives a single contact only, so pinch and two-finger pan are not possible without it.';
  }
}
