#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { Logger } from './logger.js';
import { Ssdp, udnFromUsn, maxAge } from './ssdp.js';
import { Resolver, scheduleYtdlpUpdates, ytdlpVersion } from './resolver.js';
import { stats } from './stats.js';
import { Settings } from './settings.js';
import { SponsorBlock, CATEGORIES } from './sponsorblock.js';
import { History } from './history.js';
import { readFileSync } from 'node:fs';
import { MediaServer } from './mediaServer.js';
import { Renderer } from './renderer.js';
import { DeviceManager } from './devices.js';
import { removeRendererData } from './dataStore.js';
import { startStatusServer } from './statusServer.js';

const RENDERER_ST = 'urn:schemas-upnp-org:device:MediaRenderer:1';

const log = new Logger(config.logLevel, '[tube2upnp]');
const resolver = new Resolver(config, log.child('[yt-dlp]'));
const mediaServer = new MediaServer(config, resolver, log.child('[media]'));
const ssdp = new Ssdp(log.child('[ssdp]'));
const settings = new Settings(config, log.child('[settings]'));
const sponsorblock = new SponsorBlock(config, settings, log.child('[sponsorblock]'));
const history = config.history ? new History(config, log.child('[history]')) : null;

const devices = new DeviceManager(config, {
  logger: log.child('[devices]'),
  createRenderer: ({ udn, location, address, maxAge, port, onTerminate }) => new Renderer({
    udn, location, address, maxAge: maxAge ?? config.defaultMaxAge, port,
    deps: { config, resolver, mediaServer, sponsorblock, history, logger: log, onTerminate },
  }),
  probe: async (location) => {
    try {
      const res = await fetch(location, { signal: AbortSignal.timeout(5000) });
      await res.arrayBuffer();
      return res.ok;
    } catch {
      return false;
    }
  },
  removeData: (udn) => removeRendererData(config.dataDir, udn, [mediaServer.cacheDir]),
});

function onAlive(headers, rinfo) {
  const type = headers.ST ?? headers.NT ?? '';
  if (!/urn:schemas-upnp-org:device:MediaRenderer:\d/.test(type)) return;
  const udn = udnFromUsn(headers.USN);
  const location = headers.LOCATION;
  if (!udn || !location) return;
  devices.seen({ udn, location, address: rinfo.address, maxAge: maxAge(headers.CACHECONTROL, config.defaultMaxAge) })
    .catch((e) => log.error('alive handler:', e));
}

function onByebye(headers) {
  // Only the MediaRenderer's own byebye: a root or service notice isn't the speaker leaving.
  if (!/urn:schemas-upnp-org:device:MediaRenderer:\d/.test(headers.NT ?? '')) return;
  const udn = udnFromUsn(headers.USN);
  if (udn) devices.gone(udn).catch((e) => log.error('byebye handler:', e));
}

async function checkTools() {
  stats.info.version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  stats.info.ytdlp = await ytdlpVersion(config);
  if (stats.info.ytdlp) log.info(`yt-dlp ${stats.info.ytdlp}`);
  else {
    log.error(`yt-dlp not found or not runnable at "${config.ytdlpPath}"`);
    log.error('Install it (pip install -U "yt-dlp[default]") or set YTDLP_PATH.');
  }
  try {
    const { stdout } = await promisify(execFile)(config.ffmpegPath, ['-version'], { timeout: 15000 });
    stats.info.ffmpeg = /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? 'unknown';
  } catch {
    stats.info.ffmpeg = null;
    log.warn('ffmpeg not found - only OUTPUT_FORMAT=direct will work');
  }
}

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${sig} received - stopping receivers so they leave the cast menu`);
  ssdp.close();
  await devices.stopAll();
  mediaServer.stop();
  resolver.workers?.stop();
  await history?.flush();
  process.exit(0);
}

async function main() {
  await settings.load();
  await history?.load();
  await devices.load();
  const unknown = config.sponsorblockCategories.filter((c) => !CATEGORIES[c]);
  if (unknown.length) log.warn(`Unknown SPONSORBLOCK_CATEGORIES ignored by SponsorBlock: ${unknown.join(', ')}`);
  const sb = settings.sponsorblock;
  log.info(`SponsorBlock ${sb.enabled ? `on (${sb.categories.join(', ')})` : 'off'}${sb.fromEnv ? '' : ' - set on the status page'}`);
  log.info('Starting Tube2U[PnP] (a fork of upnpTube)');
  await checkTools();
  stats.startSampling();
  scheduleYtdlpUpdates(config, log.child('[yt-dlp]'), resolver.workers);
  // Load yt-dlp now, not when the first track is cast.
  resolver.workers?.start();
  await mediaServer.start();
  const search = () => ssdp.search(RENDERER_ST, 3);
  if (config.statusPort) {
    startStatusServer(config, { devices, mediaServer, settings, history, rediscover: search }, log.child('[status]'));
  }

  ssdp.on('alive', onAlive);
  ssdp.on('byebye', onByebye);
  ssdp.listen();

  // Known speakers come up on their own ports right away, without waiting for SSDP.
  devices.checkAll();
  search();
  // A second search shortly after start catches devices that drop the first packet.
  setTimeout(search, 5000).unref();
  setInterval(search, config.discoveryInterval * 1000).unref();
  setInterval(() => devices.checkAll(), config.deviceCheckInterval * 1000);

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
