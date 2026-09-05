# simcheck

Hand off mobile UI testing to a pool of pre-booted iOS simulators and Android
emulators.

**[Documentation](https://nickbabenko.github.io/Simcheck/)** — features, how it
works, and setup for Claude Code, Claude Desktop, Codex, Cursor, VS Code and any
other MCP agent. Also available offline: `simcheck docs` opens the same page
from your checkout, no network needed.

An agent submits a build, a test scenario and the screenshots it wants back.
The harness leases a warm device, installs the app, drives the UI, captures
the named screenshots and returns a verdict. The caller polls until it is done,
then attaches the evidence to a PR.

The platform is inferred from the build — an `.apk` means Android, a `.app`
means iOS — so most requests never mention it. One pool holds both.

The point is to replace "I changed the toggle and it should work" with a
screenshot of the toggle in its new state.

```
     agent                    daemon                      device pool
       |                        |                              |
       |-- run_device_test ---->| queue: pending               |  01 ios   ready
       |<-- runId --------------| lease a ready device ------->|  02 ios   ready
       |                        | build -> install -> drive    |  03 droid leased
       |-- wait_for_test_run -->|                              |
       |<-- passed + shots -----| recycle the device --------->|  03 droid ready
```

## Install

```bash
git clone <this repo> ~/Developer/simcheck && cd ~/Developer/simcheck
./install.sh
```

That checks your toolchain, installs the [AXe](https://github.com/cameroncooke/AXe)
simulator driver via Homebrew, builds, links `simcheck` into `~/.local/bin`,
registers a launchd agent so the pool is warm after a reboot, installs the
`ios-sim-test` Claude skill, and registers the MCP server with Claude Code.

```bash
./install.sh --no-daemon     # set up without starting the daemon
./install.sh --no-mcp        # skip Claude Code registration
./install.sh --uninstall     # remove agent, MCP entry, skill and symlinks
```

Requirements: macOS, Node 20+, and Homebrew.

For iOS: Xcode with a simulator runtime installed, plus AXe (the installer adds
it). For Android: the SDK, a JDK, an emulator and a system image —

```bash
brew install --cask android-commandlinetools android-platform-tools
brew install openjdk@21
sdkmanager "emulator" "build-tools;35.0.0" \
           "system-images;android-35;google_apis;arm64-v8a"
```

Neither platform is required. A Mac with Xcode and no Android SDK runs iOS and
reports android as unavailable with a reason; the reverse also holds. Run
`simcheck doctor` to see exactly what is missing and the command that fixes it.

## Use it

```bash
simcheck status                              # daemon and pool
simcheck submit examples/demo-steps.json --wait
simcheck report <run-id>                     # markdown evidence
simcheck inspect simcheck-01              # live screen, for authoring steps
simcheck upload build/App.app                # returns an artifact id
simcheck whoami                              # capabilities of the current token
simcheck doctor                              # toolchain, TLS path, exposure
```

Tests: `npm test` — 25 cases covering Cloudflare Access JWT verification against
forged tokens, CIDR matching, and the full remote OAuth flow including replayed
authorization codes, rotated refresh tokens, wrong PKCE verifiers and reused
pairing codes.

From an agent, the MCP tools are the better surface — `get_test_screenshot`
returns the PNG as an image, so the agent can actually look at what it built:

| Tool | |
|---|---|
| `run_ios_test` | Queue a run, returns a `runId` straight away |
| `wait_for_test_run` | Block until it finishes |
| `get_test_run` | Current state, optionally with the full trace |
| `get_test_screenshot` | One screenshot, as an image |
| `get_test_report` | The markdown write-up |
| `list_test_runs` / `cancel_test_run` | |
| `sim_pool_status` / `sim_pool_add` | |
| `inspect_simulator` | Live accessibility tree, for authoring `steps` |

## The three ways to describe a test

**Natural language** — an agent reads the accessibility tree, decides the taps,
and captures the screenshots you named:

```json
{
  "app": { "project": "App.xcodeproj", "scheme": "App" },
  "scenario": "Sign in as demo@example.com / hunter2, open Settings, turn on Beta Features.",
  "screenshots": ["signed-in", "beta-on"],
  "assert": "The Beta Features toggle reads On."
}
```

**Explicit steps** — deterministic, no model in the loop, no token cost:

```json
{
  "app": { "path": "/abs/path/App.app" },
  "screenshots": ["beta-on"],
  "steps": [
    { "action": "tap", "id": "beta_toggle" },
    { "action": "screenshot", "name": "beta-on" }
  ]
}
```

Every scenario run returns `executedSteps` — the exact steps it took. Lift them
into a `steps` run and the one-off exploration becomes a repeatable check.

Actions: `tap` (by `id`, `label`, `value` or `x`/`y`), `double_tap`, `type`,
`clear_text`, `press_enter`, `swipe`, `gesture`, **`pinch`**, **`pan`**,
`button`, `wait`, `wait_for`, `screenshot`, `open_url`, `appearance`,
`permission`, `launch`, `relaunch`, `terminate`, `describe_ui`.

### Multi-touch

`pinch`, `pan` and `double_tap` are genuine two-contact HID input, via
[baguette](https://github.com/tddworks/baguette) (`brew install baguette`). AXe
drives a single contact — `axe touch` takes one coordinate pair with no finger
index — so those gestures are not expressible through it. The driver is
optional: without it only those three actions fail, with an install hint.

For a gesture claim that needs an assertion rather than a screenshot, use
`xctest`: `XCUIElement.pinch(withScale:velocity:)` is multi-touch too, and its
result is assertable.

## Supplying the build

| | |
|---|---|
| `{"project": "App.xcodeproj", "scheme": "App"}` | Built by the harness, into its own DerivedData |
| `{"workspace": "App.xcworkspace", "scheme": "App"}` | Same, for workspaces |
| `{"path": "/abs/App.app"}` | A prebuilt simulator bundle, or a `.zip` of one |
| `{"bundleId": "com.example.app"}` | Already installed on the pooled sims |
| `{"artifactId": "<id>"}` | A `.app` uploaded earlier |
| `{"url": "https://…/App.zip"}` | A zipped simulator `.app` the harness **downloads itself** |

`.ipa` files are rejected with an explanation — they hold arm64 device slices
and cannot run on a simulator.

## Testing a CI build

### The simplest way: the agent uploads it (no CI changes at all)

If your repo already produces a build artifact, nothing needs adding to CI. An
agent that holds an OAuth session mints its own upload URL:

1. `create_upload_url` → a single-use URL, valid 15 minutes
2. The agent downloads the artifact from CI and POSTs the zip to that URL
3. The response carries an `id` → run `{"app": {"artifactId": "<id>"}}`

```bash
curl -X POST "<uploadUrl>" -H "Content-Type: application/zip" --data-binary @App.zip
```

The URL *is* the authorisation, so there is no header to set and no secret in
CI. It works because a tool call carries JSON — a 40MB binary needs a plain HTTP
request, which this provides. Tickets are single use and burned before the body
is read, so a retry cannot replay one.

This is the right default when the agent can already reach your CI artifacts.

### If CI should push instead

Useful when no agent is in the loop — a nightly build, say. Per-repo setup is
one curl, using a long-lived token in CI secrets.

```yaml
- name: Push the build to simcheck
  run: |
    ditto -c -k --keepParent "$APP_PATH" App.zip
    curl -sS -X POST "$SIMCHECK_URL/upload?label=$GITHUB_REF_NAME" \
      -H "Authorization: Bearer $SIMCHECK_TOKEN" \
      -H "Content-Type: application/zip" \
      --data-binary @App.zip
```

It returns JSON with an `id`; the agent then runs
`{"app": {"artifactId": "<id>"}}`. Mint the CI token with
`simcheck token create ci --preset remote` — it needs `artifacts:write`, and
deliberately cannot trigger a local build.

Ask the `get_upload_command` MCP tool and it prints this snippet with your real
URL filled in.

### The other direction: the harness pulls (`app.url`)

An MCP tool call carries JSON, so a 40MB binary cannot go through one. Instead
the harness fetches the build:

```json
{
  "app": {
    "url": "https://api.github.com/repos/OWNER/REPO/actions/artifacts/123/zip",
    "urlHeaders": { "Authorization": "Bearer ghp_..." }
  },
  "scenario": "Sign in and open Settings.",
  "screenshots": ["settings"]
}
```

Useful when the build already exists somewhere and you would rather not change
CI at all. It costs more setup than the upload route, though: the harness needs
a stored provider credential, and it opens an outbound request surface that has
to be guarded. Prefer the upload endpoint unless you specifically need pulling.

For GitHub specifically, `app.github` resolves the newest matching artifact
using credentials stored on the Mac, so no token passes through the agent:

```json
{ "app": { "github": { "repo": "owner/app", "artifact": "simulator-app", "branch": "main" } } }
```

A working workflow is in [`examples/ci/github-actions.yml`](examples/ci/github-actions.yml).

Two things that bite people, both handled:

- **It must be a simulator build.** An `.ipa` holds an arm64 device slice and
  cannot run on a simulator; a URL ending `.ipa` is rejected at submit with that
  explanation. Build with `-destination 'generic/platform=iOS Simulator'`.
- **`actions/upload-artifact` does not preserve the executable bit**, so a raw
  `.app` arrives unable to launch. `ditto` it into a zip first — which means the
  download is a zip containing a zip. The harness unwraps that automatically.

Downloads are content-addressed, so re-running an unchanged build costs one
HTTP request and no disk.

### What it refuses to fetch

`app.url` lets a caller make the daemon issue an HTTP request, which is a
server-side request forgery primitive if left open. So:

- **https only**, and the host is resolved **at submit time** — a bad URL fails
  immediately rather than after leasing a simulator
- **Private destinations are refused**: RFC1918, loopback, link-local
  (`169.254.169.254`, the cloud metadata address), and the `100.64.0.0/10` CGNAT
  range that Tailscale uses
- **Every redirect hop is re-checked**, and the `Authorization` header is
  dropped on a cross-origin redirect, so a CI token is never handed to a
  redirect target
- **`urlHeaders` never touch disk.** They are held in memory for the one fetch
  and redacted in the stored run record

`allowedBuildHosts` restricts fetching to named hosts. Listing a host is also a
deliberate statement of trust, so it **overrides the private-address block** —
which is how you host builds on your own LAN or tailnet without weakening the
guard for anything else.

## The pool

`poolSize` simulators are kept booted and idle. A device is `pending` when it
has been added but not yet booted, `ready` when idle, `leased` while running a
job, and `recycling` while being reset. Runs queue as `pending` until a matching
device is free, so pool size is the concurrency limit.

```bash
simcheck pool                      # state
simcheck pool add -n 2             # added as pending, booted shortly after
simcheck pool remove <udid>
```

### A pool of more than one runtime

`poolSize` keeps N devices of a single `deviceType`/`runtime`. To hold several
kinds at once — say one runtime your SDK can build for and another matching what
you ship — set `pool` instead, and each entry is filled independently:

```json
{
  "pool": [
    { "deviceType": "iPhone 17 Pro", "runtime": "26.3", "count": 1 },
    { "deviceType": "iPhone 17 Pro", "runtime": "27.0", "count": 1 }
  ]
}
```

A run then picks with `"device": { "runtime": "27.0" }` (or `name` for the
device type). A request nothing in the pool can satisfy fails immediately with
what is available, rather than queueing for ever.

Each warm simulator costs roughly 3 GB of disk, so size this against the space
you have.

**The pool only ever touches simulators named `simcheck-*`.** Simulators you
use in Xcode are never booted, erased or deleted by this daemon.

Between runs a device is reset by uninstalling the app (fast). Pass
`"resetPolicy": "erase"` for a full factory reset when a test needs virgin state.

Recycling also **sanitises the screen**, which matters more than it sounds.
Uninstalling an app does not dismiss a system alert it left behind — a
"Allow X to access your calendar?" sheet belongs to SpringBoard, so it survives
the uninstall and would silently swallow the next run's taps. Recycling
therefore presses home, dismisses any leftover modal (always choosing the
declining option, never granting a permission), and reboots the device if the
modal will not go. A device that is still dirty after that is marked `offline`
rather than handed to a run.

## Claude on your phone (remote MCP)

The stdio MCP server only works for an agent on this Mac. The Claude apps —
including the phone — connect through a **custom connector**, and the key
detail is who does the connecting:

> "Claude connects to your remote MCP server from Anthropic's cloud
> infrastructure, rather than from your local device… Servers hosted on a
> private corporate network, behind a VPN, or blocked by a firewall won't
> connect."

So the endpoint must be reachable from the public internet. **Tailscale cannot
serve this** — your phone being on the tailnet is irrelevant, because your phone
is not what connects. That leaves a tunnel, and therefore real authentication.

`simcheck remote` is an OAuth 2.1 authorization server plus the MCP endpoint
as a resource server. Two things keep the blast radius small:

- **Authorization needs a pairing code printed on the Mac.** Finding the URL is
  not enough; you must be able to run `simcheck pair`. The code is
  hashed on disk, single use, and expires in ten minutes.
- **It talks to the daemon with a scoped token.** Point `remoteToken` at a
  `remote` preset token and the connector can never build from a local path —
  removing the only route to arbitrary code execution, even if OAuth were bypassed.

### Setting it up

```bash
# 1. a token the connector cannot hurt you with
simcheck token create phone --preset remote

# 2. tell the harness where it will be published, in ~/.simcheck/config.json
#    { "publicUrl": "https://<host>:8443", "remoteToken": "<the secret>" }

# 3. publish it, then register the launchd agent
./install.sh                # picks up publicUrl and keeps the server running

# 4. in Claude: Settings > Connectors > Add custom connector
#    URL: https://<host>:8443/mcp

# 5. when Claude shows the consent screen, on the Mac:
simcheck pair            # prints e.g. K7QP-3MTX, valid 10 minutes
```

### Publishing it: Tailscale Funnel

Funnel is the shortest path if you already run Tailscale — no DNS record, no
second account, the TLS certificate is handled for you, and the config lives in
`tailscaled` state so it **survives reboots without a launchd wrapper**.

```bash
tailscale funnel --bg 8830        # local 8830, published on public 443
```

**It must be public port 443.** The argument above is the *local* port; the
public side defaults to 443. Funnel also accepts `--https=8443` and
`--https=10000`, but **Claude connectors reject a non-443 URL** — a connector
pointed at `…ts.net:8443/mcp` fails with "Couldn't reach this address" even
though the endpoint answers correctly from the public internet. That failure
mode costs an afternoon if you do not know it, because every other diagnostic
says the server is fine.

Funnel is all-or-nothing per port — from the Tailscale docs, *"If the most
recent command to configure the port was `funnel`, then the port will be
completely public"*. So if `tailscale serve` already publishes something on 443,
move it to another port first or it becomes public too:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:<its-port>   # that service, tailnet-only
tailscale funnel --bg 8830                                       # simcheck, public 443
```

Funnel has no authentication of its own, which is exactly why the pairing code
and the scoped token matter — they are the only thing between the public
internet and your Mac.

For Cloudflare instead, `simcheck tunnel <hostname>` scaffolds it. Note that
a tunnel needs a *proxied* CNAME, so do not put it in a namespace your Terraform
manages as unproxied private records.

Claude registers itself dynamically, so there is no client ID or secret to copy.

```bash
simcheck remote status        # registered clients and live tokens
simcheck remote revoke-all    # kill every connector credential at once
```

`revoke-all` is the thing to run if you lose the phone.

### What it does not solve

The endpoint is public. The pairing code and the scoped token are what make that
acceptable — do not skip either. And `publicUrl` must be `https`, or OAuth
redirect URIs are rejected.


## Security model

**The daemon binds to `127.0.0.1` and is not reachable from the network.** That
is the intended deployment: the agent and the simulator pool live on the same
Mac, so nothing leaves the machine.

### Why that matters more than it looks

Submitting `{"project": "App.xcodeproj", "scheme": "App"}` makes the daemon run
`xcodebuild` on that project, and Xcode Run Script build phases execute
arbitrary shell **as you**. A caller that can name a local project therefore has
code execution on this Mac. That is inherent to any build service, and it is why
tokens are scoped rather than all-powerful.

### Scoped tokens

Each token carries an explicit capability set. Secrets are stored as SHA-256
hashes; the plaintext is shown once at creation and never again.

| Capability | Grants |
|---|---|
| `runs:submit:local` | Name a path, project or workspace on this Mac — **implies code execution** |
| `runs:submit:artifact` | Run a previously uploaded `.app` |
| `runs:submit:url` | Have the harness download a build and run it |
| `runs:submit:installed` | Run an app already on the simulator |
| `artifacts:write` | Upload a `.app` zip |
| `runs:read` / `runs:cancel` | Poll runs, fetch screenshots, reports, logs; cancel |
| `pool:read` / `pool:write` | Read pool state; create or delete simulators |
| `inspect` | Read the live screen of a pooled simulator |

Three presets:

- **`full`** — everything. The auto-created `local` token, for agents on this Mac.
- **`remote`** — deliberately **omits `runs:submit:local`**, so a remote caller
  can never name a path on your filesystem. It uploads a built `.app` instead,
  which is only ever installed into a simulator. Defaults to 2 concurrent runs
  and 60 per hour.
- **`readonly`** — poll and read results only.

```bash
simcheck whoami                                   # what the current token may do
simcheck token list
simcheck token create cloud --preset remote       # prints the secret once
simcheck token revoke cloud
```

Managing tokens requires `pool:write`, which no remote preset grants — a remote
token cannot mint itself a better one.

### Audit log

Every submission, upload and refusal is appended to `~/.simcheck/audit.log`
as JSONL, tagged with the token that did it.

```bash
tail -f ~/.simcheck/audit.log | jq -r '"\(.at) \(.token) \(.action) \(.outcome)"'
```

`~/.simcheck/{token,tokens.json,audit.log}` are all mode 600. Do not print
them into a transcript.

### Exposing it: edge authentication

`edgeAuth` decides who may reach the daemon *before* any token is checked. The
daemon **refuses to bind beyond `127.0.0.1` while `edgeAuth` is `none`**, because
that would publish a code-execution surface.

| Mode | For |
|---|---|
| `none` (default) | Loopback only. Correct on a dev machine. |
| `cloudflare-access` | The daemon verifies the `Cf-Access-Jwt-Assertion` JWT itself |
| `trusted-proxy` | A ZTNA broker or internal reverse proxy — Netskope Private Access, Caddy, an internal LB |

#### Cloudflare Access

```bash
simcheck tunnel sim.home.nickbabenko.com
```

That writes a `cloudflared` config and prints the remaining steps. It
deliberately **creates nothing in your Cloudflare account** — publishing a
service that can build code is a decision to take deliberately.

```json
{
  "host": "127.0.0.1",
  "edgeAuth": "cloudflare-access",
  "cloudflareTeamDomain": "yourteam.cloudflareaccess.com",
  "cloudflareAud": ["<Application Audience tag>"]
}
```

The daemon fetches your team's JWKS and verifies every request's JWT:
signature (RS256), issuer, audience, and expiry. **Verifying in the origin is
the point** — if you only trust "it arrived via the tunnel", anyone who reaches
the origin by another route walks straight past Access. Signing keys rotate, so
an unknown `kid` triggers a refresh rather than a rejection.

A client then sends three things:

```bash
curl https://sim.home.nickbabenko.com/v1/runs \
  -H "CF-Access-Client-Id: <id>.access" \
  -H "CF-Access-Client-Secret: <secret>" \
  -H "Authorization: Bearer <simcheck token>" \
  -d @request.json
```

#### Netskope, and other ZTNA brokers

There is no SDK to integrate — the work splits in two:

**Reachability** is admin-side. In Netskope Private Access you publish a Private
App pointing at this host and port, reached through an NPA Publisher on your
network, and grant it to the right group. NPA brokers TCP; it does not stamp a
signed identity into HTTP requests. So the daemon authenticates *the hop* and
leaves authorisation entirely to the bearer token:

```json
{
  "host": "0.0.0.0",
  "edgeAuth": "trusted-proxy",
  "trustedProxies": ["10.20.30.0/24"],
  "identityHeader": "X-Forwarded-User"
}
```

`trustedProxies` is the address your publisher connects from. `identityHeader`
is optional and **advisory only** — recorded in the audit log, never trusted for
authorisation, and only read at all from a trusted hop.

**TLS interception** is the half that actually breaks things. Netskope re-signs
outbound TLS, so Node rejects every HTTPS call with `SELF_SIGNED_CERT_IN_CHAIN`
unless it trusts the corporate root:

```json
{ "caBundle": "/Library/Application Support/Netskope/STAgent/data/nscacert.pem" }
```

Then re-run `./install.sh`, which writes it into the launchd plist as
`NODE_EXTRA_CA_CERTS`. Node reads that variable **once at startup**, so setting
it later has no effect — `simcheck doctor` warns when the two disagree.

#### Binding the two credentials together

By default, edge auth and token auth are independent doors. `identityBindings`
makes them useful only in combination, so neither a stolen service token nor a
stolen bearer token is enough alone:

```json
{ "identityBindings": { "abc123.access": ["cloud"] } }
```

### Diagnosing it

```bash
simcheck doctor
```

Checks the toolchain, whether your Xcode SDK can actually target your installed
simulator runtimes, whether outbound TLS is being intercepted (and by whom),
and whether your exposure settings are coherent. Exits non-zero if anything is
broken.

## Deployment shapes

**On your own machine (default, and the right answer at work).** Claude Code and
the daemon both run on the engineer's Mac; the agent talks to `127.0.0.1` and
submits local project paths. Source never leaves the box, builds are incremental
against warm DerivedData, and there is no new egress to sanction. If your repos
are IP-protected, this is the shape you want.

**Split machines — build here, test there.** Your Mac builds and uploads; some
other agent drives the test with a `remote` token:

```bash
simcheck upload --scheme App --project App.xcodeproj --label "fix-toggle"
# builds for the simulator, zips, uploads, prints an artifact id
```

Then submit `{"app": {"artifactId": "<id>"}}`. Only the compiled bundle moves,
never the source. Uploads are content-addressed, so re-uploading an unchanged
build costs nothing.

**A shared pool for a team.** Uploading a build per run gets wasteful. The
efficient shape is a git ref the shared Mac fetches itself — an incremental
`git fetch` plus an incremental build, with clients passing only a sha, so the
code goes git-server → build-Mac and crosses no boundary. Not built yet; say the
word.


## Configuration

`~/.simcheck/config.json`, or `SIMCHECK_*` environment variables
(`SIMCHECK_POOL_SIZE`, `SIMCHECK_PORT`, ...).

There is no config file by default — the daemon runs on the built-in defaults
below, which means loopback-only with no edge auth. `config.example.json` in
this repo lists every key with its default; copy it and delete what you do not
need. `simcheck doctor` reports what is actually live.

| Key | Default | |
|---|---|---|
| `poolSize` | `3` | Pre-booted simulators, and therefore max concurrency |
| `deviceType` | `iPhone 17 Pro` | |
| `runtime` | newest installed | |
| `port` / `host` | `8829` / `127.0.0.1` | Loopback only by default |
| `defaultTimeoutMs` | `600000` | Hard ceiling per run |
| `defaultMaxActions` | `60` | Action budget for scenario runs |
| `llmBackend` | `auto` | `anthropic`, `claude-cli`, or `none` |
| `model` | `claude-opus-5` | |
| `retainRuns` | `200` | Older runs are deleted from disk |
| `maxArtifactBytes` | `1073741824` | Largest accepted `.app` zip upload |
| `allowedBuildHosts` | `[]` | Hosts `app.url` may fetch from; also overrides the private-address block |
| `buildCredentials` | `{}` | Per-host headers for fetching a build, e.g. a GitHub token. Keeps the secret off the caller |
| `artifactRetentionDays` | `14` | Uploaded builds older than this are pruned |
| `edgeAuth` | `none` | `none`, `cloudflare-access` or `trusted-proxy` |
| `edgeAllowLoopback` | `true` | Keep accepting local callers when an edge mode is on |
| `cloudflareTeamDomain` / `cloudflareAud` | `''` / `[]` | Access team and Application Audience tags |
| `trustedProxies` | `[]` | Source CIDRs permitted in `trusted-proxy` mode |
| `identityHeader` | `''` | Advisory identity header, audit only |
| `identityBindings` | `{}` | Which bearer tokens an edge identity may use |
| `caBundle` | `''` | Corporate root CA, for networks that inspect TLS |

### The model backend

Natural-language scenarios need a model. With no configuration the harness
shells out to your local `claude` CLI, so it works immediately — but each turn
pays for a fresh session.

Setting an API key is markedly cheaper and faster, because the Messages API
backend keeps one cached conversation per run:

```bash
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc
simcheck stop && simcheck start
```

`simcheck status` reports which backend is live. Explicit `steps` runs never
call a model at all.

## HTTP API

Loopback, bearer token at `~/.simcheck/token` (mode 600 — do not print it).

Every route except `/health` needs `Authorization: Bearer <token>`, and each
one checks a specific capability.

```
GET    /health                              unauthenticated liveness
GET    /v1/whoami                           this token's capabilities and limits
POST   /v1/artifacts?label=&gitSha=         upload a zipped .app  [artifacts:write]
GET    /v1/artifacts | /v1/artifacts/:id    uploaded builds       [runs:read]
GET    /v1/tokens                           list tokens           [pool:write]
POST   /v1/tokens                           mint one, secret shown once
DELETE /v1/tokens/:nameOrId                 revoke
POST   /v1/runs                             submit; 202 with the run id
GET    /v1/runs?status=&limit=              list
GET    /v1/runs/:id                         full state
GET    /v1/runs/:id/wait?timeoutMs=         long-poll until terminal
DELETE /v1/runs/:id                         cancel
GET    /v1/runs/:id/report                  markdown
GET    /v1/runs/:id/screenshots             index
GET    /v1/runs/:id/screenshots/:name       PNG
GET    /v1/runs/:id/app.log | build.log     logs
GET    /v1/pool                             pool state
POST   /v1/pool/devices                     add (lands as pending)
DELETE /v1/pool/devices/:udid[?force=true]  remove
GET    /v1/inspect/:deviceOrUdid            live accessibility tree
```

Run statuses: `pending` → `preparing` → `running` → `passed` | `failed` |
`error` | `timeout` | `cancelled`. `error` means the harness or the build
broke; it is not a verdict on the app.

## Artifacts

Everything for a run lands in `~/.simcheck/runs/<id>/`:

```
run.json                 full state, including executedSteps and the trace
report.md                the human-readable evidence write-up
screenshots/*.png        every named capture, plus final-state
app.log                  the app's own log output
build.log                xcodebuild output, when built from source
```

## Layout

| | |
|---|---|
| `src/daemon.ts` | Entry point: preflight, pool, scheduler, HTTP server |
| `src/pool.ts` | Keeps N simulators booted; leases and recycles them |
| `src/scheduler.ts` | Matches queued runs to ready devices |
| `src/runner.ts` | One run: build, install, drive, report, release |
| `src/agent.ts` | The natural-language scenario loop |
| `src/steps.ts` | Executes one action; records it for replay |
| `src/device.ts` | The platform seam: device backend, UI driver, multi-touch |
| `src/screen.ts` | The normalised screen model both drivers produce |
| `src/platforms.ts` | Which platforms this daemon can actually serve |
| `src/ios/axe.ts` | AXe wrapper, and the tree compression that makes it promptable |
| `src/ios/build.ts` | xcodebuild, zip unpacking, device-build detection |
| `src/llm.ts` | Anthropic API and `claude` CLI backends |
| `src/server.ts` | HTTP API |
| `src/auth.ts` | Scoped capability tokens |
| `src/artifacts.ts` | Content-addressed store of uploaded `.app` bundles and `.apk`s |
| `src/fetchbuild.ts` | Downloads a build from a URL, with SSRF guards |
| `src/ios/xctest.ts` | Runs an XCUITest bundle and parses the .xcresult |
| `src/ios/baguette.ts` | iOS multi-touch driver (pinch, pan, double-tap) |
| `src/android/sdk.ts` | Finds the Android SDK, and a JDK to run its Java tools |
| `src/android/adb.ts` | adb transport, keyed by AVD name rather than serial |
| `src/android/avd.ts` | System images, AVD creation, emulator boot and kill |
| `src/android/uiautomator.ts` | `uiautomator dump` + `input`, flattened to the shared model |
| `src/android/apk.ts` | Manifest reading and the ABI compatibility check |
| `src/android/gradle.ts` | Assembles app and androidTest APKs |
| `src/android/instrument.ts` | Runs an instrumentation suite and parses its stream |
| `src/android/touch.ts` | Android multi-touch, via the driver APK |
| `driver/` | The UiAutomator multi-touch driver APK (built by `driver/build.sh`) |
| `src/audit.ts` | Append-only JSONL audit log |
| `src/edge.ts` | Cloudflare Access JWT verification, trusted-proxy gating |
| `src/doctor.ts` | Toolchain, TLS-interception and exposure diagnosis |
| `src/mcp-server.ts` | MCP tool definitions, shared by both transports |
| `src/mcp.ts` | stdio entry point, for a local agent |
| `src/mcp-remote.ts` | remote HTTP entry point, OAuth, and upload tickets |
| `src/oauth.ts` | OAuth 2.1 authorization server with pairing-code consent |
| `src/cli.ts` | `simcheck` |
| `examples/DemoApp/` | A tiny SwiftUI app to test the harness against |
| `examples/DemoAndroidApp/` | Its Android counterpart, sharing the same identifiers, with an Espresso suite |
| `docs/index.html` | The documentation page — served at [nickbabenko.github.io/Simcheck](https://nickbabenko.github.io/Simcheck/), opened locally by `simcheck docs` |

## Troubleshooting

**Runs stay `pending`.** The pool is busy or still booting — `simcheck status`.
Raise `poolSize` or `simcheck pool add`.

**`xcodebuild: Unable to find a destination matching...`** Your Xcode is older
than the installed simulator runtimes. `xcodebuild -showsdks` against
`xcrun simctl list runtimes`: if the SDK is iOS 26.2 and the only runtime is
iOS 27.0, no project on the machine will build for those sims. Update Xcode, or
install a runtime matching your SDK.

**`axe: command not found`.** `brew tap cameroncooke/axe && brew trust cameroncooke/axe && brew install axe`.

**A Claude connector says "Couldn't reach this address".** Check the URL is on
port 443. Connectors are dialled from Anthropic's cloud, not your device, and
reject non-standard ports — so `…:8443/mcp` fails even when `curl` and every
discovery document work. Confirm reachability independently before blaming the
server.

**A connector reaches consent, then says the request expired immediately.**
The server restarted mid-flow. Consent state is persisted now, so this should
not recur; if it does, check `~/.simcheck/remote.err.log` for a crash loop.

**`403 lacks the "runs:submit:local" capability`.** That token is scoped for
remote use and cannot name paths on this Mac. Upload the build and reference it
by `artifactId`, or use the `local` token.

**Scenarios are disabled.** No model backend — install the `claude` CLI or set
`ANTHROPIC_API_KEY`, then restart.

**A tap does nothing.** `simcheck inspect <device>` and check the element is
really there. SwiftUI needs an explicit `.accessibilityIdentifier(...)` for `id`
targeting to work.

**`Timed out creating the simulator remote automation session`.** CoreSimulator
occasionally refuses an automation session on a device that has just booted.
AXe calls retry this automatically; if it persists, the device is likely wedged
— `simcheck pool remove <udid>` and let the pool recreate it.
