// UPnP helpers that upnp-device-client gets wrong:
//  * it only reads the ROOT device's serviceList, so renderers that are embedded
//    devices (Sonos, Denon/Marantz, Yamaha, many AVRs) fail with
//    "Service urn:upnp-org:serviceId:AVTransport not provided by device";
//  * it requires the exact serviceId "urn:upnp-org:serviceId:X", which some
//    vendors spell differently.
// We parse the description ourselves and pre-seed the client's cache with it.

import et from 'elementtree';
import { MIME_ALIASES } from './formats.js';
import { yxcBaseFrom } from './yamaha.js';

const MEDIA_RENDERER = /urn:schemas-upnp-org:device:MediaRenderer:\d/;

function text(node, tag) {
  return node?.findtext(tag)?.trim() ?? '';
}

function findRendererDevice(root) {
  const stack = [root.find('./device')].filter(Boolean);
  while (stack.length) {
    const dev = stack.shift();
    if (MEDIA_RENDERER.test(text(dev, 'deviceType'))) return dev;
    stack.push(...dev.findall('./deviceList/device'));
  }
  return null;
}

/** Parse a device description XML into the shape upnp-device-client caches. */
export function parseDescription(xml, location) {
  const doc = et.parse(xml);
  const root = doc.getroot();
  const base = text(root, 'URLBase') || location;
  const dev = findRendererDevice(doc) ?? doc.find('./device');
  if (!dev) throw new Error('No <device> element in description');

  const abs = (u) => (u ? new URL(u, base).toString() : '');
  // Shown as a link and fetched (icons): only plain web URLs, nothing like javascript: or file:.
  const webUrl = (u) => {
    try {
      const url = new URL(u, base);
      return /^https?:$/.test(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  };
  // Embedded renderers often leave the web page and icons to the root device.
  const rootDev = doc.find('./device');
  const pick = (fn) => fn(dev) || (rootDev && rootDev !== dev ? fn(rootDev) : null);
  const services = {};
  for (const s of dev.findall('./serviceList/service')) {
    const serviceId = text(s, 'serviceId');
    const short = serviceId.split(':').pop(); // AVTransport, RenderingControl, ConnectionManager
    services[`urn:upnp-org:serviceId:${short}`] = {
      serviceType: text(s, 'serviceType'),
      SCPDURL: abs(text(s, 'SCPDURL')),
      controlURL: abs(text(s, 'controlURL')),
      eventSubURL: abs(text(s, 'eventSubURL')),
    };
  }

  return {
    deviceType: text(dev, 'deviceType'),
    friendlyName: text(dev, 'friendlyName') || 'Unknown renderer',
    manufacturer: text(dev, 'manufacturer'),
    modelName: text(dev, 'modelName'),
    modelNumber: text(dev, 'modelNumber'),
    modelDescription: text(dev, 'modelDescription'),
    UDN: text(dev, 'UDN'),
    presentationURL: pick((d) => (text(d, 'presentationURL') ? webUrl(text(d, 'presentationURL')) : null)),
    icons: pick((d) => {
      const icons = d.findall('./iconList/icon').map((i) => ({
        url: webUrl(text(i, 'url')), mimetype: text(i, 'mimetype').toLowerCase(),
        width: Number.parseInt(text(i, 'width'), 10) || 0, height: Number.parseInt(text(i, 'height'), 10) || 0,
      })).filter((i) => i.url);
      return icons.length ? icons : null;
    }) ?? [],
    yxcBase: yxcBaseFrom(root, location),
    services,
  };
}

/** The icon to show on the status page: a raster image, closest to 64 px, PNG preferred. */
export function pickIcon(icons) {
  const raster = icons.filter((i) => /^image\/(png|jpeg|gif)$/.test(i.mimetype));
  const score = (i) => Math.abs((i.width || 64) - 64) + (i.mimetype === 'image/png' ? 0 : 8);
  return raster.sort((a, b) => score(a) - score(b))[0] ?? null;
}

export async function fetchDescription(location, timeoutMs = 5000) {
  const res = await fetch(location, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${location}`);
  return parseDescription(await res.text(), location);
}

/**
 * A service description (SCPD): the actions the device implements, and the allowed
 * ranges of its state variables (RenderingControl leaves the Volume scale to the device).
 */
export function parseScpd(xml) {
  const root = et.parse(xml).getroot();
  const actions = new Set(root.findall('.//action').map((a) => text(a, 'name')).filter(Boolean));
  const ranges = {};
  for (const v of root.findall('.//stateVariable')) {
    const min = Number.parseFloat(text(v, 'allowedValueRange/minimum'));
    const max = Number.parseFloat(text(v, 'allowedValueRange/maximum'));
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) ranges[text(v, 'name')] = { min, max };
  }
  return { actions, ranges };
}

export async function fetchScpd(scpdUrl, timeoutMs = 5000) {
  if (!scpdUrl) return null;
  const res = await fetch(scpdUrl, { signal: AbortSignal.timeout(timeoutMs) });
  return res.ok ? parseScpd(await res.text()) : null;
}

const ICON_TYPES = /^image\/(png|jpeg|gif)$/;
const MAX_ICON_BYTES = 256 * 1024;

/**
 * Fetch a device icon (or cover) to serve from the status page (its CSP doesn't allow
 * LAN http images). Raster images only, and not too big: the bytes are kept in memory.
 */
export async function fetchIcon(url, { timeoutMs = 5000, maxBytes = MAX_ICON_BYTES } = {}) {
  // No redirects: covers are only fetched from the device itself, a redirect could go anywhere.
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!res.ok || !ICON_TYPES.test(type)) return null;
  if (Number(res.headers.get('content-length')) > maxBytes) return null;
  const data = Buffer.from(await res.arrayBuffer());
  return data.length && data.length <= maxBytes ? { type, data } : null;
}

/** Title (and artist) from a DIDL-Lite metadata string, for "playing another source". */
export function didlTitle(didl) {
  if (!didl || !/<DIDL-Lite/i.test(didl)) return null;
  try {
    const root = et.parse(didl).getroot();
    let title = null;
    let artist = null;
    root.iter('*', (e) => {
      const tag = e.tag.split(':').pop();
      if (tag === 'title' && !title) title = e.text?.trim() || null;
      if ((tag === 'creator' || tag === 'artist') && !artist) artist = e.text?.trim() || null;
    });
    return title ? { title, artist } : null;
  } catch {
    return null;
  }
}

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
}[c]));

function hms(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** DIDL-Lite for SetAVTransportURI, with title/artist/cover so renderer displays show them. */
export function buildDidl({ url, protocolInfo, title, artist, album, albumArt, albumArtProfile, duration, isVideo }) {
  const cls = isVideo ? 'object.item.videoItem' : 'object.item.audioItem.musicTrack';
  return [
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"',
    ' xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">',
    '<item id="0" parentID="-1" restricted="1">',
    `<dc:title>${esc(title)}</dc:title>`,
    artist ? `<dc:creator>${esc(artist)}</dc:creator><upnp:artist>${esc(artist)}</upnp:artist>` : '',
    album ? `<upnp:album>${esc(album)}</upnp:album>` : '',
    albumArt ? `<upnp:albumArtURI${albumArtProfile ? ` dlna:profileID="${esc(albumArtProfile)}"` : ''}>${esc(albumArt)}</upnp:albumArtURI>` : '',
    `<upnp:class>${cls}</upnp:class>`,
    `<res protocolInfo="${esc(protocolInfo)}"${duration ? ` duration="${hms(duration)}.000"` : ''}>${esc(url)}</res>`,
    '</item></DIDL-Lite>',
  ].join('');
}

/**
 * Does the renderer's GetProtocolInfo sink list accept this MIME type?
 * Returns null if unknown (no list), so callers can fall back to trying.
 */
export function sinkAccepts(protocols, mime) {
  if (!protocols?.length) return null;
  const [type] = mime.split('/');
  const names = [mime, ...(MIME_ALIASES[mime] ?? [])];
  return protocols.some((p) => {
    const cf = (p.contentFormat ?? '').toLowerCase();
    return p.protocol === 'http-get' && (cf === '*' || cf === `${type}/*` || names.includes(cf));
  });
}
