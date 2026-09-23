/**
 * Run recording: the transcoder's arithmetic and fallbacks (with a scripted
 * ffmpeg), the runner's ordering (record after install and before launch,
 * stop before the reset, convert after the device is back in the pool, and
 * never fail a run over it), and the allowlisted artifact route.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { transcode, findBinary } from '../dist/video.js';
import { Runner } from '../dist/runner.js';
import { Store } from '../dist/store.js';
import { Pool } from '../dist/pool.js';
import { TokenStore } from '../dist/auth.js';
import { createServer } from '../dist/server.js';
import { tempHome, testConfig, fakePlatforms, device, run } from './sim-fakes.mjs';

/* ------------------------------------------------------------ transcode -- */

/** A scripted ffmpeg: writes whatever file is the last argument, records argv. */
function fakeFfmpeg({ duration = 4, fail = [] } = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([path.basename(cmd), ...args]);
    if (cmd.endsWith('ffprobe')) return { code: 0, stdout: `${duration}\n`, stderr: '' };
    const outFile = args[args.length - 1];
    if (fail.some((f) => outFile.endsWith(f))) return { code: 1, stdout: '', stderr: 'boom\nEncoder not found' };
    fs.writeFileSync(outFile, Buffer.alloc(4096));
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, exec, ffmpeg: '/x/ffmpeg', ffprobe: '/x/ffprobe' };
}
const rawIn = (dir, name = 'video.raw.mp4') => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.alloc(4096));
  return f;
};

test('transcode makes video.mp4 and preview.gif, and deletes the raw file', async () => {
  const dir = tempHome('video');
  const raw = rawIn(dir);
  const ff = fakeFfmpeg({ duration: 4 });
  const out = await transcode([raw], dir, ff);
  assert.deepEqual({ video: out.video, preview: out.preview, notes: out.notes }, { video: 'video.mp4', preview: 'preview.gif', notes: [] });
  assert.equal(fs.existsSync(raw), false, 'raw deleted');
  const mp4 = ff.calls.find((c) => c.at(-1).endsWith('video.mp4'));
  assert.ok(mp4.includes("scale='min(480,iw)':-2,fps=30"), '<=480 wide');
  assert.ok(mp4.includes('+faststart'));
  const gif = ff.calls.find((c) => c.at(-1).endsWith('preview.gif')).join(' ');
  assert.match(gif, /setpts=PTS\/1\.0000/, 'a short run plays at real speed');
  assert.match(gif, /fps=8,scale=320:-1/);
  assert.match(gif, /palettegen/);
});

test('a long recording is sped up so the GIF fits in 15s', async () => {
  const dir = tempHome('video');
  const ff = fakeFfmpeg({ duration: 60 });
  await transcode([rawIn(dir)], dir, ff);
  const gif = ff.calls.find((c) => c.at(-1).endsWith('preview.gif')).join(' ');
  assert.match(gif, /setpts=PTS\/4\.0000/);
  assert.match(gif, /-t 17/);
});

test('segments are joined before converting', async () => {
  const dir = tempHome('video');
  const ff = fakeFfmpeg();
  const segs = [rawIn(dir, 'video.raw.0.mp4'), rawIn(dir, 'video.raw.1.mp4')];
  const out = await transcode(segs, dir, ff);
  assert.equal(out.video, 'video.mp4');
  assert.ok(ff.calls[0].includes('concat'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['preview.gif', 'video.mp4'], 'segments, list and join all cleaned up');
});

test('each output fails on its own, with a note, and no ffmpeg is a note too', async () => {
  const dir = tempHome('video');
  const ff = fakeFfmpeg({ fail: ['video.mp4'] });
  const out = await transcode([rawIn(dir)], dir, ff);
  assert.equal(out.video, undefined);
  assert.equal(out.preview, 'preview.gif', 'the GIF survives an mp4 failure');
  assert.match(out.notes[0], /could not encode video\.mp4.*Encoder not found/);
  assert.equal(fs.existsSync(path.join(dir, 'video.mp4')), false);

  const dir2 = tempHome('video');
  const raw = rawIn(dir2);
  const none = await transcode([raw], dir2, { ffmpeg: null, ffprobe: null });
  assert.match(none.notes[0], /ffmpeg is not installed/);
  assert.equal(fs.existsSync(raw), false, 'raw deleted even then');
});

/* --------------------------------------------------------------- runner -- */

const FFMPEG = findBinary('ffmpeg');

function rig(recorder) {
  const home = tempHome();
  const cfg = testConfig(home);
  fs.writeFileSync(path.join(home, 'pool.json'), JSON.stringify([device('D1', { status: 'leased' })]));
  const platforms = fakePlatforms();
  const backend = platforms.backend;
  const order = [];
  for (const m of ['install', 'launch', 'uninstall']) {
    const orig = backend[m].bind(backend);
    backend[m] = async (...a) => { order.push(m); return orig(...a); };
  }
  if (recorder) backend.recordVideo = async (id, out) => { order.push('record:start'); return recorder(out, order); };
  const pool = new Pool(cfg, platforms);
  pool.load();
  const store = new Store(cfg);
  const runner = new Runner(cfg, pool, store, null, {}, platforms);
  const go = async (extra = {}) => {
    const r = run('r1', { request: { ...run('x').request, record: true }, ...extra });
    store.create(r);
    await runner.execute(store.get(r.id), pool.get('D1'));
    return store.get(r.id);
  };
  return { go, store, pool, order };
}

test('a recorded run films from install to reset and converts after release', { skip: !FFMPEG && 'no ffmpeg' }, async () => {
  let deviceReadyWhenConverted;
  const { go, store, pool, order } = rig((out, order) => ({
    async stop() {
      order.push('record:stop');
      execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=402x874:rate=30',
        '-pix_fmt', 'yuv420p', out]);
      return { files: [out] };
    },
  }));
  // Observe the pool at the moment video.mp4 is recorded on the run.
  store.onChange((r) => {
    if (r.artifacts?.video && deviceReadyWhenConverted === undefined) deviceReadyWhenConverted = pool.get('D1').status;
  });
  const r = await go();
  assert.equal(r.status, 'passed', r.error);
  assert.deepEqual(order, ['uninstall', 'install', 'record:start', 'launch', 'record:stop', 'uninstall']);
  assert.equal(r.artifacts.video, 'video.mp4');
  assert.equal(r.artifacts.preview, 'preview.gif');
  const dir = store.dir(r.id);
  assert.ok(fs.statSync(path.join(dir, 'video.mp4')).size > 1024);
  assert.ok(fs.statSync(path.join(dir, 'preview.gif')).size > 1024);
  assert.equal(fs.existsSync(path.join(dir, 'video.raw.mp4')), false, 'raw deleted');
  assert.equal(deviceReadyWhenConverted, 'ready', 'converted after the device was back in the pool');
  assert.equal(typeof r.timings.recordMs, 'number');
  assert.equal(r.timings.totalMs, r.timings.queueMs + r.timings.occupancyMs, 'recordMs is in neither');
  assert.ok(r.releasedAt, 'settled only once the video exists');
});

test('a recorder that will not start, or produces nothing, is a note -- the run still passes', async () => {
  const failing = rig(async () => { throw new Error('recordVideo exited (1) before recording: no display'); });
  failing.order.length = 0;
  const a = await failing.go();
  assert.equal(a.status, 'passed', a.error);
  assert.ok(a.trace.some((t) => t.kind === 'note' && /could not start recording: .*no display/.test(t.text)));
  assert.equal(a.artifacts.video, undefined);

  const empty = rig(() => ({ async stop() { return { files: [], note: 'recordVideo produced no usable file (exit 1)' }; } }));
  const b = await empty.go();
  assert.equal(b.status, 'passed', b.error);
  assert.ok(b.trace.some((t) => /recording: recordVideo produced no usable file/.test(t.text)));
  assert.equal(b.timings.recordMs, undefined, 'nothing to convert');

  const unsupported = rig(null);
  const c = await unsupported.go();
  assert.equal(c.status, 'passed', c.error);
  assert.ok(c.trace.some((t) => /recording is not supported/.test(t.text)));
});

test('an unrecorded run never touches the recorder', async () => {
  const { go, order } = rig(() => { throw new Error('should not be called'); });
  const r = await go({ request: run('x').request });
  assert.equal(r.status, 'passed', r.error);
  assert.ok(!order.includes('record:start'));
});

/* ---------------------------------------------------------------- route -- */

async function daemon() {
  const cfg = { ...testConfig(tempHome()), identityBindings: {}, maxArtifactBytes: 1e9 };
  const tokens = new TokenStore(cfg);
  tokens.load();
  const { secret } = tokens.create({ name: 'invitee', preset: 'remote' });
  const store = new Store(cfg);
  const deps = {
    cfg, store, tokens,
    pool: { list: () => [], get: () => undefined, targetCount: () => 0 },
    runner: { active: 0, cancel: () => false },
    scheduler: { tick() {}, queueInfo: () => null, queuePosition: () => 0 },
    audit: { record() {} },
    artifacts: { get: () => undefined },
    edge: { mode: 'none', async verify() { return { via: 'loopback', subject: 'local' }; } },
    platforms: { has: () => true, default: () => 'ios', available: () => ['ios'], reason: () => '' },
    llmName: null,
  };
  const server = createServer(deps);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, auth = true) => fetch(base + p, { headers: auth ? { authorization: `Bearer ${secret}` } : {} });
  const post = (p, body) => fetch(base + p, {
    method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { server, store, get, post };
}

test('over HTTP: record is validated, and the video is served only through the allowlist', async () => {
  const { server, store, get, post } = await daemon();
  try {
    const REQ = { app: { bundleId: 'com.example.app' }, steps: [{ action: 'wait', ms: 1 }] };
    const bad = await post('/v1/runs', { ...REQ, record: 'yes' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /record must be true or false/);

    const r = await (await post('/v1/runs', { ...REQ, record: true })).json();
    assert.equal(r.request.record, true);
    const dir = store.dir(r.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'video.mp4'), 'MP4DATA');
    fs.writeFileSync(path.join(dir, 'preview.gif'), 'GIF89a');
    fs.writeFileSync(path.join(dir, 'run.secret'), 'nope');

    assert.equal((await get(`/v1/runs/${r.id}/artifacts/video.mp4`)).status, 404, 'not until the run record says it exists');
    store.update(r.id, { artifacts: { video: 'video.mp4', preview: 'preview.gif' } });

    const v = await get(`/v1/runs/${r.id}/artifacts/video.mp4`);
    assert.equal(v.status, 200);
    assert.equal(v.headers.get('content-type'), 'video/mp4');
    assert.equal(await v.text(), 'MP4DATA');
    const g = await get(`/v1/runs/${r.id}/artifacts/preview.gif`);
    assert.equal(g.headers.get('content-type'), 'image/gif');

    for (const name of ['run.secret', 'run.json', '..%2Frun.json', '__proto__', 'constructor']) {
      assert.equal((await get(`/v1/runs/${r.id}/artifacts/${name}`)).status, 404, name);
    }
    assert.equal((await get(`/v1/runs/${r.id}/artifacts/video.mp4`, false)).status, 401);

    const pub = await (await get(`/v1/runs/${r.id}`)).json();
    assert.equal(pub.links.video, `/v1/runs/${r.id}/artifacts/video.mp4`);
    assert.equal(pub.links.preview, `/v1/runs/${r.id}/artifacts/preview.gif`);
  } finally {
    server.close();
  }
});
