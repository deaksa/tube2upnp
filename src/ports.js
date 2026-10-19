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
  #writing = Promise.resolve();

  constructor(config, logger) {
    this.base = config.receiverBasePort;
    this.log = logger;
    this.#file = path.resolve(config.dataDir, 'ports.json');
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      // Valid JSON can still be the wrong shape (null, [], a hand edit); claim() would then
      // throw for every speaker and none of them would come up.
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
      this.#saved = Object.fromEntries(Object.entries(data)
        .filter(([, p]) => Number.isInteger(p) && p > 0 && p < 65536));
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
  remember(udn, port) {
    if (this.#saved[udn] === port) return this.#writing;
    this.#saved[udn] = port;
    // Several speakers come up at once; writes share one temp file, so run them one at a time.
    this.#writing = this.#writing.then(() => this.#save());
    return this.#writing;
  }

  async #save() {
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
