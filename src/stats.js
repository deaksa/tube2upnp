// Process-wide counters and timings for the status page's "stats for nerds".

import os from 'node:os';

class Timer {
  #samples = [];
  count = 0;
  total = 0;

  add(ms) {
    this.count++;
    this.total += ms;
    this.#samples.push(ms);
    if (this.#samples.length > 200) this.#samples.shift();
  }

  summary() {
    const s = [...this.#samples].sort((a, b) => a - b);
    const q = (p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null);
    return {
      count: this.count,
      avg: this.count ? Math.round(this.total / this.count) : null,
      p50: q(0.5), p95: q(0.95), max: s.length ? Math.round(s[s.length - 1]) : null,
    };
  }
}

class Stats {
  started = Date.now();
  counters = {};
  gauges = {};
  timers = {};
  info = {};
  history = [];
  #lastCpu = process.cpuUsage();
  #lastAt = Date.now();
  #lastBytes = 0;

  inc(name, n = 1) { this.counters[name] = (this.counters[name] ?? 0) + n; }

  gauge(name, delta) { this.gauges[name] = Math.max(0, (this.gauges[name] ?? 0) + delta); }

  time(name, ms) { (this.timers[name] ??= new Timer()).add(ms); }

  /** Time an async function under `name`. */
  async measure(name, fn) {
    const t = Date.now();
    try { return await fn(); } finally { this.time(name, Date.now() - t); }
  }

  /** Sample CPU/memory/throughput every few seconds for the sparklines (10 min of history). */
  startSampling(intervalMs = 5000) {
    const t = setInterval(() => {
      const now = Date.now();
      const cpu = process.cpuUsage(this.#lastCpu);
      const wallUs = (now - this.#lastAt) * 1000;
      const bytes = this.counters['http.bytes'] ?? 0;
      const mem = process.memoryUsage();
      this.history.push({
        t: now,
        cpu: wallUs ? Math.round(((cpu.user + cpu.system) / wallUs) * 1000) / 10 : 0, // % of one core
        rss: mem.rss,
        heap: mem.heapUsed,
        kbps: Math.round(((bytes - this.#lastBytes) * 8) / ((now - this.#lastAt) || 1)), // kbit/s
        streams: this.gauges['http.active'] ?? 0,
      });
      if (this.history.length > 120) this.history.shift();
      this.#lastCpu = process.cpuUsage();
      this.#lastAt = now;
      this.#lastBytes = bytes;
    }, intervalMs);
    t.unref();
  }

  snapshot() {
    const mem = process.memoryUsage();
    return {
      uptimeS: Math.round((Date.now() - this.started) / 1000),
      info: {
        ...this.info,
        node: process.version,
        platform: `${os.type()} ${os.release()} (${process.arch})`,
        host: os.hostname(),
        cpus: `${os.cpus().length} × ${os.cpus()[0]?.model?.trim() ?? 'unknown'}`,
        loadavg: os.loadavg().map((x) => Math.round(x * 100) / 100),
      },
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
      counters: { ...this.counters },
      gauges: { ...this.gauges },
      timers: Object.fromEntries(Object.entries(this.timers).map(([k, v]) => [k, v.summary()])),
      history: this.history,
    };
  }
}

export const stats = new Stats();
