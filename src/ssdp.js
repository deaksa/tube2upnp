// Minimal SSDP client: M-SEARCH on every IPv4 interface + passive NOTIFY listener.
// (node-ssdp only receives notifications during a search, hence our own implementation.)

import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

export function lanInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

/** Parse an SSDP datagram into { startLine, headers } with UPPERCASE letter-only keys. */
export function parseMessage(buf) {
  const lines = buf.toString('utf8').split(/\r?\n/);
  const startLine = (lines.shift() ?? '').trim();
  const headers = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).toUpperCase().replace(/[^A-Z]/g, '');
    if (key) headers[key] = line.slice(i + 1).trim();
  }
  return { startLine, headers };
}

/** "uuid:abcd::urn:..." -> "abcd" */
export function udnFromUsn(usn) {
  const m = /uuid:([^:]+)/i.exec(usn ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** "max-age=1800, no-cache" -> 1800 */
export function maxAge(cacheControl, def) {
  const m = /max-age\s*=\s*(\d+)/i.exec(cacheControl ?? '');
  return m ? Number.parseInt(m[1], 10) : def;
}

export class Ssdp extends EventEmitter {
  #notifySocket = null;
  #searchSockets = [];

  constructor(logger) {
    super();
    this.log = logger;
  }

  /** Listen for NOTIFY (alive/byebye) on all interfaces. */
  listen() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => this.log.warn('SSDP notify socket error:', err.message));
    sock.on('message', (msg, rinfo) => this.#onNotify(msg, rinfo));
    sock.bind(SSDP_PORT, () => {
      for (const ifc of lanInterfaces()) {
        try {
          sock.addMembership(SSDP_ADDR, ifc.address);
        } catch (err) {
          this.log.debug(`addMembership on ${ifc.name} (${ifc.address}) failed: ${err.message}`);
        }
      }
    });
    this.#notifySocket = sock;
  }

  /** Send an M-SEARCH from every LAN interface. */
  search(st, mx = 3) {
    if (this.#searchSockets.length === 0) {
      const ifcs = lanInterfaces();
      if (ifcs.length === 0) this.log.warn('No non-internal IPv4 interface found - discovery will not work.');
      for (const ifc of ifcs) {
        const sock = dgram.createSocket('udp4');
        sock.on('error', (err) => this.log.warn(`SSDP search socket (${ifc.address}) error:`, err.message));
        sock.on('message', (msg, rinfo) => this.#onResponse(msg, rinfo));
        sock.bind(0, ifc.address);
        this.#searchSockets.push(sock);
      }
    }

    const msg = Buffer.from([
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      `MX: ${mx}`,
      `ST: ${st}`,
      '', '',
    ].join('\r\n'));

    for (const sock of this.#searchSockets) {
      sock.send(msg, SSDP_PORT, SSDP_ADDR, (err) => {
        if (err) this.log.warn('M-SEARCH send failed:', err.message);
      });
    }
  }

  close() {
    this.#notifySocket?.close();
    this.#notifySocket = null;
    for (const s of this.#searchSockets) s.close();
    this.#searchSockets = [];
  }

  #onResponse(buf, rinfo) {
    const { startLine, headers } = parseMessage(buf);
    const status = Number.parseInt(startLine.split(' ')[1], 10);
    if (status !== 200) {
      this.log.debug(`Ignoring SSDP response with status "${startLine}" from ${rinfo.address}`);
      return;
    }
    this.emit('alive', headers, rinfo);
  }

  #onNotify(buf, rinfo) {
    const { startLine, headers } = parseMessage(buf);
    if (!startLine.toUpperCase().startsWith('NOTIFY')) return;
    const nts = (headers.NTS ?? '').toLowerCase();
    if (nts.includes('ssdp:alive')) this.emit('alive', headers, rinfo);
    else if (nts.includes('ssdp:byebye')) this.emit('byebye', headers, rinfo);
  }
}
