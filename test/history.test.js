import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { History } from '../src/history.js';
import { Logger } from '../src/logger.js';

const A = 'AAAAAAAAAAA';
const B = 'BBBBBBBBBBB';
const make = (cfg = {}) => new History({ dataDir: mkdtempSync(path.join(tmpdir(), 'hist-')), ...cfg }, new Logger('none'));
const play = (h, videoId, udn, at, extra = {}) => h.record({
  videoId, udn, speakerName: udn === 'k' ? 'Kitchen' : 'Living Room', at,
  info: { title: `Song ${videoId[0]}`, artist: 'Band', thumbnail: 'https://i/x.jpg' }, senders: ['Anna'], format: 'mp4', playedS: 31, ...extra,
});

test('counts plays per track and per speaker, newest plays first', async () => {
  const h = await make().load();
  play(h, A, 'l', 1000);
  play(h, B, 'k', 2000);
  play(h, A, 'k', 3000);
  assert.deepEqual(h.top().map((t) => [t.videoId, t.plays]), [[A, 2], [B, 1]]);
  assert.deepEqual(h.top({ speaker: 'l' }).map((t) => [t.videoId, t.plays]), [[A, 1]]);
  assert.deepEqual(h.recent().map((e) => e.at), [3000, 2000, 1000]);
  assert.deepEqual(h.recent({ speaker: 'k', before: 3000 }).map((e) => [e.videoId, e.speakerName, e.title]), [[B, 'Kitchen', 'Song B']]);
  assert.deepEqual(h.recent({ limit: 1 })[0].senders, ['Anna']);
  assert.deepEqual(h.speakers().map((s) => s.name), ['Kitchen', 'Living Room']);
});

test('the list is capped but counts are kept', async () => {
  const h = await make({ historyMax: 2 }).load();
  for (let i = 1; i <= 5; i++) play(h, A, 'l', i);
  assert.deepEqual(h.recent().map((e) => e.at), [5, 4]);
  assert.equal(h.top()[0].plays, 5);
});

test('persists to DATA_DIR/history.json and tolerates a corrupt file', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'hist-'));
  const h = await new History({ dataDir, historyMax: 2 }, new Logger('none')).load();
  for (let i = 1; i <= 3; i++) play(h, A, 'l', i);
  await h.flush();
  const again = await new History({ dataDir, historyMax: 2 }, new Logger('none')).load();
  assert.equal(again.top()[0].plays, 3);
  assert.deepEqual(again.recent().map((e) => e.at), [3, 2]);

  writeFileSync(path.join(dataDir, 'history.json'), '{ not json');
  const broken = await new History({ dataDir }, new Logger('none')).load();
  assert.deepEqual(broken.top(), []);
});

test('CSV: quoted cells, no spreadsheet formulas, speaker filter', async () => {
  const h = await make().load();
  play(h, A, 'l', Date.UTC(2026, 0, 2, 3, 4, 5), { info: { title: '=HYPERLINK("x")', artist: 'Ő, the "band"' }, quality: 'AAC 258 kbps' });
  play(h, B, 'k', 2000);
  const lines = h.toCsv().trim().split('\r\n');
  assert.equal(lines[0], 'played_at,speaker,title,artist,album,video_id,url,senders,format,quality,played_s');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^2026-01-02T03:04:05\.000Z,Living Room,"'=HYPERLINK\(""x""\)","Ő, the ""band""",/);
  assert.ok(lines[1].endsWith(`,${A},https://music.youtube.com/watch?v=${A},Anna,mp4,AAC 258 kbps,31`), lines[1]);
  assert.equal(h.toCsv({ speaker: 'k' }).trim().split('\r\n').length, 2);
});

test('clear() empties everything on disk too', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'hist-'));
  const h = await new History({ dataDir }, new Logger('none')).load();
  play(h, A, 'l', 1);
  await h.clear();
  assert.deepEqual(h.top(), []);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'history.json'), 'utf8')).recent, []);
});
