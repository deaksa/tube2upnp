// Per-renderer persistent store. yt-cast-receiver's DefaultDataStore uses one shared
// node-persist directory, so every receiver in this process would read the same
// 'app.pid' / screenId - casts would land on the wrong speaker. Namespace it.

import path from 'node:path';
import storage from 'node-persist';
import { DataStore } from 'yt-cast-receiver';

export class RendererDataStore extends DataStore {
  #ready;
  #store;

  constructor(baseDir, rendererId) {
    super();
    const dir = path.resolve(baseDir, rendererId.replace(/[^A-Za-z0-9_.-]/g, '_'));
    this.#store = storage.create({ dir });
    this.#ready = this.#store.init();
  }

  async set(key, value) {
    await this.#ready;
    try {
      await this.#store.setItem(key, value);
    } catch (err) {
      this.logger?.error(`DataStore set '${key}' failed:`, err);
    }
  }

  async get(key) {
    await this.#ready;
    try {
      return (await this.#store.getItem(key)) ?? null;
    } catch (err) {
      this.logger?.error(`DataStore get '${key}' failed:`, err);
      return null;
    }
  }

  async clear() {
    await this.#ready;
    return this.#store.clear();
  }
}
