# Examples

| File | Needs a build? | |
|---|---|---|
| `settings-steps.json` | no | Drives the preinstalled iOS Settings app with explicit steps. The fastest way to check the harness works. |
| `android-settings-steps.json` | no | The Android counterpart: drives Settings on an emulator and toggles dark mode. Needs a pooled Android device. |
| `settings-scenario.json` | no | Same app, driven by a natural-language scenario. Exercises the model backend. |
| `demo-steps.json` | yes | Builds `DemoApp/` from source and drives a sign-in flow. Exercises the `xcodebuild` path. |
| `android-instrumentation.json` | yes | Builds `DemoAndroidApp/` with Gradle and runs its Espresso suite. Exercises the `instrumentation` path. |

```bash
simcheck submit examples/settings-steps.json --wait
```

Relative paths inside a request file resolve against the file, not your shell's
working directory, so the `demo-steps.json` reference to `DemoApp/` works from
anywhere.

## DemoApp

A tiny SwiftUI app with the shapes a scenario needs: a login gate, a tab bar, a
toggle that changes visible text, and a counter. Every control carries an
`.accessibilityIdentifier`, so `{"action": "tap", "id": "beta_toggle"}` works.

Building it needs an Xcode whose SDK is at least as new as your installed
simulator runtimes. If `demo-steps.json` fails with *"Unable to find a
destination matching..."*, compare `xcodebuild -showsdks` with
`xcrun simctl list runtimes` — an Xcode older than the runtime cannot build for
it, and that affects every project on the machine, not just this one.

## DemoAndroidApp

The Android counterpart, and deliberately the same shapes: a login gate, two
tabs, a toggle that rewrites visible text, and a counter. Every control carries
the *same* identifier as its iOS equivalent — `email_field`, `sign_in_button`,
`beta_toggle`, `count_label` — so one step list drives either platform. That is
the clearest demonstration that the harness speaks a single vocabulary.

Plain Android views, no Compose, no AppCompat: the app itself has zero
dependencies, so a first build takes seconds rather than minutes.

```bash
simcheck submit examples/android-instrumentation.json --wait
```

Its `src/androidTest` suite asserts things a screenshot cannot settle — that
the counter holds the right number, that toggling actually rewrote the status
text — and saves a screenshot into `additionalTestOutputDir`, which comes back
as an attachment on the run.

Two things it does on purpose, both learned the hard way against a real
emulator:

- **No action bar.** Android 15 enforces edge-to-edge for anything targeting
  SDK 35, so content draws behind the system bars. With an action bar present
  the tab buttons sat underneath it — still "90% visible" as far as Espresso is
  concerned, so the click was accepted and then swallowed by the bar, and the
  failure surfaced three lines later on an unrelated view.
- **No nested view animators.** A `ViewFlipper` inside a `ViewFlipper` does not
  reliably lay out the pane it reveals: the revealed child requests a layout
  that never reaches the root, so it stays 0×0 and Espresso refuses to click
  it. The tabs toggle visibility directly instead.

There is no Gradle wrapper checked in, so the harness falls back to a system
`gradle` and says so. A real project should commit its wrapper — it pins the
version the project actually builds with.
