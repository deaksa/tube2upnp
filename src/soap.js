// Minimal UPnP SOAP client. Replaces upnp-device-client's callAction, which:
//  * crashes the whole process (uncaught TypeError) when a renderer returns a
//    fault without <errorDescription> - seen in the wild on Pause;
//  * sends Content-Length as the JS string length, not the byte length, so any
//    non-ASCII metadata (accented titles!) truncates the request body.

import et from 'elementtree';
import { stats } from './stats.js';

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
}[c]));

export class UpnpError extends Error {
  constructor(message, { code, statusCode, errorCode } = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

/** Collect the children of the <u:{action}Response> element into a plain object. */
export function parseResponse(xml, action) {
  const root = et.parse(xml).getroot();
  let resp = null;
  root.iter('*', (e) => {
    if (!resp && (e.tag === `${action}Response` || e.tag.endsWith(`:${action}Response`))) resp = e;
  });
  const out = {};
  for (const child of resp?.getchildren() ?? []) {
    out[child.tag.split(':').pop()] = child.text?.trim() ?? '';
  }
  return out;
}

/** Best-effort fault parsing: never throws, whatever the renderer sends. */
export function parseFault(xml) {
  try {
    const root = et.parse(xml).getroot();
    let code = '';
    let desc = '';
    root.iter('*', (e) => {
      const tag = e.tag.split(':').pop();
      if (tag === 'errorCode') code = e.text?.trim() ?? '';
      if (tag === 'errorDescription') desc = e.text?.trim() ?? '';
      if (tag === 'faultstring' && !desc) desc = e.text?.trim() ?? '';
    });
    return { code, desc };
  } catch {
    return { code: '', desc: xml.slice(0, 200).replace(/\s+/g, ' ').trim() };
  }
}

// Common UPnP AVTransport error codes, for readable logs.
const ERROR_NAMES = {
  401: 'Invalid Action', 402: 'Invalid Args', 501: 'Action Failed',
  701: 'Transition not available', 702: 'No contents', 703: 'Read error',
  704: 'Format not supported for playback', 706: 'Illegal seek target',
  710: 'Seek mode not supported', 714: 'Illegal MIME-type', 716: 'Resource not found',
};

/**
 * @param {{serviceType:string, controlURL:string}} service
 * @param {string} action
 * @param {Record<string, string|number|null>} params
 */
export async function callAction(service, action, params = {}, timeoutMs = 8000) {
  const args = Object.entries(params).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${service.serviceType}">${args}</u:${action}></s:Body></s:Envelope>`;
  const buf = Buffer.from(body, 'utf8');

  let res;
  const started = Date.now();
  stats.inc('soap.calls');
  try {
    res = await fetch(service.controlURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': String(buf.length),
        SOAPACTION: `"${service.serviceType}#${action}"`,
      },
      body: buf,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    stats.inc('soap.errors');
    throw new UpnpError(`${action}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`, { code: 'ENETWORK' });
  }

  const text = await res.text();
  stats.time('soap', Date.now() - started);
  if (!res.ok) {
    stats.inc('soap.errors');
    const { code, desc } = parseFault(text);
    const name = desc || ERROR_NAMES[code] || `HTTP ${res.status}`;
    throw new UpnpError(`${action}: ${name}${code ? ` (${code})` : ''}`, {
      code: code === '401' ? 'ENOACTION' : 'EUPNP', statusCode: res.status, errorCode: code,
    });
  }
  try {
    return parseResponse(text, action);
  } catch {
    return {}; // Some renderers return junk on success; the call still worked.
  }
}

/** Parse GetProtocolInfo's Sink list into [{protocol, network, contentFormat, additionalInfo}]. */
export function parseSink(sink) {
  return (sink ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((line) => {
    const [protocol, network, contentFormat, additionalInfo] = line.split(':');
    return { protocol, network, contentFormat, additionalInfo };
  });
}
