import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SponsorBlock, merge } from '../src/sponsorblock.js';
import { Settings } from '../src/settings.js';
import { Logger } from '../src/logger.js';

const VID = 'dQw4w9WgXcQ';
const quiet = new Logger('none');
const cfg = (o = {}) => ({ dataDir: mkdtempSync(path.join(tmpdir(), 'sb-')), sponsorblock: true,
  sponsorblockCategories: ['music_offtopic', 'sponsor'], sponsorblockApi: 'https://sb.example', ...o });

function fakeFetch(body, status = 200) {
  const calls = [];
  const f = async (url) => { calls.push(String(url)); return { ok: status < 400, status, json: async () => body }; };
  f.calls = calls;
  return f;
}

test('queries by hash prefix only and keeps just this video\'s skip segments', async () => {
  const f = fakeFetch([
    { videoID: 'otherVideo1', segments: [{ segment: [0, 30], category: 'sponsor', actionType: 'skip' }] },
    { videoID: VID, segments: [
      { segment: [0, 14.5], category: 'music_offtopic', actionType: 'skip' },
      { segment: [14, 20], category: 'sponsor', actionType: 'skip' },
      { segment: [100, 100.4], category: 'sponsor', actionType: 'skip' },  // too short
      { segment: [150, 160], category: 'sponsor', actionType: 'mute' },    // not a skip
      { segment: [200, 230], category: 'intro', actionType: 'skip' },      // not selected
    ] },
  ]);
  const c = cfg();
  const sb = new SponsorBlock(c, await new Settings(c, quiet).load(), quiet, f);
  const segs = await sb.segments(VID);
  assert.deepEqual(segs, [{ start: 0, end: 20, category: 'music_offtopic+sponsor' }]);
  const prefix = createHash('sha256').update(VID).digest('hex').slice(0, 4);
  assert.match(f.calls[0], new RegExp(`/api/skipSegments/${prefix}\\?`));
  assert.ok(!f.calls[0].includes(VID), 'video ID never sent');
  await sb.segments(VID);
  assert.equal(f.calls.length, 1, 'cached');
});

test('404 means no segments; errors never break playback; off means no request', async () => {
  const c = cfg();
  const settings = await new Settings(c, quiet).load();
  assert.deepEqual(await new SponsorBlock(c, settings, quiet, fakeFetch(null, 404)).segments(VID), []);
  const broken = async () => { throw new Error('ECONNREFUSED'); };
  assert.deepEqual(await new SponsorBlock(c, settings, quiet, broken).segments(VID), []);
  const off = cfg({ sponsorblock: false });
  const f = fakeFetch([]);
  assert.deepEqual(await new SponsorBlock(off, await new Settings(off, quiet).load(), quiet, f).segments(VID), []);
  assert.equal(f.calls.length, 0);
});

test('status-page settings override .env, persist, and reset', async () => {
  const c = cfg({ sponsorblock: false });
  const s = await new Settings(c, quiet).load();
  assert.equal(s.sponsorblock.enabled, false);
  assert.equal(s.sponsorblock.fromEnv, true);
  await s.setSponsorblock({ enabled: true, categories: ['sponsor'] });
  const again = await new Settings(c, quiet).load();
  assert.deepEqual(again.sponsorblock, { enabled: true, categories: ['sponsor'], fromEnv: false });
  assert.match(readFileSync(path.join(c.dataDir, 'settings.json'), 'utf8'), /"sponsor"/);
  await again.resetSponsorblock();
  assert.equal((await new Settings(c, quiet).load()).sponsorblock.enabled, false);
});

test('merge joins overlapping and adjacent segments', () => {
  assert.deepEqual(merge([{ start: 50, end: 60, category: 'a' }, { start: 10, end: 20, category: 'b' }, { start: 20.3, end: 25, category: 'b' }]),
    [{ start: 10, end: 25, category: 'b' }, { start: 50, end: 60, category: 'a' }]);
});
