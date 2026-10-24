// One HTTP server for all renderers. Renderers get short, unguessable URLs like
//   http://192.168.1.10:8000/stream/3f9c...e1.m4a
// served in one of the formats from formats.js. Short URLs matter: many renderers
// truncate or choke on 1-2 KB googlevideo URLs.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { FORMATS, FILE_FORMATS, dlnaFeatures, mimeOf } from './formats.js';
import { downloadWithYtdlp } from './resolver.js';
import { stats } from './stats.js';

const MAX_TOKENS = 256;
const MAX_ART = 64;
const ART_SIZE = 480; // square, within DLNA's JPEG_SM (640x480)
const MAX_ART_SOURCE_BYTES = 5 * 1024 * 1024;
// Covers are only fetched from YouTube's image hosts (the thumbnail URL yt-dlp reports).
const ART_HOSTS = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com)$/;
const ART_FEATURES = 'DLNA.ORG_PN=JPEG_SM;DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=00f00000000000000000000000000000';
const CACHE_FILE = /\.(m4a|flac|source)$/;
const PASSTHROUGH_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } // suffix: last N bytes
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start <= end && start < size ? { start, end } : 'invalid';
}

export class MediaServer {
  #tokens = new Map();
  #server = null;
  #remuxJobs = new Map();    // `${videoId}-${format}-${startAt}` -> Promise<file path>
  #downloadJobs = new Map(); // videoId -> Promise<source path>
  #pins = new Map();         // cache file name -> number of downloads/builds/responses using it
  #art = new Map();          // token -> { source, jpeg: Promise<Buffer|null> }
  #artTokens = new Map();    // source URL -> token

  /**
   * @param {object} [opts]
   * @param {(videoId, info, dest) => Promise<void>} [opts.download] - fetch source audio to a file
   * @param {(url) => Promise<Buffer>} [opts.fetchImage] - fetch a cover's source image
   */
  constructor(config, resolver, logger, opts = {}) {
    this.cfg = config;
    this.resolver = resolver;
    this.log = logger;
    this.download = opts.download
      ?? ((videoId, info, dest) => downloadWithYtdlp(config, logger, videoId, info, dest));
    this.fetchImage = opts.fetchImage ?? fetchImage;
    // Default: under DATA_DIR, so the cache survives restarts (and the Docker data volume
    // keeps it). Never the shared temp folder: other local users could read or pre-create
    // files at a predictable path there.
    this.cacheDir = config.cacheDir ?? path.join(config.dataDir ?? './data', 'cache');
  }

  async start() {
    await fsp.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    // Keep finished files from earlier runs; drop anything a crash or restart left half-written.
    let kept = 0;
    let bytes = 0;
    for (const f of await fsp.readdir(this.cacheDir)) {
      const full = path.join(this.cacheDir, f);
      if (/\.(part|download|info\.json)$/.test(f)) await fsp.rm(full, { force: true });
      else if (CACHE_FILE.test(f)) { kept++; bytes += (await fsp.stat(full)).size; }
    }
    if (kept) this.log.info(`Cache: ${kept} file(s), ${(bytes / 1048576).toFixed(0)} MB kept from earlier runs (${this.cacheDir})`);
    await this.#pruneCache();
    await new Promise((resolve, reject) => {
      this.#server = http.createServer((req, res) => this.#handle(req, res).catch((err) => {
        this.log.error('Stream error:', err.message);
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      }));
      this.#server.on('error', reject);
      this.#server.listen(this.cfg.mediaPort, () => {
        this.log.info(`Media server listening on :${this.cfg.mediaPort}`);
        resolve();
      });
    });
  }

  get port() {
    return this.#server?.address()?.port;
  }

  stop() {
    this.#server?.close();
    this.#server?.closeAllConnections?.();
  }

  /**
   * Register a stream and return the path (without host) to hand to a renderer.
   * @param {{videoId:string, format:string, ext:string, startAt?:number, onRequest?:Function}} entry
   */
  register(entry) {
    const token = randomBytes(16).toString('hex');
    this.#tokens.set(token, entry);
    while (this.#tokens.size > MAX_TOKENS) this.#tokens.delete(this.#tokens.keys().next().value);
    return `/stream/${token}.${FORMATS[entry.format].ext ?? entry.ext}`;
  }

  /**
   * Register a track's cover and return its path (without host), or null if the URL isn't a
   * YouTube image. Renderers often can't use the thumbnail itself: it's HTTPS, often WebP and
   * up to 1280x720 (16:9, with bars around album art). We serve a 480x480 JPEG over plain HTTP
   * instead, cropped to the square in the middle. It's built right away, in the background.
   */
  registerArt(source) {
    let url;
    try { url = new URL(source); } catch { return null; }
    if (url.protocol !== 'https:' || !ART_HOSTS.test(url.hostname)) return null;
    let token = this.#artTokens.get(url.href);
    if (!token) {
      token = randomBytes(16).toString('hex');
      const jpeg = this.#makeArt(url.href).catch((err) => {
        this.log.debug(`Cover ${url.href} not converted (${err.message}) - the renderer gets the original`);
        return null;
      });
      this.#art.set(token, { source: url.href, jpeg });
      this.#artTokens.set(url.href, token);
      while (this.#art.size > MAX_ART) {
        const [oldest, old] = this.#art.entries().next().value;
        this.#art.delete(oldest);
        this.#artTokens.delete(old.source);
      }
    }
    return `/art/${token}.jpg`;
  }

  async #makeArt(source) {
    const input = await this.fetchImage(source);
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-vf', `crop=w='min(iw,ih)':h='min(iw,ih)',scale=${ART_SIZE}:${ART_SIZE}`,
      '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '3', '-f', 'mjpeg', 'pipe:1'];
    return new Promise((resolve, reject) => {
      const ff = spawn(this.cfg.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const out = [];
      let err = '';
      const timer = setTimeout(() => ff.kill('SIGKILL'), 15000);
      ff.stdout.on('data', (d) => out.push(d));
      ff.stderr.on('data', (d) => { err += d; });
      ff.on('error', (e) => { clearTimeout(timer); reject(e); });
      ff.on('close', (code) => {
        clearTimeout(timer);
        const jpeg = Buffer.concat(out);
        if (code === 0 && jpeg.length) resolve(jpeg);
        else reject(new Error(`ffmpeg exited with ${code}: ${err.trim().split('\n').pop() ?? ''}`));
      });
      ff.stdin.on('error', () => {}); // ffmpeg may exit before reading everything
      ff.stdin.end(input);
    });
  }

  async #serveArt(req, res, art) {
    const jpeg = await art.jpeg;
    if (!jpeg) {
      // Couldn't convert it (no ffmpeg, odd image): the renderer can still try the original.
      res.writeHead(302, { Location: art.source }).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length,
      'transferMode.dlna.org': 'Interactive', 'contentFeatures.dlna.org': ART_FEATURES,
      'Cache-Control': 'max-age=86400',
    });
    res.end(req.method === 'HEAD' ? undefined : jpeg);
  }

  /** Do any slow preparation (building mp4/flac files) before the renderer is told to play. */
  async prepare(entry) {
    if (!FILE_FORMATS.includes(entry.format)) return {};
    const file = await this.#remuxToFile(entry);
    // The audio actually played: the source on disk may be older than the current
    // extraction (downloaded at 128 kbps before cookies were set up, say).
    const src = this.#sourcePath(entry.videoId);
    const audio = await this.probeAudio(fs.existsSync(src) ? src : entry.format === 'mp4' ? file : null);
    return { sourceAudio: audio };
  }

  #probes = new Map(); // `${file}:${mtime}` -> { codec, kbps, sampleRate }

  /** Codec, bitrate and sample rate of a cached file, from ffmpeg's stream info (null if unknown). */
  async probeAudio(file) {
    if (!file) return null;
    let key;
    try { key = `${file}:${(await fsp.stat(file)).mtimeMs}`; } catch { return null; }
    if (this.#probes.has(key)) return this.#probes.get(key);
    const stderr = await new Promise((resolve) => {
      const ff = spawn(this.cfg.ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      let out = '';
      ff.stderr.on('data', (d) => { out += d; });
      ff.on('error', () => resolve(''));
      ff.on('close', () => resolve(out)); // exits 1 (no output file): only the info is wanted
    });
    const m = /Audio: (\w+)[^\n]*?, (\d+) Hz([^\n]*)/.exec(stderr);
    // The stream's own bitrate; for an audio-only file the overall one is close enough.
    const kbps = /, (\d+) kb\/s/.exec(m?.[3] ?? '')?.[1] ?? /bitrate: (\d+) kb\/s/.exec(stderr)?.[1];
    const audio = m ? { codec: m[1], kbps: kbps ? Number(kbps) : null, sampleRate: Number(m[2]) } : null;
    this.#probes.set(key, audio);
    if (this.#probes.size > 256) this.#probes.delete(this.#probes.keys().next().value);
    return audio;
  }

  async #handle(req, res) {
    const a = /^\/art\/([0-9a-f]{32})\.jpg$/.exec(req.url ?? '');
    const art = a && this.#art.get(a[1]);
    if (art && ['GET', 'HEAD'].includes(req.method)) return this.#serveArt(req, res, art);
    const m = /^\/stream\/([0-9a-f]{32})\.\w+$/.exec(req.url ?? '');
    const entry = m && this.#tokens.get(m[1]);
    if (!entry || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404).end();
      return;
    }
    this.log.debug(`${req.method} ${req.url} range=${req.headers.range ?? '-'} from ${req.socket.remoteAddress}`);
    if (req.method === 'GET') entry.onRequest?.();
    stats.inc('http.requests');
    stats.inc(`http.requests.${entry.format}`);
    stats.gauge('http.active', 1);
    res.on('close', () => stats.gauge('http.active', -1));

    switch (entry.format) {
      case 'mp4':
      case 'flac':
        return this.#serveFile(req, res, entry);
      case 'adts': return this.#pipe(req, res, entry, ['-c:a', 'copy', '-f', 'adts']);
      case 'mp3': return this.#pipe(req, res, entry, ['-c:a', 'libmp3lame', '-b:a', this.cfg.mp3Bitrate, '-f', 'mp3']);
      default: return this.#proxy(req, res, entry, await this.resolver.resolve(entry.videoId), true);
    }
  }

  #headers(format, mime) {
    return {
      'Content-Type': mime,
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org': dlnaFeatures(format),
      'Cache-Control': 'no-store',
    };
  }

  // ---------------------------------------------------------------- direct

  #proxy(req, res, entry, info, retry) {
    // The renderer may have hung up while we resolved: don't open a request nobody reads.
    if (res.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const headers = { ...info.headers };
      if (req.headers.range) headers.Range = req.headers.range;

      const lib = info.url.startsWith('https:') ? https : http;
      const up = lib.request(info.url, { method: req.method, headers }, (upRes) => {
        // Signed googlevideo URLs expire or get revoked: re-resolve once.
        if ((upRes.statusCode === 403 || upRes.statusCode === 410) && retry) {
          upRes.resume();
          this.log.warn(`Upstream ${upRes.statusCode} for ${entry.videoId}, re-resolving`);
          this.resolver.invalidate(entry.videoId);
          this.resolver.resolve(entry.videoId)
            .then((fresh) => this.#proxy(req, res, entry, fresh, false))
            .then(resolve, reject);
          return;
        }
        if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location && retry) {
          upRes.resume();
          this.#proxy(req, res, entry, { ...info, url: upRes.headers.location }, false).then(resolve, reject);
          return;
        }

        const out = this.#headers('direct', mimeOf('direct', info.mime));
        for (const h of PASSTHROUGH_HEADERS) if (upRes.headers[h]) out[h] = upRes.headers[h];
        if (!out['accept-ranges']) out['accept-ranges'] = 'bytes';
        res.writeHead(upRes.statusCode, out);
        upRes.on('data', (c) => stats.inc('http.bytes', c.length));
        upRes.pipe(res);
        upRes.on('end', resolve);
        upRes.on('error', reject);
      });
      up.on('error', reject);
      res.on('close', () => { up.destroy(); resolve(); });
      up.end();
    });
  }

  // ------------------------------------------------------------ ffmpeg common

  #urlInputArgs(info, startAt) {
    const hdrs = Object.entries(info.headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    return [
      '-hide_banner', '-loglevel', 'error',
      ...(hdrs ? ['-headers', hdrs] : []),
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      // Input-side -ss: ffmpeg range-requests from the offset instead of reading from 0.
      ...(startAt > 0 ? ['-ss', String(startAt)] : []),
      '-i', info.url, '-vn',
    ];
  }

  #fileInputArgs(file, startAt) {
    return ['-hide_banner', '-loglevel', 'error', ...(startAt > 0 ? ['-ss', String(startAt)] : []), '-i', file, '-vn'];
  }

  // ---------------------------------------------------------- adts / mp3 pipes

  // ffmpeg reads YouTube's URL itself so the stream starts at once. YouTube may refuse
  // that URL (403: expired, or a format URL it won't serve to ffmpeg), so fall back to a
  // fresh extraction, then to yt-dlp's own download - slower to start, but it is what
  // mp4/flac rely on. Headers go out with the first audio byte, so until then a failed
  // attempt can still be retried, and a complete failure is a 502, not an empty 200.
  async #pipe(req, res, entry, outArgs) {
    const headers = this.#headers(entry.format, FORMATS[entry.format].mime);
    if (req.method === 'HEAD') return res.writeHead(200, headers).end();

    const { videoId, startAt } = entry;
    const attempts = [
      ['YouTube URL', async () => this.#urlInputArgs(await this.resolver.resolve(videoId), startAt)],
      ['a fresh extraction', async () => {
        this.resolver.invalidate(videoId);
        return this.#urlInputArgs(await this.resolver.resolve(videoId), startAt);
      }],
      ['the yt-dlp download', async () => this.#fileInputArgs(await this.#existingSourceFile(videoId), startAt)],
    ];
    // Source already downloaded (mp4 tried before, or an earlier run): no need to ask YouTube.
    if (this.#downloadJobs.has(videoId) || fs.existsSync(this.#sourcePath(videoId))) attempts.unshift(attempts.pop());

    let error;
    for (const [i, [, input]] of attempts.entries()) {
      if (i > 0) {
        this.log.warn(`ffmpeg could not read ${videoId} (${error}) - retrying with ${attempts[i][0]}`);
        stats.inc('pipe.retries');
      }
      let args;
      try {
        args = await input();
      } catch (err) {
        error = err.message;
        continue;
      }
      // Hung up while we resolved or downloaded: an ffmpeg started now would block forever
      // on a pipe nobody reads, since the 'close' that kills it has already happened.
      if (res.destroyed) return;
      const r = await this.#runPipe([...args, ...outArgs, 'pipe:1'], res, headers);
      if (r.ok || r.bytes || res.destroyed) {
        if (!r.ok && !res.destroyed) this.log.warn(`ffmpeg stopped mid-stream for ${videoId}: ${r.error}`);
        res.end();
        return;
      }
      error = r.error;
    }
    stats.inc('pipe.failed');
    throw new Error(`ffmpeg could not stream ${videoId}: ${error}`);
  }

  /** Run one ffmpeg into `res`; resolves when it exits, with how many bytes it sent. */
  #runPipe(args, res, headers) {
    return new Promise((resolve) => {
      const ff = spawn(this.cfg.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      stats.gauge('ffmpeg.active', 1);
      let bytes = 0;
      let err = '';
      ff.stdout.on('data', (c) => {
        if (!res.headersSent) res.writeHead(200, headers);
        bytes += c.length;
        stats.inc('http.bytes', c.length);
      });
      ff.stdout.pipe(res, { end: false });
      ff.stderr.on('data', (d) => {
        this.log.debug('ffmpeg:', d.toString().trim());
        err = (err + d).slice(-2000);
      });
      ff.on('error', (e) => { err ||= `ffmpeg failed to start: ${e.message}`; });
      const kill = () => ff.kill('SIGKILL');
      res.on('close', kill);
      ff.on('close', (code) => {
        res.off('close', kill);
        stats.gauge('ffmpeg.active', -1);
        resolve({ ok: code === 0, bytes, error: err.trim().split('\n').pop() || `exit code ${code}` });
      });
    });
  }

  // ------------------------------------------------------- mp4 / flac (file)

  /** Files and bytes in the disk cache, for the status page. */
  async cacheInfo() {
    let files = 0;
    let bytes = 0;
    try {
      for (const f of await fsp.readdir(this.cacheDir)) {
        if (!CACHE_FILE.test(f)) continue;
        files++;
        bytes += (await fsp.stat(path.join(this.cacheDir, f))).size;
      }
    } catch { /* cache dir missing */ }
    return { dir: this.cacheDir, files, bytes, limitBytes: (this.cfg.cacheMb ?? 512) * 1048576 };
  }

  #remuxKey(entry) {
    return `${entry.videoId}-${entry.format}-${entry.startAt ?? 0}`;
  }

  #remuxToFile(entry) {
    const key = this.#remuxKey(entry);
    return this.#once(this.#remuxJobs, key, () => this.#runRemux(entry, key));
  }

  /**
   * Mark a cache file as in use so eviction leaves it alone, and as recently used (its
   * mtime: LRU order that survives restarts). Returns the release function.
   */
  #pin(file) {
    const name = path.basename(file);
    this.#pins.set(name, (this.#pins.get(name) ?? 0) + 1);
    const now = new Date();
    fsp.utimes(file, now, now).catch(() => {}); // not there yet / gone: nothing to mark
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = this.#pins.get(name) - 1;
      if (n > 0) this.#pins.set(name, n);
      else this.#pins.delete(name);
    };
  }

  /** The downloaded source, downloaded again if it vanished (evicted, or a tmp cleaner). */
  async #existingSourceFile(videoId) {
    const job = this.#sourceFile(videoId);
    const src = await job;
    if (fs.existsSync(src)) return src;
    if (this.#downloadJobs.get(videoId) === job) this.#downloadJobs.delete(videoId);
    return this.#sourceFile(videoId);
  }

  #sourcePath(videoId) {
    return path.join(this.cacheDir, `${videoId}.source`);
  }

  #sourceFile(videoId) {
    return this.#once(this.#downloadJobs, videoId, async () => {
      const dest = this.#sourcePath(videoId);
      if (await this.#reuse(dest)) return dest;
      const started = Date.now();
      await this.#download(videoId, dest, this.cfg.downloadRetryDelaysMs ?? [2000, 5000]);
      const { size } = await fsp.stat(dest);
      stats.inc('download.bytes', size);
      this.log.info(`Downloaded ${videoId} (${(size / 1048576).toFixed(1)} MB) in ${Date.now() - started} ms`);
      return dest;
    });
  }

  async #download(videoId, dest, delays) {
    // Download to a temp name and rename, so an interrupted download is never mistaken for a
    // complete file after a restart (and is never a cache file that eviction could pick).
    // Not ".part": yt-dlp strips that suffix from -o names and would write straight to dest.
    const part = `${dest}.download`;
    for (let attempt = 0; ; attempt++) {
      try {
        const info = await this.resolver.resolve(videoId);
        const t = Date.now();
        await this.download(videoId, info, part);
        await fsp.rename(part, dest);
        stats.time('download', Date.now() - t);
        return;
      } catch (err) {
        // A 403 on a URL that's seconds old isn't expiry: YouTube handed out a format URL
        // it won't serve (it varies per extraction). Drop it and extract afresh.
        this.resolver.invalidate(videoId);
        await fsp.rm(part, { force: true });
        if (err.forbidden) stats.inc('download.forbidden');
        if (attempt >= delays.length) {
          stats.inc('download.failed');
          if (err.forbidden) {
            this.log.warn('YouTube keeps refusing downloads (403). If this persists, see README '
              + '"yt-dlp errors" - a PO-token provider or cookies usually fix it.');
          }
          throw err;
        }
        this.log.warn(`${err.message.replace(/^yt-dlp download failed for \S+: /, 'Download failed: ')}`
          + ` - retrying with a fresh extraction in ${delays[attempt] / 1000}s (${attempt + 1}/${delays.length})`);
        stats.inc('download.retries');
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }

  /** Run a job once per key; forget it if it fails so the next request retries. */
  #once(map, key, fn) {
    if (map.has(key)) stats.inc('cache.hits');
    else {
      stats.inc('cache.misses');
      map.set(key, fn().catch((err) => { map.delete(key); throw err; }));
    }
    return map.get(key);
  }

  async #runRemux(entry, key) {
    const file = path.join(this.cacheDir, `${key}.${FORMATS[entry.format].ext}`);
    if (await this.#reuse(file)) return file;
    const src = await this.#existingSourceFile(entry.videoId);
    const part = `${file}.part`;
    const started = Date.now();
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...(entry.startAt > 0 ? ['-ss', String(entry.startAt)] : []),
      '-i', src, '-vn', ...this.#fileCodecArgs(entry.format), '-y', part,
    ];
    const unpinSrc = this.#pin(src);
    stats.gauge('ffmpeg.active', 1);
    try {
      await new Promise((resolve, reject) => {
        const ff = spawn(this.cfg.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        ff.on('close', () => stats.gauge('ffmpeg.active', -1));
        let err = '';
        ff.stderr.on('data', (d) => { err += d; });
        ff.on('error', reject);
        ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg remux exited ${code}: ${err.trim().split('\n').pop()}`))));
      });
      await fsp.rename(part, file);
    } catch (err) {
      await fsp.rm(part, { force: true });
      throw err;
    } finally {
      unpinSrc();
    }
    stats.time(`build.${entry.format}`, Date.now() - started);
    this.log.info(`${entry.format === 'mp4' ? 'Remuxed' : 'Encoded'} ${entry.videoId}${entry.startAt ? ` @${entry.startAt}s` : ''} to ${entry.format.toUpperCase()} in ${Date.now() - started} ms`);
    // Never evict what was just built (or its source), even if it alone exceeds CACHE_MB:
    // the renderer is about to fetch it. It becomes evictable once something newer is used.
    this.#pruneCache([path.basename(file), path.basename(src)])
      .catch((err) => this.log.debug('Cache cleanup failed:', err.message));
    return file;
  }

  /** Use a finished file from the cache (this or an earlier run) and mark it recently used. */
  async #reuse(file) {
    try {
      const st = await fsp.stat(file);
      if (!st.size) return false;
      const now = new Date();
      await fsp.utimes(file, now, now); // LRU by mtime: atime is often not updated (relatime/noatime)
      stats.inc('cache.diskHits');
      return true;
    } catch {
      return false;
    }
  }

  /** Delete every cached file (e.g. after changing YTDLP_FORMAT), except files in use. */
  async clearCache() {
    this.#downloadJobs.clear();
    this.#remuxJobs.clear();
    let n = 0;
    let busy = 0;
    for (const f of await fsp.readdir(this.cacheDir)) {
      if (!CACHE_FILE.test(f)) continue;
      // A track being played or built keeps its file; it goes with the next eviction.
      if (this.#pins.has(f)) { busy++; continue; }
      await fsp.rm(path.join(this.cacheDir, f), { force: true });
      n++;
    }
    this.log.info(`Cache cleared (${n} file(s)${busy ? `, ${busy} in use kept` : ''})`);
    return n;
  }

  #fileCodecArgs(format) {
    if (format === 'flac') {
      // AAC decodes to float; store as 16- or 24-bit integer PCM, losslessly compressed.
      const bits = this.cfg.flacBits === 24 ? ['-sample_fmt', 's32', '-bits_per_raw_sample', '24'] : ['-sample_fmt', 's16'];
      return ['-c:a', 'flac', ...bits, '-compression_level', '5', '-f', 'flac'];
    }
    return ['-c:a', 'copy', '-movflags', '+faststart', '-f', 'mp4'];
  }

  /** Evict least-recently-used files until the cache fits CACHE_MB, sparing files in use. */
  async #pruneCache(keep = []) {
    const limit = (this.cfg.cacheMb ?? 512) * 1048576;
    const names = (await fsp.readdir(this.cacheDir)).filter((f) => CACHE_FILE.test(f));
    const files = (await Promise.all(names.map(async (f) => {
      try {
        const st = await fsp.stat(path.join(this.cacheDir, f));
        // mtime, which use updates (#reuse, #pin): atime barely moves on noatime/relatime mounts.
        return { f, size: st.size, used: st.mtimeMs };
      } catch {
        return null; // removed meanwhile
      }
    }))).filter(Boolean);
    let total = files.reduce((n, x) => n + x.size, 0);
    files.sort((a, b) => a.used - b.used); // least recently used first
    for (const x of files) {
      if (total <= limit) break;
      if (keep.includes(x.f) || this.#pins.has(x.f)) continue; // being written, read or just built
      if (x.f.endsWith('.source')) this.#downloadJobs.delete(x.f.slice(0, -'.source'.length));
      else this.#remuxJobs.delete(x.f.replace(/\.\w+$/, ''));
      await fsp.rm(path.join(this.cacheDir, x.f), { force: true });
      total -= x.size;
      stats.inc('cache.evictions');
    }
  }

  async #serveFile(req, res, entry) {
    const job = this.#remuxToFile(entry);
    let file = await job;
    let unpin = this.#pin(file);
    try {
      let size;
      try {
        ({ size } = await fsp.stat(file));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        // Gone since it was built (evicted, or a tmp cleaner): build it again.
        unpin();
        const key = this.#remuxKey(entry);
        if (this.#remuxJobs.get(key) === job) this.#remuxJobs.delete(key);
        file = await this.#remuxToFile(entry);
        unpin = this.#pin(file);
        ({ size } = await fsp.stat(file));
      }
      if (res.destroyed) return; // hung up while the file was being built
      await this.#sendFile(req, res, entry.format, file, size);
    } finally {
      unpin();
    }
  }

  async #sendFile(req, res, format, file, size) {
    const headers = { ...this.#headers(format, FORMATS[format].mime), 'Accept-Ranges': 'bytes' };
    const range = req.headers.range ? parseRange(req.headers.range, size) : null;
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    headers['Content-Length'] = end - start + 1;
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();
    await new Promise((resolve) => {
      const s = fs.createReadStream(file, { start, end });
      s.on('data', (c) => stats.inc('http.bytes', c.length));
      s.pipe(res);
      s.on('end', resolve);
      s.on('error', () => { res.destroy(); resolve(); });
      res.on('close', () => { s.destroy(); resolve(); });
    });
  }
}

/** A cover's source image: not followed elsewhere by redirects, and not too big. */
async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_ART_SOURCE_BYTES) throw new Error('image too big');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_ART_SOURCE_BYTES) throw new Error('image too big');
  return data;
}
