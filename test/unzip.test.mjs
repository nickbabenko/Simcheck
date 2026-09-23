/**
 * S1: uploads unpack with ditto on macOS and unzip elsewhere. ditto does not
 * exist on Linux, where Android runs, so before this every uploaded APK
 * failed there. The Linux path is driven on the Mac too (unzip ships with
 * macOS), through ArtifactStore.unzipOn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { unzipArchive } from '../dist/util.js';
import { ArtifactStore } from '../dist/artifacts.js';
import { tempHome, testConfig } from './sim-fakes.mjs';

/** A stored (uncompressed) zip of `entries` ({ name: Buffer|string }), built
 *  by hand so a test can include names a zip tool would refuse to write. */
function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const fakeApk = () => zipOf({ 'AndroidManifest.xml': 'manifest', 'classes.dex': 'dex' });

test('unzip (the non-macOS path) extracts into dest', async () => {
  const home = tempHome();
  const archive = path.join(home, 'a.zip');
  fs.writeFileSync(archive, zipOf({ 'dir/file.txt': 'hello' }));

  await unzipArchive(archive, path.join(home, 'out'), { platform: 'linux' });
  assert.equal(fs.readFileSync(path.join(home, 'out', 'dir', 'file.txt'), 'utf8'), 'hello');
});

test('unzip refuses an entry that climbs out of dest, and keeps the rest', async () => {
  const home = tempHome();
  const archive = path.join(home, 'slip.zip');
  fs.writeFileSync(archive, zipOf({ '../../escaped.txt': 'bad', 'ok.txt': 'fine' }));
  const out = path.join(home, 'nested', 'out');

  await unzipArchive(archive, out, { platform: 'linux' });
  assert.equal(fs.existsSync(path.join(home, 'escaped.txt')), false, 'nothing written above dest');
  assert.equal(fs.readFileSync(path.join(out, 'ok.txt'), 'utf8'), 'fine');
});

test('a corrupt archive is an error naming unzip', async () => {
  const home = tempHome();
  const archive = path.join(home, 'bad.zip');
  fs.writeFileSync(archive, 'not a zip at all');
  await assert.rejects(unzipArchive(archive, path.join(home, 'out'), { platform: 'linux' }), /unzip .* exited/);
});

function store(platform) {
  const artifacts = new ArtifactStore(testConfig(tempHome()));
  artifacts.unzipOn = platform;
  artifacts.setManifestReader('android', async () => 'com.example.app');
  return artifacts;
}

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: a bare APK upload is stored as the APK itself`, async () => {
    const artifact = await store(platform).accept(Readable.from([fakeApk()]), { uploadedBy: 't', declaredBytes: 1e9 });
    assert.equal(artifact.platform, 'android');
    assert.equal(artifact.bundleId, 'com.example.app');
    assert.equal(path.basename(artifact.appPath), 'app.apk');
  });

  test(`${platform}: a zip holding an APK, and a zip holding that zip, both yield the APK`, async () => {
    const zipped = zipOf({ 'build/app-debug.apk': fakeApk() });
    const direct = await store(platform).accept(Readable.from([zipped]), { uploadedBy: 't', declaredBytes: 1e9 });
    assert.equal(path.basename(direct.appPath), 'app-debug.apk');

    const nested = zipOf({ 'artifact.zip': zipOf({ 'app-release.apk': fakeApk() }) });
    const unwrapped = await store(platform).accept(Readable.from([nested]), { uploadedBy: 't', declaredBytes: 1e9 });
    assert.equal(path.basename(unwrapped.appPath), 'app-release.apk');
    assert.equal(unwrapped.platform, 'android');
  });
}

/** Anything the store left behind in its root besides published artifacts. */
function debris(artifacts) {
  const root = path.dirname(artifacts.dir('x'));
  return fs.readdirSync(root).filter((name) => name.startsWith('.'));
}

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: concurrent uploads of identical bytes both succeed with one stored copy`, async () => {
    const artifacts = store(platform);
    // A slow manifest read holds every upload mid-build, so all six are past
    // the "already stored?" check before any of them publishes.
    artifacts.setManifestReader('android', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'com.example.app';
    });
    const bytes = zipOf({ 'build/app-debug.apk': fakeApk() });
    const uploads = Array.from({ length: 6 }, (_, i) =>
      artifacts.accept(Readable.from([bytes]), { uploadedBy: `agent-${i}`, declaredBytes: 1e9 }));

    const stored = await Promise.all(uploads);

    assert.equal(new Set(stored.map((artifact) => artifact.id)).size, 1);
    for (const artifact of stored) {
      assert.equal(fs.existsSync(artifact.appPath), true, `${artifact.appPath} exists after the race`);
    }
    assert.equal(artifacts.list().length, 1);
    assert.deepEqual(debris(artifacts), [], 'no staging or build directories left behind');
  });
}

test('the stored appPath points at the published directory, not the private build one', async () => {
  const artifacts = store('darwin');
  const artifact = await artifacts.accept(Readable.from([fakeApk()]), { uploadedBy: 't', declaredBytes: 1e9 });

  assert.equal(path.dirname(artifact.appPath), artifacts.dir(artifact.id));
  assert.deepEqual(artifacts.get(artifact.id), artifact);
});

test('a half-built directory from an older crash is replaced, not reused', async () => {
  const artifacts = store('linux');
  const bytes = fakeApk();
  const first = await artifacts.accept(Readable.from([bytes]), { uploadedBy: 't', declaredBytes: 1e9 });
  fs.rmSync(path.join(artifacts.dir(first.id), 'artifact.json'));
  fs.writeFileSync(path.join(artifacts.dir(first.id), 'stale'), 'x');

  const second = await artifacts.accept(Readable.from([bytes]), { uploadedBy: 't', declaredBytes: 1e9 });

  assert.equal(second.id, first.id);
  assert.equal(fs.existsSync(path.join(artifacts.dir(first.id), 'stale')), false);
  assert.equal(fs.existsSync(second.appPath), true);
});

test('a rejected upload leaves nothing behind', async () => {
  const artifacts = store('linux');

  await assert.rejects(
    artifacts.accept(Readable.from([zipOf({ 'readme.txt': 'no build here' })]), { uploadedBy: 't', declaredBytes: 1e9 }),
    /no .app bundle or .apk/);

  assert.deepEqual(artifacts.list(), []);
  assert.deepEqual(debris(artifacts), []);
});
