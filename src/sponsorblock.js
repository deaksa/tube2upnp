// SponsorBlock: community-submitted segments (non-music parts of music videos,
// sponsor reads, intros...) that upnpTube skips by seeking past them.
//
// Privacy: we query by the first 4 hex chars of SHA-256(videoId), so the server
// never learns which video is playing (k-anonymity API), and filter locally.

import { createHash } from 'node:crypto';
import { stats } from './stats.js';

export const CATEGORIES = {
  music_offtopic: 'Non-music parts of music videos',
  sponsor: 'Sponsor reads',
  selfpromo: 'Self-promotion',
  interaction: 'Like/subscribe reminders',
  intro: 'Intros',
  outro: 'Outros and end cards',
  preview: 'Previews and recaps',
  filler: 'Filler and jokes',
};

export const DEFAULT_CATEGORIES = ['music_offtopic', 'sponsor', 'selfpromo', 'interaction'];

const CACHE_MS = 30 * 60 * 1000;
const MAX_CACHE = 200;

export class SponsorBlock {
  #cache = new Map();

  constructor(config, settings, logger, fetchImpl = fetch) {
    this.cfg = config;
    this.settings = settings;
    this.log = logger;
    this.fetch = fetchImpl;
    settings?.on?.('change', () => this.#cache.clear());
  }

  get enabled() {
    return this.settings.sponsorblock.enabled;
  }

  /**
   * Segments to skip for a video, sorted, merged where they overlap: [{ start, end, category }].
   * Never throws: a SponsorBlock outage just means nothing is skipped.
   */
  async segments(videoId) {
    if (!this.enabled) return [];
    const { categories } = this.settings.sponsorblock;
    if (!categories.length) return [];
    const key = `${videoId}|${categories.join(',')}`;
    const hit = this.#cache.get(key);
    if (hit && hit.at > Date.now() - CACHE_MS) return hit.segments;

    const prefix = createHash('sha256').update(videoId).digest('hex').slice(0, 4);
    const url = new URL(`/api/skipSegments/${prefix}`, this.cfg.sponsorblockApi);
    url.searchParams.set('categories', JSON.stringify(categories));
    url.searchParams.set('actionTypes', JSON.stringify(['skip']));

    let segments = [];
    const started = Date.now();
    try {
      const res = await this.fetch(url, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'upnpTube' } });
      if (res.status !== 404) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = await res.json();
        const entry = Array.isArray(list) ? list.find((v) => v.videoID === videoId) : null;
        segments = merge((entry?.segments ?? [])
          .filter((s) => s.actionType === 'skip' && categories.includes(s.category))
          .map((s) => ({ start: Number(s.segment[0]), end: Number(s.segment[1]), category: s.category }))
          .filter((s) => s.end - s.start >= 1));
      }
      stats.time('sponsorblock', Date.now() - started);
      stats.inc('sponsorblock.lookups');
    } catch (err) {
      stats.inc('sponsorblock.failed');
      this.log.warn(`SponsorBlock lookup for ${videoId} failed (${err.message}) - playing without skips`);
      return [];
    }
    this.#cache.set(key, { at: Date.now(), segments });
    while (this.#cache.size > MAX_CACHE) this.#cache.delete(this.#cache.keys().next().value);
    if (segments.length) {
      this.log.info(`SponsorBlock: ${segments.length} segment(s) to skip in ${videoId}`
        + ` (${segments.map((s) => `${fmt(s.start)}-${fmt(s.end)} ${s.category}`).join(', ')})`);
    }
    return segments;
  }
}

/** Sort and merge overlapping/adjacent segments so one seek skips the whole run. */
export function merge(segs) {
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start <= last.end + 0.5) {
      last.end = Math.max(last.end, s.end);
      if (!last.category.includes(s.category)) last.category += `+${s.category}`;
    } else out.push({ ...s });
  }
  return out;
}

export function fmt(sec) {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
