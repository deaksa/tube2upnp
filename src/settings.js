// Runtime settings changed on the status page, persisted in DATA_DIR/settings.json.
// The .env / environment values are the defaults; a saved value wins until reset.

import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export class Settings extends EventEmitter {
  #file;
  #saved = {};

  constructor(config, logger) {
    super();
    this.cfg = config;
    this.log = logger;
    this.#file = path.resolve(config.dataDir, 'settings.json');
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

  get sponsorblock() {
    const s = this.#saved.sponsorblock ?? {};
    return {
      enabled: s.enabled ?? this.cfg.sponsorblock,
      categories: s.categories ?? this.cfg.sponsorblockCategories,
      fromEnv: s.enabled === undefined && s.categories === undefined,
    };
  }

  async setSponsorblock({ enabled, categories }) {
    const cur = this.#saved.sponsorblock ?? {};
    if (enabled !== undefined) cur.enabled = Boolean(enabled);
    if (categories !== undefined) cur.categories = categories;
    this.#saved.sponsorblock = cur;
    await this.#save();
    this.emit('change', 'sponsorblock');
  }

  /** Forget values saved from the status page, back to .env defaults. */
  async resetSponsorblock() {
    delete this.#saved.sponsorblock;
    await this.#save();
    this.emit('change', 'sponsorblock');
  }

  async #save() {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.#saved, null, 2));
    await fs.rename(tmp, this.#file);
  }
}
