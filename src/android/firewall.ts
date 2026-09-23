/**
 * The guest firewall: keep a tenant's app off the host's loopback.
 *
 * In the emulator's user-mode network, 10.0.2.2 is the host's 127.0.0.1 and
 * fec0::2 is the host's ::1. A tenant app that connects to 10.0.2.2:5037
 * reaches the host's adb server, which has no authentication, and from there
 * a shell on every other emulator on the machine. The same path reaches the
 * simcheck API and anything else listening on loopback. Measured on an API 35
 * google_apis image: an ordinary app connects to all of them.
 *
 * Nothing on the host can tell that traffic apart from simcheck's own adb
 * client: both belong to the same user. So the rule goes inside the guest,
 * where the app is an unprivileged uid that cannot remove it:
 *
 *   iptables  -I OUTPUT -j simcheck_isolation;  -d 10.0.2.2/32 -j REJECT
 *   ip6tables -I OUTPUT -j simcheck_isolation;  -d fec0::2/128 -j REJECT
 *
 * Only the host aliases are refused. The default route and DNS (10.0.2.3) are
 * untouched, so the app still reaches the internet. iptables rules do not
 * survive a reboot, so this runs on every boot, `-wipe-data` included, and is
 * then checked from inside the guest against listeners the check opens on
 * the host itself: a pass means a connection was refused that would
 * otherwise have been accepted.
 *
 * It needs `adb root`, which `google_apis` images allow and `_playstore`
 * images do not.
 */
import net from 'node:net';
import type { Adb } from './adb.js';
import { logger } from '../log.js';

const log = logger('android-firewall');

export type GuestFirewallMode = 'required' | 'best-effort' | 'off';
export const GUEST_FIREWALL_MODES: readonly GuestFirewallMode[] = ['required', 'best-effort', 'off'];

/** The guest's names for the host's loopback, per address family. */
export const HOST_ALIASES = { ipv4: '10.0.2.2', ipv6: 'fec0::2' } as const;

const CHAIN = 'simcheck_isolation';

/**
 * Idempotent: create the chain if missing, flush it, add the reject, and
 * insert the jump at the top of OUTPUT unless it is already there. `-w`
 * waits for the xtables lock, which netd holds while it works. Prints one
 * `simcheck-fw-fail <tool>` line per family that could not be set.
 */
export const FIREWALL_SCRIPT = [
  ['iptables', `${HOST_ALIASES.ipv4}/32`],
  ['ip6tables', `${HOST_ALIASES.ipv6}/128`],
].map(([tool, destination]) =>
  `${tool} -w -N ${CHAIN} 2>/dev/null; ` +
  `{ ${tool} -w -F ${CHAIN} && ${tool} -w -A ${CHAIN} -d ${destination} -j REJECT && ` +
  `{ ${tool} -w -C OUTPUT -j ${CHAIN} 2>/dev/null || ${tool} -w -I OUTPUT 1 -j ${CHAIN}; }; } ` +
  `|| echo simcheck-fw-fail ${tool}`,
).join('; ');

/** What a boot did about the firewall, for the log and the device record. */
export interface FirewallOutcome {
  applied: boolean;
  /** Families whose host alias refused a connection from inside the guest. */
  verified: ('ipv4' | 'ipv6')[];
  /** Why it is not fully in place, when it is not. */
  problem?: string;
}

async function waitForDevice(adb: Adb, serial: string): Promise<void> {
  await adb.rawTry(serial, ['wait-for-device'], { timeoutMs: 60_000 });
}

/** `adb root`, and wait for adbd to come back as root. */
async function becomeRoot(adb: Adb, serial: string): Promise<void> {
  const rooted = await adb.rawTry(serial, ['root'], { timeoutMs: 30_000 });
  const said = (rooted.stdout + rooted.stderr).trim();
  if (rooted.code !== 0 || /cannot run as root|not allowed/i.test(said)) {
    throw new Error(
      `adb root was refused (${said.slice(0, 200) || `exit ${rooted.code}`}). The guest firewall needs a ` +
      '"google_apis" system image; "_playstore" images refuse root');
  }
  await waitForDevice(adb, serial);

  const who = await adb.shellTry(serial, 'id -u', { timeoutMs: 15_000 });
  if (who.out.trim() !== '0') throw new Error('adb root reported success, but the shell is not uid 0');
}

/** Back to the default non-root adbd. A failure is logged, never fatal. */
async function dropRoot(adb: Adb, serial: string): Promise<void> {
  const unrooted = await adb.rawTry(serial, ['unroot'], { timeoutMs: 30_000 });
  if (unrooted.code !== 0) log.warn(`adb unroot on ${serial} exited ${unrooted.code}`);
  await waitForDevice(adb, serial);
}

/** Install the rules. Assumes a root shell. */
async function installRules(adb: Adb, serial: string): Promise<void> {
  const r = await adb.shellTry(serial, FIREWALL_SCRIPT, { timeoutMs: 60_000 });
  const failed = r.out.split('\n').filter((line) => line.startsWith('simcheck-fw-fail'));
  if (failed.length) {
    throw new Error(`could not install the guest firewall (${failed.join(', ')}): ${r.out.trim().slice(0, 300)}`);
  }

  // Read the rules back rather than trusting the exit codes.
  for (const tool of ['iptables', 'ip6tables']) {
    const listed = await adb.shellTry(serial, `${tool} -w -S OUTPUT`, { timeoutMs: 30_000 });
    const first = listed.out.split('\n').map((line) => line.trim()).find((line) => line.startsWith('-A OUTPUT'));
    if (first !== `-A OUTPUT -j ${CHAIN}`) {
      throw new Error(`${tool}: the ${CHAIN} jump is not first in OUTPUT (first rule: ${first ?? 'none'})`);
    }
  }
}

/**
 * Best-effort, as early in boot as adbd answers: installing the rules before
 * any app process exists closes the window in which an app left installed
 * (resetPolicy "relaunch") could run a boot receiver against an open host.
 * Leaves adbd as root; `ensureGuestFirewall` re-applies (netd may have
 * rebuilt OUTPUT while booting), verifies and drops root once boot is done.
 */
export async function applyGuestFirewallEarly(adb: Adb, serial: string): Promise<void> {
  try {
    await waitForDevice(adb, serial);
    await becomeRoot(adb, serial);
    await installRules(adb, serial);
  } catch (e) {
    log.info(`early guest firewall on ${serial} deferred to after boot: ${(e as Error).message}`);
  }
}

/**
 * Apply and verify the firewall on a booted emulator. Throws in `required`
 * mode when it cannot be put in place; `best-effort` logs and carries on.
 */
export async function ensureGuestFirewall(
  adb: Adb, serial: string, mode: GuestFirewallMode,
): Promise<FirewallOutcome> {
  if (mode === 'off') return { applied: false, verified: [], problem: 'androidGuestFirewall is "off"' };

  let outcome: FirewallOutcome;
  try {
    await becomeRoot(adb, serial);
    try {
      await installRules(adb, serial);
    } finally {
      await dropRoot(adb, serial);
    }

    const probe = await probeGuestIsolation(adb, serial);
    const open = probe.tested.filter((family) => !probe.refused.includes(family));
    outcome = { applied: true, verified: probe.refused };

    if (open.length) {
      outcome.problem = `the host was still reachable over ${open.join(' and ')} from inside the guest`;
    } else if (!probe.tested.length) {
      outcome.problem = 'could not open a loopback listener on the host to verify against';
    }
  } catch (e) {
    outcome = { applied: false, verified: [], problem: (e as Error).message };
  }

  if (!outcome.problem) {
    log.info(`guest firewall on ${serial}: host loopback refused over ${outcome.verified.join(' and ')}`);
    return outcome;
  }
  // Fail closed: anything but an explicit "best-effort" is treated as required.
  if (mode !== 'best-effort') {
    throw new Error(
      `guest firewall not in place on ${serial}: ${outcome.problem}. Without it an app on this emulator can ` +
      'reach the host adb server (10.0.2.2:5037) and every other loopback service. Use a google_apis ' +
      'system image, or set "androidGuestFirewall": "best-effort" on a machine that only runs your own apps');
  }
  log.warn(`guest firewall on ${serial} (best-effort): ${outcome.problem}`);
  return outcome;
}

/** A loopback listener on the host, to test reachability against. */
async function listen(host: string): Promise<net.Server | null> {
  const server = net.createServer((socket) => socket.destroy());
  return new Promise((resolve) => {
    server.once('error', () => resolve(null));
    server.listen(0, host, () => resolve(server));
  });
}

/** How the host's loopback looked from inside the guest, per family. */
export interface IsolationProbe {
  /** Families the host has a loopback listener for, so could be tested. */
  tested: ('ipv4' | 'ipv6')[];
  /** Of those, the ones whose guest alias refused the connection. */
  refused: ('ipv4' | 'ipv6')[];
}

/**
 * From inside the guest, as the non-root shell uid: open a listener on the
 * host's loopback, and check that the guest's alias for it is refused. The
 * listener proves the connection would otherwise have succeeded, so a
 * refusal means the rule did it. A host with no ::1 has nothing for fec0::2
 * to reach, and that family is simply not tested.
 */
export async function probeGuestIsolation(adb: Adb, serial: string): Promise<IsolationProbe> {
  const result: IsolationProbe = { tested: [], refused: [] };

  for (const [family, host, alias] of [
    ['ipv4', '127.0.0.1', HOST_ALIASES.ipv4],
    ['ipv6', '::1', HOST_ALIASES.ipv6],
  ] as const) {
    const server = await listen(host);
    if (!server) continue;

    try {
      const port = (server.address() as net.AddressInfo).port;
      const probe = await adb.shellTry(serial,
        `command -v nc >/dev/null 2>&1 || { echo simcheck-nc=missing; exit 0; }; ` +
        `nc -z -w 3 ${alias} ${port}; echo simcheck-nc=$?`, { timeoutMs: 30_000 });
      const code = /simcheck-nc=(\w+)/.exec(probe.out)?.[1];

      // nc exits 1 for refused or timed out, 0 for connected. Anything else
      // (no nc, a shell error) proves nothing either way.
      if (code !== '0' && code !== '1') {
        throw new Error(`could not probe ${alias} from inside the guest: ${probe.out.trim().slice(0, 200) || 'no output'}`);
      }

      result.tested.push(family);
      if (code === '1') result.refused.push(family);
    } finally {
      server.close();
    }
  }

  return result;
}
