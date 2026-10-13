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
import { FORMATS, dlnaFeatures, mimeOf } from './formats.js';

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
  #remuxJobs = new Map(); // cacheKey -> Promise<filePath>

  constructor(config, resolver, logger) {
    this.cfg = config;
    this.resolver = resolver;
    this.log = logger;
    this.cacheDir = config.cacheDir ?? path.join(os.tmpdir(), 'upnptube-cache');
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

  /** Do any slow preparation (mp4 remux) before the renderer is told to play. */
  async prepare(entry) {
    if (entry.format === 'mp4') await this.#remuxToFile(entry);
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

    switch (entry.format) {
      case 'mp4': return this.#serveFile(req, res, await this.#remuxToFile(entry));
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

  async #inputArgs(entry) {
    const info = await this.resolver.resolve(entry.videoId);
    const hdrs = Object.entries(info.headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    return [
      '-hide_banner', '-loglevel', 'error',
      ...(hdrs ? ['-headers', hdrs] : []),
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      // Input-side -ss: ffmpeg range-requests from the offset instead of reading from 0.
      ...(entry.startAt > 0 ? ['-ss', String(entry.startAt)] : []),
      '-i', info.url, '-vn',
    ];
  }

  // ---------------------------------------------------------- adts / mp3 pipes

  async #pipe(req, res, entry, outArgs) {
    const args = [...await this.#inputArgs(entry), ...outArgs, 'pipe:1'];
    res.writeHead(200, this.#headers(entry.format, FORMATS[entry.format].mime));
    if (req.method === 'HEAD') return res.end();

    const ff = spawn(this.cfg.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    ff.stdout.pipe(res);
    ff.stderr.on('data', (d) => this.log.debug('ffmpeg:', d.toString().trim()));
    ff.on('error', (err) => { this.log.error('ffmpeg failed to start:', err.message); res.destroy(); });
    res.on('close', () => ff.kill('SIGKILL'));
  }

  // ------------------------------------------------------------ mp4 (file)

  #remuxToFile(entry) {
    const key = `${entry.videoId}-${entry.startAt ?? 0}`;
    if (!this.#remuxJobs.has(key)) {
      const job = this.#runRemux(entry, key).catch((err) => {
        this.#remuxJobs.delete(key);
        throw err;
      });
      this.#remuxJobs.set(key, job);
    }
    return this.#remuxJobs.get(key);
  }

  async #runRemux(entry, key) {
    const file = path.join(this.cacheDir, `${key}.m4a`);
    const part = `${file}.part`;
    const started = Date.now();
    const args = [...await this.#inputArgs(entry), '-c:a', 'copy', '-movflags', '+faststart', '-f', 'mp4', '-y', part];
    await new Promise((resolve, reject) => {
      const ff = spawn(this.cfg.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      ff.stderr.on('data', (d) => { err += d; });
      ff.on('error', reject);
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg remux exited ${code}: ${err.trim().split('\n').pop()}`))));
    });
    await fsp.rename(part, file);
    const { size } = await fsp.stat(file);
    this.log.info(`Remuxed ${entry.videoId} to MP4 (${(size / 1048576).toFixed(1)} MB) in ${Date.now() - started} ms`);
    this.#pruneCache().catch(() => {});
    return file;
  }

  async #pruneCache() {
    const limit = (this.cfg.cacheMb ?? 512) * 1048576;
    const files = await Promise.all((await fsp.readdir(this.cacheDir))
      .filter((f) => f.endsWith('.m4a'))
      .map(async (f) => ({ f, ...(await fsp.stat(path.join(this.cacheDir, f))) })));
    files.sort((a, b) => b.atimeMs - a.atimeMs); // newest first
    let total = 0;
    for (const x of files) {
      total += x.size;
      if (total > limit) {
        const key = x.f.slice(0, -4);
        this.#remuxJobs.delete(key);
        await fsp.rm(path.join(this.cacheDir, x.f), { force: true });
      }
    }
  }

  async #serveFile(req, res, file) {
    const { size } = await fsp.stat(file);
    const headers = { ...this.#headers('mp4', 'audio/mp4'), 'Accept-Ranges': 'bytes' };
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
      s.pipe(res);
      s.on('end', resolve);
      s.on('error', () => { res.destroy(); resolve(); });
      res.on('close', () => { s.destroy(); resolve(); });
    });
  }
}
