#!/usr/bin/env bash
# Build the simcheck multi-touch driver APKs.
#
# One-time setup: the harness installs the resulting APKs onto each pooled
# emulator and drives one gesture per `am instrument` call. Without them,
# pinch/pan/two_finger_press/double_tap fail with an explanation rather than
# being approximated by a single-pointer swipe.
#
# Needs a JDK and Gradle. The output APKs are left in build/outputs/apk/.
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${JAVA_HOME:-}" ]; then
  for candidate in /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk@17 "$(/usr/libexec/java_home -v 17+ 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate/bin/java" ]; then export JAVA_HOME="$candidate"; break; fi
  done
fi
[ -n "${JAVA_HOME:-}" ] || { echo "no JDK found. Try: brew install openjdk@21" >&2; exit 1; }
export PATH="$JAVA_HOME/bin:$PATH"

# AGP resolves the SDK from ANDROID_HOME or local.properties and fails the
# build outright without one. A login shell often has it; a script run from an
# installer or a daemon does not, so resolve it here rather than assume.
if [ -z "${ANDROID_HOME:-}" ]; then
  for candidate in "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk" /opt/homebrew/share/android-commandlinetools /usr/local/share/android-commandlinetools; do
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then export ANDROID_HOME="$candidate"; break; fi
  done
fi
[ -n "${ANDROID_HOME:-}" ] || { echo "no Android SDK found. Try: brew install --cask android-commandlinetools" >&2; exit 1; }
export ANDROID_SDK_ROOT="$ANDROID_HOME"

if [ -x ./gradlew ]; then
  GRADLE=./gradlew
elif command -v gradle >/dev/null; then
  GRADLE=gradle
else
  echo "no Gradle found. Try: brew install gradle" >&2
  exit 1
fi

echo "==> building the driver with $GRADLE"
echo "    JAVA_HOME=$JAVA_HOME"
echo "    ANDROID_HOME=$ANDROID_HOME"
"$GRADLE" assembleDebug assembleDebugAndroidTest --no-daemon --console=plain

echo
echo "built:"
find build/outputs/apk -name '*.apk' -print
