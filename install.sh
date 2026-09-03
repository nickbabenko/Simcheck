#!/usr/bin/env bash
#
# One-command install for simcheck.
#
#   ./install.sh              full install
#   ./install.sh --no-daemon  set everything up but do not start the daemon
#   ./install.sh --no-mcp     skip registering the MCP server with Claude Code
#   ./install.sh --uninstall  remove the launchd agent, MCP entry, skill and symlinks
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.nickbabenko.simcheck"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REMOTE_LABEL="com.nickbabenko.simcheck-remote"
REMOTE_PLIST="$HOME/Library/LaunchAgents/$REMOTE_LABEL.plist"
BINDIR="$HOME/.local/bin"
SKILLDIR="$HOME/.claude/skills/device-test"
# Superseded by device-test, which covers Android too.
OLD_SKILLDIR="$HOME/.claude/skills/ios-sim-test"
HARNESS_HOME="${SIMCHECK_HOME:-$HOME/.simcheck}"

WANT_DAEMON=1; WANT_MCP=1; UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-daemon) WANT_DAEMON=0 ;;
    --no-mcp)    WANT_MCP=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)   sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31mx\033[0m  %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------- uninstall --
if [ "$UNINSTALL" = 1 ]; then
  say "Removing simcheck"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" && ok "launchd agent removed"
  launchctl bootout "gui/$(id -u)/$REMOTE_LABEL" 2>/dev/null || true
  rm -f "$REMOTE_PLIST" && ok "remote MCP agent removed"
  command -v tailscale >/dev/null && { tailscale funnel --https=8443 off >/dev/null 2>&1 || true; ok "tailscale funnel on 8443 disabled"; }
  rm -rf "$OLD_SKILLDIR"
  rm -f "$BINDIR/simcheck" "$BINDIR/simcheck-mcp" && ok "symlinks removed"
  rm -rf "$SKILLDIR" && ok "skill removed"
  command -v claude >/dev/null && { claude mcp remove simcheck --scope user >/dev/null 2>&1 || true; ok "MCP entry removed"; }
  warn "left alone: $HARNESS_HOME (runs and token) and any simcheck-* simulators"
  echo "    delete those with: rm -rf $HARNESS_HOME  &&  xcrun simctl delete <udid>"
  exit 0
fi

# ------------------------------------------------------------ prerequisites --
say "Checking prerequisites"

[ "$(uname -s)" = "Darwin" ] || die "simcheck drives iOS simulators, so it only runs on macOS."

command -v node >/dev/null || die "node is not installed. Try: brew install node"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node 20 or newer is required (found $(node -v))."
ok "node $(node -v)"

command -v xcrun >/dev/null || die "Xcode command line tools are missing. Try: xcode-select --install"
xcrun simctl help >/dev/null 2>&1 || die "xcrun simctl is not working. Point it at a full Xcode: sudo xcode-select -s /Applications/Xcode.app"
ok "Xcode $(xcodebuild -version 2>/dev/null | head -1 | cut -d' ' -f2)"

if ! xcrun simctl list runtimes 2>/dev/null | grep -q "iOS "; then
  die "no iOS simulator runtimes installed. Add one in Xcode > Settings > Components."
fi
ok "iOS runtime: $(xcrun simctl list runtimes 2>/dev/null | grep '^iOS' | head -1 | cut -d'(' -f1 | xargs)"

# AXe drives taps and typing; there is no substitute in simctl.
if ! command -v axe >/dev/null; then
  command -v brew >/dev/null || die "AXe is required and Homebrew is not installed. See https://github.com/cameroncooke/AXe"
  say "Installing AXe (simulator UI automation)"
  brew tap cameroncooke/axe
  # Homebrew requires explicit trust for third-party taps.
  brew trust cameroncooke/axe 2>/dev/null || true
  brew install axe
fi
command -v axe >/dev/null || die "AXe install did not complete."
ok "axe $(axe --version 2>/dev/null | head -1)"

# ---------------------------------------------------------------- android --
# Entirely optional. A Mac with Xcode and no Android SDK is a perfectly good
# simcheck install -- it simply reports android as unavailable and refuses
# those runs with a reason. So nothing here is fatal.
say "Checking Android support (optional)"

ANDROID_SDK=""
for candidate in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk" /opt/homebrew/share/android-commandlinetools /usr/local/share/android-commandlinetools; do
  if [ -n "$candidate" ] && [ -d "$candidate" ]; then ANDROID_SDK="$candidate"; break; fi
done

# Homebrew's openjdk formulae are keg-only and never register with the
# /usr/bin/java stub, so a machine can hold three JDKs and still fail every
# Android tool with "Unable to locate a Java Runtime". Resolve one by path.
JDK_HOME="${JAVA_HOME:-}"
if [ -z "$JDK_HOME" ]; then
  for candidate in /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk@17 "$(/usr/libexec/java_home -v 17+ 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate/bin/java" ]; then JDK_HOME="$candidate"; break; fi
  done
fi

if [ -z "$ANDROID_SDK" ]; then
  warn "no Android SDK found; android runs will be refused"
  warn "  to add it: brew install --cask android-commandlinetools android-platform-tools"
else
  ok "Android SDK at $ANDROID_SDK"
  [ -n "$JDK_HOME" ] && ok "JDK at $JDK_HOME" || warn "no JDK found; avdmanager and Gradle need one (brew install openjdk@21)"
  [ -x "$ANDROID_SDK/emulator/emulator" ] || warn "no emulator binary; add it with: sdkmanager \"emulator\""
  if ! ls -d "$ANDROID_SDK"/system-images/*/*/* >/dev/null 2>&1; then
    ABI=arm64-v8a; [ "$(uname -m)" = "x86_64" ] && ABI=x86_64
    warn "no system image; add one with: sdkmanager \"system-images;android-35;google_apis;$ABI\""
  fi
  # The multi-touch driver is a build artefact, not a checked-in binary: adb
  # drives one pointer, so without it pinch and two-finger pan cannot happen.
  if [ -n "$JDK_HOME" ] && ls "$REPO"/driver/build/outputs/apk/androidTest/debug/*.apk >/dev/null 2>&1; then
    ok "multi-touch driver already built"
  elif [ -n "$JDK_HOME" ] && { [ -x "$REPO/driver/gradlew" ] || command -v gradle >/dev/null; }; then
    say "Building the Android multi-touch driver"
    if (cd "$REPO/driver" && JAVA_HOME="$JDK_HOME" ./build.sh >/tmp/simcheck-driver-build.log 2>&1); then
      ok "multi-touch driver built"
    else
      warn "driver build failed (see /tmp/simcheck-driver-build.log); pinch/pan/double_tap will be unavailable on Android"
    fi
  else
    warn "skipping the multi-touch driver: needs a JDK and Gradle (brew install gradle), then ./driver/build.sh"
  fi
fi

# ------------------------------------------------------------------- build --
say "Building"
cd "$REPO"
if [ -f package-lock.json ]; then npm ci --silent; else npm install --silent; fi
npm run build --silent
ok "built to $REPO/dist"

# ---------------------------------------------------------------- symlinks --
say "Linking commands into $BINDIR"
mkdir -p "$BINDIR"
ln -sf "$REPO/dist/cli.js" "$BINDIR/simcheck"
ln -sf "$REPO/dist/mcp.js" "$BINDIR/simcheck-mcp"
ok "simcheck, simcheck-mcp"
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) warn "$BINDIR is not on your PATH. Add this to ~/.zshrc:"
     echo "        export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# --------------------------------------------------- corporate TLS interception --
# Networks running Netskope, Zscaler and friends re-sign TLS, so Node needs the
# proxy's root CA or every outbound HTTPS call fails. Node reads
# NODE_EXTRA_CA_CERTS once at startup, so it has to go into the plist.
CA_BUNDLE="${NODE_EXTRA_CA_CERTS:-}"
if [ -z "$CA_BUNDLE" ] && [ -f "$HARNESS_HOME/config.json" ]; then
  CA_BUNDLE=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("caBundle",""))' "$HARNESS_HOME/config.json" 2>/dev/null || true)
fi
if [ -n "$CA_BUNDLE" ]; then
  if [ -f "$CA_BUNDLE" ]; then ok "corporate CA bundle: $CA_BUNDLE"
  else warn "caBundle points at $CA_BUNDLE, which does not exist"; CA_BUNDLE=""; fi
fi

# ------------------------------------------------------------------ launchd --
if [ "$WANT_DAEMON" = 1 ]; then
  say "Installing the launchd agent"
  mkdir -p "$(dirname "$PLIST")" "$HARNESS_HOME"
  # KeepAlive so the daemon comes back if it crashes; RunAtLoad so a warm pool
  # is waiting after a reboot. PATH must include Homebrew for axe.
  #
  # launchd's environment is not a login shell: ANDROID_HOME and JAVA_HOME that
  # exist in Terminal are simply absent here, which is why they are baked in
  # rather than assumed.
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$REPO/dist/daemon.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>SIMCHECK_HOME</key><string>$HARNESS_HOME</string>${ANDROID_SDK:+
    <key>ANDROID_HOME</key><string>$ANDROID_SDK</string>
    <key>ANDROID_SDK_ROOT</key><string>$ANDROID_SDK</string>}${JDK_HOME:+
    <key>JAVA_HOME</key><string>$JDK_HOME</string>}${CA_BUNDLE:+
    <key>NODE_EXTRA_CA_CERTS</key><string>$CA_BUNDLE</string>}${ANTHROPIC_API_KEY:+
    <key>ANTHROPIC_API_KEY</key><string>$ANTHROPIC_API_KEY</string>}
  </dict>
  <key>StandardOutPath</key><string>$HARNESS_HOME/daemon.out.log</string>
  <key>StandardErrorPath</key><string>$HARNESS_HOME/daemon.err.log</string>
</dict>
</plist>
PLISTEOF
  # bootout returns before the service is really gone, and bootstrapping over a
  # still-registered label fails with a bare "Input/output error".
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
    sleep 0.5
  done
  bootstrapped=0
  for attempt in 1 2 3; do
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then bootstrapped=1; break; fi
    sleep 2
  done
  if [ "$bootstrapped" = 1 ]; then
    ok "daemon registered and starting"
  else
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || true
    die "could not register the launchd agent. Run it in the foreground instead: simcheck start --foreground"
  fi
else
  warn "skipped the daemon; start it by hand with: simcheck start --foreground"
fi

# --------------------------------------------------- remote MCP (optional) --
# Only registered once publicUrl is set: without it the server refuses to start,
# and there is no sensible default for a public hostname.
PUBLIC_URL=""
if [ -f "$HARNESS_HOME/config.json" ]; then
  PUBLIC_URL=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("publicUrl",""))' "$HARNESS_HOME/config.json" 2>/dev/null || true)
fi
if [ -n "$PUBLIC_URL" ] && [ "$WANT_DAEMON" = 1 ]; then
  say "Installing the remote MCP agent ($PUBLIC_URL)"
  cat > "$REMOTE_PLIST" <<RPLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$REMOTE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$REPO/dist/mcp-remote.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>SIMCHECK_HOME</key><string>$HARNESS_HOME</string>
  </dict>
  <key>StandardOutPath</key><string>$HARNESS_HOME/remote.out.log</string>
  <key>StandardErrorPath</key><string>$HARNESS_HOME/remote.err.log</string>
</dict>
</plist>
RPLISTEOF
  launchctl bootout "gui/$(id -u)/$REMOTE_LABEL" 2>/dev/null || true
  for _ in $(seq 1 20); do launchctl print "gui/$(id -u)/$REMOTE_LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
  launchctl bootstrap "gui/$(id -u)" "$REMOTE_PLIST" 2>/dev/null && ok "remote MCP agent running" \
    || warn "could not register the remote MCP agent"
else
  [ "$WANT_DAEMON" = 1 ] && warn "publicUrl not set - skipping the remote MCP agent (only needed for Claude connectors)"
fi

# ---------------------------------------------------------------- the skill --
say "Installing the Claude skill"
mkdir -p "$SKILLDIR"
cp "$REPO/skill/SKILL.md" "$SKILLDIR/SKILL.md"
# The skill was called ios-sim-test before it could reach Android; leaving both
# installed would offer an agent two skills for one job.
if [ -d "$OLD_SKILLDIR" ]; then rm -rf "$OLD_SKILLDIR" && ok "removed the superseded ios-sim-test skill"; fi
ok "$SKILLDIR"

# ------------------------------------------------------------------ the MCP --
if [ "$WANT_MCP" = 1 ]; then
  if command -v claude >/dev/null; then
    say "Registering the MCP server with Claude Code"
    claude mcp remove simcheck --scope user >/dev/null 2>&1 || true
    claude mcp add simcheck --scope user -- "$(command -v node)" "$REPO/dist/mcp.js"
    ok "available to every Claude Code session as 'simcheck'"
  else
    warn "claude CLI not found; register the MCP server yourself with:"
    echo "        claude mcp add simcheck --scope user -- $(command -v node) $REPO/dist/mcp.js"
  fi
fi

# ------------------------------------------------------------------- finish --
if [ "$WANT_DAEMON" = 1 ]; then
  say "Waiting for the daemon"
  for _ in $(seq 1 30); do
    if "$BINDIR/simcheck" status >/dev/null 2>&1; then break; fi
    sleep 1
  done
  echo
  "$BINDIR/simcheck" status || warn "daemon did not come up; check: simcheck logs"
fi

cat <<DONE

$(printf '\033[1;32mInstalled.\033[0m')

  simcheck doctor                    toolchain, TLS path and exposure
  simcheck status                    pool and daemon state
  simcheck submit examples/settings-steps.json --wait
  simcheck logs -f                   watch it work

The pool warms in the background; the first simulator takes about a minute to
boot. Natural-language scenarios work out of the box through your Claude Code
login, but are much cheaper and faster with an API key:

  echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc && simcheck stop && simcheck start

DONE
