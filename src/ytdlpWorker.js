// Long-running yt-dlp processes (src/ytdlp_worker.py), so a lookup or download doesn't pay
// for starting Python and loading yt-dlp every time: about a second each on a small machine,
// which made the first track noticeably slow to start.
//
// A small pool: a resolve for the next track (prefetch) must not hold up the one the user
// just picked. Each process handles one request at a time. A process that times out is
// killed and replaced. If none can start (no Python with yt-dlp next to YTDLP_PATH, e.g. the
// standalone yt-dlp binary), the Resolver runs yt-dlp once per lookup, as before.

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./ytdlp_worker.py', import.meta.url));
const START_TIMEOUT_MS = 30000;
const MAX_FAILED_STARTS = 3;

/** The Python that can import yt-dlp: YTDLP_PYTHON, else the one next to YTDLP_PATH (a venv), else python3. */
export function pythonFor(config) {
  if (config.ytdlpPython) return config.ytdlpPython;
  let bin = config.ytdlpPath ?? '';
  try { bin = realpathSync(bin); } catch { /* a bare name on PATH, or missing */ }
  const dir = path.dirname(bin);
  if (dir && dir !== '.') {
    for (const name of ['python3', 'python']) {
      if (existsSync(path.join(dir, name))) return path.join(dir, name);
    }
  }
  return 'python3';
}

class Worker {
  #pending = null;
  #buf = '';
  stderr = '';
  dead = false;
  reserved = false;
  retire = false;
  served = 0;

  constructor(python, log) {
    this.log = log;
    // fd 3 carries the replies; yt-dlp's own output stays on stdout/stderr.
    this.proc = spawn(python, [SCRIPT], { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
    this.proc.stdio[3].setEncoding('utf8');
    this.proc.stdio[3].on('data', (d) => {
      this.#buf += d;
      for (let i; (i = this.#buf.indexOf('\n')) >= 0;) {
        const line = this.#buf.slice(0, i);
        this.#buf = this.#buf.slice(i + 1);
        this.#reply(line);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-4000);
      for (const line of d.split('\n')) if (line.trim()) this.log.debug('yt-dlp:', line.trim());
    });
    this.proc.stdin.on('error', () => {}); // it died; 'close' reports it
    this.proc.on('error', (err) => this.#exit(err));
    this.proc.on('close', (code, signal) => this.#exit(new Error(`yt-dlp worker exited (${signal ?? `code ${code}`})`
      + (this.stderr ? `: ${this.stderr.trim().split('\n').pop()}` : ''))));
  }

  request(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error('yt-dlp worker is not running'));
      const timer = setTimeout(() => {
        this.#pending = null;
        reject(Object.assign(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`), { kind: 'timeout' }));
        this.kill(); // whatever it was doing, it's stuck: start a fresh one next time
      }, timeoutMs);
      timer.unref?.();
      this.#pending = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.stderr = '';
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  #reply(line) {
    let r;
    try { r = JSON.parse(line); } catch { return; }
    const p = this.#pending;
    this.#pending = null;
    if (!p) return;
    if (r.ok) p.resolve(r.result);
    else p.reject(Object.assign(new Error(r.error || 'yt-dlp failed'), { stderr: this.stderr, kind: 'ytdlp' }));
  }

  #exit(err) {
    err.kind ??= 'exit';
    this.dead = true;
    const p = this.#pending;
    this.#pending = null;
    p?.reject(err);
  }

  kill() {
    this.dead = true;
    this.proc.kill('SIGKILL');
  }
}

export class YtdlpWorkers {
  #workers = [];
  #waiting = [];
  #ready = null;
  #failedStarts = 0;

  /**
   * @param {object} config - ytdlpPath, ytdlpPython?, ytdlpWorkers? (pool size, default 2)
   * @param {object} logger
   */
  constructor(config, logger) {
    this.python = pythonFor(config);
    this.size = Math.max(1, config.ytdlpWorkers ?? 2);
    this.log = logger;
  }

  /** Start the first process. Resolves to false if it can't run: callers then run yt-dlp per lookup. */
  start() {
    this.#ready ??= (async () => {
      try {
        const w = this.#spawn();
        const { version, fastJsc } = await w.request({ op: 'ping' }, START_TIMEOUT_MS);
        this.log.info(`yt-dlp ${version} stays loaded between lookups (up to ${this.size} process${this.size > 1 ? 'es' : ''})`
          + (fastJsc ? ', reusing the preprocessed YouTube player for JS challenges' : ''));
        return true;
      } catch (err) {
        this.log.info(`yt-dlp runs once per lookup (could not keep it loaded with ${this.python}: ${err.message})`);
        this.stop();
        return false;
      }
    })();
    return this.#ready;
  }

  /** Can requests go to a worker? (Starts the pool on first use.) */
  async ready() {
    return (await this.start()) && this.#failedStarts < MAX_FAILED_STARTS;
  }

  /**
   * Run one request on an idle worker, waiting for one if all are busy. Errors carry `kind`:
   * 'ytdlp' (yt-dlp's own answer, e.g. "Sign in to confirm..."), 'timeout' or 'exit' (the
   * process died; worth trying once without it).
   */
  async run(msg, timeoutMs) {
    const w = await this.#acquire();
    const fresh = w.served === 0;
    try {
      const result = await w.request(msg, timeoutMs);
      this.#failedStarts = 0;
      return result;
    } catch (err) {
      // A process that dies before it ever answers, over and over, isn't going to work.
      if (fresh && w.dead && ++this.#failedStarts >= MAX_FAILED_STARTS) {
        this.log.warn(`yt-dlp worker keeps exiting - running yt-dlp once per lookup from now on (${err.message})`);
      }
      throw err;
    } finally {
      w.served++;
      this.#release(w);
    }
  }

  /** Run the same request on every process of the pool (starting them), e.g. to warm them up. */
  async runOnAll(msg, timeoutMs) {
    if (!(await this.ready())) return [];
    // Concurrent requests take an idle process each, starting new ones up to the pool size.
    return Promise.allSettled(Array.from({ length: this.size }, () => this.run(msg, timeoutMs)));
  }

  /** After yt-dlp updated itself: replace the processes so the new version is loaded. */
  restart() {
    this.#failedStarts = 0; // a new version deserves another try
    for (const w of this.#workers) {
      w.retire = true;
      if (!w.reserved) this.#drop(w);
    }
  }

  stop() {
    for (const w of this.#workers) w.kill();
    this.#workers = [];
    for (const waiter of this.#waiting.splice(0)) waiter.reject(new Error('yt-dlp workers stopped'));
  }

  #spawn() {
    const w = new Worker(this.python, this.log);
    this.#workers.push(w);
    w.proc.on('close', () => { if (!w.reserved) this.#drop(w); });
    return w;
  }

  #drop(w) {
    this.#workers = this.#workers.filter((x) => x !== w);
    if (!w.dead) w.kill();
    // A waiting request may now start a process of its own.
    if (this.#waiting.length && this.#workers.length < this.size) this.#waiting.shift().resolve(this.#reserve(this.#spawn()));
  }

  #reserve(w) {
    w.reserved = true;
    return w;
  }

  #acquire() {
    const idle = this.#workers.find((w) => !w.reserved && !w.dead && !w.retire);
    if (idle) return Promise.resolve(this.#reserve(idle));
    if (this.#workers.filter((w) => !w.dead).length < this.size) return Promise.resolve(this.#reserve(this.#spawn()));
    return new Promise((resolve, reject) => this.#waiting.push({ resolve, reject }));
  }

  #release(w) {
    w.reserved = false;
    if (w.dead || w.retire) return this.#drop(w);
    const next = this.#waiting.shift();
    if (next) next.resolve(this.#reserve(w));
  }
}
