// DeviceManager: remembered speakers, fixed ports, online/offline checks, remove/ignore.
// Renderers and the reachability probe are stubbed, so every transition is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeviceManager } from '../src/devices.js';
import { Logger } from '../src/logger.js';

const loc = (udn) => `http://10.0.0.${udn.length}/${udn}.xml`;

function make({ dataDir = mkdtempSync(path.join(tmpdir(), 'dev-')), init = () => true, ...cfg } = {}) {
  const started = [];   // [udn, port] per successful init
  const destroyed = [];
  const removedData = [];
  const reachable = new Set();
  let clock = 1_000_000;
  const live = new Map(); // udn -> stub renderer
  const m = new DeviceManager({ dataDir, receiverBasePort: 3000, deviceOfflineAfter: 3, ...cfg }, {
    logger: new Logger('none'),
    now: () => clock,
    probe: async (location) => reachable.has(location),
    removeData: async (udn) => { removedData.push(udn); },
    createRenderer: (p) => {
      const r = {
        ...p, name: `🔊 ${p.udn}`,
        description: { friendlyName: p.udn, manufacturer: 'Acme', modelName: 'Box', presentationURL: `http://${p.udn}.lan/` },
        icon: { type: 'image/png', data: Buffer.from(p.udn) },
        status: 0, refreshes: 0,
        async init() {
          const ok = await init(p);
          if (ok) { started.push([p.udn, p.port]); live.set(p.udn, r); }
          return ok;
        },
        async destroy() { destroyed.push(p.udn); live.delete(p.udn); },
        refresh() {},
        async refreshStatus() { r.refreshes++; },
        statusInfo: () => ({ id: p.udn, name: r.name, volume: { level: 40, raw: 40, min: 0, max: 100, muted: false } }),
      };
      return r;
    },
  });
  const seen = (udn, location = loc(udn)) => {
    reachable.add(location);
    return m.seen({ udn, location, address: '10.0.0.9', maxAge: 1800 });
  };
  const state = (udn) => m.list().find((d) => d.id === udn)?.state;
  return { m, dataDir, started, destroyed, removedData, reachable, live, seen, state, tick: (ms) => { clock += ms; } };
}

test('a found speaker gets a port, is remembered, and keeps the port after a restart', async () => {
  const a = make();
  await a.m.load();
  await a.seen('kitchen');
  await a.seen('lamp');
  assert.deepEqual(a.started, [['kitchen', 3000], ['lamp', 3001]]);
  const saved = JSON.parse(readFileSync(path.join(a.dataDir, 'devices.json'), 'utf8'));
  assert.deepEqual(Object.fromEntries(Object.entries(saved.devices).map(([k, v]) => [k, v.port])), { kitchen: 3000, lamp: 3001 });

  // Restart: discovered the other way round, the ports stay.
  const b = make({ dataDir: a.dataDir });
  await b.m.load();
  assert.deepEqual(b.m.list().map((d) => [d.id, d.state, d.dialPort]), [['kitchen', 'offline', 3000], ['lamp', 'offline', 3001]]);
  await b.seen('lamp');
  await b.seen('kitchen');
  assert.deepEqual(b.started, [['lamp', 3001], ['kitchen', 3000]]);
});

test('known speakers come up from the direct check alone, without SSDP', async () => {
  const a = make();
  await a.m.load();
  await a.seen('kitchen');
  const b = make({ dataDir: a.dataDir });
  await b.m.load();
  b.reachable.add(loc('kitchen'));
  await b.m.checkAll();
  assert.deepEqual(b.started, [['kitchen', 3000]]);
  assert.equal(b.state('kitchen'), 'online');
});

test('a speaker that stops answering goes offline after N checks; its port is kept for it', async () => {
  const d = make();
  await d.m.load();
  await d.seen('kitchen');
  d.reachable.delete(loc('kitchen'));
  await d.m.checkAll();
  await d.m.checkAll();
  assert.equal(d.state('kitchen'), 'online', 'two misses are not enough');
  await d.m.checkAll();
  assert.equal(d.state('kitchen'), 'offline');
  assert.deepEqual(d.destroyed, ['kitchen'], 'receiver stopped: it leaves the cast menu');
  assert.equal(d.m.renderers.size, 0);
  assert.equal(d.m.list()[0].volume.level, 40, 'last known volume is still shown');

  await d.seen('newcomer');
  assert.deepEqual(d.started.at(-1), ['newcomer', 3001], "a new speaker doesn't take the offline one's port");

  d.reachable.add(loc('kitchen'));
  await d.m.checkAll();
  assert.equal(d.state('kitchen'), 'online');
  assert.deepEqual(d.started.at(-1), ['kitchen', 3000], 'back on the same port');
});

test('during playback a speaker gets twice as long before it is taken offline', async () => {
  const d = make();
  await d.m.load();
  await d.seen('kitchen');
  d.live.get('kitchen').status = 1; // PLAYING
  d.reachable.delete(loc('kitchen'));
  for (let i = 0; i < 5; i++) await d.m.checkAll();
  assert.equal(d.state('kitchen'), 'online');
  await d.m.checkAll();
  assert.equal(d.state('kitchen'), 'offline');
});

test('an answering speaker is checked quietly and its status refreshed', async () => {
  const d = make();
  await d.m.load();
  await d.seen('kitchen');
  await d.m.checkAll();
  await d.m.checkAll();
  assert.equal(d.live.get('kitchen').refreshes, 2);
  assert.equal(d.started.length, 1, 'not restarted');
});

test('SSDP byebye takes a speaker offline at once; an alive brings it back', async () => {
  const d = make();
  await d.m.load();
  await d.seen('kitchen');
  await d.m.gone('kitchen');
  assert.equal(d.state('kitchen'), 'offline');
  await d.seen('kitchen');
  assert.equal(d.state('kitchen'), 'online');
  assert.deepEqual(d.started, [['kitchen', 3000], ['kitchen', 3000]]);
});

test('a new description URL restarts the receiver on the same port', async () => {
  const d = make();
  await d.m.load();
  await d.seen('kitchen');
  await d.seen('kitchen', 'http://10.0.0.7:49152/desc.xml');
  assert.deepEqual(d.started, [['kitchen', 3000], ['kitchen', 3000]]);
  assert.deepEqual(d.destroyed, ['kitchen']);
});

test('filtered speakers (init() false) are not listed, remembered or given a port', async () => {
  const d = make({ init: (p) => p.udn !== 'tv' });
  await d.m.load();
  await d.seen('tv');
  await d.seen('tv'); // skipped from now on, init not retried
  await d.seen('lamp');
  assert.deepEqual(d.m.list().map((x) => x.id), ['lamp']);
  assert.deepEqual(d.started, [['lamp', 3000]]);
});

test('a known speaker whose receiver fails shows an error, keeps its port and is retried later', async () => {
  let fail = false;
  const d = make({ init: () => !fail || Promise.reject(new Error('DIAL port 3000 in use')), retryFailedMs: 60_000 });
  await d.m.load();
  await d.seen('kitchen');
  await d.m.gone('kitchen');
  fail = true;
  await d.seen('kitchen');
  const row = d.m.list()[0];
  assert.equal(row.state, 'error');
  assert.match(row.error, /in use/);
  assert.equal(row.dialPort, 3000);

  fail = false;
  await d.m.checkAll();
  assert.equal(d.state('kitchen'), 'error', 'not before the retry time');
  d.tick(61_000);
  await d.m.checkAll();
  assert.equal(d.state('kitchen'), 'online');
});

test('a new speaker that fails to start is not listed and holds no port', async () => {
  const d = make({ init: (p) => (p.udn === 'bad' ? Promise.reject(new Error('boom')) : true) });
  await d.m.load();
  await d.seen('bad');
  await d.seen('lamp');
  assert.deepEqual(d.m.list().map((x) => [x.id, x.dialPort]), [['lamp', 3000]]);
});

test('a terminated receiver is restarted by a later check', async () => {
  const d = make();
  await d.m.load();
  await d.seen('kitchen');
  d.live.get('kitchen').onTerminate(new Error('lounge session lost'));
  await d.m.list(); // let the queued stop run
  await new Promise((r) => setImmediate(r));
  assert.equal(d.state('kitchen'), 'error');
  d.tick(31_000);
  await d.m.checkAll();
  assert.equal(d.state('kitchen'), 'online');
  assert.deepEqual(d.started, [['kitchen', 3000], ['kitchen', 3000]]);
});

test('remove: only offline speakers; frees the port and deletes the stored data', async () => {
  const d = make();
  await d.m.load();
  await d.seen('kitchen');
  await d.seen('lamp');
  await assert.rejects(d.m.remove('kitchen'), (e) => e.status === 409);
  await d.m.gone('kitchen');
  await d.m.remove('kitchen');
  assert.deepEqual(d.m.list().map((x) => x.id), ['lamp']);
  assert.deepEqual(d.removedData, ['kitchen']);
  await d.seen('newcomer');
  assert.deepEqual(d.started.at(-1), ['newcomer', 3000], 'the freed port is handed out again');
  await assert.rejects(d.m.remove('nope'), (e) => e.status === 404);

  const again = make({ dataDir: d.dataDir });
  await again.m.load();
  assert.deepEqual(again.m.list().map((x) => x.id).sort(), ['lamp', 'newcomer'], 'removal persisted');
});

test('ignore: stops it, frees the port, survives restarts; allowing it again sets it up as new', async () => {
  const d = make();
  await d.m.load();
  await d.seen('tv');
  await d.m.ignore('tv');
  assert.deepEqual(d.destroyed, ['tv']);
  assert.deepEqual(d.removedData, ['tv']);
  assert.deepEqual(d.m.list().map((x) => [x.id, x.state, x.dialPort]), [['tv', 'ignored', null]]);
  await d.seen('tv');
  assert.equal(d.started.length, 1, 'ignored: not set up again');

  const after = make({ dataDir: d.dataDir });
  await after.m.load();
  await after.seen('tv');
  assert.equal(after.started.length, 0, 'still ignored after a restart');
  await after.seen('lamp');
  assert.deepEqual(after.started, [['lamp', 3000]], 'the ignored one holds no port');
  await after.m.unignore('tv');
  await after.seen('tv');
  assert.deepEqual(after.started.at(-1), ['tv', 3001]);
});

test('devices.json of the wrong shape or with bad entries is ignored', async () => {
  for (const content of ['null', '[]', '{"devices":null}', '{nope',
    '{"devices":{"a":{"port":"3000","location":"x"},"b":{"port":3005},"c":{"port":3002,"location":"http://c"}}}']) {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'dev-'));
    writeFileSync(path.join(dataDir, 'devices.json'), content);
    const d = make({ dataDir });
    await d.m.load();
    assert.deepEqual(d.m.list().map((x) => x.id), content.includes('"c"') ? ['c'] : [], content);
  }
});

test('concurrent discovery and checks start a speaker once', async () => {
  const d = make();
  await d.m.load();
  await d.seen('kitchen');
  await d.m.gone('kitchen');
  await Promise.all([d.seen('kitchen'), d.m.checkAll(), d.seen('kitchen')]);
  assert.deepEqual(d.started, [['kitchen', 3000], ['kitchen', 3000]]);
});

test('online time, dropouts and check round trip are tracked; icon and device page stay while offline', async () => {
  const d = make();
  await d.m.load();
  await d.seen('kitchen');
  await d.m.checkAll();
  let row = d.m.list()[0];
  assert.equal(row.onlineForS, 0);
  assert.equal(row.dropouts, 0);
  assert.equal(typeof row.checkMs, 'number');
  d.tick(90_000);
  assert.equal(d.m.list()[0].onlineForS, 90);

  d.reachable.delete(loc('kitchen'));
  for (let i = 0; i < 3; i++) await d.m.checkAll();
  row = d.m.list()[0];
  assert.equal(row.state, 'offline');
  assert.equal(row.onlineForS, null);
  assert.equal(row.dropouts, 1);
  assert.equal(row.presentationURL, 'http://kitchen.lan/');
  assert.equal(row.icon, true);
  assert.equal(d.m.icon('kitchen').data.toString(), 'kitchen');
  assert.equal(d.m.icon('nope'), null);

  const again = make({ dataDir: d.dataDir });
  await again.m.load();
  assert.equal(again.m.list()[0].presentationURL, 'http://kitchen.lan/', 'device page remembered across restarts');
});
