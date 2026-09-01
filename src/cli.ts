#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig, paths, baseUrl } from './config.js';
import { Client, DaemonDownError, readRequestFile, type RunView } from './client.js';
import type { RunRequest } from './types.js';

const cfg = loadConfig();
const client = new Client(cfg);

const USAGE = `simcheck - hand off iOS simulator testing

  simcheck start [--foreground]     start the daemon (launchd by default)
  simcheck stop                     stop the daemon
  simcheck status                   daemon health and pool state
  simcheck logs [-f]                tail the daemon log

  simcheck submit <request.json>    queue a run; prints the run id
       [--wait] [--timeout <sec>]      block until it finishes
  simcheck get <run-id>             full run state as JSON
  simcheck watch <run-id>           follow a run until it finishes
  simcheck list [-n <count>]        recent runs
  simcheck cancel <run-id>          stop a run
  simcheck report <run-id>          print the markdown evidence report
  simcheck open <run-id>            open the run directory in Finder

  simcheck upload <App.app|zip>     upload a built app; prints an artifact id
  simcheck upload --scheme <S> [--project <P>|--workspace <W>]
                                       build it here, then upload
       [--label <text>] [--git-sha <sha>]
  simcheck artifacts                list uploaded builds

  simcheck doctor                   check toolchain, TLS path and exposure
  simcheck mcp-config [agent]       MCP setup for claude-code, claude-desktop,
                                       codex, cursor, vscode, or generic
  simcheck docs                     open the documentation page

  simcheck remote                   run the remote MCP server (for Claude
                                       connectors, incl. the phone app)
  simcheck pair                     print a pairing code to approve a connector
  simcheck remote status            OAuth clients and tokens
  simcheck remote clients           registered connectors
  simcheck remote revoke <clientId> drop one connector
  simcheck remote revoke-all        drop every connector credential
  simcheck tunnel <hostname>        scaffold a Cloudflare Tunnel + Access setup

  simcheck token                    print the local API token (secret)
  simcheck token list               registered tokens and their capabilities
  simcheck token create <name> [--preset full|remote|readonly]
       [--note <text>] [--max-concurrent <n>] [--max-per-hour <n>]
  simcheck token grant <name> <capability>
  simcheck token revoke <name>
  simcheck whoami                   what the current token may do

  simcheck pool                     pool state
  simcheck pool add [-n <count>] [--device "iPhone 17 Pro"] [--runtime "iOS 27.0"]
  simcheck pool remove <udid> [--force]
  simcheck inspect <device|udid>    live accessibility tree, for authoring steps

`;

const args = process.argv.slice(2);
const cmd = args[0];

const flag = (name: string): boolean => args.includes(`--${name}`);
function opt(name: string, short?: string): string | undefined {
  for (const key of [`--${name}`, ...(short ? [`-${short}`] : [])]) {
    const i = args.indexOf(key);
    if (i !== -1 && args[i + 1]) return args[i + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'start':   return start();
    case 'stop':    return stop();
    case 'status':  return status();
    case 'logs':    return logs();
    case 'submit':  return submit();
    case 'get':     return void print(await client.get(need(1, 'run id')));
    case 'watch':   return watch(need(1, 'run id'));
    case 'list':    return list();
    case 'cancel':  return void print(await client.cancel(need(1, 'run id')));
    case 'report':  return void console.log(await client.report(need(1, 'run id')));
    case 'open':    return openDir(need(1, 'run id'));
    case 'pool':    return pool();
    case 'upload':  return upload();
    case 'artifacts': return artifacts();
    case 'whoami':  return void print(await client.whoami());
    case 'doctor':  return doctor();
    case 'mcp-config': return mcpConfig();
    case 'docs':    return openDocs();
    case 'pair':    return pair();
    case 'remote':  return remote();
    case 'tunnel':  return tunnel();
    case 'inspect': return void print(await client.inspect(need(1, 'device name or udid')));
    case 'token':   return token();
    case undefined:
    case '-h': case '--help': case 'help':
      return void console.log(USAGE);
    default:
      console.error(`unknown command "${cmd}"\n\n${USAGE}`);
      process.exit(1);
  }
}

function need(index: number, what: string): string {
  const v = args[index];
  if (!v || v.startsWith('-')) { console.error(`error: expected a ${what}\n\n${USAGE}`); process.exit(1); }
  return v;
}

const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const PLIST_LABEL = 'com.nickbabenko.simcheck';
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

async function start(): Promise<void> {
  if (flag('foreground')) {
    const daemon = path.join(path.dirname(new URL(import.meta.url).pathname), 'daemon.js');
    const child = spawn(process.execPath, [daemon], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  if (!fs.existsSync(plistPath)) {
    console.error(`no launchd agent at ${plistPath}. Run ./install.sh, or use: simcheck start --foreground`);
    process.exit(1);
  }
  await launchctl(['bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath], true);
  await launchctl(['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`]);
  console.log('daemon starting; run `simcheck status` in a few seconds');
}

async function stop(): Promise<void> {
  await launchctl(['bootout', `gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`], true);
  console.log('daemon stopped (pooled simulators stay booted)');
}

function launchctl(argv: string[], tolerant = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('launchctl', argv, { stdio: 'pipe' });
    let err = '';
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('close', (code) => {
      if (code === 0 || tolerant) resolve();
      else reject(new Error(`launchctl ${argv[0]} failed: ${err.trim() || `exit ${code}`}`));
    });
    child.on('error', reject);
  });
}

async function status(): Promise<void> {
  const health = await client.health().catch(() => null);
  if (!health) {
    console.log(`daemon:  DOWN (${baseUrl(cfg)})`);
    console.log('         start it with: simcheck start');
    process.exit(1);
  }
  const p = await client.pool();
  console.log(`daemon:  up at ${baseUrl(cfg)}`);
  console.log(`scenarios: ${health.llm ? `enabled via ${health.llm}` : 'DISABLED (no LLM backend; explicit steps only)'}`);
  console.log(`pool:    ${p.counts['ready'] ?? 0} ready, ${p.counts['leased'] ?? 0} busy, ${p.counts['pending'] ?? 0} pending, ${p.counts['booting'] ?? 0} booting, target ${p.target}`);
  console.log(`queue:   ${p.queued} waiting, ${p.active} running`);
  console.log('');
  for (const d of p.devices) {
    const suffix = d.currentRunId ? `  <- ${d.currentRunId}` : d.lastError ? `  (${d.lastError.slice(0, 60)})` : '';
    console.log(`  ${d.name.padEnd(16)} ${d.status.padEnd(10)} ${d.deviceType} / ${d.runtime}${suffix}`);
  }
}

function logs(): void {
  const file = paths(cfg).log;
  if (!fs.existsSync(file)) { console.error(`no log at ${file}`); process.exit(1); }
  const tailArgs = args.includes('-f') || flag('follow') ? ['-f', '-n', '80', file] : ['-n', '200', file];
  spawn('tail', tailArgs, { stdio: 'inherit' });
}

async function submit(): Promise<void> {
  const file = need(1, 'path to a request JSON file');
  const request: RunRequest = readRequestFile(file);

  // Relative paths in the request file are relative to that file, not to cwd.
  const baseDir = path.dirname(path.resolve(file));
  const absolutise = <T extends Record<string, unknown>>(obj: T | undefined, keys: readonly string[]) => {
    if (!obj) return;
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === 'string' && v && !path.isAbsolute(v)) {
        (obj as Record<string, unknown>)[key] = path.resolve(baseDir, v);
      }
    }
  };
  absolutise(request.app as Record<string, unknown> | undefined, ['path', 'project', 'workspace']);
  absolutise(request.xctest as Record<string, unknown> | undefined, ['project', 'workspace', 'xctestrun']);

  const run = await client.submit(request);
  if (!flag('wait')) {
    console.log(run.id);
    console.error(`queued at position ${run.queuePosition ?? 0}; follow with: simcheck watch ${run.id}`);
    return;
  }
  await watch(run.id);
}

async function watch(id: string): Promise<void> {
  const timeoutSec = Number(opt('timeout') ?? 1800);
  let lastTrace = 0;

  const render = (run: RunView) => {
    for (const t of run.trace.slice(lastTrace)) {
      const mark = { thought: '~', step: '.', error: '!', screenshot: '*', note: '#' }[t.kind] ?? '.';
      console.error(`  ${t.at.slice(11, 19)} ${mark} ${t.text.split('\n')[0]}`);
    }
    lastTrace = run.trace.length;
  };

  const poll = setInterval(() => {
    void client.get(id).then(render).catch(() => {});
  }, 2000);

  try {
    const run = await client.wait(id, timeoutSec * 1000);
    render(run);
    console.error('');
    console.error(`${run.status.toUpperCase()}  ${run.verdict?.summary ?? run.error ?? ''}`);
    if (run.screenshots.length) {
      console.error(`screenshots (${run.screenshots.length}): ${run.screenshots.map((s) => s.name).join(', ')}`);
    }
    console.error(`evidence: ${path.join(run.dir, 'report.md')}`);
    process.exit(run.status === 'passed' ? 0 : 1);
  } finally {
    clearInterval(poll);
  }
}

async function list(): Promise<void> {
  const { runs } = await client.list(Number(opt('count', 'n') ?? 20));
  if (!runs.length) return void console.log('no runs yet');
  for (const r of runs as any[]) {
    const label = r.label ? ` ${r.label}` : '';
    console.log(`${String(r.id).padEnd(22)} ${String(r.status).padEnd(10)} ${r.createdAt.slice(0, 19).replace('T', ' ')} ${r.screenshots} shots${label}`);
  }
}

function openDir(id: string): void {
  const dir = path.join(paths(cfg).runs, id);
  if (!fs.existsSync(dir)) { console.error(`no run directory at ${dir}`); process.exit(1); }
  spawn('open', [dir], { stdio: 'inherit' });
}

async function pool(): Promise<void> {
  const sub = args[1];
  if (sub === 'add') {
    const spec: { deviceType?: string; runtime?: string; count?: number } = {
      count: Number(opt('count', 'n') ?? 1),
    };
    const device = opt('device'); if (device) spec.deviceType = device;
    const runtime = opt('runtime'); if (runtime) spec.runtime = runtime;
    const { added } = await client.addDevices(spec);
    for (const d of added) console.log(`${d.name}  ${d.status}  ${d.deviceType} / ${d.runtime}  ${d.udid}`);
    console.error('added as pending; they become ready once booted');
    return;
  }
  if (sub === 'remove') {
    await client.removeDevice(need(2, 'device udid'), flag('force'));
    console.log('removed');
    return;
  }
  print(await client.pool());
}

async function token(): Promise<void> {
  const sub = args[1];

  if (sub === 'list') {
    const { tokens, presets } = await client.listTokens();
    for (const t of tokens as any[]) {
      const limits = [
        t.maxConcurrentRuns ? `${t.maxConcurrentRuns} concurrent` : null,
        t.maxRunsPerHour ? `${t.maxRunsPerHour}/hr` : null,
      ].filter(Boolean).join(', ') || 'no limits';
      console.log(`${String(t.name).padEnd(14)} ${String(t.id).padEnd(14)} ${limits}`);
      console.log(`  ${(t.capabilities as string[]).join(' ')}`);
      if (t.note) console.log(`  ${t.note}`);
      if (t.lastUsedAt) console.log(`  last used ${String(t.lastUsedAt).slice(0, 19).replace('T', ' ')}`);
      console.log('');
    }
    console.error(`presets: ${Object.keys(presets).join(', ')}`);
    return;
  }

  if (sub === 'create') {
    const name = need(2, 'token name');
    const body: Record<string, unknown> = { name, preset: opt('preset') ?? 'remote' };
    if (opt('note')) body['note'] = opt('note');
    if (opt('max-concurrent')) body['maxConcurrentRuns'] = Number(opt('max-concurrent'));
    if (opt('max-per-hour')) body['maxRunsPerHour'] = Number(opt('max-per-hour'));

    const { record, secret } = await client.createToken(body as any);
    // The secret is shown once and never stored in plaintext, so make that clear.
    console.error(`created "${(record as any).name}" (${(record as any).id})`);
    console.error(`capabilities: ${((record as any).capabilities as string[]).join(' ')}`);
    console.error('');
    console.error('This secret is shown once and is not recoverable. Store it now:');
    console.log(secret);
    return;
  }

  if (sub === 'grant') {
    const name = need(2, 'token name'); const cap = need(3, 'capability');
    await client.grantToken(name, cap);
    console.log(`granted ${cap} to ${name}`);
    return;
  }
  if (sub === 'revoke') {
    await client.revokeToken(need(2, 'token name or id'));
    console.log('revoked');
    return;
  }

  if (sub === undefined) {
    const file = paths(cfg).token;
    if (!fs.existsSync(file)) { console.error(`no token yet at ${file} - start the daemon once`); process.exit(1); }
    process.stdout.write(fs.readFileSync(file, 'utf8'));
    return;
  }
  console.error(`unknown token subcommand "${sub}"\n\n${USAGE}`);
  process.exit(1);
}

async function artifacts(): Promise<void> {
  const { artifacts: list } = await client.listArtifacts();
  if (!list.length) return void console.log('no uploaded artifacts');
  for (const a of list) {
    const size = `${(a.bytes / 1e6).toFixed(1)}MB`.padStart(8);
    console.log(`${a.id}  ${size}  ${a.appName.padEnd(24)} ${a.bundleId}`);
    console.log(`  uploaded ${a.uploadedAt.slice(0, 19).replace('T', ' ')} by ${a.uploadedBy}${a.label ? ` - ${a.label}` : ''}${a.gitSha ? ` @ ${a.gitSha.slice(0, 8)}` : ''}`);
  }
}

/**
 * Build (optionally) and upload a simulator .app.
 *
 * This is the local half of "my Mac builds, something else tests": the source
 * never leaves this machine, only the compiled bundle does.
 */
async function upload(): Promise<void> {
  const scheme = opt('scheme');
  let appPath: string;
  let cleanup: string | null = null;

  if (scheme) {
    appPath = await buildForUpload(scheme);
  } else {
    const given = need(1, 'path to a .app bundle or a zip of one');
    appPath = path.resolve(given);
    if (!fs.existsSync(appPath)) { console.error(`no such path: ${appPath}`); process.exit(1); }
  }

  let zipPath: string;
  if (appPath.endsWith('.zip')) {
    zipPath = appPath;
  } else {
    if (!appPath.endsWith('.app')) { console.error(`expected a .app bundle, got ${appPath}`); process.exit(1); }
    zipPath = path.join(os.tmpdir(), `simcheck-${path.basename(appPath, '.app')}-${Date.now()}.zip`);
    cleanup = zipPath;
    console.error(`zipping ${path.basename(appPath)}...`);
    await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
  }

  const meta: { label?: string; gitSha?: string } = {};
  const label = opt('label'); if (label) meta.label = label;
  const gitSha = opt('git-sha') ?? currentGitSha(scheme ? process.cwd() : path.dirname(appPath));
  if (gitSha) meta.gitSha = gitSha;

  console.error(`uploading ${(fs.statSync(zipPath).size / 1e6).toFixed(1)}MB...`);
  try {
    const artifact = await client.uploadArtifact(zipPath, meta);
    console.error(`stored ${artifact.appName} (${artifact.bundleId})`);
    console.error('reference it as: {"app": {"artifactId": "' + artifact.id + '"}}');
    console.log(artifact.id);
  } finally {
    if (cleanup) fs.rmSync(cleanup, { force: true });
  }
}

async function buildForUpload(scheme: string): Promise<string> {
  const project = opt('project');
  const workspace = opt('workspace');
  if (!project && !workspace) {
    console.error('--scheme needs --project <App.xcodeproj> or --workspace <App.xcworkspace>');
    process.exit(1);
  }
  const configuration = opt('configuration') ?? 'Debug';
  const derived = path.join(os.tmpdir(), `simcheck-build-${Buffer.from(String(project ?? workspace) + scheme).toString('hex').slice(0, 12)}`);

  console.error(`building ${scheme} (${configuration}) for the simulator...`);
  await run('xcodebuild', [
    workspace ? '-workspace' : '-project', path.resolve(String(workspace ?? project)),
    '-scheme', scheme,
    '-configuration', configuration,
    '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', derived,
    'CODE_SIGNING_ALLOWED=NO',
    'build',
  ]);

  const products = path.join(derived, 'Build', 'Products', `${configuration}-iphonesimulator`);
  const app = fs.existsSync(products)
    ? fs.readdirSync(products).find((f) => f.endsWith('.app'))
    : undefined;
  if (!app) { console.error(`build succeeded but no .app found under ${products}`); process.exit(1); }
  return path.join(products, app);
}

/** Tag the upload with the commit it came from, when there is one. */
function currentGitSha(dir: string): string | undefined {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).trim() || undefined : undefined;
}

function run(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
    child.on('error', reject);
  });
}

/** Environment diagnosis. Exits non-zero if anything is broken. */
async function doctor(): Promise<void> {
  const { diagnose } = await import('./doctor.js');
  const checks = await diagnose(cfg);

  const MARK = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ', info: '      ' };
  let failed = 0;
  for (const c of checks) {
    if (c.state === 'fail') failed++;
    console.log(`${MARK[c.state]} ${c.name.padEnd(22)} ${c.detail}`);
    if (c.fix && c.state !== 'ok') console.log(`${' '.repeat(30)}-> ${c.fix}`);
  }

  const health = await client.health().catch(() => null);
  console.log('');
  console.log(health
    ? `  ok   daemon                 up, edge auth "${(health as { edge?: string }).edge ?? 'none'}", ${health.pool} pooled device(s)`
    : `  FAIL daemon                 not responding -- simcheck start`);
  if (!health) failed++;

  process.exit(failed ? 1 : 0);
}

/**
 * Write a cloudflared config and print the commands to finish the setup.
 *
 * This deliberately creates nothing in your Cloudflare account -- exposing a
 * service that can build code is a decision to make deliberately, so the
 * account-changing steps are yours to run.
 */
async function tunnel(): Promise<void> {
  const hostname = need(1, 'public hostname, e.g. sim.home.nickbabenko.com');
  const name = opt('name') ?? 'simcheck';
  const dir = path.join(os.homedir(), '.cloudflared');
  const configPath = path.join(dir, `${name}.yml`);

  if (!which('cloudflared')) {
    console.error('cloudflared is not installed. Install it first:\n  brew install cloudflared\n');
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, [
    `# simcheck tunnel -- generated by \`simcheck tunnel ${hostname}\``,
    `tunnel: ${name}`,
    `credentials-file: ${path.join(dir, '<TUNNEL-UUID>.json')}`,
    '',
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: ${baseUrl(cfg)}`,
    '  - service: http_status:404',
    '',
  ].join('\n'));

  console.log(`wrote ${configPath}`);
  console.log('');
  console.log('Then, in order:');
  console.log('');
  console.log(`  1. cloudflared tunnel login`);
  console.log(`  2. cloudflared tunnel create ${name}`);
  console.log(`     # put the printed UUID into credentials-file above`);
  console.log(`  3. cloudflared tunnel route dns ${name} ${hostname}`);
  console.log(`  4. cloudflared tunnel --config ${configPath} run ${name}`);
  console.log('');
  console.log('  5. In Zero Trust > Access > Applications, add a self-hosted app for');
  console.log(`     ${hostname}, with a policy of Service Auth allowing a service token.`);
  console.log('     Copy the Application Audience (AUD) tag.');
  console.log('');
  console.log('  6. Point the daemon at it, so it verifies Access itself rather than');
  console.log('     trusting that traffic arrived via the tunnel:');
  console.log('');
  console.log(`     ${path.join(cfg.home, 'config.json')}`);
  console.log(JSON.stringify({
    edgeAuth: 'cloudflare-access',
    cloudflareTeamDomain: '<your-team>.cloudflareaccess.com',
    cloudflareAud: ['<AUD-tag>'],
    edgeAllowLoopback: true,
  }, null, 2).split('\n').map((l) => '     ' + l).join('\n'));
  console.log('');
  console.log('  7. simcheck stop && simcheck start && simcheck doctor');
  console.log('');
  console.log('  8. Mint a matching token for the far side:');
  console.log('       simcheck token create cloud --preset remote');
  console.log('');
  console.log('  The client then sends three headers:');
  console.log('       CF-Access-Client-Id, CF-Access-Client-Secret, Authorization: Bearer <token>');
  console.log('');
  console.log('  Optionally bind them together so neither works alone, in config.json:');
  console.log('       "identityBindings": { "<client-id>.access": ["cloud"] }');
}

/** Absolute path of an executable on PATH, or null. */
function lookup(bin: string): string | null {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  const out = r.status === 0 ? String(r.stdout).trim() : '';
  return out || null;
}

const which = (bin: string): boolean => lookup(bin) !== null;

/**
 * Print ready-to-paste MCP client configuration.
 *
 * Generated from the live install rather than written down, so the paths are
 * always the real ones even if the repo moves.
 */
function mcpConfig(): void {
  // process.execPath is version-pinned (…/Cellar/node/24.3.0/bin/node) and would
  // break on the next upgrade; prefer the stable symlink on PATH.
  const node = lookup('node') ?? process.execPath;
  const server = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'mcp.js');
  const agent = (args[1] ?? 'all').toLowerCase();

  const json = (key: string) => JSON.stringify(
    { [key]: { 'simcheck': { command: node, args: [server] } } }, null, 2);

  const blocks: Record<string, () => void> = {
    'claude-code': () => {
      section('Claude Code', 'run this once; it applies to every session');
      console.log(`claude mcp add simcheck --scope user -- ${node} ${server}`);
    },
    'claude-desktop': () => {
      section('Claude Desktop', '~/Library/Application Support/Claude/claude_desktop_config.json');
      console.log(json('mcpServers'));
      console.log('\n(quit and reopen Claude Desktop afterwards)');
    },
    codex: () => {
      section('Codex', '~/.codex/config.toml');
      console.log(`[mcp_servers.simcheck]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(server)}]`);
      console.log(`\nor: codex mcp add simcheck -- ${node} ${server}`);
    },
    cursor: () => {
      section('Cursor', '~/.cursor/mcp.json (global) or .cursor/mcp.json (per project)');
      console.log(json('mcpServers'));
    },
    vscode: () => {
      section('VS Code / Copilot', '.vscode/mcp.json -- note the key is "servers", not "mcpServers"');
      console.log(json('servers'));
    },
    generic: () => {
      section('Any other MCP client', 'a stdio server: run this command, speak MCP over stdin/stdout');
      console.log(`command: ${node}\nargs:    [${JSON.stringify(server)}]`);
      console.log('\nMost clients use the Claude Desktop shape:');
      console.log(json('mcpServers'));
    },
  };

  if (agent === 'all') {
    for (const render of Object.values(blocks)) { render(); console.log(''); }
    console.error('Pick one with: simcheck mcp-config <claude-code|claude-desktop|codex|cursor|vscode|generic>');
    return;
  }
  const render = blocks[agent];
  if (!render) {
    console.error(`unknown agent "${agent}". Try: ${Object.keys(blocks).join(', ')}`);
    process.exit(1);
  }
  render();
}

function section(title: string, note: string): void {
  console.log(`# ${title}`);
  console.log(`# ${note}`);
}

/** Open the bundled documentation page in the default browser. */
function openDocs(): void {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const page = path.resolve(here, '..', 'docs', 'index.html');
  if (!fs.existsSync(page)) { console.error(`no docs page at ${page}`); process.exit(1); }
  spawn('open', [page], { stdio: 'ignore', detached: true }).unref();
  console.log(page);
}

/**
 * Pairing code for approving a Claude connector.
 *
 * Printed only here, on the machine itself -- that is what stops anyone who
 * merely reaches the public OAuth endpoint from completing an authorization.
 */
async function pair(): Promise<void> {
  const { SimcheckOAuth } = await import('./oauth.js');
  const { SCOPES } = await import('./mcp-remote.js');
  const oauth = new SimcheckOAuth(cfg, SCOPES);
  const { code, expiresAt } = oauth.issuePairingCode();

  console.error('Enter this on the Claude consent screen:');
  console.error('');
  console.log(code);
  console.error('');
  console.error(`valid until ${expiresAt.slice(11, 19)} (10 minutes), single use`);
  if (!cfg.publicUrl) console.error('note: publicUrl is not set, so the remote server will not start yet');
}

async function remote(): Promise<void> {
  const sub = args[1];
  const { SimcheckOAuth } = await import('./oauth.js');
  const { SCOPES } = await import('./mcp-remote.js');

  if (sub === 'status') {
    const oauth = new SimcheckOAuth(cfg, SCOPES);
    print({
      publicUrl: cfg.publicUrl || null,
      connectorUrl: cfg.publicUrl ? new URL('/mcp', cfg.publicUrl).href : null,
      listening: `http://127.0.0.1:${cfg.remotePort}`,
      tokenScope: cfg.remoteToken ? 'remoteToken (scoped)' : 'local token -- consider a scoped one',
      ...oauth.status(),
    });
    return;
  }
  if (sub === 'clients') {
    const rows = new SimcheckOAuth(cfg, SCOPES).listClients();
    if (!rows.length) return void console.log('no connectors registered');
    for (const r of rows) {
      console.log(`${r.clientId}  ${r.name.padEnd(18)} ${r.issuedAt?.slice(0, 19).replace('T', ' ') ?? ''}`);
    }
    return;
  }
  if (sub === 'revoke') {
    const id = need(2, 'client id (see: simcheck remote clients)');
    const gone = new SimcheckOAuth(cfg, SCOPES).revokeClient(id);
    if (!gone) { console.error(`no connector ${id}`); process.exit(1); }
    console.log(`revoked ${id}`);
    return;
  }
  if (sub === 'revoke-all') {
    new SimcheckOAuth(cfg, SCOPES).revokeAll();
    console.log('revoked every OAuth client, access token and refresh token');
    return;
  }
  if (sub === undefined) {
    const server = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'mcp-remote.js');
    const child = spawn(process.execPath, [server], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  console.error(`unknown remote subcommand "${sub}"`);
  process.exit(1);
}

main().catch((e) => {
  if (e instanceof DaemonDownError) console.error(e.message);
  else console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});