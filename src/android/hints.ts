/**
 * How to install a missing Android piece, for the machine the daemon is on.
 *
 * Every hint used to say `brew install ...`, which is no help on the Linux
 * box Android is meant to run on, and an operator reads these at 2 a.m.
 * macOS keeps its Homebrew commands; elsewhere the hint names apt for the
 * JDK and sdkmanager for the SDK's own pieces.
 */

export interface InstallHints {
  sdk: string;
  jdk: string;
  adb: string;
}

export function installHints(platform: NodeJS.Platform = process.platform): InstallHints {
  if (platform === 'darwin') {
    return {
      sdk: 'brew install --cask android-commandlinetools',
      jdk: 'brew install openjdk@21',
      adb: 'brew install --cask android-platform-tools',
    };
  }

  return {
    sdk: 'unpack the Android command-line tools (developer.android.com/studio#command-line-tools-only) ' +
      'into /opt/android-sdk/cmdline-tools/latest, then set androidSdk or ANDROID_HOME',
    jdk: 'apt install openjdk-21-jdk-headless (openjdk-17-jdk-headless on Debian 12)',
    adb: 'sdkmanager "platform-tools"',
  };
}

/**
 * The ABI an emulator on this host runs natively: x86_64 on an Intel or AMD
 * host, arm64-v8a on Apple silicon and other arm64 hosts. An image of any
 * other ABI is emulated in software and far too slow.
 */
export const preferredAbi = (arch: string = process.arch): string => (arch === 'arm64' ? 'arm64-v8a' : 'x86_64');

/** What to say when an APK has no native code this emulator can run. */
export function noMatchingAbiHint(arch: string = process.arch): string {
  const abi = preferredAbi(arch);
  if (abi === 'x86_64') {
    return 'The APK has no native slice this emulator can run. The emulator is x86_64: ship an x86_64 slice, ' +
      'or rely on the image\'s ARM translation (Android 11+ x86_64 images run arm64-v8a code, more slowly) -- ' +
      'if that failed too, the APK may be armeabi-v7a only.';
  }
  return 'The APK has no native slice this emulator can run. The emulator is arm64-v8a: the APK needs an arm64-v8a slice.';
}
