// One UPnP MediaRenderer exposed as one YouTube cast receiver.

import YouTubeCastReceiver, { Player, PLAYER_STATUSES, AUTOPLAY_MODES } from 'yt-cast-receiver';
import { RendererDataStore } from './dataStore.js';
import { fetchDescription, buildDidl, sinkAccepts } from './upnp.js';
import { localAddressFor } from './net.js';
import { callAction, parseSink, UpnpError } from './soap.js';
import { FORMATS, FALLBACK_CHAIN, FILE_FORMATS, dlnaFeatures, mimeOf } from './formats.js';
import { fmt as fmtSec } from './sponsorblock.js';
import { stats } from './stats.js';

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
  #polls = 0;
  #current = null;         // { video, format, startAt, loadedAt, fetched }
  #queued = null;          // prepared next track: { video, item, sentToRenderer }
  #advanced = null;        // queued track the renderer already switched to by itself
  #prefetching = false;
  #polling = false;
  #gaplessSupported = null; // null = unknown, learned from SetNextAVTransportURI

  /**
   * @param {object} p
   * @param {string} p.udn       - unique device id (from SSDP USN)
   * @param {string} p.location  - device description URL
   * @param {string} p.address   - renderer IP (SSDP source address)
   * @param {number} p.maxAge    - SSDP cache max-age in seconds
   * @param {number} p.port      - DIAL port for this receiver
   * @param {object} p.deps      - { config, resolver, mediaServer, logger, createReceiver? }
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
    this.media = deps.mediaServer;
    this.createReceiver = deps.createReceiver ?? ((player, opts) => new YouTubeCastReceiver(player, opts));
    this.baseLog = deps.logger;
    this.log = deps.logger.child(`[${address}]`);
    this.name = null;
    this.description = null;
    this.nowPlaying = null;
    this.lastError = null;
    this.refresh(maxAge);
  }

  refresh(maxAge = this.maxAge) {
    this.maxAge = maxAge;
    this.lastSeen = Date.now();
  }

  isStale() {
    // Allow a grace period: many devices re-announce exactly at max-age.
    return Date.now() - this.lastSeen > this.maxAge * 1000 * 1.5;
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
    });

    await this.#receiver.start();
    this.log.info(`Cast receiver "${this.name}" ready on ${this.#ip}:${this.port}`);
    return true;
  }

  async destroy() {
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
        await this.#safeCall('AVTransport', 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(position) });
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

    this.#prefetching = true;
    try {
      const item = await this.#prepareItem(up, 0);
      // Queue or current track changed while we were preparing? Try again next poll.
      if (this.getUpcomingVideo()?.id !== up.id || this.#current?.video.id !== currentId) return;
      this.#queued = { video: up, item, sentToRenderer: false };
      this.log.info(`Prepared next track "${item.info.title}" (${item.format})`);
      await this.#sendNextToRenderer();
    } catch (err) {
      this.log.warn(`Preparing next track ${up.id} failed: ${err.message}`);
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
    return this.#ok('AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
  }

  async doStop() {
    this.#loadSeq++; // cancel any pending load
    this.#resetSkips();
    this.#position = null;
    this.#transport = 'STOPPED';
    this.#current = null;
    this.#queued = null;
    this.#advanced = null;
    this.#stopPolling();
    this.#expectStop = true;
    const ok = await this.#ok('AVTransport', 'Stop', { InstanceID: 0 });
    this.nowPlaying = null;
    return ok;
  }

  async doSeek(position) {
    const c = this.#current;
    if (!c) return false;
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
    return okLevel;
  }

  async doGetVolume() {
    const r = await this.#safeCall('RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' });
    const m = await this.#safeCall('RenderingControl', 'GetMute', { InstanceID: 0, Channel: 'Master' });
    return {
      level: r ? Number.parseInt(r.CurrentVolume, 10) || 0 : 50,
      muted: m ? ['1', 'true'].includes(String(m.CurrentMute).toLowerCase()) : false,
    };
  }

  async doGetPosition() {
    const c = this.#current;
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
      model: [this.description?.modelName, this.description?.modelNumber].filter(Boolean).join(' '),
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
      format: {
        mode: this.formatMode, override: this.#formatOverride, global: this.cfg.outputFormat,
        learned: this.#learnedFormat, current: this.#current?.format ?? null,
      },
      gapless: this.#gaplessSupported,
      sink: (this.#protocols ?? []).map((x) => x.contentFormat).filter(Boolean),
      soap: { ...this.#soap, avgMs: this.#soap.calls ? Math.round(this.#soap.totalMs / this.#soap.calls) : null },
      polls: this.#polls,
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
    if (!state) return;
    this.#transport = state;
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
      }
    }

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
      if (this.status === PLAYER_STATUSES.PAUSED) await this.notifyExternalStateChange(PLAYER_STATUSES.PLAYING);

      if (await this.#rendererAdvanced()) {
        // Renderer played on into the queued track. Advance YouTube's queue to match;
        // doPlay() sees #advanced and adopts the track instead of reloading it.
        this.#stopPolling();
        this.#advanced = this.#queued;
        this.#queued = null;
        this.log.info('Renderer continued into the next track');
        if (!(await this.next())) this.#advanced = null;
        return;
      }
      this.#maintainNext().catch(() => {}); // background: don't hold up polling
      this.#checkSkip().catch((err) => this.log.debug('SponsorBlock check failed:', err.message));
    } else if (state === 'PAUSED_PLAYBACK') {
      if (this.status === PLAYER_STATUSES.PLAYING) await this.notifyExternalStateChange(PLAYER_STATUSES.PAUSED);
    } else if ((state === 'STOPPED' || state === 'NO_MEDIA_PRESENT') && this.#sawPlaying
               && this.status === PLAYER_STATUSES.PLAYING) {
      // Track ended on the renderer (or someone pressed stop on the device).
      // Advance the YouTube queue - this is what makes playlists/autoplay work.
      this.#stopPolling();
      this.log.info('Track finished on renderer - advancing queue');
      await this.next();
    }
  }
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
