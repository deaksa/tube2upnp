// One HTTP server for all renderers. Renderers get short, unguessable URLs like
//   http://192.168.1.10:8000/stream/3f9c...e1.m4a
// served in one of the formats from formats.js. Short URLs matter: many renderers
// truncate or choke on 1-2 KB googlevideo URLs.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { FORMATS, FILE_FORMATS, dlnaFeatures, mimeOf } from './formats.js';
import { downloadWithYtdlp } from './resolver.js';
import { stats } from './stats.js';

const MAX_TOKENS = 256;
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

  /**
   * @param {object} [opts]
   * @param {(videoId, info, dest) => Promise<void>} [opts.download] - fetch source audio to a file
   */
  constructor(config, resolver, logger, opts = {}) {
    this.cfg = config;
    this.resolver = resolver;
    this.log = logger;
    this.download = opts.download
      ?? ((videoId, info, dest) => downloadWithYtdlp(config, logger, videoId, info, dest));
    this.cacheDir = config.cacheDir ?? path.join(os.tmpdir(), 'tube2upnp-cache');
  }

  async start() {
    await fsp.rm(this.cacheDir, { recursive: true, force: true });
    await fsp.mkdir(this.cacheDir, { recursive: true });
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

  /** Do any slow preparation (building mp4/flac files) before the renderer is told to play. */
  async prepare(entry) {
    if (FILE_FORMATS.includes(entry.format)) await this.#remuxToFile(entry);
  }

  async #handle(req, res) {
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
        return this.#serveFile(req, res, entry.format, await this.#remuxToFile(entry));
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
      ['the yt-dlp download', async () => this.#fileInputArgs(await this.#sourceFile(videoId), startAt)],
    ];
    // Source already downloaded (e.g. mp4 was tried before): no need to ask YouTube.
    if (this.#downloadJobs.has(videoId)) attempts.unshift(attempts.pop());

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
        if (!/\.(m4a|flac|source)$/.test(f)) continue;
        files++;
        bytes += (await fsp.stat(path.join(this.cacheDir, f))).size;
      }
    } catch { /* cache dir missing */ }
    return { dir: this.cacheDir, files, bytes, limitBytes: (this.cfg.cacheMb ?? 512) * 1048576 };
  }

  #remuxToFile(entry) {
    const key = `${entry.videoId}-${entry.format}-${entry.startAt ?? 0}`;
    return this.#once(this.#remuxJobs, key, () => this.#runRemux(entry, key));
  }

  #sourceFile(videoId) {
    return this.#once(this.#downloadJobs, videoId, async () => {
      const dest = path.join(this.cacheDir, `${videoId}.source`);
      const started = Date.now();
      const delays = this.cfg.downloadRetryDelaysMs ?? [2000, 5000];
      for (let attempt = 0; ; attempt++) {
        try {
          const info = await this.resolver.resolve(videoId);
          const t = Date.now();
          await this.download(videoId, info, dest);
          stats.time('download', Date.now() - t);
          break;
        } catch (err) {
          // A 403 on a URL that's seconds old isn't expiry: YouTube handed out a format URL
          // it won't serve (it varies per extraction). Drop it and extract afresh.
          this.resolver.invalidate(videoId);
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
      const { size } = await fsp.stat(dest);
      stats.inc('download.bytes', size);
      this.log.info(`Downloaded ${videoId} (${(size / 1048576).toFixed(1)} MB) in ${Date.now() - started} ms`);
      return dest;
    });
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
    const src = await this.#sourceFile(entry.videoId);
    const file = path.join(this.cacheDir, `${key}.${FORMATS[entry.format].ext}`);
    const part = `${file}.part`;
    const started = Date.now();
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...(entry.startAt > 0 ? ['-ss', String(entry.startAt)] : []),
      '-i', src, '-vn', ...this.#fileCodecArgs(entry.format), '-y', part,
    ];
    stats.gauge('ffmpeg.active', 1);
    await new Promise((resolve, reject) => {
      const ff = spawn(this.cfg.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      ff.on('close', () => stats.gauge('ffmpeg.active', -1));
      let err = '';
      ff.stderr.on('data', (d) => { err += d; });
      ff.on('error', reject);
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg remux exited ${code}: ${err.trim().split('\n').pop()}`))));
    });
    await fsp.rename(part, file);
    stats.time(`build.${entry.format}`, Date.now() - started);
    this.log.info(`${entry.format === 'mp4' ? 'Remuxed' : 'Encoded'} ${entry.videoId}${entry.startAt ? ` @${entry.startAt}s` : ''} to ${entry.format.toUpperCase()} in ${Date.now() - started} ms`);
    this.#pruneCache().catch(() => {});
    return file;
  }

  #fileCodecArgs(format) {
    if (format === 'flac') {
      // AAC decodes to float; store as 16- or 24-bit integer PCM, losslessly compressed.
      const bits = this.cfg.flacBits === 24 ? ['-sample_fmt', 's32', '-bits_per_raw_sample', '24'] : ['-sample_fmt', 's16'];
      return ['-c:a', 'flac', ...bits, '-compression_level', '5', '-f', 'flac'];
    }
    return ['-c:a', 'copy', '-movflags', '+faststart', '-f', 'mp4'];
  }

  async #pruneCache() {
    const limit = (this.cfg.cacheMb ?? 512) * 1048576;
    const files = await Promise.all((await fsp.readdir(this.cacheDir))
      .filter((f) => /\.(m4a|flac|source)$/.test(f))
      .map(async (f) => ({ f, ...(await fsp.stat(path.join(this.cacheDir, f))) })));
    files.sort((a, b) => b.atimeMs - a.atimeMs); // newest first
    let total = 0;
    for (const x of files) {
      total += x.size;
      if (total > limit) {
        if (x.f.endsWith('.source')) this.#downloadJobs.delete(x.f.slice(0, -'.source'.length));
        else this.#remuxJobs.delete(x.f.replace(/\.\w+$/, ''));
        await fsp.rm(path.join(this.cacheDir, x.f), { force: true });
      }
    }
  }

  async #serveFile(req, res, format, file) {
    const { size } = await fsp.stat(file);
    if (res.destroyed) return; // hung up while the file was being built
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
