// Real ffmpeg round-trips on a fragmented M4A (what YouTube serves). Skipped without ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaServer, parseRange } from '../src/mediaServer.js';
import { Logger } from '../src/logger.js';
import { stats } from '../src/stats.js';

let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

const probe = (file, entries) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file]).toString().trim();

let downloads = 0;
async function harness(t, cfg = {}, deps = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'remux-'));
  const src = path.join(dir, 'src.m4a');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
    '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', src]);
  const file = readFileSync(src);
  const up = http.createServer((req, res) => {
    if (req.url.includes('forbidden')) return res.writeHead(403).end();
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (m) {
      const a = +m[1]; const b = m[2] ? +m[2] : file.length - 1;
      res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${file.length}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' });
      return res.end(file.subarray(a, b + 1));
    }
    res.writeHead(200, { 'content-length': file.length, 'accept-ranges': 'bytes' }).end(file);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${up.address().port}`;
  const ms = new MediaServer(
    { mediaPort: 0, ffmpegPath: 'ffmpeg', mp3Bitrate: '128k', cacheDir: path.join(dir, 'cache'), cacheMb: 64, ...cfg },
    {
      resolve: async () => ({ url: `${base}/s.m4a`, headers: { 'User-Agent': 'test' } }),
      invalidate: () => {},
      ...deps.resolver?.(base),
    },
    new Logger('none'),
    {
      download: deps.download ?? (async (_id, info, dest) => {
        downloads++;
        writeFileSync(dest, Buffer.from(await (await fetch(info.url)).arrayBuffer()));
      }),
    });
  await ms.start();
  t.after(() => { ms.stop(); up.close(); });
  const get = async (entry, headers = {}) => {
    await ms.prepare(entry);
    const res = await fetch(`http://127.0.0.1:${ms.port}${ms.register(entry)}`, { headers });
    const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return { res, out };
  };
  return { get, downloads: () => downloads, ms, dir, src };
}

test('mp4: lossless remux to a non-fragmented, faststart MP4 with byte ranges', { skip: !hasFfmpeg }, async (t) => {
  const { get } = await harness(t);
  const { res, out } = await get({ videoId: 'aaaaaaaaaaa', format: 'mp4', ext: 'm4a' });
  assert.equal(res.headers.get('content-type'), 'audio/mp4');
  assert.ok(Number(res.headers.get('content-length')) > 0);
  assert.equal(probe(out, 'stream=codec_name'), 'aac');                        // not re-encoded
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 60) < 0.5);
  const bytes = readFileSync(out);
  assert.ok(bytes.indexOf('moov') < bytes.indexOf('mdat'), 'index (moov) before data: faststart');
  assert.equal(bytes.indexOf('moof'), -1, 'not fragmented');

  const ranged = await get({ videoId: 'aaaaaaaaaaa', format: 'mp4', ext: 'm4a' }, { Range: 'bytes=100-199' });
  assert.equal(ranged.res.status, 206);
  assert.equal(readFileSync(ranged.out).length, 100);
});

test('mp4 at offset (renderer cannot Seek) reuses the downloaded source', { skip: !hasFfmpeg }, async (t) => {
  const { get, downloads } = await harness(t);
  const before = downloads();
  await get({ videoId: 'bbbbbbbbbbb', format: 'mp4', ext: 'm4a' });
  const { out } = await get({ videoId: 'bbbbbbbbbbb', format: 'mp4', ext: 'm4a', startAt: 45 });
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 15) < 0.5);
  assert.equal(downloads() - before, 1, 'source downloaded once');
});

test('adts: lossless AAC stream, starts at offset', { skip: !hasFfmpeg }, async (t) => {
  const { get } = await harness(t);
  const { res, out } = await get({ videoId: 'ccccccccccc', format: 'adts', ext: 'm4a', startAt: 30 });
  assert.equal(res.headers.get('content-type'), 'audio/aac');
  assert.match(res.headers.get('contentfeatures.dlna.org'), /AAC_ADTS/);
  assert.equal(probe(out, 'stream=codec_name'), 'aac');
  assert.equal(probe(out, 'format=format_name'), 'aac');
  // ADTS has no index; ffprobe estimates duration from bitrate, so allow slack.
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 30) < 3);
});

for (const bits of [16, 24]) {
  test(`flac (${bits}-bit): lossless file with byte ranges and correct length`, { skip: !hasFfmpeg }, async (t) => {
    const { get } = await harness(t, { flacBits: bits });
    const { res, out } = await get({ videoId: `eeeeeeeee${bits}`, format: 'flac', ext: 'm4a' });
    assert.equal(res.headers.get('content-type'), 'audio/flac');
    assert.equal(Number(res.headers.get('content-length')), readFileSync(out).length);
    assert.match(res.headers.get('contentfeatures.dlna.org'), /DLNA.ORG_OP=01/);
    assert.equal(probe(out, 'stream=codec_name'), 'flac');
    assert.equal(probe(out, 'stream=bits_per_raw_sample'), String(bits));
    assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 60) < 0.5);
    assert.equal(readFileSync(out).subarray(0, 4).toString('latin1'), 'fLaC');

    const ranged = await get({ videoId: `eeeeeeeee${bits}`, format: 'flac', ext: 'm4a' }, { Range: 'bytes=0-3' });
    assert.equal(ranged.res.status, 206);
    assert.equal(readFileSync(ranged.out).toString('latin1'), 'fLaC');
  });
}

test('flac at offset (renderer cannot Seek)', { skip: !hasFfmpeg }, async (t) => {
  const { get } = await harness(t);
  const { out } = await get({ videoId: 'fffffffffff', format: 'flac', ext: 'm4a', startAt: 40 });
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 20) < 0.5);
});

test('mp3 transcode', { skip: !hasFfmpeg }, async (t) => {
  const { get } = await harness(t);
  const { res, out } = await get({ videoId: 'ddddddddddd', format: 'mp3', ext: 'm4a' });
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(probe(out, 'stream=codec_name'), 'mp3');
});

test('adts/mp3: a refused YouTube URL is retried with a fresh extraction', { skip: !hasFfmpeg }, async (t) => {
  let resolves = 0;
  const { get } = await harness(t, {}, {
    resolver: (base) => ({ resolve: async () => ({ url: `${base}/${resolves++ === 0 ? 'forbidden' : 's'}.m4a`, headers: {} }) }),
  });
  const { res, out } = await get({ videoId: 'iiiiiiiiiii', format: 'mp3', ext: 'm4a' });
  assert.equal(res.status, 200);
  assert.equal(probe(out, 'stream=codec_name'), 'mp3');
  assert.equal(resolves, 2);
});

test('adts/mp3: falls back to the yt-dlp download when YouTube keeps refusing ffmpeg', { skip: !hasFfmpeg }, async (t) => {
  let downloaded = 0;
  const { get, src } = await harness(t, {}, {
    resolver: (base) => ({ resolve: async () => ({ url: `${base}/forbidden.m4a`, headers: {} }) }),
    download: async (_id, _info, dest) => { downloaded++; writeFileSync(dest, readFileSync(src)); },
  });
  const { res, out } = await get({ videoId: 'jjjjjjjjjjj', format: 'adts', ext: 'm4a', startAt: 30 });
  assert.equal(res.status, 200);
  assert.equal(probe(out, 'stream=codec_name'), 'aac');
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 30) < 3);
  assert.equal(downloaded, 1);
});

test('adts/mp3: a stream that cannot be read at all is a 502, not an empty 200', { skip: !hasFfmpeg }, async (t) => {
  const { get } = await harness(t, { downloadRetryDelaysMs: [] }, {
    resolver: (base) => ({ resolve: async () => ({ url: `${base}/forbidden.m4a`, headers: {} }) }),
    download: async () => { throw new Error('download refused'); },
  });
  const { res } = await get({ videoId: 'kkkkkkkkkkk', format: 'mp3', ext: 'm4a' });
  assert.equal(res.status, 502);
});

test('a renderer that hangs up while the stream is being prepared leaves nothing running', { skip: !hasFfmpeg }, async (t) => {
  const { ms } = await harness(t, {}, {
    resolver: (base) => ({ resolve: async () => {
      await new Promise((r) => setTimeout(r, 400)); // slow yt-dlp lookup
      return { url: `${base}/s.m4a`, headers: {} };
    } }),
  });
  for (const format of ['mp3', 'direct']) {
    const path = ms.register({ videoId: 'lllllllllll', format, ext: 'm4a' });
    const ac = new AbortController();
    const req = fetch(`http://127.0.0.1:${ms.port}${path}`, { signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await req;
  }
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(stats.gauges['ffmpeg.active'] ?? 0, 0, 'no ffmpeg left behind');
  assert.equal(stats.gauges['http.active'] ?? 0, 0);
});

test('cache: a file larger than CACHE_MB is still served; older files are evicted first', { skip: !hasFfmpeg }, async (t) => {
  const { get, dir } = await harness(t, { cacheMb: 0 });
  const cached = () => readdirSync(path.join(dir, 'cache')).sort();
  const a = await get({ videoId: 'mmmmmmmmmmm', format: 'mp4', ext: 'm4a' });
  assert.equal(a.res.status, 200);
  assert.ok(probe(a.out, 'format=duration') > 59, 'complete file served');
  await new Promise((r) => setTimeout(r, 200)); // eviction runs in the background
  assert.deepEqual(cached(), ['mmmmmmmmmmm-mp4-0.m4a', 'mmmmmmmmmmm.source'], 'just built: kept');

  const b = await get({ videoId: 'nnnnnnnnnnn', format: 'flac', ext: 'm4a' });
  assert.equal(b.res.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(cached(), ['nnnnnnnnnnn-flac-0.flac', 'nnnnnnnnnnn.source'], 'older track evicted');
});

test('cache: a file that vanished after it was built is built again', { skip: !hasFfmpeg }, async (t) => {
  const { get, dir, downloads } = await harness(t);
  const entry = { videoId: 'ooooooooooo', format: 'mp4', ext: 'm4a' };
  await get(entry);
  const before = downloads();
  for (const f of readdirSync(path.join(dir, 'cache'))) rmSync(path.join(dir, 'cache', f)); // e.g. a tmp cleaner
  const again = await get(entry);
  assert.equal(again.res.status, 200);
  assert.ok(probe(again.out, 'format=duration') > 59);
  assert.equal(downloads() - before, 1, 'source downloaded again');
});

test('download retries with a fresh extraction after a 403', { skip: !hasFfmpeg }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'retry-'));
  let resolves = 0;
  let invalidations = 0;
  let attempts = 0;
  const ms = new MediaServer(
    { mediaPort: 0, ffmpegPath: 'ffmpeg', cacheDir: path.join(dir, 'cache'), downloadRetryDelaysMs: [10, 10] },
    { resolve: async () => ({ url: `u${++resolves}`, headers: {} }), invalidate: () => { invalidations++; } },
    new Logger('none'),
    {
      download: async (_id, _info, dest) => {
        if (++attempts < 3) {
          const e = new Error('yt-dlp download failed for x: ERROR: HTTP Error 403: Forbidden');
          e.forbidden = true;
          throw e;
        }
        writeFileSync(dest, 'audio');
      },
    });
  await ms.start();
  t.after(() => ms.stop());
  // The stub "audio" isn't real AAC, so the remux after the download fails - that's fine here.
  await ms.prepare({ videoId: 'ggggggggggg', format: 'mp4', ext: 'm4a' }).catch(() => {});
  assert.equal(attempts, 3);
  assert.equal(resolves, 3, 'each retry uses a fresh extraction');
  assert.equal(invalidations, 2);
});

test('download gives up after the configured retries', { skip: !hasFfmpeg }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'retry-'));
  let attempts = 0;
  const ms = new MediaServer(
    { mediaPort: 0, ffmpegPath: 'ffmpeg', cacheDir: path.join(dir, 'cache'), downloadRetryDelaysMs: [10] },
    { resolve: async () => ({ url: 'u', headers: {} }), invalidate: () => {} },
    new Logger('none'),
    { download: async () => { attempts++; throw new Error('nope'); } });
  await ms.start();
  t.after(() => ms.stop());
  await assert.rejects(ms.prepare({ videoId: 'hhhhhhhhhhh', format: 'mp4', ext: 'm4a' }), /nope/);
  assert.equal(attempts, 2);
});

test('cache survives a restart; half-written files are dropped; clear works', { skip: !hasFfmpeg }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'persist-'));
  const src = path.join(dir, 'src.m4a');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:a', 'aac', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', src]);
  let downloads = 0;
  const make = () => new MediaServer(
    { mediaPort: 0, ffmpegPath: 'ffmpeg', dataDir: dir },
    { resolve: async () => ({ url: 'x', headers: {} }), invalidate: () => {} },
    new Logger('none'),
    { download: async (_id, _info, dest) => { downloads++; writeFileSync(dest, readFileSync(src)); } });
  const entry = { videoId: 'iiiiiiiiiii', format: 'mp4', ext: 'm4a' };

  const first = make();
  await first.start();
  await first.prepare(entry);
  first.stop();
  assert.equal(downloads, 1);
  // Simulate a crash mid-download of another track.
  writeFileSync(path.join(dir, 'cache', 'jjjjjjjjjjj.source.download'), 'half');

  const second = make();
  await second.start();
  t.after(() => second.stop());
  await second.prepare(entry);
  assert.equal(downloads, 1, 'served from the cache kept on disk, not downloaded again');
  assert.throws(() => readFileSync(path.join(dir, 'cache', 'jjjjjjjjjjj.source.download')), /ENOENT/, 'partial file removed');
  assert.ok((await second.cacheInfo()).files >= 2);

  assert.ok(await second.clearCache() >= 2);
  assert.equal((await second.cacheInfo()).files, 0);
  await second.prepare(entry);
  assert.equal(downloads, 2, 'downloaded again after clearing');
});

test('clearing the cache keeps a file that is being played', { skip: !hasFfmpeg }, async (t) => {
  // Bigger than the socket buffers (loopback send buffers grow to MBs), so the server is
  // still sending when the cache is cleared.
  const big = path.join(mkdtempSync(path.join(tmpdir(), 'big-')), 'big.m4a');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=600',
    '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', big]);
  const { ms, dir } = await harness(t, {}, { download: async (_id, _info, dest) => writeFileSync(dest, readFileSync(big)) });
  const entry = { videoId: 'ppppppppppp', format: 'mp4', ext: 'm4a' };
  await ms.prepare(entry);
  // A renderer mid-track: connected, reading slowly (here: not at all).
  const req = http.get(`http://127.0.0.1:${ms.port}${ms.register(entry)}`);
  const res = await new Promise((r) => req.on('response', r));
  res.pause();
  t.after(() => req.destroy());
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await ms.clearCache(), 1, 'only the source is deleted');
  assert.deepEqual(readdirSync(path.join(dir, 'cache')), ['ppppppppppp-mp4-0.m4a']);
});

test('range parsing', () => {
  assert.deepEqual(parseRange('bytes=0-', 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=5-100', 10), { start: 5, end: 9 });
  assert.equal(parseRange('bytes=20-', 10), 'invalid');
  assert.equal(parseRange('items=1-2', 10), null);
});

test('covers: a YouTube thumbnail is served as a square 480x480 JPEG over HTTP', { skip: !hasFfmpeg }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'art-'));
  const webp = path.join(dir, 'thumb.webp');
  // 16:9 like maxresdefault, WebP like many YouTube thumbnails.
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720', '-frames:v', '1', webp]);
  const fetched = [];
  const ms = new MediaServer({ mediaPort: 0, ffmpegPath: 'ffmpeg', cacheDir: path.join(dir, 'cache') }, {}, new Logger('none'), {
    fetchImage: async (url) => {
      fetched.push(url);
      if (url.includes('broken')) throw new Error('HTTP 404');
      return readFileSync(webp);
    },
  });
  await ms.start();
  t.after(() => ms.stop());
  const base = `http://127.0.0.1:${ms.port}`;

  const thumb = 'https://i.ytimg.com/vi_webp/AAAAAAAAAAA/maxresdefault.webp';
  const p = ms.registerArt(thumb);
  assert.match(p, /^\/art\/[0-9a-f]{32}\.jpg$/);
  assert.equal(ms.registerArt(thumb), p, 'same cover, same path');
  const res = await fetch(base + p);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('contentfeatures.dlna.org'), /DLNA\.ORG_PN=JPEG_SM/);
  const out = path.join(dir, 'cover.jpg');
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  assert.equal(probe(out, 'stream=codec_name,width,height'), 'mjpeg,480,480');
  assert.deepEqual(fetched, [thumb], 'fetched and converted once');

  assert.equal(ms.registerArt('http://i.ytimg.com/vi/x/hq.jpg'), null, 'not HTTPS');
  assert.equal(ms.registerArt('https://example.com/x.jpg'), null, 'not a YouTube image host');
  assert.equal(ms.registerArt('https://ytimg.com.evil.example/x.jpg'), null);

  const broken = 'https://i.ytimg.com/vi/broken/hq.jpg';
  const fallback = await fetch(base + ms.registerArt(broken), { redirect: 'manual' });
  assert.equal(fallback.status, 302, 'conversion failed: the renderer gets the original');
  assert.equal(fallback.headers.get('location'), broken);
  assert.equal((await fetch(`${base}/art/${'0'.repeat(32)}.jpg`)).status, 404);
});
