// Playback history: what was played, where, and by whom, persisted in DATA_DIR/history.json.
// Play counts per track (and per speaker) are kept forever; the detailed list of plays
// is capped at HISTORY_MAX entries, oldest dropped first.

import fs from 'node:fs/promises';
import path from 'node:path';

const empty = () => ({ version: 1, tracks: {}, speakers: {}, recent: [] });

/** One CSV cell: RFC 4180 quoting, and no leading = + - @ so spreadsheets don't run it as a formula. */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class History {
  #file;
  #data = empty();
  #saving = null;  // in-flight save
  #dirty = false;  // changed since that save started

  constructor(config, logger) {
    this.max = Math.max(1, config.historyMax ?? 5000);
    this.log = logger;
    this.#file = path.resolve(config.dataDir, 'history.json');
  }

  async load() {
    try {
      const d = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      this.#data = { ...empty(), ...d };
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`Ignoring unreadable ${this.#file}: ${err.message}`);
      this.#data = empty();
    }
    return this;
  }

  /** Count one play. */
  record({ videoId, info = {}, udn, speakerName, senders = [], format = null, quality = null, playedS = 0, at = Date.now() }) {
    const d = this.#data;
    const t = d.tracks[videoId] ??= { plays: 0, bySpeaker: {} };
    // Keep the latest metadata: YouTube titles get corrected, thumbnails move.
    Object.assign(t, {
      title: info.title ?? t.title ?? videoId, artist: info.artist ?? t.artist ?? '',
      album: info.album ?? t.album ?? '', thumbnail: info.thumbnail ?? t.thumbnail ?? null,
    });
    t.plays++;
    t.bySpeaker[udn] = (t.bySpeaker[udn] ?? 0) + 1;
    t.lastPlayed = at;
    d.speakers[udn] = { name: speakerName ?? d.speakers[udn]?.name ?? udn, lastSeen: at };
    d.recent.push({ at, videoId, speaker: udn, senders, format, quality, playedS: Math.round(playedS) });
    if (d.recent.length > this.max) d.recent.splice(0, d.recent.length - this.max);
    this.#save();
  }

  #entry(e) {
    const t = this.#data.tracks[e.videoId] ?? {};
    return {
      ...e, title: t.title ?? e.videoId, artist: t.artist ?? '', album: t.album ?? '',
      thumbnail: t.thumbnail ?? null, speakerName: this.#data.speakers[e.speaker]?.name ?? e.speaker,
    };
  }

  /** Plays, newest first. `before` (a timestamp) pages back through older ones. */
  recent({ limit = 100, before = Infinity, speaker = null } = {}) {
    const out = [];
    const r = this.#data.recent;
    for (let i = r.length - 1; i >= 0 && out.length < limit; i--) {
      const e = r[i];
      if (e.at < before && (!speaker || e.speaker === speaker)) out.push(this.#entry(e));
    }
    return out;
  }

  /** Most played tracks, overall or on one speaker. */
  top({ limit = 100, speaker = null } = {}) {
    return Object.entries(this.#data.tracks)
      .map(([videoId, t]) => ({
        videoId, title: t.title, artist: t.artist, album: t.album, thumbnail: t.thumbnail,
        plays: speaker ? (t.bySpeaker[speaker] ?? 0) : t.plays, lastPlayed: t.lastPlayed,
      }))
      .filter((t) => t.plays > 0)
      .sort((a, b) => b.plays - a.plays || b.lastPlayed - a.lastPlayed)
      .slice(0, limit);
  }

  /** Speakers that appear in the history (for the filter). */
  speakers() {
    return Object.entries(this.#data.speakers)
      .map(([id, s]) => ({ id, name: s.name, lastSeen: s.lastSeen }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The detailed list as CSV, oldest first. */
  toCsv({ speaker = null } = {}) {
    const rows = [['played_at', 'speaker', 'title', 'artist', 'album', 'video_id', 'url', 'senders', 'format', 'quality', 'played_s']];
    for (const raw of this.#data.recent) {
      if (speaker && raw.speaker !== speaker) continue;
      const e = this.#entry(raw);
      rows.push([new Date(e.at).toISOString(), e.speakerName, e.title, e.artist, e.album, e.videoId,
        `https://music.youtube.com/watch?v=${e.videoId}`, e.senders.join('; '), e.format ?? '', e.quality ?? '', e.playedS]);
    }
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  async clear() {
    this.#data = empty();
    this.#save();
    await this.flush();
  }

  /** Wait until everything recorded so far is on disk. */
  async flush() {
    while (this.#saving) await this.#saving;
  }

  // One write at a time; changes made meanwhile are written right after it.
  #save() {
    if (this.#saving) {
      this.#dirty = true;
      return;
    }
    this.#saving = (async () => {
      do {
        this.#dirty = false;
        try {
          await fs.mkdir(path.dirname(this.#file), { recursive: true });
          const tmp = `${this.#file}.tmp`;
          await fs.writeFile(tmp, JSON.stringify(this.#data));
          await fs.rename(tmp, this.#file);
        } catch (err) {
          this.log.warn(`Could not save ${this.#file}: ${err.message}`);
        }
      } while (this.#dirty);
      this.#saving = null;
    })();
  }
}
