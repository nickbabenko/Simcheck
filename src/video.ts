/**
 * Screen recording of a run, and turning the raw capture into something a web
 * page can show: `video.mp4` (at most 480 wide, faststart) and `preview.gif`
 * (at most 15s, sped up to fit, 320 wide, 8fps, palette).
 *
 * Everything here is best-effort. A recording that fails is a trace note, never
 * a failed run: the video is evidence about the run, not part of the verdict.
 *
 * Capture is the platform's job (`DeviceBackend.recordVideo`), because it has
 * to happen while the device is leased. Transcoding is not, and runs after the
 * device is back in the pool so it costs no device time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exec } from './util.js';
import { logger } from './log.js';

const log = logger('video');

/** launchd hands the daemon a minimal PATH, so look in the usual places too. */
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

export function findBinary(name: string, envVar?: string): string | null {
  const explicit = envVar ? process.env[envVar] : undefined;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const dirs = [...(process.env['PATH'] ?? '').split(':'), ...EXTRA_PATHS].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/** A file big enough to hold a playable mp4 (a header alone is ~1KB). */
export const usable = (file: string): boolean => {
  try { return fs.statSync(file).size > 1024; } catch { return false; }
};

export const RAW_VIDEO = 'video.raw.mp4';
export const VIDEO = 'video.mp4';
export const PREVIEW = 'preview.gif';
export const GIF_MAX_SECONDS = 15;
export const GIF_MAX_BYTES = 5 * 1024 * 1024;

export interface Transcoded {
  /** File names relative to the run directory. */
  video?: string;
  preview?: string;
  durationSec?: number;
  /** What went wrong, for the run's trace. Empty when both outputs exist. */
  notes: string[];
}

/** Runs a command; injectable so the transcode arithmetic can be tested. */
export type Runner = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
const run: Runner = (cmd, args) => exec(cmd, args, { timeoutMs: 5 * 60_000 });

const lastLine = (s: string) => s.trim().split('\n').pop() ?? '';

/**
 * Raw capture(s) -> `video.mp4` and `preview.gif` in `runDir`, then delete the
 * raw files. Several raw files (Android records in segments) are joined
 * first. Each output is independent: a GIF failure still leaves the mp4.
 */
export async function transcode(raws: string[], runDir: string, opts: {
  ffmpeg?: string | null; ffprobe?: string | null; exec?: Runner;
} = {}): Promise<Transcoded> {
  const out: Transcoded = { notes: [] };
  const x = opts.exec ?? run;
  const ffmpeg = opts.ffmpeg !== undefined ? opts.ffmpeg : findBinary('ffmpeg', 'FFMPEG');
  const ffprobe = opts.ffprobe !== undefined ? opts.ffprobe : findBinary('ffprobe', 'FFPROBE');
  const cleanup: string[] = [...raws];
  try {
    if (!ffmpeg) {
      out.notes.push('ffmpeg is not installed (brew install ffmpeg), so the recording was not converted');
      return out;
    }

    let raw = raws[0]!;
    if (raws.length > 1) {
      const list = path.join(runDir, 'video.segments.txt');
      fs.writeFileSync(list, raws.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      cleanup.push(list);
      raw = path.join(runDir, 'video.joined.mp4');
      cleanup.push(raw);
      const r = await x(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', raw]);
      if (r.code !== 0 || !usable(raw)) {
        // Fall back to the first segment rather than nothing.
        out.notes.push(`could not join ${raws.length} recording segments (${lastLine(r.stderr)}); kept the first`);
        raw = raws[0]!;
      }
    }

    if (ffprobe) {
      const r = await x(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', raw]);
      const d = Number(r.stdout.trim());
      if (r.code === 0 && Number.isFinite(d) && d > 0) out.durationSec = d;
    }

    const mp4 = path.join(runDir, VIDEO);
    const encoders = [
      ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28'],
      ['-c:v', 'h264_videotoolbox', '-b:v', '1200k'],
    ];
    let mp4Error = '';
    for (const enc of encoders) {
      const r = await x(ffmpeg, ['-y', '-v', 'error', '-i', raw, '-vf', "scale='min(480,iw)':-2,fps=30", ...enc,
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
      if (r.code === 0 && usable(mp4)) { out.video = VIDEO; break; }
      mp4Error = `${enc[1]}: ${lastLine(r.stderr)}`;
    }
    if (!out.video) {
      fs.rmSync(mp4, { force: true });
      out.notes.push(`could not encode video.mp4 (${mp4Error})`);
    }

    const gif = path.join(runDir, PREVIEW);
    const speed = out.durationSec && out.durationSec > GIF_MAX_SECONDS ? out.durationSec / GIF_MAX_SECONDS : 1;
    const attempts = [{ fps: 8, width: 320, colors: 128 }, { fps: 6, width: 240, colors: 64 }, { fps: 4, width: 200, colors: 48 }];
    let gifError = '';
    for (const a of attempts) {
      // Hold the last frame 1.5s so the end state registers before the loop:
      // simctl records a variable frame rate, so a static tail is otherwise lost.
      const filter = `[0:v]setpts=PTS/${speed.toFixed(4)},tpad=stop_mode=clone:stop_duration=1.5,fps=${a.fps},` +
        `scale=${a.width}:-1:flags=lanczos,split[x][y];` +
        `[x]palettegen=max_colors=${a.colors}:stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
      const r = await x(ffmpeg, ['-y', '-v', 'error', '-i', raw, '-filter_complex', filter, '-loop', '0',
        // Never longer than the cap, even if the duration probe was wrong.
        '-t', String(GIF_MAX_SECONDS + 2), gif]);
      if (r.code !== 0 || !usable(gif)) { gifError = lastLine(r.stderr); break; }
      if (fs.statSync(gif).size <= GIF_MAX_BYTES) { out.preview = PREVIEW; break; }
      gifError = `still ${fs.statSync(gif).size} bytes at ${a.width}px/${a.fps}fps`;
    }
    if (!out.preview) {
      fs.rmSync(gif, { force: true });
      out.notes.push(`could not make preview.gif (${gifError})`);
    }
    return out;
  } finally {
    for (const f of cleanup) fs.rmSync(f, { force: true });
    log.debug(`transcoded ${raws.length} raw file(s) in ${runDir}: ${JSON.stringify(out)}`);
  }
}
