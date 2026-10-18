// Drives the Renderer against a fake UPnP device, with YouTube and yt-dlp stubbed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Renderer } from '../src/renderer.js';
import { Logger } from '../src/logger.js';
import { startFakeRenderer } from './fakeRenderer.js';

class FakeReceiver extends EventEmitter {
  status = 'stopped';
  async start() { this.status = 'running'; }
  async stop() { this.status = 'stopped'; }
  enableAutoplayOnConnect() {}
  getConnectedSenders() { return []; }
}

function setup(fake, overrides = {}, dataDir = mkdtempSync(path.join(tmpdir(), 'tube2upnp-')), extraDeps = {}) {
  let receiverOpts;
  const registered = [];
  const resolves = [];
  const config = {
    nameTemplate: '🔊 {name}', include: null, exclude: null, outputFormat: 'auto',
    advertiseIp: null, mediaPort: 8000, pollIntervalMs: 50, startTimeoutMs: 200, autoplayOnConnect: true,
    logLevel: 'none', dataDir, ...overrides,
  };
  const r = new Renderer({
    udn: 'fake-renderer', location: fake.location, address: '127.0.0.1', maxAge: 1800, port: 3000,
    deps: {
      config,
      logger: new Logger('none'),
      resolver: { resolve: async (id) => { resolves.push(id); return ({ url: 'https://example/v', ext: 'm4a', mime: 'audio/mp4',
        headers: {}, title: `Song & Dance – Pitypang ő ű ${id}`, artist: 'Band', album: '', thumbnail: 'https://i/x.jpg', duration: 210 }); } },
      mediaServer: {
        prepare: async () => {},
        register: (e) => {
          e.onRequest?.();
          registered.push(e);
          return `/stream/${String(registered.length).padStart(32, '0')}.${e.format === 'direct' ? e.ext : e.format}`;
        },
      },
      createReceiver: (_p, opts) => { receiverOpts = opts; return new FakeReceiver(); },
      ...extraDeps,
    },
  });
  return { r, registered, resolves, opts: () => receiverOpts };
}

test('init handles embedded renderer and names the receiver', async (t) => {
  const fake = await startFakeRenderer();
  t.after(() => fake.server.close());
  const { r, opts } = setup(fake);
  assert.equal(await r.init(), true);
  assert.equal(opts().device.name, '🔊 Living Room Speaker');
  assert.equal(opts().dial.port, 3000);
  await r.destroy();
});

test('doPlay loads short URL with DIDL metadata and plays', async (t) => {
  const fake = await startFakeRenderer();
  t.after(() => fake.server.close());
  const { r, registered } = setup(fake);
  await r.init();
  assert.equal(await r.doPlay({ id: 'dQw4w9WgXcQ' }, 0), true);
  const set = fake.calls.find((c) => c.action === 'SetAVTransportURI');
  assert.match(set.body, /http:\/\/127\.0\.0\.1:8000\/stream\/0{31}1\.m4a/);
  assert.match(set.body, /Song &amp;amp; Dance/);
  assert.ok(fake.calls.some((c) => c.action === 'Play'));
  assert.equal(registered[0].format, 'direct');
  assert.equal(await r.doGetPosition(), 65);
  assert.equal(await r.doGetDuration(), 210);
  assert.deepEqual(await r.doGetVolume(), { level: 30, muted: false });
  await r.destroy();
});

test('picks the first format the renderer advertises (lossless ADTS before MP3)', async (t) => {
  const fake = await startFakeRenderer({ sink: 'http-get:*:audio/vnd.dlna.adts:*' });
  t.after(() => fake.server.close());
  const { r, registered } = setup(fake);
  await r.init();
  await r.doPlay({ id: 'dQw4w9WgXcQ' }, 0);
  assert.equal(registered[0].format, 'adts');
  await r.destroy();
});

test('prefers lossless FLAC over MP3 when the renderer lists FLAC but no AAC', async (t) => {
  const fake = await startFakeRenderer({ sink: 'http-get:*:audio/mpeg:*,http-get:*:audio/x-flac:*' });
  t.after(() => fake.server.close());
  const { r, registered } = setup(fake);
  await r.init();
  await r.doPlay({ id: 'dQw4w9WgXcQ' }, 0);
  assert.equal(registered[0].format, 'flac');
  assert.match(fake.calls.find((c) => c.action === 'SetAVTransportURI').body, /audio\/flac:DLNA.ORG_OP=01/);
  await r.destroy();
});

test('FLAC: if the renderer rejects Seek, a new FLAC starting at the offset is sent', async (t) => {
  const fake = await startFakeRenderer({ bareFaultOn: ['Seek'] });
  t.after(() => fake.server.close());
  const { r, registered } = setup(fake, { outputFormat: 'flac' });
  await r.init();
  await r.doPlay({ id: 'dQw4w9WgXcQ' }, 0);
  assert.equal(await r.doSeek(50), true);
  assert.deepEqual(registered.map((e) => [e.format, e.startAt]), [['flac', 0], ['flac', 50]]);
  await r.destroy();
});

test('MP3 only when the renderer advertises nothing better', async (t) => {
  const fake = await startFakeRenderer({ sink: 'http-get:*:audio/mpeg:*' });
  t.after(() => fake.server.close());
  const { r, registered } = setup(fake);
  await r.init();
  await r.doPlay({ id: 'dQw4w9WgXcQ' }, 0);
  assert.equal(registered[0].format, 'mp3');
  assert.match(fake.calls.find((c) => c.action === 'SetAVTransportURI').body, /audio\/mpeg/);
  await r.destroy();
});

test('exclude filter skips renderer', async (t) => {
  const fake = await startFakeRenderer();
  t.after(() => fake.server.close());
  const { r } = setup(fake, { exclude: /living/i });
  assert.equal(await r.init(), false);
});

test('renderer errors without UPnP fault body do not crash, and UTF-8 bodies have byte-accurate length', async (t) => {
  const fake = await startFakeRenderer({ bareFaultOn: ['Pause'] });
  t.after(() => fake.server.close());
  const { r } = setup(fake);
  await r.init();
  assert.equal(await r.doPlay({ id: 'dQw4w9WgXcQ' }, 0), true);
  assert.equal(await r.doPause(), false); // reported as failure, process survives
  for (const c of fake.calls) assert.equal(c.contentLength, c.bytes, `${c.action} Content-Length`);
  await r.destroy();
});

test('walks the format chain when the renderer never starts, and remembers the winner', async (t) => {
  const fake = await startFakeRenderer({ neverPlay: true });
  t.after(() => fake.server.close());
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tube2upnp-'));
  const { r, registered } = setup(fake, {}, dataDir);
  await r.init();
  r.setLogger(new Logger('none'));
  // Renderer "starts working" once it gets an MP4 (non-fragmented) stream.
  const realPlay = fake.state;
  let lastUri = '';
  fake.server.prependListener('request', (req) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { if (/SetAVTransportURI/.test(req.headers.soapaction ?? '')) lastUri = b; });
  });
  const iv = setInterval(() => { if (/audio\/mp4:DLNA.ORG_PN/.test(lastUri)) realPlay.transport = 'PLAYING'; }, 20);
  t.after(() => clearInterval(iv));

  await r.play({ id: 'dQw4w9WgXcQ', client: { key: 'YT' } }, 0);
  await new Promise((res) => setTimeout(res, 900));
  assert.deepEqual(registered.map((e) => e.format), ['direct', 'mp4']);
  await r.destroy();

  // A fresh process starts straight with the remembered format.
  const again = setup(fake, {}, dataDir);
  await again.r.init();
  await again.r.doPlay({ id: 'dQw4w9WgXcQ' }, 0);
  assert.equal(again.registered[0].format, 'mp4');
  await again.r.destroy();
});

test('MP4: if the renderer rejects Seek, a new MP4 starting at the offset is sent', async (t) => {
  const fake = await startFakeRenderer({ bareFaultOn: ['Seek'] });
  t.after(() => fake.server.close());
  const { r, registered } = setup(fake, { outputFormat: 'mp4' });
  await r.init();
  await r.doPlay({ id: 'dQw4w9WgXcQ' }, 0);
  assert.equal(await r.doSeek(80), true);
  assert.deepEqual(registered.map((e) => [e.format, e.startAt]), [['mp4', 0], ['mp4', 80]]);
  assert.equal(await r.doGetPosition(), 80 + 65);
  await r.destroy();
});

test('seeking a non-seekable stream (mp3/adts) restarts it at the offset', async (t) => {
  const fake = await startFakeRenderer();
  t.after(() => fake.server.close());
  const { r, registered } = setup(fake, { outputFormat: 'mp3' });
  await r.init();
  await r.doPlay({ id: 'dQw4w9WgXcQ' }, 0);
  assert.equal(await r.doSeek(95.7), true);
  assert.equal(registered.length, 2);
  assert.equal(registered[1].format, 'mp3');
  assert.equal(registered[1].startAt, 95);
  assert.equal(await r.doGetPosition(), 95 + 65); // offset + renderer RelTime (fake reports 0:01:05)
  assert.equal(await r.doGetDuration(), 210);
  assert.ok(!fake.calls.some((c) => c.action === 'Seek'), 'no AVTransport Seek on a non-seekable stream');
  await r.destroy();
});

test('casting mid-video with a non-seekable format starts the stream at that position', async (t) => {
  const fake = await startFakeRenderer();
  t.after(() => fake.server.close());
  const { r, registered } = setup(fake, { outputFormat: 'adts' });
  await r.init();
  await r.doPlay({ id: 'dQw4w9WgXcQ' }, 36);
  assert.equal(registered[0].startAt, 36);
  assert.match(fake.calls.find((c) => c.action === 'SetAVTransportURI').body, /duration=&quot;0:02:54\.000&quot;/);
  await r.destroy();
});

const A = 'AAAAAAAAAAA';
const B = 'BBBBBBBBBBB';
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

test('gapless: next track is prepared, queued with SetNextAVTransportURI, and adopted without reloading', async (t) => {
  const fake = await startFakeRenderer();
  t.after(() => fake.server.close());
  const { r, registered } = setup(fake, { prefetch: true, gapless: true });
  await r.init();
  r.getUpcomingVideo = () => ({ id: B });
  assert.equal(await r.doPlay({ id: A }, 0), true);
  await wait(300);

  const setNext = fake.calls.find((c) => c.action === 'SetNextAVTransportURI');
  assert.ok(setNext, 'next track handed to renderer');
  assert.equal(registered[1].videoId, B);
  assert.match(fake.state.nextUri, new RegExp(`/stream/0{31}2\\.m4a$`));

  // Renderer finishes A and plays on into B by itself. What yt-cast-receiver does:
  r.next = async () => r.doPlay({ id: B }, 0);
  r.getUpcomingVideo = () => null;
  const loadsBefore = fake.calls.filter((c) => c.action === 'SetAVTransportURI').length;
  fake.advance();
  await wait(300);
  assert.equal(r.nowPlaying.videoId, B);
  assert.equal(fake.calls.filter((c) => c.action === 'SetAVTransportURI').length, loadsBefore, 'B was not reloaded');
  assert.equal(fake.state.transport, 'PLAYING');
  await r.destroy();
});

test('no gapless support: falls back cleanly and uses the prepared track at end of song', async (t) => {
  const fake = await startFakeRenderer({ noGapless: true });
  t.after(() => fake.server.close());
  const { r, resolves } = setup(fake, { prefetch: true, gapless: true });
  await r.init();
  r.getUpcomingVideo = () => ({ id: B });
  await r.doPlay({ id: A }, 0);
  await wait(300);
  assert.deepEqual(resolves, [A, B], 'B resolved ahead of time');

  // Song ends; renderer stops; YouTube asks for B.
  assert.equal(await r.doPlay({ id: B }, 0), true);
  assert.deepEqual(resolves, [A, B], 'B not resolved again - prepared item reused');
  assert.match(fake.state.currentUri, /0{31}2\.m4a$/);
  await r.destroy();
});

test('queue change replaces the prepared next track', async (t) => {
  const fake = await startFakeRenderer();
  t.after(() => fake.server.close());
  const { r } = setup(fake, { prefetch: true, gapless: true });
  await r.init();
  r.getUpcomingVideo = () => ({ id: B });
  await r.doPlay({ id: A }, 0);
  await wait(250);
  const C = 'CCCCCCCCCCC';
  r.getUpcomingVideo = () => ({ id: C });
  await wait(250);
  const nexts = fake.calls.filter((c) => c.action === 'SetNextAVTransportURI');
  assert.equal(nexts.length, 2);
  r.getUpcomingVideo = () => null; // end of queue, autoplay off: renderer's next slot cleared
  await wait(250);
  assert.equal(fake.state.nextUri, '');
  await r.destroy();
});

test('per-renderer format override wins over the global setting and is persisted', async (t) => {
  const fake = await startFakeRenderer();
  t.after(() => fake.server.close());
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tube2upnp-'));
  const { r, registered } = setup(fake, { outputFormat: 'mp4' }, dataDir);
  await r.init();
  await r.setFormatOverride('flac');
  await r.doPlay({ id: A }, 0);
  assert.equal(registered.at(-1).format, 'flac');
  assert.equal(r.statusInfo().format.mode, 'flac');
  await assert.rejects(r.setFormatOverride('ogg'), /Unknown format/);
  await r.destroy();

  const again = setup(fake, { outputFormat: 'mp4' }, dataDir);
  await again.r.init();
  assert.equal(again.r.statusInfo().format.override, 'flac', 'override survives restart');
  await again.r.setFormatOverride(null);
  await again.r.doPlay({ id: A }, 0);
  assert.equal(again.registered.at(-1).format, 'mp4', 'back to the global setting');
  await again.r.destroy();
});

test('SponsorBlock: seeks past a segment the renderer is inside', async (t) => {
  const fake = await startFakeRenderer(); // reports RelTime 0:01:05
  t.after(() => fake.server.close());
  const sponsorblock = { enabled: true, segments: async () => [{ start: 60, end: 90, category: 'music_offtopic' }] };
  const { r } = setup(fake, {}, undefined, { sponsorblock });
  await r.init();
  r.setLogger(new Logger('none'));
  await r.play({ id: A, client: { key: 'YT' } }, 0);
  await wait(400);
  const seek = fake.calls.find((c) => c.action === 'Seek');
  assert.ok(seek, 'seeked');
  assert.match(seek.body, /<Target>00:01:30<\/Target>/);
  assert.equal(r.statusInfo().sponsorblock.skipped, 1);
  const seeks = fake.calls.filter((c) => c.action === 'Seek').length;
  await wait(300);
  assert.equal(fake.calls.filter((c) => c.action === 'Seek').length, seeks, 'each segment skipped once');
  await r.destroy();
});

test('SponsorBlock: a segment running to the end skips to the next track', async (t) => {
  const fake = await startFakeRenderer();
  t.after(() => fake.server.close());
  const sponsorblock = { enabled: true, segments: async () => [{ start: 60, end: 210, category: 'outro' }] };
  const { r } = setup(fake, {}, undefined, { sponsorblock });
  await r.init();
  r.setLogger(new Logger('none'));
  let nexts = 0;
  r.next = async () => { nexts++; return true; };
  await r.play({ id: A, client: { key: 'YT' } }, 0);
  await wait(400);
  assert.equal(nexts, 1);
  assert.ok(!fake.calls.some((c) => c.action === 'Seek'));
  await r.destroy();
});

test('SponsorBlock off: no lookups, no seeks', async (t) => {
  const fake = await startFakeRenderer();
  t.after(() => fake.server.close());
  let lookups = 0;
  const sponsorblock = { enabled: false, segments: async () => { lookups++; return [{ start: 60, end: 90, category: 'x' }]; } };
  const { r } = setup(fake, {}, undefined, { sponsorblock });
  await r.init();
  r.setLogger(new Logger('none'));
  await r.play({ id: A, client: { key: 'YT' } }, 0);
  await wait(300);
  assert.equal(lookups, 0);
  assert.ok(!fake.calls.some((c) => c.action === 'Seek'));
  await r.destroy();
});

test('duration comes from the video, not a renderer still reporting the previous track', async (t) => {
  const fake = await startFakeRenderer();
  t.after(() => fake.server.close());
  const { r } = setup(fake); // resolver stub: duration 210 s (3:30)
  await r.init();
  await r.doPlay({ id: A }, 0);

  // Renderer briefly still reports the previous, longer track (4:58 at 2:40).
  Object.assign(fake.state, { trackDuration: '0:04:58', relTime: '0:02:40', reportedUri: 'http://192.168.0.85:8000/stream/' + 'f'.repeat(32) + '.m4a' });
  assert.equal(await r.doGetDuration(), 210, 'video length, not the stale 4:58');
  assert.equal(await r.doGetPosition(), 0, 'stale position ignored');

  // Once it reports our stream, its position is used again.
  Object.assign(fake.state, { reportedUri: undefined, relTime: '0:00:07' });
  assert.equal(await r.doGetPosition(), 7);
  await r.destroy();
});
