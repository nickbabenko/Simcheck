import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, RunView } from './client.js';
import type { RunRequest, Step } from './types.js';



/**
 * Build the MCP server. Shared by the stdio entry point (a local agent spawns
 * it as a child process) and the remote HTTP entry point (Claude's cloud
 * connects to it over OAuth), so both surfaces expose exactly the same tools.
 */
export interface McpServerOptions {
  /**
   * Mint a single-use upload URL. Supplied by the remote transport only: a
   * local stdio caller can already reach the daemon directly, and an upload
   * ticket would be pointless indirection.
   */
  createUploadUrl?: (label?: string) => { url: string; expiresAt: string; expiresInSeconds: number };
}

export function createMcpServer(client: Client, opts: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'sim-harness', version: '0.1.0' },
    {
      instructions: [
        'sim-harness runs a build on a pre-booted iOS simulator, drives a test scenario, and returns screenshots as evidence.',
        '',
        'Use it to prove a UI change actually works before asking for PR review, rather than asserting it does.',
        '',
        'The normal shape is: run_ios_test -> wait_for_test_run -> get_test_screenshot for each screenshot you asked for.',
        'run_ios_test returns immediately with a run id; the run sits in "pending" until a simulator in the pool frees up.',
        '',
        'Tokens are scoped. If a submission is refused with a missing-capability error, call whoami:',
        'a remote token generally cannot name paths on the host and must use an uploaded build (artifactId) instead.',
      ].join('\n'),
    },
  );
  
  /* ------------------------------------------------------------------ schemas */
  
  const appSchema = z.object({
    artifactId: z.string().optional().describe('Id of a .app already uploaded to this harness. Use this when you are not on the machine that holds the source -- it names nothing on the host filesystem.'),
  url: z.string().optional().describe('https URL of a .zip containing a SIMULATOR .app, which the harness downloads itself. This is the way to test a CI build when you cannot upload a binary: point it at a GitHub Actions artifact, a release asset, or a presigned object-store URL. An .ipa will not work -- those are device builds.'),
  urlHeaders: z.record(z.string(), z.string()).optional().describe('Headers for that download. PREFER configuring buildCredentials on the harness instead, so you never handle a token. Redacted from the stored run record and never logged.'),
  github: z.object({
    repo: z.string().describe('"owner/repo"'),
    artifact: z.string().optional().describe('Artifact name from actions/upload-artifact, e.g. "simulator-app".'),
    runId: z.number().optional().describe('Restrict to one workflow run.'),
    branch: z.string().optional().describe('Restrict to artifacts built from this branch.'),
  }).optional().describe('Test the newest matching GitHub Actions artifact. The harness resolves and downloads it using its own stored credentials, so no token passes through you. This is the usual way to test a CI build.'),
    path: z.string().optional().describe('Absolute path to a built simulator .app bundle, or a .zip containing one. Only usable by a token with the runs:submit:local capability. An .ipa will not work -- those are device builds.'),
    project: z.string().optional().describe('Absolute path to an .xcodeproj, to build from source instead.'),
    workspace: z.string().optional().describe('Absolute path to an .xcworkspace, to build from source instead.'),
    scheme: z.string().optional().describe('Scheme to build. Required when building from source.'),
    configuration: z.string().optional().describe('Build configuration. Defaults to Debug.'),
    bundleId: z.string().optional().describe('Only needed if it cannot be read from the app Info.plist.'),
    launchArgs: z.array(z.string()).optional().describe('Arguments passed to the app on launch, e.g. ["-UITestMode", "1"].'),
    launchEnv: z.record(z.string(), z.string()).optional().describe('Environment variables for the app process.'),
  }).describe('Which build to test. Give one of: `url` (a zipped simulator .app to download), `artifactId` (already uploaded), `path`, `scheme` plus `project`/`workspace`, or `bundleId` alone (already installed).');
  
  const deviceSchema = z.object({
    name: z.string().optional().describe('Device type, e.g. "iPhone 17 Pro". Defaults to whatever the pool holds.'),
    runtime: z.string().optional().describe('Runtime, e.g. "iOS 27.0".'),
    udid: z.string().optional().describe('Pin the run to one specific pooled simulator.'),
  }).describe('Which simulator to lease. Omit to take the first free one.');
  
  /* -------------------------------------------------------------------- tools */
  
  server.registerTool('run_ios_test', {
    title: 'Run an iOS test scenario',
    description: [
      'Queue a test run on a pooled iOS simulator and return immediately with a run id.',
      '',
      'Give ONE of: `scenario` (natural language -- an agent drives the UI and works out the taps), `steps` (exact actions, deterministic and free), or `xctest` (run the app\'s own XCUITest bundle, for assertions the screen cannot settle).',
      'Name the screenshots you want in `screenshots`; the run is marked failed if it never reaches a state where it can capture one.',
      'Use `assert` to state what must be true for the run to pass.',
      '',
      'The run starts as "pending" and moves to "running" when a simulator frees up. Poll with wait_for_test_run.',
    ].join('\n'),
    inputSchema: {
      app: appSchema,
      scenario: z.string().optional().describe('What to do, in plain English. e.g. "Log in as demo@test.com / hunter2, open Settings from the tab bar, and turn on Dark Mode."'),
      xctest: z.object({
      xctestrun: z.string().optional().describe('Absolute path to a pre-built .xctestrun. Runs test-without-building, so it works even where the project cannot be compiled.'),
      project: z.string().optional().describe('Absolute path to an .xcodeproj, to build and test from source.'),
      workspace: z.string().optional().describe('Absolute path to an .xcworkspace.'),
      scheme: z.string().optional().describe('Scheme containing the UI test target.'),
      configuration: z.string().optional(),
      testPlan: z.string().optional().describe('Restrict to one test plan.'),
      only: z.array(z.string()).optional().describe('-only-testing entries, e.g. ["AppUITests/PinchTests/testZoom"].'),
      skip: z.array(z.string()).optional().describe('-skip-testing entries.'),
      timeoutMs: z.number().optional(),
    }).optional().describe('Run an XCUITest bundle instead of driving the UI from outside. Use this when the claim needs an assertion the screen cannot settle -- that a gesture changed zoomScale, that a delegate fired, that state is correct rather than merely looking correct. XCUITest also has genuine multi-touch. Cannot be combined with scenario or steps.'),
    steps: z.array(z.record(z.string(), z.any())).optional().describe('Exact actions instead of a scenario. Each is {"action":"tap"|"type"|"screenshot"|"wait"|"wait_for"|"gesture"|"button"|"swipe"|"pinch"|"pan"|"two_finger_press"|"double_tap"|"open_url"|"appearance"|"launch"|"relaunch"|"terminate"|"clear_text"|"press_enter", ...}. Multi-touch: pinch takes `scale` (3 = zoom to 3x, 0.4 = pinch back in) or exact `startSpread`/`endSpread`; two_finger_press puts two fingers down with no travel, which isolates whether the app reacts to the second contact landing rather than to the spread. Unknown keys are rejected rather than ignored.'),
      screenshots: z.array(z.string()).optional().describe('Names of the screenshots to capture, e.g. ["login", "settings", "dark-mode-on"].'),
      assert: z.string().optional().describe('What must hold for a pass, e.g. "the Settings screen renders with a dark background and the toggle reads On".'),
      device: deviceSchema.optional(),
      timeoutMs: z.number().optional().describe('Hard limit on the whole run. Default 10 minutes.'),
      maxActions: z.number().optional().describe('Cap on simulator actions in scenario mode. Default 60.'),
      resetPolicy: z.enum(['uninstall', 'erase']).optional().describe('"uninstall" (fast, default) or "erase" for a full factory reset between runs.'),
      label: z.string().optional().describe('Short human label, shown in listings and on the report.'),
    },
  }, async (args) => {
    const request = args as unknown as RunRequest;
    if (request.steps) request.steps = request.steps as unknown as Step[];
    const run = await client.submit(request);
    return json({
      runId: run.id,
      status: run.status,
      queuePosition: run.queuePosition ?? 0,
      mode: run.mode,
      next: `Call wait_for_test_run with runId "${run.id}".`,
      dir: run.dir,
    });
  });
  
  server.registerTool('wait_for_test_run', {
    title: 'Wait for a test run to finish',
    description: 'Block until the run reaches a terminal state, or until the wait budget runs out. ' +
      'If it returns with done=false the run is still going -- call it again; repeated calls are the ' +
      'intended way to wait out a long run. The harness itself will hold the connection for as long ' +
      'as you ask (measured: 78s on a 150s budget), but most MCP clients kill a single tool call at ' +
      'around 60s, which surfaces as a transport error rather than a result. The default stays under ' +
      'that ceiling deliberately; raise timeoutMs only if you know your client permits it.',
    inputSchema: {
      runId: z.string(),
      timeoutMs: z.number().optional().describe(
        'How long to wait in this call. Default 55000, kept below the ~60s per-call limit most MCP ' +
        'clients impose. Honoured up to 600000, but a value above ~60000 risks the client aborting ' +
        'the call before the harness answers.'),
    },
  }, async ({ runId, timeoutMs }) => {
    const run = await client.waitOnce(runId, Math.min(timeoutMs ?? 55_000, 600_000));
    return json(outcome(run));
  });
  
  server.registerTool('get_test_run', {
    title: 'Get test run state',
    description: 'Current state of a run, including the trace so far. Use wait_for_test_run rather than polling this in a loop.',
    inputSchema: {
      runId: z.string(),
      includeTrace: z.boolean().optional().describe('Include the full step-by-step trace. Off by default because it is long.'),
    },
  }, async ({ runId, includeTrace }) => {
    const run = await client.get(runId);
    return json({ ...outcome(run), ...(includeTrace ? { trace: run.trace } : {}) });
  });
  
  server.registerTool('get_test_screenshot', {
    title: 'Get a screenshot from a test run',
    description: 'Return a captured screenshot as an image so you can actually look at it. This is the evidence you attach to a PR.',
    inputSchema: {
      runId: z.string(),
      name: z.string().describe('Screenshot name, as listed by wait_for_test_run.'),
    },
  }, async ({ runId, name }) => {
    const png = await client.screenshot(runId, name);
    return {
      content: [
        { type: 'text' as const, text: `Screenshot "${name}" from run ${runId}:` },
        { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
      ],
    };
  });
  
  server.registerTool('get_test_report', {
    title: 'Get the evidence report',
    description: 'The markdown report for a run: verdict, evidence, screenshots and the full trace. Paste this into a PR description.',
    inputSchema: { runId: z.string() },
  }, async ({ runId }) => {
    const md = await client.report(runId);
    return { content: [{ type: 'text' as const, text: md }] };
  });
  
  server.registerTool('list_test_runs', {
    title: 'List recent test runs',
    description: 'Recent runs, newest first.',
    inputSchema: { limit: z.number().optional().describe('Default 20.') },
  }, async ({ limit }) => json(await client.list(limit ?? 20)));
  
  server.registerTool('cancel_test_run', {
    title: 'Cancel a test run',
    description: 'Stop a queued or running test and release its simulator.',
    inputSchema: { runId: z.string() },
  }, async ({ runId }) => json(outcome(await client.cancel(runId))));
  
  server.registerTool('sim_pool_status', {
    title: 'Simulator pool status',
    description: 'How many simulators are ready, busy or still pending, and how many runs are queued. Check here if runs are sitting in "pending".',
    inputSchema: {},
  }, async () => {
    const pool = await client.pool();
    return json({
      target: pool.target,
      counts: pool.counts,
      queued: pool.queued,
      running: pool.active,
      devices: pool.devices.map((d) => ({
        name: d.name, status: d.status, deviceType: d.deviceType, runtime: d.runtime,
        udid: d.udid, runId: d.currentRunId ?? null, error: d.lastError ?? null,
      })),
    });
  });
  
  server.registerTool('sim_pool_remove', {
    title: 'Remove a simulator from the pool',
    description: [
      'Delete a pooled simulator, freeing its disk (roughly 3GB each).',
      'Refuses while it is running a test unless you pass force.',
    ].join('\n'),
    inputSchema: {
      udid: z.string().describe('UDID from sim_pool_status.'),
      force: z.boolean().optional().describe('Remove even if a run is using it.'),
    },
  }, async ({ udid, force }) => json(await client.removeDevice(udid, force ?? false)));

  server.registerTool('sim_pool_add', {
    title: 'Add simulators to the pool',
    description: [
      'Create and boot extra simulators. They are added in "pending" and become "ready" once booted, roughly half a minute each.',
      '',
      'You usually do NOT need this: a run asking for a device the pool lacks provisions one automatically -- it just starts slower.',
      'Use this to warm a device ahead of time when you know you will need it, or to widen the pool for concurrency.',
      'Each warm simulator costs about 3GB of disk.',
    ].join('\n'),
    inputSchema: {
      count: z.number().optional().describe('How many to add. Default 1.'),
      deviceType: z.string().optional().describe('e.g. "iPhone 17 Pro". Defaults to the pool default.'),
      runtime: z.string().optional().describe('e.g. "iOS 27.0". Defaults to the newest installed.'),
    },
  }, async (args) => {
    const { added, pool } = await client.addDevices(args);
    return json({
      added: added.map((d) => ({ name: d.name, udid: d.udid, status: d.status, deviceType: d.deviceType, runtime: d.runtime })),
      note: 'Added as pending; they will be picked up and booted shortly.',
      counts: pool.counts,
    });
  });
  
  if (opts.createUploadUrl) {
    server.registerTool('create_upload_url', {
      title: 'Get a URL to upload a build to',
      description: [
        'Mint a short-lived, single-use URL for uploading a simulator build (a zip of a .app).',
        '',
        'Use this when you have a build you cannot pass through a tool call -- an artifact you downloaded from CI, say.',
        'Tool calls carry JSON, so a 40MB binary cannot go through one; this gives you a plain HTTP endpoint instead.',
        '',
        'Then: curl -X POST "<url>" -H "Content-Type: application/zip" --data-binary @App.zip',
        'The response contains an "id" to pass as {"app": {"artifactId": "<id>"}}.',
        'No extra credential is needed -- the URL itself is the authorisation, and it expires.',
      ].join('\n'),
      inputSchema: {
        label: z.string().optional().describe('Optional label, e.g. the branch or PR this build came from.'),
      },
    }, async ({ label }) => {
      const ticket = opts.createUploadUrl!(label);
      return json({
        uploadUrl: ticket.url,
        expiresAt: ticket.expiresAt,
        expiresInSeconds: ticket.expiresInSeconds,
        method: 'POST',
        contentType: 'application/zip',
        singleUse: true,
        next: 'POST the zipped .app to uploadUrl, then use the returned id as app.artifactId.',
        note: 'It must be a SIMULATOR build. An .ipa holds an arm64 device slice and will be rejected.',
      });
    });
  }

  server.registerTool('get_upload_command', {
  title: 'How CI should upload a build',
  description: [
    'The exact command a CI job runs to push a simulator build into this harness, and the run request that then tests it.',
    'Use this when someone asks how to wire up CI: it is one curl, needs no GitHub token on the harness, and works with any CI provider.',
  ].join('\n'),
  inputSchema: {
    label: z.string().optional().describe('Optional label for the upload, e.g. the branch name.'),
  },
}, async ({ label }) => {
  const { upload } = await client.health() as unknown as { upload?: string };
  const url = upload ?? '<the harness public URL>/upload';
  return { content: [{ type: 'text' as const, text: [
    '# 1. In CI, after building for the simulator:',
    'ditto -c -k --keepParent "$APP_PATH" App.zip',
    `curl -sS -X POST "${url}${label ? `?label=${encodeURIComponent(label)}` : '?label=$GITHUB_REF_NAME'}" \\`,
    '  -H "Authorization: Bearer $SIM_HARNESS_TOKEN" \\',
    '  -H "Content-Type: application/zip" \\',
    '  --data-binary @App.zip',
    '',
    '# It prints JSON containing an "id". Then test that build:',
    '#   run_ios_test { "app": { "artifactId": "<id>" }, "scenario": "...", "screenshots": [...] }',
    '',
    '# The CI token needs the artifacts:write capability:',
    '#   sim-harness token create ci --preset remote',
    '# An .ipa will not work -- build with -destination "generic/platform=iOS Simulator".',
  ].join('\n') }] };
});

server.registerTool('whoami', {
    title: 'What can this token do',
    description: 'The capabilities and limits of the token this MCP server is using. Check here first if a submission is rejected with a 403 -- it will tell you which capability is missing.',
    inputSchema: {},
  }, async () => json(await client.whoami()));
  
  server.registerTool('list_uploaded_builds', {
    title: 'List uploaded builds',
    description: 'Simulator .app bundles that have been uploaded to this harness, newest first. Reference one by its id as {"app": {"artifactId": "..."}}.',
    inputSchema: {},
  }, async () => json(await client.listArtifacts()));
  
  server.registerTool('inspect_simulator', {
    title: 'Inspect a simulator screen',
    description: 'Live accessibility tree of a pooled simulator: every element with its type, label, identifier and tap coordinates. Use this to author exact `steps` for a deterministic run.',
    inputSchema: { device: z.string().describe('Pool device name (e.g. "sim-harness-01") or its UDID.') },
  }, async ({ device }) => json(await client.inspect(device)));

  return server;
}

/* ------------------------------------------------------------------ helpers */

/** The shape a calling agent needs to decide what to do next. */
function outcome(run: RunView) {
  return {
    runId: run.id,
    status: run.status,
    done: run.done,
    passed: run.status === 'passed',
    ...(run.done ? {} : { queuePosition: run.queuePosition ?? null }),
    summary: run.verdict?.summary ?? run.error ?? null,
    evidence: run.verdict?.evidence ?? null,
    device: run.device?.name ?? null,
    screenshots: run.screenshots.map((s) => s.name),
    missingScreenshots: (run.request.screenshots ?? []).filter(
      (w) => !run.screenshots.some((s) => s.name === w)),
    actionsUsed: run.actionsUsed ?? null,
    ...(run.tests ? { tests: run.tests } : {}),
    reportPath: run.artifacts.report ? `${run.dir}/${run.artifacts.report}` : null,
    ...(run.done && run.status !== 'passed'
      ? { hint: 'Read get_test_report for the full trace, and get_test_screenshot to see what the app actually showed.' }
      : {}),
  };
}

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

