import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStatusServer } from '../src/statusServer.js';
import { Logger, recentLogs } from '../src/logger.js';
import { Settings } from '../src/settings.js';
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
  };
}

async function start(t, cfg = {}) {
  const r = fakeRenderer();
  const conf = { statusPort: 0, outputFormat: 'mp4', dataDir: mkdtempSync(path.join(tmpdir(), 'st-')),
    sponsorblock: false, sponsorblockCategories: ['sponsor'], ...cfg };
  const settings = await new Settings(conf, new Logger('none')).load();
  const server = startStatusServer(conf,
    { renderers: new Map([['r1', r]]), settings, mediaServer: { cacheInfo: async () => ({ files: 0, bytes: 0, limitBytes: 1 }) } },
    new Logger('none'));
  await new Promise((res) => server.once('listening', res));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, r, settings };
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
