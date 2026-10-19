// Stable DIAL port per renderer, persisted in DATA_DIR/ports.json.
// YouTube apps cache a receiver's address, so if a speaker's port changes across restarts
// (discovery order is a race), a cast to "Lamp" can land on whichever speaker now holds its old port.
// A speaker gets its remembered port back; ports remembered for other speakers are never handed out.

import fs from 'node:fs/promises';
import path from 'node:path';

export class PortRegistry {
  #file;
  #saved = {};
  #inUse = new Set();

  constructor(config, logger) {
    this.base = config.receiverBasePort;
    this.log = logger;
    this.#file = path.resolve(config.dataDir, 'ports.json');
  }

  async load() {
    try {
      this.#saved = JSON.parse(await fs.readFile(this.#file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`Ignoring unreadable ${this.#file}: ${err.message}`);
      this.#saved = {};
    }
    return this;
  }

  /** Reserve a port for udn: its remembered one if free, else the lowest port nobody holds or remembers. */
  claim(udn) {
    const mine = this.#saved[udn];
    if (Number.isInteger(mine) && !this.#inUse.has(mine)) {
      this.#inUse.add(mine);
      return mine;
    }
    const remembered = new Set(Object.values(this.#saved));
    let p = this.base;
    while (this.#inUse.has(p) || remembered.has(p)) p++;
    this.#inUse.add(p);
    return p;
  }

  /** Persist the port once the renderer is up, so devices that get filtered out don't reserve one. */
  async remember(udn, port) {
    if (this.#saved[udn] === port) return;
    this.#saved[udn] = port;
    try {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.#saved, null, 2));
      await fs.rename(tmp, this.#file);
    } catch (err) {
      this.log.warn(`Could not save ${this.#file}: ${err.message}`);
    }
  }

  release(port) {
    this.#inUse.delete(port);
  }
}
