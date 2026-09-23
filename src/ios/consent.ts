/**
 * SpringBoard's "Open in '<App>'?" consent sheet.
 *
 * On iOS 26 the first `simctl openurl` to a custom URL scheme on a device puts
 * up a system sheet asking whether to open the app; nothing reaches the app
 * until someone taps Open. `simctl erase` resets that consent, so under an
 * erase-on-tenant-change policy the first deep link after every tenant change
 * would otherwise silently not land. Unanswered sheets also queue, one per
 * call, and outlive the app.
 *
 * What AXe's describe-ui shows on iOS 26.3 (iPhone 17 Pro, points):
 *
 *   [Sheet]  "Open in “Greyfix”?"          frame 41,388 320x126
 *     [StaticText] "Open in “Greyfix”?"
 *     [Button] "Cancel"                     frame 57,450 140x48
 *     [Button] "Open"                       frame 205,450 140x48
 *
 * The buttons are siblings deep inside the sheet, not children the flattened
 * `Screen` keeps a link to, so they are matched by frame containment.
 * http(s) links go to Safari or a universal-link handler and show no sheet.
 */
import type { UiDriver } from '../device.js';
import type { Screen, UiElement } from '../screen.js';
import { modalButtons } from '../screen.js';
import { sleep } from '../util.js';

export interface OpenInSheet {
  /** The sheet's own label, e.g. `Open in “Greyfix”?`. */
  title: string;
  /** The button to press to let the link through. */
  open: UiElement;
  /** Its dismissive sibling, when one could be told apart. */
  cancel?: UiElement;
}

const OPEN_IN = /^open in\b/i;

/**
 * Find the consent sheet on a screen, or null.
 *
 * Matched by title, then the "Open" button, falling back to the right-hand
 * button, where iOS puts the default action. The sheet is SpringBoard's, so it
 * speaks the simulator's system language -- English on the devices simcheck
 * creates -- and an app's own `-AppleLanguages` launch argument does not
 * change it. There is deliberately no locale-blind fallback on the sheet's
 * shape alone: an app's own "Delete “Draft”?" sheet has the same shape, and
 * tapping its right-hand button would do damage.
 */
export function findOpenInSheet(screen: Screen): OpenInSheet | null {
  for (const sheet of screen.elements.filter((e) => e.type === 'Sheet')) {
    const title = sheet.label ?? '';
    if (!OPEN_IN.test(title)) continue;
    const buttons = modalButtons(screen, sheet);
    if (buttons.length < 2) continue;
    const open = buttons.find((b) => /^open$/i.test(b.label!)) ?? buttons[buttons.length - 1]!;
    const cancel = buttons.find((b) => /^cancel$/i.test(b.label!)) ?? buttons.find((b) => b !== open);
    return { title, open, ...(cancel ? { cancel } : {}) };
  }
  return null;
}

export interface ConsentOptions {
  /** How long to look for the sheet after `openurl` returns. */
  windowMs?: number;
  /** Pause between reads. describe-ui itself takes ~350ms. */
  pollMs?: number;
  signal?: AbortSignal;
}

/**
 * After an `openurl`, watch briefly for the consent sheet and tap Open.
 * Returns the sheet's title if one was answered, else null.
 *
 * describe-ui can fail outright while the sheet animates in ("No translation
 * object returned for simulator ... fullscreen dialog"), so a failed read is
 * retried within the window rather than taken as "no sheet".
 */
export async function acceptOpenIn(ui: UiDriver, opts: ConsentOptions = {}): Promise<string | null> {
  const windowMs = opts.windowMs ?? 2000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + windowMs;
  for (;;) {
    const screen = await ui.describe(opts.signal).catch(() => null);
    const sheet = screen && findOpenInSheet(screen);
    if (sheet) {
      await ui.tap({ x: sheet.open.center.x, y: sheet.open.center.y }, opts.signal);
      return sheet.title;
    }
    if (Date.now() >= deadline || opts.signal?.aborted) return null;
    await sleep(pollMs, opts.signal);
  }
}
