import fs from 'node:fs';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import type { Config } from './config.js';
import { baseUrl } from './config.js';
import { isToolsError, resolveTools } from './android/sdk.js';
import { listSystemImages, preferredAbi } from './android/avd.js';
import { resolveDriverApks } from './android/touch.js';

export interface Check {
  name: string;
  state: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  fix?: string;
}

/** Vendors whose presence in a certificate chain means TLS is being inspected. */
const INSPECTORS = /netskope|zscaler|bluecoat|blue coat|forcepoint|palo alto|mcafee|websense|fortinet|cisco umbrella|proxy/i;

/**
 * Diagnose the environment a harness run depends on: toolchain, TLS path and
 * edge configuration. Written for corporate networks, where the usual failure
 * is an inspecting proxy rather than anything wrong with the code.
 */
export async function diagnose(cfg: Config): Promise<Check[]> {
  const checks: Check[] = [];
  if (cfg.platforms.includes('ios')) checks.push(...iosChecks(cfg));
  if (cfg.platforms.includes('android')) checks.push(...androidChecks(cfg));
  checks.push(...await networkChecks(cfg));
  return checks;
}

/** Everything an iOS run depends on before it reaches the network. */
function iosChecks(cfg: Config): Check[] {
  const checks: Check[] = [];

  /* -------------------------------------------------------------- toolchain */
  const sdks = run('xcodebuild', ['-showsdks']);
  const simSdk = sdks.match(/iphonesimulator([\d.]+)/)?.[1];
  const runtimes = [...run('xcrun', ['simctl', 'list', 'runtimes']).matchAll(/^iOS ([\d.]+)/gm)].map((m) => m[1]!);

  if (!simSdk) {
    checks.push({ name: 'Xcode', state: 'fail', detail: 'no iOS simulator SDK found', fix: 'sudo xcode-select -s /Applications/Xcode.app' });
  } else if (!runtimes.length) {
    checks.push({ name: 'Xcode', state: 'fail', detail: `SDK ${simSdk}, but no iOS runtimes installed`, fix: 'xcodebuild -downloadPlatform iOS' });
  } else {
    // A runtime one *minor* version ahead of the SDK builds fine (26.3 against
    // a 26.2 SDK works). It is the major-version jump xcodebuild refuses, which
    // is what produces the confusing "no destination" error.
    const major = (v: string) => Number(v.split('.')[0] ?? 0);
    const usable = runtimes.filter((r) => major(r) <= major(simSdk));
    checks.push(usable.length
      ? { name: 'Xcode', state: 'ok', detail: `SDK ${simSdk}; can build for iOS ${usable.join(', ')}` }
      : {
          name: 'Xcode',
          state: 'fail',
          detail: `SDK is iOS ${simSdk} but the only runtimes are ${runtimes.join(', ')} -- xcodebuild cannot target a runtime a major version ahead of its SDK, so build-from-source will fail`,
          fix: `update Xcode, or install a matching runtime with: xcodebuild -downloadPlatform iOS  (then set "runtime": "${simSdk}" in config.json)`,
        });
  }

  const axe = run(cfg.axeBin, ['--version']).trim();
  checks.push(axe
    ? { name: 'AXe', state: 'ok', detail: axe }
    : { name: 'AXe', state: 'fail', detail: 'not on PATH', fix: 'brew tap cameroncooke/axe && brew trust cameroncooke/axe && brew install axe' });

  const baguette = run(cfg.baguetteBin, ['--version']).trim();
  checks.push(baguette
    ? { name: 'iOS multi-touch', state: 'ok', detail: `baguette ${baguette}` }
    : {
        name: 'iOS multi-touch', state: 'warn',
        detail: 'no baguette on PATH -- pinch, pan and double_tap will fail on iOS',
        fix: 'brew install baguette',
      });

  return checks;
}

/**
 * Everything an Android run depends on.
 *
 * Ordered so the first failure is the one worth fixing: without an SDK
 * nothing else can be judged, and without a JDK every Java tool in it reports
 * a confusing "Unable to locate a Java Runtime" rather than its real problem.
 */
function androidChecks(cfg: Config): Check[] {
  const checks: Check[] = [];
  const tools = resolveTools(cfg);

  if (isToolsError(tools)) {
    checks.push({
      name: 'Android SDK', state: 'fail', detail: tools.error,
      fix: 'brew install --cask android-commandlinetools',
    });
    return checks;
  }
  checks.push({ name: 'Android SDK', state: 'ok', detail: tools.sdkRoot });

  checks.push(tools.javaHome
    ? { name: 'JDK', state: 'ok', detail: tools.javaHome }
    : {
        name: 'JDK', state: 'fail',
        detail: 'no JDK found -- avdmanager, sdkmanager, apkanalyzer and Gradle all need one',
        fix: 'brew install openjdk@21  (Homebrew JDKs are keg-only, so this resolves them by path rather than via /usr/bin/java)',
      });

  const adb = run(tools.adb, ['--version']).split('\n')[0]?.trim();
  checks.push(adb
    ? { name: 'adb', state: 'ok', detail: adb }
    : { name: 'adb', state: 'fail', detail: `not usable at ${tools.adb}`, fix: 'brew install --cask android-platform-tools' });

  const abi = preferredAbi();
  checks.push(fs.existsSync(tools.emulator)
    ? { name: 'Emulator', state: 'ok', detail: tools.emulator }
    : { name: 'Emulator', state: 'fail', detail: 'no emulator binary in the SDK', fix: 'sdkmanager "emulator"' });

  const images = listSystemImages(tools.sdkRoot);
  const native = images.filter((i) => i.abi === abi);
  if (!images.length) {
    checks.push({
      name: 'System image', state: 'fail', detail: 'none installed',
      fix: `sdkmanager "system-images;android-35;google_apis;${abi}"`,
    });
  } else if (!native.length) {
    checks.push({
      name: 'System image', state: 'warn',
      detail: `${images.length} installed, but none for ${abi} -- an emulator would run under emulation and be far too slow`,
      fix: `sdkmanager "system-images;android-35;google_apis;${abi}"`,
    });
  } else {
    checks.push({
      name: 'System image', state: 'ok',
      detail: `${native.map((i) => `API ${i.api}`).join(', ')} (${abi})`,
    });
  }

  checks.push(tools.aapt2
    ? { name: 'aapt2', state: 'ok', detail: tools.aapt2 }
    : tools.apkanalyzer
      ? { name: 'aapt2', state: 'warn', detail: 'not installed; falling back to apkanalyzer, which is slower', fix: 'sdkmanager "build-tools;35.0.0"' }
      : { name: 'aapt2', state: 'fail', detail: 'no way to read an APK manifest', fix: 'sdkmanager "build-tools;35.0.0"' });

  const driver = resolveDriverApks(cfg);
  checks.push(driver
    ? { name: 'Android multi-touch', state: 'ok', detail: driver.test }
    : {
        name: 'Android multi-touch', state: 'warn',
        detail: 'driver APK not built -- pinch, pan and double_tap will fail on Android',
        fix: './driver/build.sh  (needs a JDK and Gradle)',
      });

  return checks;
}

async function networkChecks(cfg: Config): Promise<Check[]> {
  const checks: Check[] = [];

  /* -------------------------------------------------------------------- TLS */
  const caPath = cfg.caBundle || process.env['NODE_EXTRA_CA_CERTS'] || '';
  if (caPath) {
    checks.push(fs.existsSync(caPath)
      ? { name: 'CA bundle', state: 'ok', detail: caPath }
      : { name: 'CA bundle', state: 'fail', detail: `${caPath} does not exist` });
  }
  if (cfg.caBundle && process.env['NODE_EXTRA_CA_CERTS'] !== cfg.caBundle) {
    checks.push({
      name: 'CA bundle',
      state: 'warn',
      detail: `caBundle is set but NODE_EXTRA_CA_CERTS is ${process.env['NODE_EXTRA_CA_CERTS'] ?? 'unset'} in this process`,
      fix: 'Node reads that variable once at startup -- re-run ./install.sh so the launchd plist carries it',
    });
  }

  checks.push(await probeTls('api.anthropic.com'));
  if (cfg.cloudflareTeamDomain) checks.push(await probeTls(cfg.cloudflareTeamDomain));

  /* ------------------------------------------------------------------- edge */
  checks.push(edgeCheck(cfg));

  return checks;
}

/** Open a TLS connection and report who actually signed the certificate. */
async function probeTls(host: string): Promise<Check> {
  return new Promise((resolve) => {
    const done = (c: Check) => { try { socket.destroy(); } catch { /* closed */ } resolve(c); };
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 12_000 }, () => {
      const cert = socket.getPeerCertificate(true);
      const issuer = [cert?.issuer?.O, cert?.issuer?.CN].filter(Boolean).join(' / ') || 'unknown';
      let root: typeof cert = cert;
      const seen = new Set<string>();
      while (root?.issuerCertificate && !seen.has(root.fingerprint256)) {
        seen.add(root.fingerprint256);
        if (root.issuerCertificate === root) break;
        root = root.issuerCertificate;
      }
      const rootName = [root?.issuer?.O, root?.issuer?.CN].filter(Boolean).join(' / ') || issuer;
      const intercepted = INSPECTORS.test(`${issuer} ${rootName}`);

      if (!socket.authorized) {
        return done({
          name: `TLS to ${host}`, state: 'fail',
          detail: `certificate rejected: ${socket.authorizationError}. Chain signed by ${rootName}`,
          fix: intercepted
            ? `TLS is being inspected by ${rootName}. Export its root CA and set "caBundle" in ~/.simcheck/config.json, then re-run ./install.sh`
            : 'check the system trust store',
        });
      }
      done(intercepted
        ? { name: `TLS to ${host}`, state: 'warn', detail: `trusted, but inspected by ${rootName} -- its CA is already in the trust store` }
        : { name: `TLS to ${host}`, state: 'ok', detail: `direct, issued by ${issuer}` });
    });
    socket.on('timeout', () => done({ name: `TLS to ${host}`, state: 'fail', detail: 'timed out', fix: 'egress to this host may be blocked' }));
    socket.on('error', (e) => done({
      name: `TLS to ${host}`, state: 'fail', detail: e.message,
      fix: /self.signed|unable to verify|UNABLE_TO_GET_ISSUER/i.test(e.message)
        ? 'this is what an inspecting proxy looks like -- set "caBundle" to your corporate root CA and re-run ./install.sh'
        : undefined,
    }));
  });
}

function edgeCheck(cfg: Config): Check {
  const loopback = cfg.host === '127.0.0.1' || cfg.host === 'localhost';
  if (cfg.edgeAuth === 'none') {
    return loopback
      ? { name: 'Exposure', state: 'ok', detail: `loopback only (${baseUrl(cfg)}); nothing is reachable off this machine` }
      : { name: 'Exposure', state: 'fail', detail: `bound to ${cfg.host} with edgeAuth "none"`, fix: 'set edgeAuth, or bind 127.0.0.1' };
  }
  if (cfg.edgeAuth === 'cloudflare-access') {
    return cfg.cloudflareTeamDomain && cfg.cloudflareAud.length
      ? { name: 'Exposure', state: 'ok', detail: `Cloudflare Access, team ${cfg.cloudflareTeamDomain}, ${cfg.cloudflareAud.length} audience tag(s)` }
      : { name: 'Exposure', state: 'fail', detail: 'cloudflare-access is set but cloudflareTeamDomain or cloudflareAud is missing' };
  }
  return cfg.trustedProxies.length
    ? { name: 'Exposure', state: 'ok', detail: `trusted proxy: ${cfg.trustedProxies.join(', ')}` }
    : { name: 'Exposure', state: 'fail', detail: 'trusted-proxy is set but trustedProxies is empty' };
}

const run = (cmd: string, args: string[]): string => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 });
  return r.status === 0 ? String(r.stdout) : '';
};

const cmp = (a: string, b: string): number => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
