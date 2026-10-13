const LEVELS = { none: -1, error: 0, warn: 1, info: 2, debug: 3 };

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
    const ts = new Date().toISOString();
    const head = `${ts} ${lvl.toUpperCase().padEnd(5)}${this.prefix ? ' ' + this.prefix : ''}`;
    fn(head, ...msg);
  }

  error(...m) { this.#out('error', console.error, m); }
  warn(...m) { this.#out('warn', console.warn, m); }
  info(...m) { this.#out('info', console.log, m); }
  debug(...m) { this.#out('debug', console.log, m); }
}
