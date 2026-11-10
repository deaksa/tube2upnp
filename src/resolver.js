// Resolves a YouTube video ID to a direct media URL using yt-dlp.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { stats } from './stats.js';
import { YtdlpWorkers } from './ytdlpWorker.js';

const execFileP = promisify(execFile);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_CACHE_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
// Looked up once per yt-dlp process at start: the first YouTube video, there since 2005.
const WARM_UP_VIDEO = 'jNQXAC9IVRw';

const MIME_BY_EXT = {
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'audio/webm',
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
};

export function mimeFor(info) {
  if (info.ext === 'webm' && info.vcodec && info.vcodec !== 'none') return 'video/webm';
  return MIME_BY_EXT[info.ext] ?? 'application/octet-stream';
}

/** Expiry of a googlevideo URL (its `expire` query param), else +1h. */
export function urlExpiry(url, now = Date.now()) {
  try {
    const exp = Number(new URL(url).searchParams.get('expire'));
    if (exp) return Math.min(exp * 1000 - 5 * 60 * 1000, now + MAX_CACHE_MS);
  } catch { /* fall through */ }
  return now + MAX_CACHE_MS;
}

export class Resolver {
  #cache = new Map();
  #inflight = new Map();

  constructor(config, logger) {
    this.cfg = config;
    this.log = logger;
    // yt-dlp kept loaded between lookups (YTDLP_WORKERS=0: run it once per lookup).
    this.workers = config.ytdlpWorkers > 0 ? new YtdlpWorkers(config, logger) : null;
  }

  /**
   * @returns {Promise<{url:string, mime:string, ext:string, headers:object,
   *   title:string, artist:string, thumbnail:string, duration:number}>}
   */
  async resolve(videoId) {
    if (!VIDEO_ID.test(videoId)) throw new Error(`Refusing invalid video ID "${videoId}"`);

    const hit = this.#cache.get(videoId);
    if (hit && hit.expires > Date.now()) {
      stats.inc('resolve.cacheHits');
      return hit.info;
    }

    // Coalesce concurrent lookups for the same video (e.g. renderer retrying).
    if (this.#inflight.has(videoId)) return this.#inflight.get(videoId);
    const p = this.#run(videoId).finally(() => this.#inflight.delete(videoId));
    this.#inflight.set(videoId, p);
    return p;
  }

  invalidate(videoId) {
    this.#cache.delete(videoId);
  }

  #args() {
    return [
      '--no-playlist', '--no-warnings', '--no-progress',
      '-f', this.cfg.ytdlpFormat,
      ...(this.cfg.ytdlpJsRuntime ? ['--js-runtimes', this.cfg.ytdlpJsRuntime] : []),
      ...this.cfg.ytdlpExtraArgs,
    ];
  }

  /**
   * Have each loaded yt-dlp process look up a video once, so the first track the user casts
   * doesn't wait for what only the first lookup does: fetching and preprocessing YouTube's
   * player (seconds on a small machine) and connecting to YouTube.
   */
  async warmUp() {
    if (!this.workers) return;
    const started = Date.now();
    const results = await this.workers.runOnAll(
      { op: 'resolve', args: this.#args(), url: `https://www.youtube.com/watch?v=${WARM_UP_VIDEO}` }, this.cfg.ytdlpTimeoutMs);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    if (ok) this.log.info(`yt-dlp warmed up in ${Date.now() - started} ms (${ok} process${ok > 1 ? 'es' : ''})`);
    for (const r of results) if (r.status === 'rejected') this.log.debug('yt-dlp warm-up failed:', r.reason?.message);
  }

  /** After yt-dlp updated itself: load the new version, and warm it up. */
  restartWorkers() {
    if (!this.workers) return;
    this.workers.restart();
    this.warmUp().catch(() => {});
  }

  async #run(videoId) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const args = this.#args();
    const started = Date.now();
    this.log.debug('yt-dlp', args.join(' '), url);

    let stdout;
    try {
      stdout = await this.#lookup(args, url);
    } catch (err) {
      stats.inc('resolve.failed');
      const detail = (err.stderr || err.message || '').toString().trim().split('\n').slice(-3).join(' | ');
      throw new Error(`yt-dlp failed for ${videoId}: ${detail}`);
    }
    stats.time('resolve', Date.now() - started);

    const j = JSON.parse(stdout);
    if (!j || typeof j !== 'object') throw new Error(`yt-dlp returned no video info for ${videoId}`);
    // With a single selected format, url/ext live at top level; with merged formats they don't.
    const fmt = j.url ? j : (j.requested_formats ?? []).find((f) => f.url);
    if (!fmt?.url) throw new Error(`yt-dlp returned no direct URL for ${videoId} (format "${this.cfg.ytdlpFormat}")`);

    const info = {
      url: fmt.url,
      ext: fmt.ext,
      mime: mimeFor(fmt),
      headers: fmt.http_headers ?? j.http_headers ?? {},
      title: j.track ?? j.title ?? videoId,
      artist: j.artist ?? j.channel ?? j.uploader ?? '',
      album: j.album ?? '',
      thumbnail: j.thumbnail ?? '',
      duration: Number(j.duration) || 0,
      filesize: Number(fmt.filesize) || 0,
      formatId: fmt.format_id ?? null,
      acodec: fmt.acodec ?? null,
      abr: Math.round(Number(fmt.abr) || Number(fmt.tbr) || 0) || null,
      asr: Number(fmt.asr) || null,
    };
    // Keep yt-dlp's full JSON (non-enumerable, so it never ends up in logs or the API)
    // so downloads can reuse it via --load-info-json instead of extracting again.
    Object.defineProperty(info, 'rawJson', { value: stdout, enumerable: false });
    this.#cache.set(videoId, { info, expires: urlExpiry(info.url) });
    while (this.#cache.size > MAX_CACHE_ENTRIES) this.#cache.delete(this.#cache.keys().next().value);
    this.log.info(`Resolved ${videoId} "${info.title}" (${info.ext}, ${info.mime}) in ${Date.now() - started} ms`);
    return info;
  }

  /** yt-dlp's info JSON for the URL: from a loaded worker if there is one, else a fresh yt-dlp. */
  async #lookup(args, url) {
    if (await this.workers?.ready()) {
      try {
        return await this.workers.run({ op: 'resolve', args, url }, this.cfg.ytdlpTimeoutMs);
      } catch (err) {
        // Only a process that died is worth a second try: yt-dlp's own answer (unavailable,
        // sign-in, ...) would be the same from the command line, and a timeout would repeat.
        if (err.kind !== 'exit') throw err;
        this.log.warn(`yt-dlp worker failed (${err.message}) - running yt-dlp directly`);
      }
    }
    // execFile, not exec: the video ID never touches a shell.
    const { stdout } = await execFileP(this.cfg.ytdlpPath, ['--dump-json', ...args, '--', url], {
      timeout: this.cfg.ytdlpTimeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  }
}

/** Periodically self-update yt-dlp. YouTube changes break old versions within weeks. */
export function scheduleYtdlpUpdates(config, logger, resolver = null) {
  if (!config.ytdlpUpdateHours) return null;
  const run = async () => {
    const [cmd, ...args] = config.ytdlpUpdateCmd
      ? config.ytdlpUpdateCmd.split(' ').filter(Boolean)
      : [config.ytdlpPath, '-U'];
    try {
      const { stdout } = await execFileP(cmd, args, { timeout: 5 * 60 * 1000 });
      logger.info('yt-dlp update:', stdout.trim().split('\n').pop());
      stats.info.ytdlp = await ytdlpVersion(config);
      resolver?.restartWorkers(); // the loaded processes still run the old version
    } catch (err) {
      logger.warn('yt-dlp update failed:', (err.stderr || err.message).toString().trim().split('\n').pop());
    }
  };
  const t = setInterval(run, config.ytdlpUpdateHours * 3600 * 1000);
  t.unref();
  return t;
}

/**
 * Download the resolved audio with yt-dlp itself (one attempt; MediaServer retries). ffmpeg fetching googlevideo directly
 * gets 403s for some clients/formats (chunking rules, IP-bound URLs); yt-dlp knows how
 * to download YouTube, so let it, and only remux the local file with ffmpeg.
 */
export async function downloadWithYtdlp(config, logger, videoId, info, dest, workers = null) {
  const common = [
    '--no-playlist', '--no-warnings', '--no-progress', '--fixup', 'never', '--no-part',
    '--force-overwrites', '-o', dest,
    ...(config.ytdlpJsRuntime ? ['--js-runtimes', config.ytdlpJsRuntime] : []),
    ...config.ytdlpExtraArgs,
  ];
  const fmt = info.formatId ?? config.ytdlpFormat;
  const timeout = 10 * 60 * 1000;
  const run = async (args) => {
    if (info.rawJson && await workers?.ready()) {
      try {
        return await workers.run({ op: 'download', args: ['-f', fmt, ...common], infoFile: jsonFile }, timeout);
      } catch (err) {
        if (err.kind !== 'exit') throw err; // see Resolver#lookup
        logger?.warn(`yt-dlp worker failed (${err.message}) - running yt-dlp directly`);
      }
    }
    return execFileP(config.ytdlpPath, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  };
  const tail = (err) => (err.stderr || err.message || '').toString().trim().split('\n').slice(-2).join(' | ');

  // Reuse the JSON from resolve() so this is a pure download, not a second extraction.
  const jsonFile = `${dest}.info.json`;
  const args = info.rawJson
    ? ['--load-info-json', jsonFile, '-f', fmt, ...common]
    : ['-f', config.ytdlpFormat, ...common, '--', `https://www.youtube.com/watch?v=${videoId}`];
  try {
    if (info.rawJson) {
      // Only we may read it, and never write through something already there (a leftover,
      // or a symlink planted in a CACHE_DIR others can write to).
      await rm(jsonFile, { force: true });
      await writeFile(jsonFile, info.rawJson, { mode: 0o600, flag: 'wx' });
    }
    await run(args);
  } catch (err) {
    const e = new Error(`yt-dlp download failed for ${videoId}: ${tail(err)}`);
    e.forbidden = /HTTP Error 403/.test(tail(err));
    throw e;
  } finally {
    await rm(jsonFile, { force: true });
  }
}

export async function ytdlpVersion(config) {
  try {
    const { stdout } = await execFileP(config.ytdlpPath, ['--version'], { timeout: 15000 });
    return stdout.trim();
  } catch {
    return null;
  }
}
