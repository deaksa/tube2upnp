// One UPnP MediaRenderer exposed as one YouTube cast receiver.

import { createHash } from 'node:crypto';
import YouTubeCastReceiver, { Player, PLAYER_STATUSES, AUTOPLAY_MODES } from 'yt-cast-receiver';
import { RendererDataStore } from './dataStore.js';
import { fetchDescription, fetchScpd, fetchIcon, pickIcon, didlTitle, buildDidl, sinkAccepts } from './upnp.js';
import { localAddressFor } from './net.js';
import { callAction, parseSink, UpnpError } from './soap.js';
import { FORMATS, FALLBACK_CHAIN, FILE_FORMATS, dlnaFeatures, mimeOf } from './formats.js';
import { fmt as fmtSec } from './sponsorblock.js';
import { stats } from './stats.js';
import { YamahaExtendedControl } from './yamaha.js';

// A next track that can't be prepared (unavailable, age-restricted, 403s) is retried
// after this long, doubling per failure - not on every poll.
const PREFETCH_RETRY_MS = 30 * 1000;
const PREFETCH_RETRY_MAX_MS = 10 * 60 * 1000;

export class Renderer extends Player {
  #call;
  #receiver = null;
  #pollTimer = null;
  #expectStop = false;     // true while WE asked the renderer to stop/switch
  #sawPlaying = false;     // renderer actually reached PLAYING for the current item
  #loadSeq = 0;            // invalidates stale async loads when the user skips quickly
  #protocols = null;
  #ip = null;
  #store = null;
  #learnedFormat = null;   // format that worked on this renderer (persisted)
  #formatOverride = null;  // per-renderer setting from the status page (persisted)
  #transport = null;       // last polled transport state
  #position = null;        // { rel, dur, at } from the last poll
  #soap = { calls: 0, errors: 0, totalMs: 0 };
  #sb = { videoId: null, segments: [], skipped: new Set(), loading: false, timer: null };
  #listen = { videoId: null, playedMs: 0, lastTick: 0, counted: false }; // for the play history
  #polls = 0;
  #volume = null;          // { raw, muted } last read from the renderer, for the status page
  #volumeRange = null;     // { min, max } of its Volume variable (SCPD), when it says
  #volumeDb = null;        // dB as the device itself shows it (GetVolumeDB), when it has that
  #volumeDbUnit = 256;     // GetVolumeDB is in 1/256 dB per the spec; some devices send plain dB
  #scpd = { rc: null, avt: null }; // { actions, ranges } of RenderingControl and AVTransport
  #external = null;        // what the renderer plays when it isn't playing for us
  #allowedActions = null;  // GetCurrentTransportActions: what the renderer allows right now
  #yxc = null;             // Yamaha Extended Control client, for MusicCast devices
  #vendor = null;          // last YXC status: { power, input, inputText, volume, playing }
  #current = null;         // { video, format, startAt, loadedAt, fetched }
  #queued = null;          // prepared next track: { video, item, sentToRenderer }
  #advanced = null;        // queued track the renderer already switched to by itself
  #prefetching = false;
  #prefetchFailures = new Map(); // videoId -> { count, until }
  #polling = false;
  #gaplessSupported = null; // null = unknown, learned from SetNextAVTransportURI
  #destroyed = false;

  /**
   * @param {object} p
   * @param {string} p.udn       - unique device id (from SSDP USN)
   * @param {string} p.location  - device description URL
   * @param {string} p.address   - renderer IP (SSDP source address)
   * @param {number} p.maxAge    - SSDP cache max-age in seconds
   * @param {number} p.port      - DIAL port for this receiver
   * @param {object} p.deps      - { config, resolver, mediaServer, logger, sponsorblock?, history?, createReceiver? }
   */
  constructor({ udn, location, address, maxAge, port, deps }) {
    super();
    this.udn = udn;
    this.location = location;
    this.address = address;
    this.port = port;
    this.cfg = deps.config;
    this.resolver = deps.resolver;
    this.sponsorblock = deps.sponsorblock ?? null;
    this.history = deps.history ?? null;
    this.media = deps.mediaServer;
    this.createReceiver = deps.createReceiver ?? ((player, opts) => new YouTubeCastReceiver(player, opts));
    this.onTerminate = deps.onTerminate ?? null;
    this.baseLog = deps.logger;
    this.log = deps.logger.child(`[${address}]`);
    this.name = null;
    this.description = null;
    this.icon = null; // { type, data }: served by the status page (its CSP blocks LAN http images)
    this.nowPlaying = null;
    this.lastError = null;
    this.refresh(maxAge);
  }

  refresh(maxAge = this.maxAge) {
    this.maxAge = maxAge;
    this.lastSeen = Date.now();
  }

  get receiverStatus() {
    return this.#receiver?.status ?? 'stopped';
  }

  /** Title of the prepared next track, for the status page. */
  get upNext() {
    const q = this.#queued;
    return q ? { title: q.item.info.title, gapless: q.sentToRenderer } : null;
  }

  get connectedSenders() {
    return this.#receiver?.getConnectedSenders?.() ?? [];
  }

  /** Fetch description, verify AVTransport, start the cast receiver. Returns false to skip this device. */
  async init() {
    const desc = await fetchDescription(this.location);
    this.description = desc;

    if (!desc.services['urn:upnp-org:serviceId:AVTransport']) {
      this.log.warn(`"${desc.friendlyName}" has no AVTransport service - skipping (${this.location})`);
      return false;
    }

    const display = desc.friendlyName;
    if (this.cfg.include && !this.cfg.include.test(display)) return false;
    if (this.cfg.exclude && this.cfg.exclude.test(display)) return false;

    this.name = this.cfg.nameTemplate
      .replace('{name}', desc.friendlyName)
      .replace('{manufacturer}', desc.manufacturer)
      .replace('{model}', desc.modelName)
      .trim();
    this.log = this.baseLog.child(`[${desc.friendlyName}]`);

    this.#call = async (svc, action, params) => {
      const service = desc.services[`urn:upnp-org:serviceId:${svc}`];
      if (!service) throw new UpnpError(`${svc} service not provided`, { code: 'ENOSERVICE' });
      const t = Date.now();
      this.#soap.calls++;
      try {
        return await callAction(service, action, params);
      } catch (err) {
        this.#soap.errors++;
        throw err;
      } finally {
        this.#soap.totalMs += Date.now() - t;
      }
    };

    try {
      const r = await this.#call('ConnectionManager', 'GetProtocolInfo', {});
      this.#protocols = parseSink(r.Sink);
      this.log.debug('Sink protocols:', this.#protocols.map((p) => p.contentFormat).join(', '));
    } catch (err) {
      this.log.debug('GetProtocolInfo failed (will assume source format works):', err.message);
    }

    // What the device implements, from its service descriptions: the volume scale (UPnP
    // leaves it to the device), whether it reports dB, and its transport actions. Optional
    // calls are only made when listed, so they don't pile up as SOAP errors.
    const scpd = (svc) => fetchScpd(desc.services[`urn:upnp-org:serviceId:${svc}`]?.SCPDURL).catch(() => null);
    [this.#scpd.rc, this.#scpd.avt] = await Promise.all([scpd('RenderingControl'), scpd('AVTransport')]);
    this.#volumeRange = this.#scpd.rc?.ranges.Volume ?? null;
    if (this.#scpd.rc?.actions.has('GetVolumeDBRange')) {
      const r = await this.#safeCall('RenderingControl', 'GetVolumeDBRange', { InstanceID: 0, Channel: 'Master' });
      // A range within +-200 can't be 1/256 dB units (that would be under 1 dB): plain dB.
      const span = Math.max(Math.abs(Number(r?.MinValue) || 0), Math.abs(Number(r?.MaxValue) || 0));
      if (span && span <= 200) this.#volumeDbUnit = 1;
    }
    const icon = pickIcon(desc.icons ?? []);
    if (icon) this.icon = await fetchIcon(icon.url).catch(() => null);
    this.#yxc = await this.#findYxc(desc);
    await this.refreshStatus();

    this.#ip = this.cfg.advertiseIp ?? await localAddressFor(this.address);

    this.#store = new RendererDataStore(this.cfg.dataDir, this.udn);
    const learned = await this.#setting('format');
    if (FORMATS[learned]) {
      this.#learnedFormat = learned;
      this.log.info(`Using previously detected stream format "${learned}"`);
    }
    const override = await this.#setting('formatOverride');
    if (override === 'auto' || FORMATS[override]) {
      this.#formatOverride = override;
      this.log.info(`Stream format set to "${override}" for this renderer`);
    }

    this.#receiver = this.createReceiver(this, {
      // DIAL answers on every interface unless ADVERTISE_IP pins it (phone and speaker
      // may live on different VLANs).
      dial: { port: this.port, ...(this.cfg.advertiseIp ? { bindToAddresses: [this.cfg.advertiseIp] } : {}) },
      device: {
        name: this.name,
        screenName: this.name,
        brand: desc.manufacturer || 'Tube2U[PnP]',
        model: desc.modelName || 'UPnP Renderer',
      },
      dataStore: this.#store,
      logger: this.baseLog.child(`[ytcr ${desc.friendlyName}]`),
      logLevel: this.cfg.logLevel,
    });
    this.#receiver.enableAutoplayOnConnect(this.cfg.autoplayOnConnect);
    this.#receiver.on('senderConnect', (s) => this.log.info(`Sender connected: ${s.user?.name ?? s.name}`));
    this.#receiver.on('senderDisconnect', (s) => this.log.info(`Sender disconnected: ${s.user?.name ?? s.name}`));
    this.#receiver.on('error', (err) => this.log.warn('Cast receiver error:', err.message));
    this.#receiver.on('terminate', (err) => {
      this.lastError = `Receiver terminated: ${err.message}`;
      this.log.error(this.lastError);
      this.onTerminate?.(err); // the device manager restarts it
    });

    await this.#receiver.start();
    this.log.info(`Cast receiver "${this.name}" ready on ${this.#ip}:${this.port}`);
    return true;
  }

  async destroy() {
    // A load, prefetch or poll still in flight must not bring polling back afterwards.
    this.#destroyed = true;
    this.#loadSeq++;
    this.#current = null;
    this.#queued = null;
    this.#advanced = null;
    this.#stopPolling();
    this.#resetSkips();
    try {
      if (this.#receiver?.status === 'running') await this.#receiver.stop();
    } catch (err) {
      this.log.warn('Error stopping receiver:', err.message);
    }
    this.#receiver = null;
  }

  /** Read a persisted per-renderer value, falling back to its key from before the rename. */
  async #setting(name) {
    const v = await this.#store.get(`tube2upnp.${name}`);
    return v ?? this.#store.get(`upnptube.${name}`);
  }

  /** Fetch a pairing code for "Link with TV code" (resolves with the code). */
  getPairingCode(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.#receiver) return reject(new Error('Receiver not running'));
      const svc = this.#receiver.getPairingCodeRequestService();
      const done = (fn, v) => { clearTimeout(t); svc.stop(); svc.removeAllListeners(); fn(v); };
      const t = setTimeout(() => done(reject, new Error('Timed out waiting for pairing code')), timeoutMs);
      svc.once('response', (code) => done(resolve, code));
      svc.once('error', (err) => done(reject, err));
      svc.start();
    });
  }

  // ---------------------------------------------------------------- Player impl

  async doPlay(video, position) {
    if (this.#destroyed) return false;
    // A play request from YouTube starts a new listen. Our own reloads of the same track
    // (seek restart, format fallback) go straight to #load and keep counting.
    this.#listen = { videoId: video.id, playedMs: 0, lastTick: 0, counted: false };
    const adv = this.#advanced;
    this.#advanced = null;
    if (adv && adv.video.id === video.id && position < 2) {
      // The renderer is already playing it (gapless); just bring our state in line.
      this.#loadSeq++;
      this.#adopt(adv.item, true);
      this.log.info(`Now playing "${adv.item.info.title}" (continued gaplessly)`);
      return true;
    }
    return this.#load(video, position);
  }

  /**
   * @param {object} video
   * @param {number} position  - start position in seconds
   * @param {string} [format]  - force a format (fallback, seek restart)
   * @param {{offsetStart?:boolean}} [opts] - start the stream itself at `position`
   */
  async #load(video, position, format = null, { offsetStart = false } = {}) {
    const seq = ++this.#loadSeq;
    this.#stopPolling();
    try {
      // Already prepared in the background while the previous track played?
      const prepared = !format && !offsetStart && position < 2 && this.#queued?.video.id === video.id
        ? this.#queued.item : null;
      this.#queued = null; // the renderer's "next" slot is re-sent after this load
      const item = prepared ?? await this.#prepareItem(video, position, format, offsetStart);
      if (seq !== this.#loadSeq) return false; // superseded by a newer play()
      if (prepared) this.log.info(`Using prepared track "${item.info.title}"`);

      this.#expectStop = true;
      await this.#safeCall('AVTransport', 'Stop', { InstanceID: 0 });
      await this.#call('AVTransport', 'SetAVTransportURI', {
        InstanceID: 0, CurrentURI: item.url, CurrentURIMetaData: item.metadata,
      });
      await this.#call('AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
      if (seq !== this.#loadSeq) return false;

      if (position > 1 && !item.current.startAt) {
        await this.#waitForState(['PLAYING'], 8000);
        if (seq !== this.#loadSeq) return false;
        await this.#safeCall('AVTransport', 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(position) });
        if (seq !== this.#loadSeq) return false;
      }

      this.#adopt(item, false);
      this.log.info(`Sent "${item.info.title}" to renderer as ${item.format} (${item.mime})`);
      return true;
    } catch (err) {
      this.lastError = err.message;
      this.log.error(`Play ${video.id} failed:`, err.message);
      this.#expectStop = false;
      return false;
    }
  }

  /** Resolve, build (mp4/flac) and register a track; returns everything needed to play it. */
  async #prepareItem(video, position, format = null, offsetStart = false) {
    const info = await this.resolver.resolve(video.id);
    format ??= this.#chooseFormat(info.mime);
    const mime = mimeOf(format, info.mime);
    // Seekable formats start at 0 and use AVTransport Seek; streams start ffmpeg at the offset.
    const startAt = (offsetStart || !FORMATS[format].seekable) && position > 1 ? Math.floor(position) : 0;
    const current = { video, format, startAt, mime: info.mime, loadedAt: 0, fetched: false, streamPath: null };
    const entry = {
      videoId: video.id, format, ext: info.ext, startAt,
      onRequest: () => {
        if (!current.fetched) this.log.info(`Renderer started fetching the stream (${format})`);
        current.fetched = true;
      },
    };
    await this.media.prepare(entry); // mp4/flac: build the file before the renderer asks for it
    const streamPath = this.media.register(entry);
    current.streamPath = streamPath;
    const url = `http://${this.#ip}:${this.cfg.mediaPort}${streamPath}`;
    const protocolInfo = `http-get:*:${mime}:${dlnaFeatures(format)}`;
    const metadata = buildDidl({
      url, protocolInfo,
      title: info.title, artist: info.artist, album: info.album,
      albumArt: info.thumbnail, duration: Math.max(0, info.duration - startAt),
      isVideo: mime.startsWith('video/'),
    });
    return { current, info, format, mime, url, streamPath, metadata };
  }

  /** Make `item` the current track (after we loaded it, or the renderer switched to it). */
  #adopt(item, alreadyPlaying) {
    // A reload of the same video (seek restart, format change) keeps its skip state.
    if (this.#current?.video.id !== item.current.video.id) this.#resetSkips();
    item.current.loadedAt = Date.now();
    // The YouTube app takes the position from the state we send when the track starts and
    // counts on by itself. Right after a switch some renderers (Yamaha) still report the
    // previous track's clock, so the app would run ahead by a whole track: send it again.
    item.current.resyncAt = Date.now() + (this.cfg.positionResyncMs ?? 4000);
    this.#current = item.current;
    this.nowPlaying = {
      videoId: item.current.video.id, title: item.info.title, artist: item.info.artist,
      duration: item.info.duration, format: item.format, thumbnail: item.info.thumbnail,
    };
    this.#position = { rel: item.current.startAt, dur: item.info.duration, at: Date.now() };
    this.lastError = null;
    this.#sawPlaying = alreadyPlaying;
    this.#expectStop = false;
    this.#startPolling();
  }

  // --------------------------------------------------------------- SponsorBlock

  #resetSkips() {
    clearTimeout(this.#sb.timer);
    this.#sb = { videoId: null, segments: [], skipped: new Set(), loading: false, timer: null };
  }

  /** Current position, extrapolated from the last poll. */
  #livePosition() {
    const p = this.#position;
    if (!p) return null;
    return p.rel + (this.#transport === 'PLAYING' ? (Date.now() - p.at) / 1000 : 0);
  }

  /** Skip if we're inside a segment; arm a timer if the next one starts before the next poll. */
  async #checkSkip() {
    const sb = this.sponsorblock;
    const id = this.#current?.video.id;
    if (!sb?.enabled || !id) return;
    if (this.#sb.videoId !== id) {
      if (this.#sb.loading) return;
      this.#sb.loading = true;
      const segments = await sb.segments(id);
      if (this.#current?.video.id !== id) return;
      Object.assign(this.#sb, { videoId: id, segments, loading: false });
    }
    if (this.#transport !== 'PLAYING' || this.status !== PLAYER_STATUSES.PLAYING) return;
    const pos = this.#livePosition();
    if (pos == null) return;

    const seg = this.#sb.segments.find((s) => !this.#sb.skipped.has(s.start) && pos >= s.start - 0.3 && pos < s.end - 0.75);
    if (seg) return this.#skip(seg);

    clearTimeout(this.#sb.timer);
    const next = this.#sb.segments.find((s) => !this.#sb.skipped.has(s.start) && s.start > pos);
    const wait = next ? (next.start - pos) * 1000 : Infinity;
    if (wait < this.cfg.pollIntervalMs + 500) {
      this.#sb.timer = setTimeout(() => this.#checkSkip().catch(() => {}), Math.max(0, wait));
      this.#sb.timer.unref?.();
    }
  }

  async #skip(seg) {
    this.#sb.skipped.add(seg.start); // once per play: seeking back into it by hand still works
    stats.inc('sponsorblock.skips');
    stats.inc('sponsorblock.skippedSeconds', Math.round(seg.end - seg.start));
    const dur = this.nowPlaying?.duration ?? 0;
    if (dur && seg.end >= dur - 1.5) {
      this.log.info(`SponsorBlock: ${seg.category} from ${fmtSec(seg.start)} runs to the end - skipping to the next track`);
      this.#stopPolling();
      await this.next();
      return;
    }
    this.log.info(`SponsorBlock: skipped ${fmtSec(seg.start)}-${fmtSec(seg.end)} (${seg.category})`);
    if (await this.doSeek(seg.end)) {
      this.#position = { ...this.#position, rel: seg.end, at: Date.now() };
      await this.notifyExternalStateChange(PLAYER_STATUSES.PLAYING); // updates the app's progress bar
    }
  }

  // ----------------------------------------------------------------- history

  /**
   * Add the time since the last PLAYING poll to this listen, and record a play once it
   * reaches HISTORY_MIN_PLAY_S (30 s) or half the track, whichever is shorter, so quick
   * skips don't count.
   */
  #countListen() {
    const l = this.#listen;
    const c = this.#current;
    if (!this.history || !c || l.videoId !== c.video.id) return;
    const now = Date.now();
    // Capped per tick: a poll stuck on a slow renderer must not add minutes at once.
    if (l.lastTick) l.playedMs += Math.min(now - l.lastTick, 2 * this.cfg.pollIntervalMs);
    l.lastTick = now;
    const minS = this.cfg.historyMinPlayS ?? 30;
    const dur = this.nowPlaying?.duration || 0;
    const needS = dur ? Math.min(minS, dur / 2) : minS;
    if (l.counted || l.playedMs / 1000 < needS) return;
    l.counted = true;
    try {
      this.history.record({
        videoId: c.video.id, info: this.nowPlaying ?? {}, udn: this.udn, speakerName: this.name,
        senders: this.connectedSenders.map((s) => s.user?.name ?? s.name).filter(Boolean),
        format: c.format, playedS: l.playedMs / 1000,
      });
    } catch (err) {
      this.log.warn('Could not record play history:', err.message);
    }
  }

  // ------------------------------------------------------ next-track prefetch

  /** The video YouTube will play after the current one (queue, then autoplay). */
  getUpcomingVideo() {
    const st = this.queue.getState();
    if (st.next) return st.next;
    if (this.autoplayMode === AUTOPLAY_MODES.ENABLED && st.autoplay) return st.autoplay;
    return null;
  }

  /**
   * Keep the next track prepared, and - if the renderer supports it - queued on the
   * renderer with SetNextAVTransportURI so it plays on without a gap.
   */
  async #maintainNext() {
    if (!this.cfg.prefetch || this.#prefetching || !this.#current) return;
    const up = this.getUpcomingVideo();
    const currentId = this.#current.video.id;

    if (!up || up.id === currentId) {
      if (this.#queued?.sentToRenderer) {
        await this.#safeCall('AVTransport', 'SetNextAVTransportURI', { InstanceID: 0, NextURI: '', NextURIMetaData: '' });
      }
      this.#queued = null;
      return;
    }
    if (this.#queued?.video.id === up.id) return;
    const failed = this.#prefetchFailures.get(up.id);
    if (failed && failed.until > Date.now()) return;

    this.#prefetching = true;
    try {
      const item = await this.#prepareItem(up, 0);
      this.#prefetchFailures.delete(up.id);
      if (this.#destroyed) return;
      // Queue or current track changed while we were preparing? Try again next poll.
      if (this.getUpcomingVideo()?.id !== up.id || this.#current?.video.id !== currentId) return;
      this.#queued = { video: up, item, sentToRenderer: false };
      this.log.info(`Prepared next track "${item.info.title}" (${item.format})`);
      await this.#sendNextToRenderer();
    } catch (err) {
      const count = (failed?.count ?? 0) + 1;
      const delay = Math.min(PREFETCH_RETRY_MS * 2 ** (count - 1), PREFETCH_RETRY_MAX_MS);
      this.#prefetchFailures.delete(up.id); // re-insert: oldest entries are dropped first
      this.#prefetchFailures.set(up.id, { count, until: Date.now() + delay });
      while (this.#prefetchFailures.size > 50) this.#prefetchFailures.delete(this.#prefetchFailures.keys().next().value);
      this.log.warn(`Preparing next track ${up.id} failed: ${err.message} - next try in ${Math.round(delay / 1000)} s`);
    } finally {
      this.#prefetching = false;
    }
  }

  async #sendNextToRenderer() {
    const q = this.#queued;
    if (!q || !this.cfg.gapless || this.#gaplessSupported === false) return;
    try {
      await this.#call('AVTransport', 'SetNextAVTransportURI', {
        InstanceID: 0, NextURI: q.item.url, NextURIMetaData: q.item.metadata,
      });
      q.sentToRenderer = true;
      if (this.#gaplessSupported === null) this.log.info('Renderer supports gapless playback (SetNextAVTransportURI)');
      this.#gaplessSupported = true;
    } catch (err) {
      if (err.errorCode === '401' || err.errorCode === '602' || err.code === 'ENOSERVICE') {
        this.#gaplessSupported = false;
        this.log.info('Renderer has no SetNextAVTransportURI - next tracks start right after the current one ends');
      } else {
        this.log.debug('SetNextAVTransportURI failed:', err.message);
      }
    }
  }

  /** Has the renderer moved on to the track we queued with SetNextAVTransportURI? */
  async #rendererAdvanced() {
    const q = this.#queued;
    if (!q?.sentToRenderer) return false;
    let uri = this.#position?.uri;
    if (!uri) uri = (await this.#safeCall('AVTransport', 'GetMediaInfo', { InstanceID: 0 }))?.CurrentURI;
    // Compare by our stream path: renderers sometimes rewrite host or escaping.
    return Boolean(uri && uri.includes(q.item.streamPath));
  }

  /** The renderer accepted the URL but never started playing: try the next format. */
  async #handleStartFailure() {
    const c = this.#current;
    const why = c.fetched ? 'fetched the stream but never started playing' : 'never requested the stream';
    const next = this.formatMode === 'auto' ? this.#nextFormat(c.format) : null;
    // Not even fetching usually means a network problem, not a format problem - but
    // some renderers reject unsupported types without fetching, so still try the next one.
    if (next) {
      this.log.warn(`Renderer ${why} as ${c.format} - trying ${next}`);
      this.#learnedFormat = null;
      await this.#load(c.video, c.startAt, next);
      return;
    }
    this.lastError = `Renderer ${why}`;
    this.log.error(`${this.lastError}.${c.fetched ? '' : ' Check that it can reach '
      + `http://${this.#ip}:${this.cfg.mediaPort} (firewall, ADVERTISE_IP).`}`);
    this.#stopPolling();
    await this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
  }

  /** Called once the renderer reaches PLAYING: remember what worked. */
  async #confirmFormat() {
    const f = this.#current?.format;
    if (!f || this.formatMode !== 'auto' || this.#learnedFormat === f) return;
    this.#learnedFormat = f;
    await this.#store?.set('tube2upnp.format', f);
    this.log.info(`Stream format "${f}" works on this renderer - remembered`);
  }

  async doPause() {
    return this.#ok('AVTransport', 'Pause', { InstanceID: 0 });
  }

  async doResume() {
    const c = this.#current;
    if (c?.stoppedAt != null) {
      // Stopped on the device (switched off, stop button): Play would start the track over,
      // or fail on a speaker in standby. Load it again where it stopped.
      this.log.info(`Resuming "${this.nowPlaying?.title ?? c.video.id}" at ${Math.floor(c.stoppedAt)}s`);
      const ok = await this.#load(c.video, c.stoppedAt, c.format);
      // Still off: keep the track where it was and keep watching the device.
      if (!ok && this.#current === c && !this.#destroyed) this.#startPolling();
      return ok;
    }
    return this.#ok('AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
  }

  async doStop() {
    // yt-cast-receiver's play() stops a PLAYING player first. If the renderer has already moved on
    // to the queued track by itself (gapless), that stop must not reach the device or forget the
    // switch, or doPlay() could not adopt the track: it would be cut off and reloaded from 0.
    // doPlay() adopts it, or #load stops the renderer itself when something else is to play.
    const switching = this.#advanced;
    this.#loadSeq++; // cancel any pending load
    this.#resetSkips();
    this.#position = null;
    this.#transport = 'STOPPED';
    this.#current = null;
    this.#queued = null;
    this.#advanced = switching;
    this.#stopPolling();
    this.#expectStop = true;
    const ok = switching ? true : await this.#ok('AVTransport', 'Stop', { InstanceID: 0 });
    this.nowPlaying = null;
    return ok;
  }

  async doSeek(position) {
    const c = this.#current;
    if (!c) return false;
    if (c.stoppedAt != null) { // nothing loaded on the device: just where to resume from
      c.stoppedAt = Math.max(0, position);
      return true;
    }
    c.lastRel = position;
    if (!FORMATS[c.format].seekable) {
      // Restart the stream from the new position. Takes a moment longer than a
      // native seek (ffmpeg has to reconnect), but works on every renderer.
      this.log.info(`Seek to ${Math.floor(position)}s by restarting the ${c.format} stream`);
      return this.#load(c.video, position, c.format);
    }
    if (await this.#ok('AVTransport', 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(position) })) return true;
    if (!FILE_FORMATS.includes(c.format)) return false;
    // Renderer rejected Seek: build a new file that starts at the position (still lossless).
    this.log.info(`Renderer rejected Seek - restarting ${c.format} at ${Math.floor(position)}s`);
    return this.#load(c.video, position, c.format, { offsetStart: true });
  }

  async doSetVolume(volume) {
    const okLevel = await this.#ok('RenderingControl', 'SetVolume',
      { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(volume.level) });
    // SetMute is optional in RenderingControl; don't fail the whole call if absent.
    await this.#safeCall('RenderingControl', 'SetMute',
      { InstanceID: 0, Channel: 'Master', DesiredMute: volume.muted ? 1 : 0 });
    if (okLevel) this.#volume = { raw: Math.round(volume.level), muted: Boolean(volume.muted) };
    return okLevel;
  }

  async doGetVolume() {
    const r = await this.#safeCall('RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' });
    const m = await this.#safeCall('RenderingControl', 'GetMute', { InstanceID: 0, Channel: 'Master' });
    const v = {
      level: r ? Number.parseInt(r.CurrentVolume, 10) || 0 : 50,
      muted: m ? ['1', 'true'].includes(String(m.CurrentMute).toLowerCase()) : false,
    };
    if (r) this.#volume = { raw: v.level, muted: v.muted };
    return v;
  }

  /** Read the volume for the status page (the device checks call this; so does playback polling). */
  async refreshVolume() {
    await this.#refreshUpnpVolume();
    if (this.#yxc) await this.#refreshVendor({ withPlayInfo: false });
    return this.#volume;
  }

  async #refreshUpnpVolume() {
    await this.doGetVolume();
    if (this.#scpd.rc?.actions.has('GetVolumeDB')) {
      const r = await this.#safeCall('RenderingControl', 'GetVolumeDB', { InstanceID: 0, Channel: 'Master' });
      const v = Number.parseInt(r?.CurrentVolume, 10);
      this.#volumeDb = Number.isFinite(v) ? Math.round((v / this.#volumeDbUnit) * 10) / 10 : null;
    }
  }

  /** Everything the status page shows besides our own playback. Called by the device checks. */
  async refreshStatus() {
    await this.#refreshUpnpVolume();
    if (this.#yxc) await this.#refreshVendor({ withPlayInfo: !this.#current });
    await this.#refreshExternal();
    if (this.#scpd.avt?.actions.has('GetCurrentTransportActions')) {
      const r = await this.#safeCall('AVTransport', 'GetCurrentTransportActions', { InstanceID: 0 });
      if (r) this.#allowedActions = (r.Actions ?? '').split(',').map((a) => a.trim()).filter(Boolean);
    }
  }

  /**
   * A Yamaha MusicCast device announces its YXC API in the description. Some Yamaha
   * descriptions don't, so for those the standard path is tried on the same host: on
   * port 80, where MusicCast serves it (the description is on another port, like 49154),
   * then on the description's port.
   */
  async #findYxc(desc) {
    if (desc.yxcBase) return new YamahaExtendedControl(desc.yxcBase);
    if (!/yamaha/i.test(desc.manufacturer)) return null;
    const loc = new URL(this.location);
    const bases = new Set([`http://${loc.hostname}/YamahaExtendedControl/v1/`,
      new URL('/YamahaExtendedControl/v1/', loc).toString()]);
    for (const base of bases) {
      const guess = new YamahaExtendedControl(base);
      if (await guess.works()) return guess;
    }
    return null;
  }

  /** The cover of what plays on another source, fetched once per URL (Yamaha changes the URL per track). */
  async #refreshArt(url) {
    if (url === (this.art?.url ?? null)) return;
    const img = url ? await fetchIcon(url, { maxBytes: 1024 * 1024 }).catch(() => null) : null;
    // Remember a failed URL too, so it isn't fetched again on every check. The version is
    // the image's hash, so the page's cached cover is never one from before a restart.
    this.art = url ? {
      url, type: img?.type ?? null, data: img?.data ?? null,
      version: img ? createHash('sha256').update(img.data).digest('hex').slice(0, 16) : null,
    } : null;
  }

  async #refreshVendor(opts) {
    try {
      const s = await this.#yxc.status(opts);
      // A volume-only read keeps what the last full read found playing.
      if (!opts.withPlayInfo && this.#vendor?.input === s.input) s.playing = this.#vendor.playing;
      if (!this.#vendor) this.log.debug(`Yamaha Extended Control: ${s.power}, input ${s.input}`);
      this.#vendor = s;
    } catch (err) {
      if (this.#vendor) this.log.debug('Yamaha Extended Control failed:', err.message);
      this.#vendor = null; // the UPnP numbers are shown instead
    }
  }

  /** Is the renderer busy with something else (Spotify, radio, another input)? Only asked while we're idle. */
  async #refreshExternal() {
    if (this.#current) {
      this.#external = null;
      this.art = null;
      return;
    }
    // UPnP only sees the device's own DLNA playback (its "server" input). YXC knows the
    // tuner, net radio, Spotify, HDMI... and that a speaker in standby plays nothing.
    const v = this.#vendor;
    if (v && (v.power !== 'on' || v.input !== 'server')) {
      const p = v.playing;
      const off = v.power !== 'on' || p?.playback === 'stop';
      await this.#refreshArt(off ? null : p?.art ?? null);
      this.#external = off ? null : {
        state: p?.playback === 'pause' ? 'PAUSED_PLAYBACK' : 'PLAYING',
        title: p?.title ?? null, artist: p?.artist ?? null, source: p?.station ?? v.inputText,
        art: this.art?.version ?? null,
      };
      return;
    }
    this.art = null;
    const state = await this.#transportState();
    if (state !== 'PLAYING' && state !== 'PAUSED_PLAYBACK') {
      this.#external = null;
      return;
    }
    const m = await this.#safeCall('AVTransport', 'GetMediaInfo', { InstanceID: 0 });
    const uri = m?.CurrentURI ?? '';
    if (/\/stream\/[0-9a-f]{32}\./.test(uri)) { // still one of ours
      this.#external = null;
      return;
    }
    const p = await this.#safeCall('AVTransport', 'GetPositionInfo', { InstanceID: 0 });
    const meta = didlTitle(p?.TrackMetaData) ?? didlTitle(m?.CurrentURIMetaData);
    this.#external = { state, title: meta?.title ?? null, artist: meta?.artist ?? null, source: sourceOf(uri) };
  }

  /** Volume as a percentage of the device's own range. */
  #volumeInfo() {
    // YXC has the master volume as the display shows it; RenderingControl may not follow it.
    const y = this.#vendor?.volume;
    if (y) {
      return {
        level: Math.round(((Math.min(y.max, Math.max(0, y.raw))) / y.max) * 100), raw: y.raw, min: 0, max: y.max,
        muted: y.muted, rangeKnown: true, db: y.db ?? this.#volumeDb,
      };
    }
    const v = this.#volume;
    if (!v) return null;
    const { min, max } = this.#volumeRange ?? { min: 0, max: 100 };
    const clamped = Math.min(max, Math.max(min, v.raw));
    return {
      level: Math.round(((clamped - min) / (max - min)) * 100), raw: v.raw, min, max, muted: v.muted,
      rangeKnown: Boolean(this.#volumeRange), db: this.#volumeDb,
    };
  }

  async doGetPosition() {
    const c = this.#current;
    if (c?.stoppedAt != null) return c.stoppedAt;
    const r = await this.#safeCall('AVTransport', 'GetPositionInfo', { InstanceID: 0 });
    // Right after a track change some renderers still report the previous track for a
    // moment. If the renderer names a different stream than ours, its numbers aren't ours.
    if (!r || this.#isStale(r.TrackURI)) return c?.startAt ?? 0;
    // The renderer counts from the start of the stream it got; add our ffmpeg offset.
    return parseHms(r.RelTime) + (c?.startAt ?? 0);
  }

  async doGetDuration() {
    // yt-dlp's duration is the video's real length. The renderer's TrackDuration can be
    // the previous track's (right after a switch), the remaining part of an offset
    // stream, or missing entirely, so it is only a fallback.
    if (this.nowPlaying?.duration) return this.nowPlaying.duration;
    const r = await this.#safeCall('AVTransport', 'GetPositionInfo', { InstanceID: 0 });
    return r && !this.#isStale(r.TrackURI) ? parseHms(r.TrackDuration) : 0;
  }

  /**
   * Did the track stop because it reached its end? Only when the renderer stopped close to
   * it. If its position never moved (some renderers report none), we can't tell: assume so.
   */
  #endedNaturally() {
    const c = this.#current;
    const dur = this.#position?.dur;
    if (!c || !dur || !((c.maxRel ?? 0) > c.startAt + 5)) return true;
    const slack = Math.max(10, (3 * this.cfg.pollIntervalMs) / 1000);
    return dur - (c.lastRel ?? 0) <= slack;
  }

  /** Does the renderer report a stream other than the one we're playing? */
  #isStale(trackUri) {
    const ours = this.#current?.streamPath;
    return Boolean(trackUri && ours && /^https?:/i.test(trackUri) && !trackUri.includes(ours));
  }

  // ------------------------------------------------------------------ internals

  /** Effective format setting: this renderer's override, else the global OUTPUT_FORMAT. */
  get formatMode() {
    return this.#formatOverride ?? this.cfg.outputFormat;
  }

  /**
   * Set this renderer's format ('auto', a format name, or null to follow OUTPUT_FORMAT).
   * Applies immediately: a playing track is reloaded at its current position.
   */
  async setFormatOverride(value) {
    if (value !== null && value !== 'auto' && !FORMATS[value]) throw new Error(`Unknown format "${value}"`);
    this.#formatOverride = value;
    await this.#store?.set('tube2upnp.formatOverride', value);
    this.log.info(value ? `Stream format set to "${value}" for this renderer` : 'Stream format follows the global setting again');
    this.#queued = null; // prepared next track may be in the old format
    const c = this.#current;
    if (c && this.status === PLAYER_STATUSES.PLAYING) {
      const pos = await this.doGetPosition();
      await this.#load(c.video, pos);
    }
  }

  async forgetLearnedFormat() {
    this.#learnedFormat = null;
    await this.#store?.set('tube2upnp.format', null);
    await this.#store?.set('upnptube.format', null); // pre-rename key
    this.log.info('Forgot the detected stream format - it will be detected again on the next track');
  }

  /** Everything the status page shows about this renderer. */
  statusInfo() {
    const p = this.#position;
    const playing = this.#transport === 'PLAYING';
    return {
      id: this.udn,
      name: this.name,
      friendlyName: this.description?.friendlyName ?? null,
      manufacturer: this.description?.manufacturer ?? '',
      model: modelText(this.description),
      address: this.address,
      advertisedIp: this.#ip,
      dialPort: this.port,
      receiver: this.receiverStatus,
      senders: this.connectedSenders.map((s) => s.user?.name ?? s.name),
      playerStatus: this.status,
      transport: this.#transport,
      nowPlaying: this.nowPlaying,
      // Position extrapolated from the last poll so the page's progress bar moves smoothly.
      position: p ? { rel: p.rel + (playing ? (Date.now() - p.at) / 1000 : 0), dur: p.dur, playing } : null,
      upNext: this.upNext,
      sponsorblock: this.#sb.videoId && this.#sb.videoId === this.#current?.video.id
        ? { segments: this.#sb.segments, skipped: this.#sb.skipped.size } : null,
      lastError: this.lastError,
      presentationURL: this.description?.presentationURL ?? null,
      icon: Boolean(this.icon),
      external: this.#external,
      power: this.#vendor?.power ?? null,
      actions: {
        supported: this.#scpd.avt ? [...this.#scpd.avt.actions].sort() : null,
        allowed: this.#allowedActions,
      },
      format: {
        mode: this.formatMode, override: this.#formatOverride, global: this.cfg.outputFormat,
        learned: this.#learnedFormat, current: this.#current?.format ?? null,
      },
      gapless: this.#gaplessSupported,
      sink: (this.#protocols ?? []).map((x) => x.contentFormat).filter(Boolean),
      soap: { ...this.#soap, avgMs: this.#soap.calls ? Math.round(this.#soap.totalMs / this.#soap.calls) : null },
      polls: this.#polls,
      volume: this.#volumeInfo(),
      lastSeenS: Math.round((Date.now() - this.lastSeen) / 1000),
    };
  }

  #chooseFormat(sourceMime) {
    if (this.formatMode !== 'auto') return this.formatMode;
    if (this.#learnedFormat) return this.#learnedFormat;
    // First format in the chain the renderer claims to support (unknown list = try it).
    return FALLBACK_CHAIN.find((f) => f === 'mp3'
      || sinkAccepts(this.#protocols, mimeOf(f, sourceMime)) !== false);
  }

  #nextFormat(format) {
    const i = FALLBACK_CHAIN.indexOf(format);
    return FALLBACK_CHAIN.slice(i + 1).find((f) => f === 'mp3'
      || sinkAccepts(this.#protocols, mimeOf(f, this.#current?.mime)) !== false) ?? null;
  }

  async #ok(service, action, params) {
    try {
      await this.#call(service, action, params);
      return true;
    } catch (err) {
      this.log.warn(`${action} failed:`, err.message);
      return false;
    }
  }

  async #safeCall(service, action, params) {
    try {
      return await this.#call(service, action, params);
    } catch (err) {
      this.log.debug(`${action} failed (ignored):`, err.message);
      return null;
    }
  }

  async #transportState() {
    const r = await this.#safeCall('AVTransport', 'GetTransportInfo', { InstanceID: 0 });
    return r?.CurrentTransportState ?? null;
  }

  async #waitForState(states, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (states.includes(await this.#transportState())) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  // Polling instead of GENA eventing: many cheap renderers have broken event
  // subscriptions, and eventing needs an inbound callback port through NAT/firewalls.
  #startPolling() {
    this.#stopPolling();
    if (this.#destroyed) return;
    this.#listen.lastTick = 0;
    this.#pollTimer = setInterval(() => {
      if (this.#polling) return; // a slow renderer must not stack up overlapping polls
      this.#polling = true;
      this.#poll().catch((err) => this.log.debug('Poll failed:', err.message)).finally(() => { this.#polling = false; });
    }, this.cfg.pollIntervalMs);
    this.#pollTimer.unref();
  }

  #stopPolling() {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  async #poll() {
    if (this.#expectStop) return;
    this.#polls++;
    const state = await this.#transportState();
    if (!state || this.#destroyed) return;
    this.#transport = state;
    if (state !== 'PLAYING') this.#listen.lastTick = 0; // paused/buffering time doesn't count
    // A knob or remote can change the volume during playback; keep the status page close behind.
    if (state === 'PLAYING' && this.#polls % 3 === 0) this.refreshVolume().catch(() => {});
    if (state === 'PLAYING' || state === 'PAUSED_PLAYBACK') {
      const r = await this.#safeCall('AVTransport', 'GetPositionInfo', { InstanceID: 0 });
      if (r) {
        let uri = r.TrackURI;
        if (!uri && this.#queued?.sentToRenderer) {
          uri = (await this.#safeCall('AVTransport', 'GetMediaInfo', { InstanceID: 0 }))?.CurrentURI;
        }
        const startAt = this.#current?.startAt ?? 0;
        // Keep the URI even when it isn't ours (that's how a gapless switch is noticed),
        // but don't take position/duration from a renderer still on the previous track.
        const stale = this.#isStale(uri);
        this.#position = {
          rel: stale ? (this.#position?.rel ?? startAt) : parseHms(r.RelTime) + startAt,
          dur: this.nowPlaying?.duration || (stale ? 0 : parseHms(r.TrackDuration)),
          uri, at: Date.now(),
        };
        const c = this.#current;
        if (!stale && c) {
          const rel = this.#position.rel;
          c.maxRel = Math.max(c.maxRel ?? 0, rel);
          // Where it really is. A jump back to the start mid-track is a renderer resetting its
          // clock (switching off, stopping), not playback: our own seeks set lastRel themselves.
          if (!(rel <= c.startAt + 1 && (c.lastRel ?? 0) > c.startAt + 5)) c.lastRel = rel;
          if (state === 'PLAYING' && rel > c.startAt + 1) c.stoppedAt = null; // started again on the device
        }
      }
    }
    if (this.#destroyed) return;

    // If the renderer hasn't reached PLAYING well after Play, assume it can't handle
    // the stream (typically YouTube's fragmented DASH M4A) and retry as MP3.
    if (!this.#sawPlaying && state !== 'PLAYING' && this.#current
        && this.status === PLAYER_STATUSES.PLAYING
        && Date.now() - this.#current.loadedAt > this.cfg.startTimeoutMs) {
      await this.#handleStartFailure();
      return;
    }

    if (state === 'PLAYING') {
      if (!this.#sawPlaying) await this.#confirmFormat();
      this.#sawPlaying = true;
      this.#countListen(); // before a gapless switch below hands over to the next track
      if (this.status === PLAYER_STATUSES.PAUSED) await this.notifyExternalStateChange(PLAYER_STATUSES.PLAYING);

      if (await this.#rendererAdvanced()) {
        // Renderer played on into the queued track. Advance YouTube's queue to match;
        // doPlay() sees #advanced and adopts the track instead of reloading it.
        this.#stopPolling();
        this.#advanced = this.#queued;
        this.#queued = null;
        this.log.info('Renderer continued into the next track');
        if (!(await this.next())) {
          this.#advanced = null;
          // Queue ended (the stop above skipped the device): stop the track it played on into.
          if (this.status === PLAYER_STATUSES.STOPPED) await this.#ok('AVTransport', 'Stop', { InstanceID: 0 });
        }
        return;
      }
      const c = this.#current;
      if (c?.resyncAt && Date.now() >= c.resyncAt && !this.#isStale(this.#position?.uri)
          && this.status === PLAYER_STATUSES.PLAYING) {
        c.resyncAt = 0;
        await this.notifyExternalStateChange(); // same status, the renderer's position now
      }
      this.#maintainNext().catch(() => {}); // background: don't hold up polling
      this.#checkSkip().catch((err) => this.log.debug('SponsorBlock check failed:', err.message));
    } else if (state === 'PAUSED_PLAYBACK') {
      if (this.status === PLAYER_STATUSES.PLAYING) await this.notifyExternalStateChange(PLAYER_STATUSES.PAUSED);
    } else if ((state === 'STOPPED' || state === 'NO_MEDIA_PRESENT') && this.#sawPlaying
               && this.status === PLAYER_STATUSES.PLAYING) {
      if (!this.#endedNaturally()) {
        // Switched off or stopped on the device mid-track: skipping would only send the next
        // track to a speaker in standby. Show it paused here; Play loads it again from here.
        const c = this.#current;
        c.stoppedAt = c.lastRel;
        this.log.info(`Stopped on the renderer at ${fmtSec(c.stoppedAt)} of ${fmtSec(this.#position.dur)}`
          + ' (switched off or stopped on the device) - pausing instead of skipping');
        await this.notifyExternalStateChange(PLAYER_STATUSES.PAUSED);
        return;
      }
      // Track ended on the renderer. Advance the YouTube queue - this is what makes
      // playlists/autoplay work.
      this.#stopPolling();
      this.log.info('Track finished on renderer - advancing queue');
      await this.next();
    }
  }
}

/** "RX-V4A", not "RX-V4A V4A": some devices repeat the model number in the name. */
function modelText(desc) {
  const name = desc?.modelName ?? '';
  const number = desc?.modelNumber ?? '';
  return number && !name.includes(number) ? [name, number].filter(Boolean).join(' ') : name;
}

/** A short name for where a URI the renderer plays comes from: a host, or a scheme like spotify. */
function sourceOf(uri) {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri ?? '')?.[1]?.toLowerCase();
  if (!scheme) return null;
  if (scheme === 'http' || scheme === 'https') {
    try {
      return new URL(uri).hostname;
    } catch {
      return null;
    }
  }
  return scheme.replace(/^x-(sonos-|rincon-)?/, ''); // x-sonos-spotify -> spotify
}

function hms(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function parseHms(t) {
  if (!t || /NOT_IMPLEMENTED/i.test(t)) return 0;
  const parts = t.split(':').map(Number.parseFloat);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}
