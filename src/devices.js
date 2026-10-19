// Speakers we have found, remembered in DATA_DIR/devices.json with a fixed DIAL port each.
//
// YouTube apps cache a receiver's address, so a speaker must keep its port across
// restarts (discovery order is a race, so "next free port" would shuffle them). Known
// speakers are also checked directly every DEVICE_CHECK_INTERVAL seconds instead of
// waiting for SSDP announcements to expire (up to 45 min): one that stops answering goes
// offline and its cast receiver is stopped, so it leaves the cast menu. It comes back on
// the same port when it answers again.
//
// States: starting -> online; offline (known, not answering); error (answers, but the
// receiver couldn't start); ignored (hidden by the user, holds no port).

import fs from 'node:fs/promises';
import path from 'node:path';
import { PLAYER_STATUSES } from 'yt-cast-receiver';

const RETRY_FAILED_MS = 5 * 60 * 1000;
const RETRY_TERMINATED_MS = 30 * 1000;
const STATE_ORDER = { online: 0, starting: 1, error: 2, offline: 3, ignored: 4 };
const SAVED_FIELDS = ['port', 'name', 'friendlyName', 'manufacturer', 'model', 'presentationURL', 'location', 'address',
  'lastSeen', 'ignored'];

const httpError = (status, message) => Object.assign(new Error(message), { status });

export class DeviceManager {
  /** udn -> running Renderer (the status page's per-renderer actions, shutdown) */
  renderers = new Map();
  #known = new Map();   // udn -> record (see #record)
  #skipped = new Map(); // udn -> { location, until }: filtered out, or new and failing
  #file;
  #writing = Promise.resolve();

  /**
   * @param {object} config
   * @param {object} deps
   * @param {(p:object) => object} deps.createRenderer - ({ udn, location, address, maxAge, port, onTerminate }) => Renderer
   * @param {(location:string) => Promise<boolean>} deps.probe - does the device still answer?
   * @param {(udn:string) => Promise<void>} [deps.removeData] - delete a speaker's stored data
   * @param {object} deps.logger
   */
  constructor(config, { createRenderer, probe, removeData = async () => {}, logger, now = Date.now }) {
    this.cfg = config;
    this.createRenderer = createRenderer;
    this.probe = probe;
    this.removeData = removeData;
    this.log = logger;
    this.now = now;
    this.base = config.receiverBasePort;
    this.offlineAfter = Math.max(1, config.deviceOfflineAfter ?? 3);
    this.retryFailedMs = config.retryFailedMs ?? RETRY_FAILED_MS;
    this.#file = path.resolve(config.dataDir, 'devices.json');
  }

  async load() {
    let saved = {};
    try {
      const data = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      // Valid JSON can still be the wrong shape (null, [], a hand edit).
      if (!data?.devices || typeof data.devices !== 'object' || Array.isArray(data.devices)) {
        throw new Error('no "devices" object');
      }
      saved = data.devices;
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`Ignoring unreadable ${this.#file}: ${err.message}`);
    }
    for (const [udn, d] of Object.entries(saved)) {
      if (!d || typeof d !== 'object') continue;
      const port = Number.isInteger(d.port) && d.port > 0 && d.port < 65536 ? d.port : null;
      if (!d.ignored && (!port || typeof d.location !== 'string')) continue;
      this.#known.set(udn, this.#record(udn, {
        ...d, port: d.ignored ? null : port, saved: true, state: d.ignored ? 'ignored' : 'offline',
      }));
    }
    const n = [...this.#known.values()].filter((r) => r.state === 'offline').length;
    if (n) this.log.info(`${n} known speaker(s) - checking whether they're reachable`);
    return this;
  }

  #record(udn, fields = {}) {
    return {
      udn, port: null, name: null, friendlyName: null, manufacturer: '', model: '', location: null, address: null,
      lastSeen: null, ignored: false, saved: false, state: 'offline', error: null, retryAt: 0, misses: 0,
      renderer: null, lastVolume: null, icon: null, presentationURL: null,
      onlineSince: null, dropouts: 0, checkMs: null, lock: Promise.resolve(), ...fields,
    };
  }

  /** One state change per speaker at a time (SSDP, the checks and the status page race). */
  #serial(rec, fn) {
    const run = rec.lock.then(fn).catch((err) => this.log.error(`${rec.name ?? rec.udn}:`, err));
    rec.lock = run;
    return run;
  }

  // ------------------------------------------------------------------ events

  /** An SSDP alive/response for a MediaRenderer. */
  seen({ udn, location, address, maxAge }) {
    let rec = this.#known.get(udn);
    if (rec?.ignored) return Promise.resolve();
    if (!rec) {
      const skip = this.#skipped.get(udn);
      if (skip && skip.location === location && skip.until > this.now()) return Promise.resolve();
      rec = this.#record(udn, { location, address });
      this.#known.set(udn, rec);
    }
    rec.lastSeen = this.now();
    rec.misses = 0;
    if (rec.state === 'online' && rec.location === location) {
      rec.renderer.refresh(maxAge);
      return Promise.resolve();
    }
    return this.#serial(rec, async () => {
      if (rec.ignored || !this.#known.has(udn)) return; // ignored or removed meanwhile
      if (rec.state === 'online' && rec.location !== location) {
        // Same speaker, new description URL (rebooted, DHCP change, random port): rebuild.
        this.log.info(`${rec.name} moved to ${location} - restarting its receiver`);
        await this.#stopRenderer(rec);
        rec.state = 'offline';
      }
      rec.location = location;
      rec.address = address;
      if (rec.state === 'error' && rec.retryAt > this.now()) return;
      if (rec.state !== 'online') await this.#start(rec, maxAge);
    });
  }

  /** An SSDP byebye: the speaker says it's leaving (switched off, rebooting). */
  gone(udn) {
    const rec = this.#known.get(udn);
    if (rec?.state !== 'online') return Promise.resolve();
    return this.#serial(rec, () => this.#takeOffline(rec, 'said goodbye'));
  }

  /** Check every known speaker directly. Runs every DEVICE_CHECK_INTERVAL seconds. */
  async checkAll() {
    await Promise.allSettled([...this.#known.values()]
      .filter((rec) => !rec.ignored && rec.state !== 'starting' && rec.location)
      .map((rec) => this.#check(rec)));
  }

  async #check(rec) {
    const t = performance.now();
    const ok = await this.probe(rec.location).catch(() => false);
    if (!this.#known.has(rec.udn) || rec.ignored) return;
    if (ok) {
      rec.checkMs = Math.round(performance.now() - t);
      rec.misses = 0;
      rec.lastSeen = this.now();
      if (rec.state === 'online') {
        try { await rec.renderer.refreshStatus?.(); } catch { /* shown as unknown */ }
      }
      else if (rec.state === 'offline' || (rec.state === 'error' && rec.retryAt <= this.now())) {
        await this.#serial(rec, () => (rec.state === 'online' ? null : this.#start(rec)));
      }
      return;
    }
    rec.misses++;
    if (rec.state !== 'online') return;
    // A blip during playback shouldn't cut the music: allow it twice as long.
    const playing = rec.renderer.status === PLAYER_STATUSES.PLAYING;
    if (rec.misses >= this.offlineAfter * (playing ? 2 : 1)) {
      await this.#serial(rec, () => (rec.state === 'online' ? this.#takeOffline(rec, 'stopped answering') : null));
    }
  }

  // --------------------------------------------------------------- lifecycle

  async #start(rec, maxAge) {
    rec.port ??= this.#freePort();
    rec.state = 'starting';
    const r = this.createRenderer({
      udn: rec.udn, location: rec.location, address: rec.address, maxAge, port: rec.port,
      onTerminate: (err) => this.#terminated(rec, r, err),
    });
    try {
      if (!(await r.init())) {
        // Filtered out (RENDERER_INCLUDE/EXCLUDE) or not a usable renderer: not listed.
        await r.destroy();
        this.#known.delete(rec.udn);
        this.#skipped.set(rec.udn, { location: rec.location, until: Infinity });
        if (rec.saved) await this.#save();
        return;
      }
    } catch (err) {
      await r.destroy();
      rec.state = 'error';
      rec.error = err.message;
      rec.retryAt = this.now() + this.retryFailedMs;
      this.log.warn(`Could not set up ${rec.name ?? `renderer at ${rec.location}`}: ${err.message}`
        + ` (retry in ${Math.round(this.retryFailedMs / 60000)} min)`);
      if (!rec.saved) {
        // A speaker we never got going doesn't keep a port, or a row once it's retried.
        this.#known.delete(rec.udn);
        this.#skipped.set(rec.udn, { location: rec.location, until: rec.retryAt });
      }
      return;
    }
    rec.renderer = r;
    this.renderers.set(rec.udn, r);
    Object.assign(rec, {
      state: 'online', error: null, retryAt: 0, misses: 0, lastSeen: this.now(), saved: true,
      name: r.name, friendlyName: r.description?.friendlyName ?? r.name,
      manufacturer: r.description?.manufacturer ?? '', model: r.description?.modelName ?? '',
      presentationURL: r.description?.presentationURL ?? null, icon: r.icon ?? rec.icon, onlineSince: this.now(),
    });
    this.#skipped.delete(rec.udn);
    await this.#save();
  }

  async #stopRenderer(rec) {
    const r = rec.renderer;
    if (!r) return;
    rec.lastVolume = r.statusInfo?.().volume ?? rec.lastVolume;
    rec.renderer = null;
    this.renderers.delete(rec.udn);
    await r.destroy();
  }

  async #takeOffline(rec, why) {
    await this.#stopRenderer(rec);
    rec.state = 'offline';
    rec.onlineSince = null;
    rec.dropouts++;
    this.log.info(`${rec.name} ${why} - offline, its receiver left the cast menu (port ${rec.port} kept)`);
  }

  #terminated(rec, r, err) {
    if (rec.renderer !== r) return;
    this.#serial(rec, async () => {
      if (rec.renderer !== r) return;
      await this.#stopRenderer(rec);
      rec.state = 'error';
      rec.error = `Receiver terminated: ${err?.message ?? 'unknown error'}`;
      rec.retryAt = this.now() + RETRY_TERMINATED_MS; // restarted by a later check
    });
  }

  #freePort() {
    const used = new Set([...this.#known.values()].map((r) => r.port));
    let p = this.base;
    while (used.has(p)) p++;
    return p;
  }

  // ------------------------------------------------------------- status page

  /** Forget an offline speaker: its port is freed and its stored data deleted. */
  async remove(udn) {
    const rec = this.#lookup(udn);
    if (rec.state === 'online' || rec.state === 'starting') {
      throw httpError(409, `${rec.name} is online - use Ignore to remove it`);
    }
    await this.#serial(rec, async () => {
      await this.#stopRenderer(rec);
      this.#known.delete(udn);
      this.#skipped.delete(udn);
      await this.#save();
      await this.removeData(udn);
      this.log.info(`Removed ${rec.name ?? udn} (port ${rec.port ?? '-'} is free again)`);
    });
  }

  /** Stop a speaker's receiver and keep it out until allowed again. Frees its port. */
  async ignore(udn) {
    const rec = this.#lookup(udn);
    await this.#serial(rec, async () => {
      await this.#stopRenderer(rec);
      const port = rec.port;
      Object.assign(rec, { ignored: true, state: 'ignored', port: null, error: null, saved: true, lastVolume: null });
      await this.#save();
      await this.removeData(udn);
      this.log.info(`Ignoring ${rec.name ?? udn} (port ${port ?? '-'} is free again)`);
    });
  }

  /** Allow an ignored speaker again: it's set up as new the next time it's discovered. */
  async unignore(udn) {
    const rec = this.#lookup(udn);
    if (!rec.ignored) return;
    this.#known.delete(udn);
    await this.#save();
    this.log.info(`${rec.name ?? udn} is allowed again`);
  }

  /** The speaker's icon (kept while it's offline), for the status page. */
  icon(udn) {
    return this.#known.get(udn)?.icon ?? null;
  }

  #lookup(udn) {
    const rec = this.#known.get(udn);
    if (!rec) throw httpError(404, 'Unknown speaker');
    return rec;
  }

  /** Every known speaker for the status page: running ones in full, others in brief. */
  list() {
    const now = this.now();
    return [...this.#known.values()]
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]
        || (a.friendlyName ?? a.name ?? '').localeCompare(b.friendlyName ?? b.name ?? ''))
      .map((rec) => {
        const brief = {
          id: rec.udn, state: rec.state, dialPort: rec.port, error: rec.error,
          lastSeenS: rec.lastSeen ? Math.round((now - rec.lastSeen) / 1000) : null,
          retryInS: rec.state === 'error' ? Math.max(0, Math.round((rec.retryAt - now) / 1000)) : null,
          onlineForS: rec.onlineSince ? Math.round((now - rec.onlineSince) / 1000) : null,
          dropouts: rec.dropouts, checkMs: rec.checkMs, icon: Boolean(rec.icon),
        };
        if (rec.state === 'online') return { ...rec.renderer.statusInfo(), ...brief };
        return {
          ...brief, name: rec.name ?? rec.udn, friendlyName: rec.friendlyName ?? rec.name ?? rec.udn,
          manufacturer: rec.manufacturer, model: rec.model, address: rec.address, volume: rec.lastVolume,
          presentationURL: rec.presentationURL,
        };
      });
  }

  /** Stop every receiver (shutdown), keeping the speakers remembered. */
  async stopAll() {
    await Promise.allSettled([...this.#known.values()].map((rec) => this.#serial(rec, () => this.#stopRenderer(rec))));
    await this.#writing;
  }

  // Writes share one temp file, so run them one at a time.
  #save() {
    const devices = {};
    for (const rec of this.#known.values()) {
      if (!rec.saved) continue;
      devices[rec.udn] = Object.fromEntries(SAVED_FIELDS.filter((k) => rec[k] != null && rec[k] !== false).map((k) => [k, rec[k]]));
    }
    const body = JSON.stringify({ version: 1, devices }, null, 2);
    this.#writing = this.#writing.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.#file), { recursive: true });
        const tmp = `${this.#file}.tmp`;
        await fs.writeFile(tmp, body);
        await fs.rename(tmp, this.#file);
      } catch (err) {
        this.log.warn(`Could not save ${this.#file}: ${err.message}`);
      }
    });
    return this.#writing;
  }
}
