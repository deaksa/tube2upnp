// Per-renderer persistent store. yt-cast-receiver's DefaultDataStore uses one shared
// node-persist directory, so every receiver in this process would read the same
// 'app.pid' / screenId - casts would land on the wrong speaker. Namespace it.

import fs from 'node:fs/promises';
import path from 'node:path';
import storage from 'node-persist';
import { DataStore } from 'yt-cast-receiver';

// The ID comes from the network (SSDP USN), so "." and ".." must not become path parts.
const dirFor = (baseDir, rendererId) => {
  const name = rendererId.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.resolve(baseDir, /^\.*$/.test(name) ? `_${name}` : name);
};

/** Delete a renderer's stored data (screen ID, detected format, settings) when it's removed. */
export async function removeRendererData(baseDir, rendererId, keep = []) {
  const dir = dirFor(baseDir, rendererId);
  // Only a renderer's own directory right under DATA_DIR: never DATA_DIR itself, its files
  // (settings.json, history.json, ...) or the media cache, whatever ID a device announces.
  if (path.dirname(dir) !== path.resolve(baseDir) || keep.map((k) => path.resolve(k)).includes(dir)) return;
  const st = await fs.stat(dir).catch(() => null);
  if (st?.isDirectory()) await fs.rm(dir, { recursive: true, force: true });
}

export class RendererDataStore extends DataStore {
  #ready;
  #store;

  constructor(baseDir, rendererId) {
    super();
    this.#store = storage.create({ dir: dirFor(baseDir, rendererId) });
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
