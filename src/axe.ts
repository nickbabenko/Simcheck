import { exec, execOk, sleep } from './util.js';
import type { GesturePreset, HardwareButton } from './types.js';

/** One node of AXe's `describe-ui` output, trimmed to what we use. */
interface AxNodeRaw {
  AXLabel?: string | null;
  AXUniqueId?: string | null;
  AXValue?: string | null;
  type?: string | null;
  role?: string | null;
  role_description?: string | null;
  help?: string | null;
  title?: string | null;
  enabled?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  children?: AxNodeRaw[];
}

export interface AxElement {
  type: string;
  label?: string;
  id?: string;
  value?: string;
  enabled: boolean;
  center: { x: number; y: number };
  frame: { x: number; y: number; width: number; height: number };
  depth: number;
}

export interface Screen {
  width: number;
  height: number;
  elements: AxElement[];
  /** Elements dropped by the cap, so the model knows the view is partial. */
  truncated: number;
}

/** Failures that mean "the simulator was not ready", not "the app is wrong". */
const TRANSIENT = /creating the simulator remote automation session|Failed to connect to the simulator|Lost connection to the simulator|device is booting/i;

/** Container roles carry no interaction affordance and would swamp the model. */
const NOISE_TYPES = new Set(['Application', 'Window', 'Group', 'Other', 'Unknown', 'ScrollView']);

/** Types worth surfacing even with no label -- the model can still tap them. */
const ALWAYS_KEEP = new Set([
  'Button', 'TextField', 'SecureTextField', 'SearchField', 'Switch', 'Slider',
  'Link', 'Cell', 'TabBar', 'MenuItem', 'Picker', 'PickerWheel', 'Stepper',
  'SegmentedControl', 'CheckBox', 'RadioButton', 'TextView',
]);

export class Axe {
  constructor(private bin: string, private udid: string) {}

  /**
   * CoreSimulator intermittently refuses to open an automation session on a
   * device that has just booted or been recycled. That failure is transient and
   * says nothing about the app, so retry it -- but only it, so genuine failures
   * (a missing element, a bad selector) still surface immediately.
   */
  private async run(
    args: string[],
    opts: { timeoutMs?: number; signal?: AbortSignal; input?: string } = {},
  ): Promise<string> {
    const argv = [...args, '--udid', this.udid];
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await execOk(this.bin, argv, { timeoutMs: 60_000, ...opts });
      } catch (e) {
        lastError = e as Error;
        if (!TRANSIENT.test(lastError.message) || opts.signal?.aborted) throw lastError;
        await sleep(1500 * (attempt + 1), opts.signal);
      }
    }
    throw lastError!;
  }

  /** The accessibility tree, flattened and compressed for an LLM prompt.
   *  Raw describe-ui output runs to ~120KB; this yields a couple of KB. */
  async describe(signal?: AbortSignal, cap = 120): Promise<Screen> {
    const raw = await this.run(['describe-ui'], { signal, timeoutMs: 45_000 });
    let tree: AxNodeRaw[];
    try {
      tree = JSON.parse(raw) as AxNodeRaw[];
    } catch {
      throw new Error(`axe describe-ui returned unparseable output: ${raw.slice(0, 300)}`);
    }

    const root = tree[0]?.frame;
    const width = root?.width ?? 0;
    const height = root?.height ?? 0;
    const collected: AxElement[] = [];

    const visit = (node: AxNodeRaw, depth: number): void => {
      const type = (node.type || node.role_description || node.role || 'Unknown').replace(/^AX/, '');
      const label = clean(node.AXLabel) ?? clean(node.title) ?? clean(node.help);
      const id = clean(node.AXUniqueId);
      const value = clean(node.AXValue);
      const f = node.frame;

      const meaningful = Boolean(label || id || value);
      const interactive = ALWAYS_KEEP.has(type);
      const visible = !!f && f.width > 0 && f.height > 0;

      if (visible && (interactive || (meaningful && !NOISE_TYPES.has(type)))) {
        collected.push({
          type,
          ...(label ? { label } : {}),
          ...(id ? { id } : {}),
          ...(value ? { value } : {}),
          enabled: node.enabled !== false,
          center: { x: Math.round(f!.x + f!.width / 2), y: Math.round(f!.y + f!.height / 2) },
          frame: { x: Math.round(f!.x), y: Math.round(f!.y), width: Math.round(f!.width), height: Math.round(f!.height) },
          depth,
        });
      }
      for (const child of node.children ?? []) visit(child, depth + 1);
    };
    for (const node of tree) visit(node, 0);

    // Reading order: top to bottom, then left to right.
    collected.sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
    const truncated = Math.max(0, collected.length - cap);
    return { width, height, elements: collected.slice(0, cap), truncated };
  }

  async screenshot(outPath: string, signal?: AbortSignal): Promise<void> {
    await this.run(['screenshot', '--output', outPath], { signal, timeoutMs: 60_000 });
  }

  async tap(sel: { id?: string; label?: string; value?: string; elementType?: string; x?: number; y?: number; waitTimeoutMs?: number }, signal?: AbortSignal): Promise<void> {
    const args = ['tap'];
    if (sel.x !== undefined && sel.y !== undefined) {
      args.push('-x', String(Math.round(sel.x)), '-y', String(Math.round(sel.y)));
    } else if (sel.id) args.push('--id', sel.id);
    else if (sel.label) args.push('--label', sel.label);
    else if (sel.value) args.push('--value', sel.value);
    else throw new Error('tap needs one of: x/y, id, label, value');

    if (sel.elementType) args.push('--element-type', sel.elementType);
    // Poll for the element rather than failing on a view that is still animating in.
    if (sel.x === undefined) args.push('--wait-timeout', String((sel.waitTimeoutMs ?? 5000) / 1000));
    await this.run(args, { signal });
  }

  /** Text goes over stdin so shell quoting can never mangle it. */
  async type(text: string, signal?: AbortSignal): Promise<void> {
    await this.run(['type', '--stdin'], { input: text, signal, timeoutMs: 120_000 });
  }

  /** HID keycode 42 = Delete/Backspace. */
  async clearText(signal?: AbortSignal, presses = 60): Promise<void> {
    await this.run(['key-sequence', '--keycodes', Array(presses).fill(42).join(','), '--delay', '0.02'], { signal, timeoutMs: 120_000 });
  }

  /** HID keycode 40 = Return. */
  async pressEnter(signal?: AbortSignal): Promise<void> {
    await this.run(['key', '40'], { signal });
  }

  async swipe(a: { startX: number; startY: number; endX: number; endY: number; durationMs?: number }, signal?: AbortSignal): Promise<void> {
    const args = ['swipe',
      '--start-x', String(Math.round(a.startX)), '--start-y', String(Math.round(a.startY)),
      '--end-x', String(Math.round(a.endX)), '--end-y', String(Math.round(a.endY))];
    if (a.durationMs) args.push('--duration', String(a.durationMs / 1000));
    await this.run(args, { signal });
  }

  async gesture(preset: GesturePreset, screen: { width: number; height: number }, durationMs?: number, signal?: AbortSignal): Promise<void> {
    const args = ['gesture', preset];
    if (screen.width) args.push('--screen-width', String(screen.width), '--screen-height', String(screen.height));
    if (durationMs) args.push('--duration', String(durationMs / 1000));
    await this.run(args, { signal });
  }

  async button(button: HardwareButton, durationMs?: number, signal?: AbortSignal): Promise<void> {
    const args = ['button', button];
    if (durationMs) args.push('--duration', String(durationMs / 1000));
    await this.run(args, { signal });
  }

  /** Poll the tree until a matching element appears. Returns false on timeout. */
  async waitFor(sel: { id?: string; label?: string }, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = await this.describe(signal).catch(() => null);
      if (screen?.elements.some((e) =>
        (sel.id && e.id === sel.id) ||
        (sel.label && (e.label === sel.label || e.label?.includes(sel.label))))) return true;
      if (Date.now() >= deadline || signal?.aborted) return false;
      await sleep(500, signal);
    }
  }

  static async available(bin: string): Promise<string | null> {
    const r = await exec(bin, ['--version'], { timeoutMs: 15_000 });
    return r.code === 0 ? r.stdout.trim() : null;
  }
}

const clean = (s: string | null | undefined): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t && t !== '-' ? t.slice(0, 200) : undefined;
};

/** Compact text rendering of a screen for the model prompt. */
export function renderScreen(screen: Screen): string {
  if (!screen.elements.length) return '(no accessible elements on screen)';
  const lines = screen.elements.map((e) => {
    const bits = [`[${e.type}]`];
    if (e.label) bits.push(JSON.stringify(e.label));
    if (e.id) bits.push(`id=${JSON.stringify(e.id)}`);
    if (e.value !== undefined) bits.push(`value=${JSON.stringify(e.value)}`);
    if (!e.enabled) bits.push('(disabled)');
    bits.push(`@${e.center.x},${e.center.y}`);
    return '  ' + bits.join(' ');
  });
  const head = `screen ${screen.width}x${screen.height} pt, ${screen.elements.length} elements`;
  const tail = screen.truncated ? `\n  ... ${screen.truncated} more elements hidden (scroll to reach them)` : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}
