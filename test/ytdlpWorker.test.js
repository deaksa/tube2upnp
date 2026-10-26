import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YtdlpWorkers, pythonFor } from '../src/ytdlpWorker.js';
import { Resolver, downloadWithYtdlp } from '../src/resolver.js';

// The worker runs against a stand-in yt_dlp package (test/fakeYtdlp), so no network.
process.env.PYTHONPATH = fileURLToPath(new URL('./fakeYtdlp', import.meta.url));
process.env.PYTHONDONTWRITEBYTECODE = '1';
const hasPython = (() => {
  try { execFileSync('python3', ['--version']); return true; } catch { return false; }
})();
const skip = !hasPython || process.platform === 'win32';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const config = (extra = {}) => ({
  ytdlpPath: '/bin/false', ytdlpPython: 'python3', ytdlpWorkers: 2, ytdlpFormat: 'bestaudio',
  ytdlpJsRuntime: '', ytdlpExtraArgs: [], ytdlpTimeoutMs: 10000, ...extra,
});
const resolveMsg = (id) => ({ op: 'resolve', args: ['-f', 'bestaudio'], url: `https://www.youtube.com/watch?v=${id}` });

test('the Python next to YTDLP_PATH (a venv) runs the worker', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'venv-'));
  writeFileSync(path.join(dir, 'python3'), '');
  assert.equal(pythonFor({ ytdlpPath: path.join(dir, 'yt-dlp') }), path.join(dir, 'python3'));
  assert.equal(pythonFor({ ytdlpPath: 'yt-dlp' }), 'python3');
  assert.equal(pythonFor({ ytdlpPath: path.join(dir, 'yt-dlp'), ytdlpPython: '/x/python' }), '/x/python');
});

test('worker answers lookups and stays loaded; yt-dlp errors keep it alive', { skip }, async (t) => {
  const w = new YtdlpWorkers(config(), quiet);
  t.after(() => w.stop());
  assert.equal(await w.ready(), true);
  const a = JSON.parse(await w.run(resolveMsg('aaaaaaaaaaa'), 5000));
  assert.equal(a.title, 'Worker aaaaaaaaaaa');
  assert.deepEqual(a.args, ['-f', 'bestaudio']);
  await assert.rejects(w.run(resolveMsg('unavailable'), 5000), (err) => err.kind === 'ytdlp' && /Video unavailable/.test(err.message));
  await assert.rejects(w.run({ op: 'resolve', args: ['--bad-option'], url: 'x' }, 5000), { kind: 'ytdlp' });
  await assert.rejects(w.run(resolveMsg('ignoredxxxx'), 5000), (err) => err.kind === 'ytdlp' && /not available/.test(err.message));
  const b = JSON.parse(await w.run(resolveMsg('bbbbbbbbbbb'), 5000));
  assert.equal(b.pid, a.pid, 'same process');
});

test('a crashed or stuck worker is replaced', { skip }, async (t) => {
  const w = new YtdlpWorkers(config({ ytdlpWorkers: 1 }), quiet);
  t.after(() => w.stop());
  const first = JSON.parse(await w.run(resolveMsg('aaaaaaaaaaa'), 5000)).pid;
  await assert.rejects(w.run(resolveMsg('crashcrashx'), 5000), { kind: 'exit' });
  const second = JSON.parse(await w.run(resolveMsg('aaaaaaaaaaa'), 5000)).pid;
  assert.notEqual(second, first);
  await assert.rejects(w.run(resolveMsg('hanghanghan'), 300), { kind: 'timeout' });
  const third = JSON.parse(await w.run(resolveMsg('aaaaaaaaaaa'), 5000)).pid;
  assert.notEqual(third, second);
});

test('requests queue for a busy pool, and restart() loads fresh processes', { skip }, async (t) => {
  const w = new YtdlpWorkers(config({ ytdlpWorkers: 1 }), quiet);
  t.after(() => w.stop());
  const [a, b] = (await Promise.all([w.run(resolveMsg('aaaaaaaaaaa'), 5000), w.run(resolveMsg('bbbbbbbbbbb'), 5000)])).map(JSON.parse);
  assert.equal(a.pid, b.pid, 'one process, one request at a time');
  w.restart();
  const c = JSON.parse(await w.run(resolveMsg('ccccccccccc'), 5000));
  assert.notEqual(c.pid, a.pid);
});

test('without a usable Python, yt-dlp runs once per lookup', { skip: process.platform === 'win32' }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ytdlp-'));
  const fake = path.join(dir, 'yt-dlp');
  writeFileSync(fake, '#!/bin/sh\necho \'{"url":"https://r1.googlevideo.com/v","ext":"m4a","title":"CLI"}\'\n');
  chmodSync(fake, 0o755);
  const r = new Resolver(config({ ytdlpPath: fake, ytdlpPython: path.join(dir, 'no-python') }), quiet);
  t.after(() => r.workers.stop());
  assert.equal((await r.resolve('aaaaaaaaaaa')).title, 'CLI');
  assert.equal(await r.workers.ready(), false);
});

test('Resolver uses the worker, and the command line when the worker dies', { skip }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ytdlp-'));
  const fake = path.join(dir, 'yt-dlp');
  writeFileSync(fake, '#!/bin/sh\necho \'{"url":"https://r1.googlevideo.com/v","ext":"m4a","title":"CLI"}\'\n');
  chmodSync(fake, 0o755);
  const r = new Resolver(config({ ytdlpPath: fake }), quiet);
  t.after(() => r.workers.stop());
  const info = await r.resolve('aaaaaaaaaaa');
  assert.equal(info.title, 'Worker aaaaaaaaaaa');
  assert.equal(info.formatId, '140');
  assert.equal(JSON.parse(info.rawJson).id, 'aaaaaaaaaaa');
  assert.equal((await r.resolve('crashcrashx')).title, 'CLI', 'fell back');
  // yt-dlp's own answer isn't retried on the command line (which would say "CLI").
  await assert.rejects(r.resolve('unavailable'), /yt-dlp failed for unavailable: .*Video unavailable/);
});

test('downloads go through the worker and keep the 403 flag', { skip }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ytdlp-'));
  const w = new YtdlpWorkers(config(), quiet);
  t.after(() => w.stop());
  const info = (id) => Object.defineProperty({ formatId: '140' }, 'rawJson', { value: JSON.stringify({ id }) });
  const dest = path.join(dir, 'aaaaaaaaaaa.source');
  await downloadWithYtdlp(config(), quiet, 'aaaaaaaaaaa', info('aaaaaaaaaaa'), dest, w);
  assert.equal(readFileSync(dest, 'utf8'), 'audio of aaaaaaaaaaa as 140');
  assert.ok(!existsSync(`${dest}.info.json`), 'info JSON removed');
  await assert.rejects(
    downloadWithYtdlp(config(), quiet, 'forbiddenxx', info('forbiddenxx'), path.join(dir, 'f.source'), w),
    (err) => err.forbidden === true && /yt-dlp download failed for forbiddenxx: .*403/.test(err.message),
  );
});

test('preprocessed YouTube players are kept in memory, the last four', { skip }, () => {
  const out = execFileSync('python3', ['-c', `
import sys; sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('../src', import.meta.url)))})
import ytdlp_jsc
from yt_dlp.cache import Cache
from yt_dlp.extractor.youtube.jsc._builtin.ejs import EJSBaseJCP
print(ytdlp_jsc.install(log=lambda m: None), EJSBaseJCP._ENABLE_PREPROCESSED_PLAYER_CACHE)
c = Cache()
for p in 'abcde':
    c.store('challenge-solver', 'player:' + p, 'pre-' + p)
c.store('challenge-solver', 'lib', 'script')
print([c.load('challenge-solver', 'player:' + p) for p in 'abcde'], c.load('challenge-solver', 'lib'))
print(sorted(k for _, k in Cache.disk))
`], { encoding: 'utf8' });
  assert.deepEqual(out.trim().split('\n'), [
    'True True',
    "[None, 'pre-b', 'pre-c', 'pre-d', 'pre-e'] script",
    "['lib']", // players never reach the disk cache
  ]);
});

test('warm-up looks a video up once in every process of the pool', { skip }, async (t) => {
  const lines = [];
  const r = new Resolver(config(), { ...quiet, info: (...a) => lines.push(a.join(' ')) });
  t.after(() => r.workers.stop());
  await r.warmUp();
  assert.ok(lines.some((l) => /yt-dlp warmed up in \d+ ms \(2 processes\)/.test(l)), lines.join('\n'));
  const pids = (await r.workers.runOnAll(resolveMsg('aaaaaaaaaaa'), 5000)).map((x) => JSON.parse(x.value).pid);
  assert.equal(new Set(pids).size, 2, 'both processes stay loaded');
});
