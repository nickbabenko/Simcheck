import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHierarchy, parseBounds, normaliseRole } from '../dist/android/uiautomator.js';
import { parseBadging, launchableFromManifest, assertRunnableAbi, parseXmlTree } from '../dist/android/apk.js';

/** A trimmed but structurally faithful `uiautomator dump`. */
const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Sign in" resource-id="" class="android.widget.TextView" package="com.example.app" content-desc="" clickable="false" enabled="true" bounds="[40,200][400,260]" />
    <node index="1" text="" resource-id="com.example.app:id/email_field" class="android.widget.EditText" package="com.example.app" content-desc="Email address" clickable="true" enabled="true" bounds="[40,300][1040,400]" />
    <node index="2" text="hunter2" resource-id="com.example.app:id/password_field" class="androidx.appcompat.widget.AppCompatEditText" package="com.example.app" content-desc="" clickable="true" enabled="true" bounds="[40,420][1040,520]" />
    <node index="3" text="Continue" resource-id="com.example.app:id/submit" class="com.google.android.material.button.MaterialButton" package="com.example.app" content-desc="" clickable="true" enabled="false" bounds="[40,560][1040,680]" />
    <node index="4" text="" resource-id="" class="android.widget.LinearLayout" package="com.example.app" content-desc="" clickable="false" enabled="true" bounds="[0,700][1080,900]">
      <node index="0" text="Remember &amp; continue" resource-id="" class="android.widget.CheckBox" package="com.example.app" content-desc="" clickable="true" enabled="true" bounds="[40,720][600,800]" />
    </node>
    <node index="5" text="" resource-id="" class="android.view.View" package="com.example.app" content-desc="" clickable="false" enabled="true" bounds="[0,0][0,0]" />
  </node>
</hierarchy>`;

test('bounds parse into a frame', () => {
  assert.deepEqual(parseBounds('[40,300][1040,400]'), { x: 40, y: 300, width: 1000, height: 100 });
  assert.equal(parseBounds('nonsense'), null);
});

test('android widget classes map onto the shared role vocabulary', () => {
  assert.equal(normaliseRole('android.widget.EditText'), 'TextField');
  assert.equal(normaliseRole('com.google.android.material.button.MaterialButton'), 'Button');
  assert.equal(normaliseRole('androidx.appcompat.widget.AppCompatEditText'), 'TextField');
  assert.equal(normaliseRole('android.widget.Switch'), 'Switch');
  // Unrecognised classes keep their leaf name rather than becoming "Unknown".
  assert.equal(normaliseRole('com.acme.FancyCarousel'), 'FancyCarousel');
});

test('the hierarchy yields the screen size and interactive elements', () => {
  const screen = parseHierarchy(DUMP);
  assert.equal(screen.width, 1080);
  assert.equal(screen.height, 2400);
  // Android measures in pixels, and must say so -- a model reasoning about
  // tap targets needs to know it is not looking at points.
  assert.equal(screen.units, 'px');

  const byId = Object.fromEntries(screen.elements.filter((e) => e.id).map((e) => [e.id, e]));
  assert.ok(byId['email_field'], 'resource-id is reduced to its bare name');
  assert.equal(byId['email_field'].type, 'TextField');
  // content-desc is the accessibility label proper and wins over drawn text.
  assert.equal(byId['email_field'].label, 'Email address');
  assert.deepEqual(byId['email_field'].center, { x: 540, y: 350 });

  // A field with drawn text but no content-desc uses the text as its label.
  assert.equal(byId['password_field'].label, 'hunter2');

  assert.equal(byId['submit'].label, 'Continue');
  assert.equal(byId['submit'].enabled, false, 'enabled="false" survives into the tree');
});

test('zero-sized nodes are dropped and XML entities are decoded', () => {
  const screen = parseHierarchy(DUMP);
  assert.ok(!screen.elements.some((e) => e.frame.width === 0 && e.frame.height === 0));
  assert.ok(screen.elements.some((e) => e.label === 'Remember & continue'),
    '&amp; should decode rather than reach the model raw');
});

test('nesting depth is tracked across self-closing and container nodes', () => {
  const screen = parseHierarchy(DUMP);
  const checkbox = screen.elements.find((e) => e.type === 'CheckBox');
  const submit = screen.elements.find((e) => e.id === 'submit');
  // The checkbox sits one level deeper than its siblings: root > layout > it.
  assert.ok(checkbox.depth > submit.depth,
    `expected the nested checkbox (${checkbox.depth}) deeper than a top-level button (${submit.depth})`);
});

test('the element cap reports what it hid', () => {
  const screen = parseHierarchy(DUMP, 2);
  assert.equal(screen.elements.length, 2);
  assert.ok(screen.truncated > 0);
});

/* ------------------------------------------------------------------- apk -- */

const BADGING = `package: name='com.example.app' versionCode='12' versionName='1.2.0' compileSdkVersion='34'
sdkVersion:'24'
targetSdkVersion:'34'
application-label:'Example'
launchable-activity: name='com.example.app.MainActivity'  label='Example' icon=''
native-code: 'arm64-v8a' 'x86_64'
feature-group: label=''`;

const TEST_BADGING = `package: name='com.example.app.test' versionCode='' versionName=''
instrumentation: name='androidx.test.runner.AndroidJUnitRunner' targetPackage='com.example.app' label='' icon='' handleProfiling='' functionalTest=''
sdkVersion:'24'`;

test('badging yields package, launch activity and ABIs', () => {
  const info = parseBadging(BADGING);
  assert.equal(info.packageName, 'com.example.app');
  assert.equal(info.launchActivity, 'com.example.app.MainActivity');
  assert.deepEqual(info.abis, ['arm64-v8a', 'x86_64']);
  assert.equal(info.instrumentationRunner, undefined);
});

test('a test APK is recognised by its instrumentation, not a launch activity', () => {
  const info = parseBadging(TEST_BADGING);
  assert.equal(info.packageName, 'com.example.app.test');
  assert.equal(info.instrumentationRunner, 'androidx.test.runner.AndroidJUnitRunner');
  assert.equal(info.instrumentationTarget, 'com.example.app');
  assert.equal(info.launchActivity, undefined);
});

test('a relative activity name is qualified with the package', () => {
  const manifest = `<manifest><application>
    <activity android:name=".MainActivity">
      <intent-filter><category android:name="android.intent.category.LAUNCHER" /></intent-filter>
    </activity>
  </application></manifest>`;
  assert.equal(launchableFromManifest(manifest, 'com.example.app'), 'com.example.app.MainActivity');
});

test('an APK with no matching ABI is refused before it can crash on launch', () => {
  const x86Only = { packageName: 'a', abis: ['x86_64'] };
  assert.throws(
    () => assertRunnableAbi(x86Only, ['arm64-v8a'], 'app-debug.apk'),
    /arm64-v8a/);

  // No native code at all runs anywhere, and must not be rejected.
  assert.doesNotThrow(() => assertRunnableAbi({ packageName: 'a', abis: [] }, ['arm64-v8a'], 'app.apk'));
  assert.doesNotThrow(() => assertRunnableAbi(x86Only, ['x86_64', 'arm64-v8a'], 'app.apk'));
});

/* ------------------------------------------------------- compiled manifest -- */

/** Real `aapt2 dump xmltree` output, trimmed. `badging` reports neither the
 *  instrumentation nor an activity-alias launcher entry, which is why this
 *  path exists at all. */
const XMLTREE = `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    A: package="com.simcheck.demo.test" (Raw: "com.simcheck.demo.test")
      E: instrumentation (line=9)
        A: http://schemas.android.com/apk/res/android:label(0x01010001)="Tests for com.simcheck.demo" (Raw: "Tests for com.simcheck.demo")
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="androidx.test.runner.AndroidJUnitRunner" (Raw: "androidx.test.runner.AndroidJUnitRunner")
        A: http://schemas.android.com/apk/res/android:targetPackage(0x01010021)="com.simcheck.demo" (Raw: "com.simcheck.demo")
      E: application (line=20)
          E: activity (line=30)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="androidx.test.core.app.InstrumentationActivityInvoker$BootstrapActivity"
              E: intent-filter (line=33)
                  E: category (line=34)
                    A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.category.LAUNCHER" (Raw: "android.intent.category.LAUNCHER")`;

const ALIAS_TREE = `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    A: package="com.example.app" (Raw: "com.example.app")
      E: application (line=20)
          E: activity (line=25)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.example.app.RealActivity"
          E: activity-alias (line=30)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)=".Launcher"
              E: intent-filter (line=33)
                  E: category (line=34)
                    A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.category.LAUNCHER" (Raw: "android.intent.category.LAUNCHER")`;

test('the compiled manifest yields an instrumentation badging omits', () => {
  const info = parseXmlTree(XMLTREE);
  assert.equal(info.instrumentationRunner, 'androidx.test.runner.AndroidJUnitRunner');
  assert.equal(info.instrumentationTarget, 'com.simcheck.demo');
});

test('a launcher entry declared as an activity-alias is found and qualified', () => {
  const info = parseXmlTree(ALIAS_TREE);
  // The alias carries LAUNCHER, not the activity above it -- and its relative
  // name has to be qualified with the package.
  assert.equal(info.launchActivity, 'com.example.app.Launcher');
});
