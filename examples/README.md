# Examples

| File | Needs a build? | |
|---|---|---|
| `settings-steps.json` | no | Drives the preinstalled iOS Settings app with explicit steps. The fastest way to check the harness works. |
| `android-settings-steps.json` | no | The Android counterpart: drives Settings on an emulator and toggles dark mode. Needs a pooled Android device. |
| `settings-scenario.json` | no | Same app, driven by a natural-language scenario. Exercises the model backend. |
| `demo-steps.json` | yes | Builds `DemoApp/` from source and drives a sign-in flow. Exercises the `xcodebuild` path. |

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
