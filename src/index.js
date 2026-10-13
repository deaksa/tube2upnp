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
import { readFileSync } from 'node:fs';
import { MediaServer } from './mediaServer.js';
import { Renderer } from './renderer.js';
import { startStatusServer } from './statusServer.js';

const RENDERER_ST = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const RETRY_FAILED_MS = 5 * 60 * 1000;

const log = new Logger(config.logLevel, '[upnpTube]');
const resolver = new Resolver(config, log.child('[yt-dlp]'));
const mediaServer = new MediaServer(config, resolver, log.child('[media]'));
const ssdp = new Ssdp(log.child('[ssdp]'));
const settings = new Settings(config, log.child('[settings]'));
const sponsorblock = new SponsorBlock(config, settings, log.child('[sponsorblock]'));

/** udn -> Renderer (running) */
const renderers = new Map();
/** udn -> { location, until } for devices that failed or were filtered out */
const skipped = new Map();
/** udn currently initialising */
const pending = new Set();
const usedPorts = new Set();

function allocPort() {
  let p = config.receiverBasePort;
  while (usedPorts.has(p)) p++;
  usedPorts.add(p);
  return p;
}

async function onAlive(headers, rinfo) {
  const type = headers.ST ?? headers.NT ?? '';
  if (!/urn:schemas-upnp-org:device:MediaRenderer:\d/.test(type)) return;

  const udn = udnFromUsn(headers.USN);
  const location = headers.LOCATION;
  if (!udn || !location) return;
  const age = maxAge(headers.CACHECONTROL, config.defaultMaxAge);

  const existing = renderers.get(udn);
  if (existing) {
    if (existing.location === location) {
      existing.refresh(age);
      return;
    }
    // Same device, new description URL (rebooted, DHCP change, random port): rebuild.
    log.info(`${existing.name} moved to ${location} - recreating`);
    await removeRenderer(udn);
  }

  const skip = skipped.get(udn);
  if (skip && skip.location === location && skip.until > Date.now()) return;
  if (pending.has(udn)) return;

  pending.add(udn);
  const port = allocPort();
  const r = new Renderer({
    udn, location, address: rinfo.address, maxAge: age, port,
    deps: { config, resolver, mediaServer, sponsorblock, logger: log },
  });
  try {
    const ok = await r.init();
    if (ok) {
      renderers.set(udn, r);
      skipped.delete(udn);
    } else {
      usedPorts.delete(port);
      skipped.set(udn, { location, until: Infinity });
    }
  } catch (err) {
    log.warn(`Could not set up renderer at ${location}: ${err.message} (retry in ${RETRY_FAILED_MS / 60000} min)`);
    await r.destroy();
    usedPorts.delete(port);
    skipped.set(udn, { location, until: Date.now() + RETRY_FAILED_MS });
  } finally {
    pending.delete(udn);
  }
}

async function removeRenderer(udn) {
  const r = renderers.get(udn);
  if (!r) return;
  renderers.delete(udn);
  await r.destroy();
  usedPorts.delete(r.port);
  log.info(`Removed renderer ${r.name}`);
}

function onByebye(headers) {
  const udn = udnFromUsn(headers.USN);
  if (udn && renderers.has(udn)) removeRenderer(udn);
}

function prune() {
  for (const [udn, r] of renderers) {
    if (r.isStale()) {
      log.info(`${r.name} not seen for ${Math.round((Date.now() - r.lastSeen) / 1000)} s - removing`);
      removeRenderer(udn);
    }
  }
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
  await Promise.allSettled([...renderers.keys()].map(removeRenderer));
  mediaServer.stop();
  process.exit(0);
}

async function main() {
  await settings.load();
  const unknown = config.sponsorblockCategories.filter((c) => !CATEGORIES[c]);
  if (unknown.length) log.warn(`Unknown SPONSORBLOCK_CATEGORIES ignored by SponsorBlock: ${unknown.join(', ')}`);
  const sb = settings.sponsorblock;
  log.info(`SponsorBlock ${sb.enabled ? `on (${sb.categories.join(', ')})` : 'off'}${sb.fromEnv ? '' : ' - set on the status page'}`);
  log.info('Starting upnpTube');
  await checkTools();
  stats.startSampling();
  scheduleYtdlpUpdates(config, log.child('[yt-dlp]'));
  await mediaServer.start();
  if (config.statusPort) startStatusServer(config, { renderers, mediaServer, settings }, log.child('[status]'));

  ssdp.on('alive', (h, rinfo) => onAlive(h, rinfo).catch((e) => log.error('alive handler:', e)));
  ssdp.on('byebye', onByebye);
  ssdp.listen();

  const search = () => ssdp.search(RENDERER_ST, 3);
  search();
  // A second search shortly after start catches devices that drop the first packet.
  setTimeout(search, 5000).unref();
  setInterval(search, config.discoveryInterval * 1000).unref();
  setInterval(prune, config.pruneInterval * 1000);

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
