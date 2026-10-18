// Resolves a YouTube video ID to a direct media URL using yt-dlp.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { stats } from './stats.js';

const execFileP = promisify(execFile);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_CACHE_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;

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

  async #run(videoId) {
    const args = [
      '--dump-json', '--no-playlist', '--no-warnings', '--no-progress',
      '-f', this.cfg.ytdlpFormat,
      ...(this.cfg.ytdlpJsRuntime ? ['--js-runtimes', this.cfg.ytdlpJsRuntime] : []),
      ...this.cfg.ytdlpExtraArgs,
      '--', `https://www.youtube.com/watch?v=${videoId}`,
    ];
    const started = Date.now();
    this.log.debug('yt-dlp', args.join(' '));

    let stdout;
    try {
      // execFile, not exec: the video ID never touches a shell.
      ({ stdout } = await execFileP(this.cfg.ytdlpPath, args, {
        timeout: this.cfg.ytdlpTimeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      }));
    } catch (err) {
      stats.inc('resolve.failed');
      const detail = (err.stderr || err.message || '').toString().trim().split('\n').slice(-3).join(' | ');
      throw new Error(`yt-dlp failed for ${videoId}: ${detail}`);
    }
    stats.time('resolve', Date.now() - started);

    const j = JSON.parse(stdout);
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
    };
    // Keep yt-dlp's full JSON (non-enumerable, so it never ends up in logs or the API)
    // so downloads can reuse it via --load-info-json instead of extracting again.
    Object.defineProperty(info, 'rawJson', { value: stdout, enumerable: false });
    this.#cache.set(videoId, { info, expires: urlExpiry(info.url) });
    while (this.#cache.size > MAX_CACHE_ENTRIES) this.#cache.delete(this.#cache.keys().next().value);
    this.log.info(`Resolved ${videoId} "${info.title}" (${info.ext}, ${info.mime}) in ${Date.now() - started} ms`);
    return info;
  }
}

/** Periodically self-update yt-dlp. YouTube changes break old versions within weeks. */
export function scheduleYtdlpUpdates(config, logger) {
  if (!config.ytdlpUpdateHours) return null;
  const run = async () => {
    const [cmd, ...args] = config.ytdlpUpdateCmd
      ? config.ytdlpUpdateCmd.split(' ').filter(Boolean)
      : [config.ytdlpPath, '-U'];
    try {
      const { stdout } = await execFileP(cmd, args, { timeout: 5 * 60 * 1000 });
      logger.info('yt-dlp update:', stdout.trim().split('\n').pop());
      stats.info.ytdlp = await ytdlpVersion(config);
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
export async function downloadWithYtdlp(config, _logger, videoId, info, dest) {
  const common = [
    '--no-playlist', '--no-warnings', '--no-progress', '--fixup', 'never', '--no-part',
    '--force-overwrites', '-o', dest,
    ...(config.ytdlpJsRuntime ? ['--js-runtimes', config.ytdlpJsRuntime] : []),
    ...config.ytdlpExtraArgs,
  ];
  const fmt = info.formatId ?? config.ytdlpFormat;
  const run = (args) => execFileP(config.ytdlpPath, args, { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
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
