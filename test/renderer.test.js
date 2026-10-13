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

function setup(fake, overrides = {}) {
  let receiverOpts;
  const registered = [];
  const config = {
    nameTemplate: '🔊 {name}', include: null, exclude: null, transcode: 'auto',
    advertiseIp: null, mediaPort: 8000, pollIntervalMs: 50, autoplayOnConnect: true,
    logLevel: 'none', dataDir: mkdtempSync(path.join(tmpdir(), 'upnptube-')), ...overrides,
  };
  const r = new Renderer({
    udn: 'fake-renderer', location: fake.location, address: '127.0.0.1', maxAge: 1800, port: 3000,
    deps: {
      config,
      logger: new Logger('none'),
      resolver: { resolve: async () => ({ url: 'https://example/v', ext: 'm4a', mime: 'audio/mp4',
        headers: {}, title: 'Song & Dance', artist: 'Band', album: '', thumbnail: 'https://i/x.jpg', duration: 210 }) },
      mediaServer: { register: (e) => { registered.push(e); return `/stream/${'a'.repeat(32)}.${e.transcode ? 'mp3' : e.ext}`; } },
      createReceiver: (_p, opts) => { receiverOpts = opts; return new FakeReceiver(); },
    },
  });
  return { r, registered, opts: () => receiverOpts };
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
  assert.match(set.body, /http:\/\/127\.0\.0\.1:8000\/stream\/a{32}\.m4a/);
  assert.match(set.body, /Song &amp;amp; Dance/);
  assert.ok(fake.calls.some((c) => c.action === 'Play'));
  assert.equal(registered[0].transcode, false);
  assert.equal(await r.doGetPosition(), 65);
  assert.equal(await r.doGetDuration(), 210);
  assert.deepEqual(await r.doGetVolume(), { level: 30, muted: false });
  await r.destroy();
});

test('auto-transcodes when renderer does not advertise the source type', async (t) => {
  const fake = await startFakeRenderer({ sink: 'http-get:*:audio/mpeg:*' });
  t.after(() => fake.server.close());
  const { r, registered } = setup(fake);
  await r.init();
  await r.doPlay({ id: 'dQw4w9WgXcQ' }, 0);
  assert.equal(registered[0].transcode, true);
  assert.match(fake.calls.find((c) => c.action === 'SetAVTransportURI').body, /audio\/mpeg/);
  await r.destroy();
});

test('exclude filter skips renderer', async (t) => {
  const fake = await startFakeRenderer();
  t.after(() => fake.server.close());
  const { r } = setup(fake, { exclude: /living/i });
  assert.equal(await r.init(), false);
});
