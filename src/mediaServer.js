// One HTTP server for all renderers. Renderers get short, unguessable URLs like
//   http://192.168.1.10:8000/stream/3f9c...e1.m4a
// which we proxy (HTTP -> HTTPS, with Range support) or transcode to MP3 with ffmpeg.
// Short URLs matter: many renderers truncate or choke on 1-2 KB googlevideo URLs.

import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const MAX_TOKENS = 256;
const PASSTHROUGH_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

export class MediaServer {
  #tokens = new Map();
  #server = null;

  constructor(config, resolver, logger) {
    this.cfg = config;
    this.resolver = resolver;
    this.log = logger;
  }

  start() {
    return new Promise((resolve, reject) => {
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
   * @param {{videoId:string, transcode:boolean, ext:string}} entry
   */
  register(entry) {
    const token = randomBytes(16).toString('hex');
    this.#tokens.set(token, entry);
    while (this.#tokens.size > MAX_TOKENS) this.#tokens.delete(this.#tokens.keys().next().value);
    return `/stream/${token}.${entry.transcode ? 'mp3' : entry.ext}`;
  }

  async #handle(req, res) {
    const m = /^\/stream\/([0-9a-f]{32})\.\w+$/.exec(req.url ?? '');
    const entry = m && this.#tokens.get(m[1]);
    if (!entry || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404).end();
      return;
    }
    this.log.debug(`${req.method} ${req.url} range=${req.headers.range ?? '-'} from ${req.socket.remoteAddress}`);

    const info = await this.resolver.resolve(entry.videoId);
    if (entry.transcode) return this.#transcode(req, res, info);
    return this.#proxy(req, res, entry, info, true);
  }

  #dlnaHeaders(seekable) {
    return {
      'transferMode.dlna.org': 'Streaming',
      // OP=01: byte-range seeking supported. FLAGS: streaming transfer mode, DLNA 1.5.
      'contentFeatures.dlna.org': `DLNA.ORG_OP=${seekable ? '01' : '00'};DLNA.ORG_CI=${seekable ? 0 : 1};DLNA.ORG_FLAGS=01700000000000000000000000000000`,
      'Cache-Control': 'no-store',
    };
  }

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
        // Follow a redirect once (googlevideo occasionally redirects).
        if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location && retry) {
          upRes.resume();
          this.#proxy(req, res, entry, { ...info, url: upRes.headers.location }, false).then(resolve, reject);
          return;
        }

        const out = { 'Content-Type': info.mime, ...this.#dlnaHeaders(true) };
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

  #transcode(req, res, info) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', ...this.#dlnaHeaders(false) });
    if (req.method === 'HEAD') return res.end();

    const hdrs = Object.entries(info.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...(hdrs ? ['-headers', hdrs] : []),
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', info.url,
      '-vn', '-c:a', 'libmp3lame', '-b:a', this.cfg.mp3Bitrate, '-f', 'mp3', 'pipe:1',
    ];
    const ff = spawn(this.cfg.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    ff.stdout.pipe(res);
    ff.stderr.on('data', (d) => this.log.debug('ffmpeg:', d.toString().trim()));
    ff.on('error', (err) => { this.log.error('ffmpeg failed to start:', err.message); res.destroy(); });
    res.on('close', () => ff.kill('SIGKILL'));
  }
}
