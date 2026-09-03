/**
 * The normalised view of what is on a device's screen.
 *
 * Both drivers flatten a platform accessibility tree into this shape -- AXe's
 * `describe-ui` on iOS, `uiautomator dump` on Android -- so everything above
 * the driver (the step executor, the agent loop, the pool's modal sweep) reads
 * one vocabulary and does not care which platform produced it.
 */

export interface UiElement {
  /** Normalised role: Button, TextField, Cell, Switch... */
  type: string;
  label?: string;
  /** Accessibility identifier on iOS, resource-id on Android. */
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
  /**
   * What the coordinates are measured in. iOS reports points; Android's
   * accessibility dump reports physical pixels. Taps use the same space the
   * tree was read in either way, so the number is self-consistent -- but a
   * model reasoning about "is 40 a plausible tap target" deserves to know
   * which one it is looking at.
   */
  units: 'pt' | 'px';
  elements: UiElement[];
  /** Elements dropped by the cap, so the model knows the view is partial. */
  truncated: number;
}

/** Container roles carry no interaction affordance and would swamp the model. */
export const NOISE_TYPES = new Set([
  'Application', 'Window', 'Group', 'Other', 'Unknown', 'ScrollView',
]);

/** Types worth surfacing even with no label -- the model can still tap them. */
export const ALWAYS_KEEP = new Set([
  'Button', 'TextField', 'SecureTextField', 'SearchField', 'Switch', 'Slider',
  'Link', 'Cell', 'TabBar', 'MenuItem', 'Picker', 'PickerWheel', 'Stepper',
  'SegmentedControl', 'CheckBox', 'RadioButton', 'TextView',
]);

export const clean = (s: string | null | undefined): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t && t !== '-' ? t.slice(0, 200) : undefined;
};

/**
 * Put a collected tree into reading order and apply the cap.
 *
 * Shared so the two drivers cannot drift on what "the first 120 elements"
 * means -- an agent comparing an iOS and an Android run should be reading the
 * same kind of list.
 */
export function finishScreen(
  elements: UiElement[], width: number, height: number, cap: number,
  units: 'pt' | 'px' = 'pt',
): Screen {
  // Reading order: top to bottom, then left to right.
  elements.sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
  const truncated = Math.max(0, elements.length - cap);
  return { width, height, units, elements: elements.slice(0, cap), truncated };
}

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
  const head = `screen ${screen.width}x${screen.height} ${screen.units ?? 'pt'}, ${screen.elements.length} elements`;
  const tail = screen.truncated ? `\n  ... ${screen.truncated} more elements hidden (scroll to reach them)` : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}
