---
name: ios-sim-test
description: Validate an iOS change on a real simulator and get screenshots back as evidence. Hand off a build plus a test scenario, poll until it finishes, then attach the screenshots to a PR. Use when the user says "test this on a simulator", "prove this works", "check my change before I open the PR", "get me screenshots of X", or when you have just changed iOS UI code and are about to claim it works. Not for unit tests (use xcodebuild test) and not for TestFlight or device installs (use the asc-* and ipa-distribute skills).
---

# Validating iOS changes on a simulator

You have changed iOS UI code. Before telling anyone it works, run it and look
at it. `sim-harness` leases a pre-booted simulator, installs your build, drives
the scenario you describe, and hands back named screenshots.

The point is evidence. "I updated the toggle" is a claim; a screenshot of the
toggle in its new state is proof, and it is what a reviewer actually wants.

## Before you start

```bash
sim-harness status
```

If the daemon is down, start it with `sim-harness start`. If `scenarios` reports
`DISABLED`, only explicit `steps` runs will work.

Tokens are scoped. If a submission is refused with a missing-capability error,
run `sim-harness whoami` (or the `whoami` MCP tool) rather than guessing: a
`remote` token cannot name paths on the host and must reference an uploaded
build instead.

## The normal flow

Use the MCP tools when they are available — they return screenshots as images
you can actually look at.

1. `run_ios_test` — hand off the build and the scenario. Returns a `runId`
   immediately. The run sits in `pending` until a simulator frees up.
2. `wait_for_test_run` — block until it finishes. If it comes back with
   `done: false`, call it again.
3. `get_test_screenshot` — pull back each screenshot you asked for and **look at
   it**. Do not report a pass you have not seen.
4. `get_test_report` — the markdown write-up to paste into the PR.

Without MCP, the CLI does the same:

```bash
sim-harness submit request.json --wait
sim-harness report <run-id>
```

## Describing the build

Three ways, in order of preference:

| You have | Use |
|---|---|
| A working tree | `{"project": "App.xcodeproj", "scheme": "App"}` — the harness builds it |
| A built `.app` | `{"path": "/abs/path/App.app"}` — fastest |
| An app already on the sim | `{"bundleId": "com.example.app"}` |
| A build uploaded earlier | `{"artifactId": "<id>"}` |

When you are not on the machine holding the source — or your token lacks
`runs:submit:local` — build and upload first, then reference the id:

```bash
sim-harness upload --scheme App --project App.xcodeproj --label "fix-toggle"
```

An `.ipa` will **not** work. Those hold device slices; simulators need a build
made for `platform=iOS Simulator`.

## Describing the test

Natural language, when you want the agent to work out the taps:

```json
{
  "app": { "project": "App.xcodeproj", "scheme": "App" },
  "scenario": "Sign in as demo@example.com / hunter2, open Settings from the tab bar, and turn on Beta Features.",
  "screenshots": ["signed-in", "settings", "beta-on"],
  "assert": "The Beta Features toggle reads On and the status line below it says beta features are enabled."
}
```

Explicit steps, when you want it deterministic and free:

```json
{
  "app": { "path": "/abs/path/App.app" },
  "screenshots": ["beta-on"],
  "steps": [
    { "action": "wait_for", "id": "email_field", "timeoutMs": 15000 },
    { "action": "tap", "id": "email_field" },
    { "action": "type", "text": "demo@example.com" },
    { "action": "tap", "id": "sign_in_button" },
    { "action": "tap", "label": "Settings" },
    { "action": "tap", "id": "beta_toggle" },
    { "action": "screenshot", "name": "beta-on" }
  ]
}
```

Every natural-language run returns the steps it actually executed, under
`executedSteps`. Lift those into a `steps` run to turn a one-off exploration
into a repeatable check.

To author steps by hand, read the live screen first:

```bash
sim-harness inspect sim-harness-01     # every element, with ids and coordinates
```

or call `inspect_simulator`.

## Writing good scenarios

- **Name the screenshots after the state, not the step.** `beta-on` beats
  `screenshot-3`, because the reviewer reads the name.
- **Always set `assert`.** Without it a run only proves the taps landed, not
  that the app did the right thing. With it, the verdict means something.
- **Give it the data it needs** — credentials, deep links, seed state. The agent
  cannot guess a password.
- **One scenario per behaviour.** A run that does five things gives you one
  verdict for five things.

## Reading the result

`status` is the verdict:

| Status | Means |
|---|---|
| `passed` | The scenario ran, the assertion held, every requested screenshot exists |
| `failed` | It ran, but the assertion did not hold or a screenshot was never reachable |
| `error` | The harness or the build broke — this is not a verdict on the app |
| `timeout` | It ran out of time |

A `failed` run with a missing screenshot is a real signal: the agent could not
reach that state. Read the trace before assuming the harness is at fault.

## Reporting back

Say what was verified and show it. Include the screenshot, the assertion, and
the device it ran on. If something failed, quote the trace line where it went
wrong rather than guessing.

Do not describe a screenshot you have not fetched and looked at.
