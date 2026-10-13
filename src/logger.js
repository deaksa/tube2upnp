import { inspect } from 'node:util';

const LEVELS = { none: -1, error: 0, warn: 1, info: 2, debug: 3 };

// Recent log lines kept in memory for the status page (shared by all loggers).
const RING_SIZE = 2000;
const ring = [];
const listeners = new Set();
let seq = 0;

const fmt = (m) => m.map((x) => (typeof x === 'string' ? x
  : x instanceof Error ? (x.stack || x.message) : inspect(x, { depth: 3, breakLength: 160 }))).join(' ');

/** Log lines with id > afterId (oldest first). */
export function recentLogs(afterId = 0, limit = RING_SIZE) {
  const out = ring.filter((l) => l.id > afterId);
  return out.slice(-limit);
}

/** Subscribe to new log lines; returns an unsubscribe function. */
export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Implements yt-cast-receiver's Logger interface (error/warn/info/debug/setLevel).
export class Logger {
  constructor(level = 'info', prefix = '') {
    this.prefix = prefix;
    this.setLevel(level);
  }

  setLevel(level) {
    this.level = LEVELS[level] ?? LEVELS.info;
  }

  child(prefix) {
    const l = new Logger('info', this.prefix ? `${this.prefix} ${prefix}` : prefix);
    l.level = this.level;
    return l;
  }

  #out(lvl, fn, msg) {
    if (this.level < LEVELS[lvl]) return;
    const ts = new Date();
    const head = `${ts.toISOString()} ${lvl.toUpperCase().padEnd(5)}${this.prefix ? ' ' + this.prefix : ''}`;
    fn(head, ...msg);

    const line = { id: ++seq, ts: ts.getTime(), level: lvl, prefix: this.prefix, text: fmt(msg) };
    ring.push(line);
    if (ring.length > RING_SIZE) ring.shift();
    for (const l of listeners) {
      try { l(line); } catch { /* a broken subscriber must not break logging */ }
    }
  }

  error(...m) { this.#out('error', console.error, m); }
  warn(...m) { this.#out('warn', console.warn, m); }
  info(...m) { this.#out('info', console.log, m); }
  debug(...m) { this.#out('debug', console.log, m); }
}
