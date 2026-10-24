import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { startStatusServer, hostOk } from '../src/statusServer.js';
import { Logger, recentLogs } from '../src/logger.js';
import { Settings } from '../src/settings.js';
import { History } from '../src/history.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function fakeRenderer() {
  const calls = [];
  return {
    calls,
    statusInfo: () => ({ id: 'r1', name: 'R1', format: { override: null } }),
    setFormatOverride: async (f) => { calls.push(['format', f]); },
    forgetLearnedFormat: async () => { calls.push(['forget']); },
    getPairingCode: async () => '123456789012',
    control: async (action, value) => {
      if (!['pause', 'resume', 'next', 'previous', 'seek', 'volume'].includes(action)) {
        throw Object.assign(new Error(`Unknown action "${action}"`), { status: 400 });
      }
      calls.push(['control', action, value]);
      return true;
    },
  };
}

/** Stands in for DeviceManager: one running speaker (r1) and one offline (r2). */
function fakeDevices(r) {
  return {
    renderers: new Map([['r1', r]]),
    list: () => [{ ...r.statusInfo(), state: 'online' }, { id: 'r2', name: 'R2', state: 'offline' }],
    remove: async (id) => {
      if (id === 'r1') throw Object.assign(new Error('online'), { status: 409 });
      r.calls.push(['remove', id]);
    },
    ignore: async (id) => { r.calls.push(['ignore', id]); },
    unignore: async (id) => { r.calls.push(['unignore', id]); },
    icon: (id) => (id === 'r1' ? { type: 'image/png', data: Buffer.from('89504e47', 'hex') } : null),
    art: (id) => (id === 'r1' ? { type: 'image/jpeg', data: Buffer.from('ffd8ffe0', 'hex') } : null),
  };
}

async function start(t, cfg = {}) {
  const r = fakeRenderer();
  const conf = { statusPort: 0, outputFormat: 'mp4', dataDir: mkdtempSync(path.join(tmpdir(), 'st-')),
    sponsorblock: false, sponsorblockCategories: ['sponsor'], ...cfg };
  const settings = await new Settings(conf, new Logger('none')).load();
  const history = cfg.history === false ? null : await new History(conf, new Logger('none')).load();
  const server = startStatusServer(conf,
    { devices: fakeDevices(r), settings, history, rediscover: () => r.calls.push(['rediscover']),
      mediaServer: { cacheInfo: async () => ({ files: 0, bytes: 0, limitBytes: 1 }) } },
    new Logger('none'));
  await new Promise((res) => server.once('listening', res));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, r, settings, history };
}

const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('serves the page with a strict CSP and the status API', async (t) => {
  const { base } = await start(t);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await page.text(), /Stats for nerds/);
  const s = await (await fetch(base + '/api/status')).json();
  assert.equal(s.renderers[0].id, 'r1');
  const st = await (await fetch(base + '/api/stats')).json();
  assert.ok('timers' in st && 'cache' in st);
});

test('format changes require the CSRF header and same origin', async (t) => {
  const { base, r } = await start(t);
  assert.equal((await post(base + '/api/renderers/r1/format', { format: 'flac' })).status, 403);
  assert.equal((await post(base + '/api/renderers/r1/format', { format: 'flac' },
    { 'X-Tube2upnp': '1', Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(base + '/api/renderers/r1/format', { format: 'flac' }, { 'X-Tube2upnp': '1' })).status, 200);
  assert.equal((await post(base + '/api/renderers/r1/format', { format: null }, { 'X-Tube2upnp': '1' })).status, 200);
  assert.equal((await post(base + '/api/renderers/r1/forget-format', {}, { 'X-Tube2upnp': '1' })).status, 200);
  assert.deepEqual(r.calls, [['format', 'flac'], ['format', null], ['forget']]);
  assert.equal((await post(base + '/api/renderers/nope/format', {}, { 'X-Tube2upnp': '1' })).status, 404);
});

test('STATUS_TOKEN protects the API (header or query), not the page or health check', async (t) => {
  const { base } = await start(t, { statusToken: 's3cret' });
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal((await fetch(base + '/api/status', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(base + '/api/status', { headers: { Authorization: 'Bearer s3cret' } })).status, 200);
  assert.equal((await fetch(base + '/api/logs?token=s3cret')).status, 200);
});

test('logs: ring buffer and live stream', async (t) => {
  const { base } = await start(t);
  const log = new Logger('info', '[test]');
  log.info('hello', { a: 1 });
  log.debug('hidden at info level');
  const last = recentLogs().at(-1);
  assert.equal(last.text, 'hello { a: 1 }');
  assert.equal(last.prefix, '[test]');

  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/logs/stream?after=${last.id}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  setTimeout(() => log.warn('live line'), 50);
  let buf = '';
  while (!buf.includes('live line')) buf += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  assert.match(buf, /"level":"warn"/);
  assert.doesNotMatch(buf, /hello/, 'only lines after the given id');
});

test('SponsorBlock settings: read, change (validated, CSRF-protected), reset', async (t) => {
  const { base, settings } = await start(t);
  const get = async () => (await (await fetch(base + '/api/settings')).json()).sponsorblock;
  assert.equal((await get()).enabled, false);
  assert.equal((await post(base + '/api/settings/sponsorblock', { enabled: true })).status, 403);
  assert.equal((await post(base + '/api/settings/sponsorblock', { enabled: 'yes' }, { 'X-Tube2upnp': '1' })).status, 400);
  assert.equal((await post(base + '/api/settings/sponsorblock', { categories: ['bogus'] }, { 'X-Tube2upnp': '1' })).status, 400);
  assert.equal((await post(base + '/api/settings/sponsorblock', { enabled: true, categories: ['music_offtopic'] }, { 'X-Tube2upnp': '1' })).status, 200);
  assert.deepEqual(settings.sponsorblock, { enabled: true, categories: ['music_offtopic'], fromEnv: false });
  assert.equal((await post(base + '/api/settings/sponsorblock/reset', {}, { 'X-Tube2upnp': '1' })).status, 200);
  assert.equal((await get()).enabled, false);
});

test('history: list, most played, CSV download, clear (CSRF-protected)', async (t) => {
  const { base, history } = await start(t);
  const song = { title: 'Dal', artist: 'Előadó' };
  history.record({ videoId: 'AAAAAAAAAAA', udn: 'r1', speakerName: 'R1', info: song, senders: ['Anna'], at: 1000 });
  history.record({ videoId: 'AAAAAAAAAAA', udn: 'r2', speakerName: 'R2', info: song, at: 2000 });

  const list = await (await fetch(base + '/api/history?speaker=r1')).json();
  assert.deepEqual(list.plays.map((p) => [p.videoId, p.speakerName, p.senders]), [['AAAAAAAAAAA', 'R1', ['Anna']]]);
  const top = await (await fetch(base + '/api/history/top')).json();
  assert.equal(top.tracks[0].plays, 2);
  assert.deepEqual(top.speakers.map((s) => s.id), ['r1', 'r2']);

  const csv = await fetch(base + '/api/history.csv');
  assert.match(csv.headers.get('content-type'), /^text\/csv; charset=utf-8/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="tube2upnp-history-/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  assert.match(bytes.toString('utf8'), /Előadó/);

  assert.equal((await post(base + '/api/history/clear', {})).status, 403);
  assert.equal((await post(base + '/api/history/clear', {}, { 'X-Tube2upnp': '1' })).status, 200);
  assert.deepEqual(history.top(), []);
});

test('history endpoints answer 404 when HISTORY=false', async (t) => {
  const { base } = await start(t, { history: false });
  const res = await fetch(base + '/api/history');
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /HISTORY=false/);
  assert.equal((await fetch(base + '/api/history.csv')).status, 404);
});

// fetch() can't set Host, so use http.request.
const withHost = (base, pathname, host, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request(base + pathname, { method, headers: { Host: host, 'X-Tube2upnp': '1' } }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.end();
});

test('DNS rebinding: unknown host names are refused, IPs and known names work', async (t) => {
  const { base, history } = await start(t);
  history.record({ videoId: 'aaaaaaaaaaa', info: { title: 'Secret' }, udn: 'r1' });
  // A page on evil.example re-pointed its domain at us: Host and Origin both say evil.example.
  assert.equal(await withHost(base, '/api/history', 'evil.example:8080'), 403);
  assert.equal(await withHost(base, '/api/history/clear', 'evil.example', 'POST'), 403);
  assert.equal(await withHost(base, '/', 'evil.example'), 403);
  assert.equal(history.recent().length, 1, 'nothing cleared');

  for (const host of ['192.168.1.20:8080', '[::1]:8080', 'localhost:8080', 'LOCALHOST.',
    os.hostname(), `${os.hostname()}.local:8080`]) {
    assert.equal(await withHost(base, '/api/status', host), 200, host);
  }
});

test('STATUS_HOSTS adds names; "*" allows any', async (t) => {
  const { base } = await start(t, { statusHosts: ['Tube.Home.lan'] });
  assert.equal(await withHost(base, '/api/status', 'tube.home.lan:8080'), 200);
  assert.equal(await withHost(base, '/api/status', 'other.home.lan'), 403);
  const any = await start(t, { statusHosts: ['*'] });
  assert.equal(await withHost(any.base, '/api/status', 'whatever.example'), 200);
});

test('host check edge cases', () => {
  const allowed = new Set(['nas']);
  assert.equal(hostOk(undefined, allowed), true, 'HTTP/1.0 without Host');
  assert.equal(hostOk('10.0.0.5', allowed), true);
  assert.equal(hostOk('nas:8080', allowed), true);
  assert.equal(hostOk('nas.evil.example', allowed), false);
  assert.equal(hostOk('10.0.0.5.evil.example', allowed), false);
  assert.equal(hostOk('bad host', allowed), false);
});

test('speakers: offline ones are listed; remove, ignore and allow again (CSRF-protected)', async (t) => {
  const { base, r } = await start(t);
  const s = await (await fetch(base + '/api/status')).json();
  assert.deepEqual(s.renderers.map((x) => [x.id, x.state]), [['r1', 'online'], ['r2', 'offline']]);

  assert.equal((await post(base + '/api/renderers/r2/remove', {})).status, 403, 'needs the CSRF header');
  const csrf = { 'X-Tube2upnp': '1' };
  assert.equal((await post(base + '/api/renderers/r2/remove', {}, csrf)).status, 200);
  assert.equal((await post(base + '/api/renderers/r1/remove', {}, csrf)).status, 409, 'online: use ignore');
  assert.equal((await post(base + '/api/renderers/r1/ignore', {}, csrf)).status, 200);
  assert.equal((await post(base + '/api/renderers/r1/unignore', {}, csrf)).status, 200);
  assert.equal((await post(base + '/api/renderers/%E0%A4%A/remove', {}, csrf)).status, 400, 'malformed id');
  assert.deepEqual(r.calls, [['remove', 'r2'], ['ignore', 'r1'], ['unignore', 'r1'], ['rediscover']]);
});

test('speaker icons are served by us, as images only, behind the token', async (t) => {
  const { base } = await start(t, { statusToken: 's3cret' });
  const res = await fetch(base + '/api/renderers/r1/icon?token=s3cret');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from('89504e47', 'hex'));
  assert.equal((await fetch(base + '/api/renderers/r2/icon?token=s3cret')).status, 404);
  assert.equal((await fetch(base + '/api/renderers/r1/icon')).status, 401);

  const art = await fetch(base + '/api/renderers/r1/art?v=3&token=s3cret');
  assert.equal(art.headers.get('content-type'), 'image/jpeg');
  assert.match(art.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await fetch(base + '/api/renderers/r2/art?token=s3cret')).status, 404);
  assert.equal((await fetch(base + '/api/renderers/r1/art')).status, 401);
});

test('playback controls go to the renderer, behind the CSRF check', async (t) => {
  const { base, r } = await start(t);
  const csrf = { 'X-Tube2upnp': '1' };
  assert.equal((await post(base + '/api/renderers/r1/control', { action: 'pause' })).status, 403, 'no CSRF header');
  const res = await post(base + '/api/renderers/r1/control', { action: 'volume', value: 40 }, csrf);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal((await post(base + '/api/renderers/r1/control', { action: 'nope' }, csrf)).status, 400);
  assert.equal((await post(base + '/api/renderers/r1/control', null, csrf)).status, 400, 'no body: no action');
  assert.equal((await post(base + '/api/renderers/r2/control', { action: 'next' }, csrf)).status, 404, 'offline');
  assert.deepEqual(r.calls.filter((c) => c[0] === 'control'), [['control', 'volume', 40]]);
});
