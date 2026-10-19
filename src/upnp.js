// UPnP helpers that upnp-device-client gets wrong:
//  * it only reads the ROOT device's serviceList, so renderers that are embedded
//    devices (Sonos, Denon/Marantz, Yamaha, many AVRs) fail with
//    "Service urn:upnp-org:serviceId:AVTransport not provided by device";
//  * it requires the exact serviceId "urn:upnp-org:serviceId:X", which some
//    vendors spell differently.
// We parse the description ourselves and pre-seed the client's cache with it.

import et from 'elementtree';
import { MIME_ALIASES } from './formats.js';

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
    icons: [],
    services,
  };
}

export async function fetchDescription(location, timeoutMs = 5000) {
  const res = await fetch(location, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${location}`);
  return parseDescription(await res.text(), location);
}

/** The allowed range of the RenderingControl Volume state variable, from its SCPD. */
export function parseVolumeRange(xml) {
  const root = et.parse(xml).getroot();
  for (const v of root.findall('.//stateVariable')) {
    if (text(v, 'name') !== 'Volume') continue;
    const min = Number.parseFloat(text(v, 'allowedValueRange/minimum'));
    const max = Number.parseFloat(text(v, 'allowedValueRange/maximum'));
    return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null;
  }
  return null;
}

export async function fetchVolumeRange(scpdUrl, timeoutMs = 5000) {
  if (!scpdUrl) return null;
  const res = await fetch(scpdUrl, { signal: AbortSignal.timeout(timeoutMs) });
  return res.ok ? parseVolumeRange(await res.text()) : null;
}

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
}[c]));

function hms(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** DIDL-Lite for SetAVTransportURI, with title/artist/cover so renderer displays show them. */
export function buildDidl({ url, protocolInfo, title, artist, album, albumArt, duration, isVideo }) {
  const cls = isVideo ? 'object.item.videoItem' : 'object.item.audioItem.musicTrack';
  return [
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
    '<item id="0" parentID="-1" restricted="1">',
    `<dc:title>${esc(title)}</dc:title>`,
    artist ? `<dc:creator>${esc(artist)}</dc:creator><upnp:artist>${esc(artist)}</upnp:artist>` : '',
    album ? `<upnp:album>${esc(album)}</upnp:album>` : '',
    albumArt ? `<upnp:albumArtURI>${esc(albumArt)}</upnp:albumArtURI>` : '',
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
