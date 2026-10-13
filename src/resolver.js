// Resolves a YouTube video ID to a direct media URL using yt-dlp.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_CACHE_MS = 60 * 60 * 1000;

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
    if (hit && hit.expires > Date.now()) return hit.info;

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
      const detail = (err.stderr || err.message || '').toString().trim().split('\n').slice(-3).join(' | ');
      throw new Error(`yt-dlp failed for ${videoId}: ${detail}`);
    }

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
    };
    this.#cache.set(videoId, { info, expires: urlExpiry(info.url) });
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
    } catch (err) {
      logger.warn('yt-dlp update failed:', (err.stderr || err.message).toString().trim().split('\n').pop());
    }
  };
  const t = setInterval(run, config.ytdlpUpdateHours * 3600 * 1000);
  t.unref();
  return t;
}
