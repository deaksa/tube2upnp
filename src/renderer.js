// One UPnP MediaRenderer exposed as one YouTube cast receiver.

import YouTubeCastReceiver, { Player, PLAYER_STATUSES } from 'yt-cast-receiver';
import { RendererDataStore } from './dataStore.js';
import { fetchDescription, buildDidl, sinkAccepts } from './upnp.js';
import { localAddressFor } from './net.js';
import { callAction, parseSink, UpnpError } from './soap.js';
import { FORMATS, FALLBACK_CHAIN, FILE_FORMATS, dlnaFeatures, mimeOf } from './formats.js';

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
  #current = null;         // { video, format, startAt, loadedAt, fetched }

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

    this.#call = (svc, action, params) => {
      const service = desc.services[`urn:upnp-org:serviceId:${svc}`];
      if (!service) return Promise.reject(new UpnpError(`${svc} service not provided`, { code: 'ENOSERVICE' }));
      return callAction(service, action, params);
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
    const learned = await this.#store.get('upnptube.format');
    if (FORMATS[learned]) {
      this.#learnedFormat = learned;
      this.log.info(`Using previously detected stream format "${learned}"`);
    }

    this.#receiver = this.createReceiver(this, {
      // DIAL answers on every interface unless ADVERTISE_IP pins it (phone and speaker
      // may live on different VLANs).
      dial: { port: this.port, ...(this.cfg.advertiseIp ? { bindToAddresses: [this.cfg.advertiseIp] } : {}) },
      device: {
        name: this.name,
        screenName: this.name,
        brand: desc.manufacturer || 'upnpTube',
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
    try {
      if (this.#receiver?.status === 'running') await this.#receiver.stop();
    } catch (err) {
      this.log.warn('Error stopping receiver:', err.message);
    }
    this.#receiver = null;
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
      const info = await this.resolver.resolve(video.id);
      if (seq !== this.#loadSeq) return false; // superseded by a newer play()

      format ??= this.#chooseFormat(info.mime);
      const mime = mimeOf(format, info.mime);
      // Seekable formats start at 0 and use AVTransport Seek; streams start ffmpeg at the offset.
      const startAt = (offsetStart || !FORMATS[format].seekable) && position > 1 ? Math.floor(position) : 0;
      const current = { video, format, startAt, mime: info.mime, loadedAt: 0, fetched: false };
      const entry = {
        videoId: video.id, format, ext: info.ext, startAt,
        onRequest: () => {
          if (!current.fetched) this.log.info(`Renderer started fetching the stream (${format})`);
          current.fetched = true;
        },
      };
      await this.media.prepare(entry); // mp4/flac: build the file before the renderer asks for it
      if (seq !== this.#loadSeq) return false;
      const url = `http://${this.#ip}:${this.cfg.mediaPort}${this.media.register(entry)}`;
      const protocolInfo = `http-get:*:${mime}:${dlnaFeatures(format)}`;

      this.#expectStop = true;
      await this.#safeCall('AVTransport', 'Stop', { InstanceID: 0 });

      await this.#call('AVTransport', 'SetAVTransportURI', {
        InstanceID: 0,
        CurrentURI: url,
        CurrentURIMetaData: buildDidl({
          url, protocolInfo,
          title: info.title, artist: info.artist, album: info.album,
          albumArt: info.thumbnail, duration: Math.max(0, info.duration - startAt),
          isVideo: mime.startsWith('video/'),
        }),
      });
      await this.#call('AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
      if (seq !== this.#loadSeq) return false;

      if (position > 1 && !startAt) {
        await this.#waitForState(['PLAYING'], 8000);
        await this.#safeCall('AVTransport', 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(position) });
      }

      current.loadedAt = Date.now();
      this.#current = current;
      this.nowPlaying = { videoId: video.id, title: info.title, artist: info.artist, duration: info.duration, format };
      this.lastError = null;
      this.#sawPlaying = false;
      this.#expectStop = false;
      this.#startPolling();
      this.log.info(`Sent "${info.title}" to renderer as ${format} (${mime})`);
      return true;
    } catch (err) {
      this.lastError = err.message;
      this.log.error(`Play ${video.id} failed:`, err.message);
      this.#expectStop = false;
      return false;
    }
  }

  /** The renderer accepted the URL but never started playing: try the next format. */
  async #handleStartFailure() {
    const c = this.#current;
    const why = c.fetched ? 'fetched the stream but never started playing' : 'never requested the stream';
    const next = this.cfg.outputFormat === 'auto' ? this.#nextFormat(c.format) : null;
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
    if (!f || this.cfg.outputFormat !== 'auto' || this.#learnedFormat === f) return;
    this.#learnedFormat = f;
    await this.#store?.set('upnptube.format', f);
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
    this.#current = null;
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
    const r = await this.#safeCall('AVTransport', 'GetPositionInfo', { InstanceID: 0 });
    // The renderer counts from the start of the stream it got; add our ffmpeg offset.
    return (r ? parseHms(r.RelTime) : 0) + (this.#current?.startAt ?? 0);
  }

  async doGetDuration() {
    // For offset streams the renderer only knows the remaining length, if anything.
    if (this.#current?.startAt && this.nowPlaying?.duration) return this.nowPlaying.duration;
    const r = await this.#safeCall('AVTransport', 'GetPositionInfo', { InstanceID: 0 });
    const d = r ? parseHms(r.TrackDuration) : 0;
    return d || this.nowPlaying?.duration || 0;
  }

  // ------------------------------------------------------------------ internals

  #chooseFormat(sourceMime) {
    if (this.cfg.outputFormat !== 'auto') return this.cfg.outputFormat;
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
    this.#pollTimer = setInterval(() => this.#poll().catch(() => {}), this.cfg.pollIntervalMs);
    this.#pollTimer.unref();
  }

  #stopPolling() {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  async #poll() {
    if (this.#expectStop) return;
    const state = await this.#transportState();
    if (!state) return;

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
