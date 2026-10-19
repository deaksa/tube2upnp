// All runtime configuration comes from environment variables, so the same image
// works for Docker, systemd and a plain `npm start`.

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
}

function str(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function regex(name) {
  const v = process.env[name];
  return v ? new RegExp(v, 'i') : null;
}

export const config = Object.freeze({
  // Logging: error | warn | info | debug
  logLevel: str('LOG_LEVEL', 'info'),

  // Each renderer gets its own DIAL/cast receiver on BASE_PORT, BASE_PORT+1, ...
  receiverBasePort: int('RECEIVER_BASE_PORT', 3000),

  // One shared HTTP server streams media to all renderers.
  mediaPort: int('MEDIA_PORT', 8000),

  // Status page with renderer list and "Link with TV code" pairing codes. 0 disables it.
  statusPort: int('STATUS_PORT', 8080),
  // Optional: address to bind the status page to (e.g. 127.0.0.1), and a token it requires.
  statusBind: str('STATUS_BIND', null),
  statusToken: str('STATUS_TOKEN', null),
  // Extra host names the status page answers to, besides IP addresses, localhost and this
  // machine's name (DNS rebinding protection). "*" allows any.
  statusHosts: str('STATUS_HOSTS', '').split(',').map((h) => h.trim()).filter(Boolean),

  // IP address renderers should use to reach us. Auto-detected per renderer if unset.
  advertiseIp: str('ADVERTISE_IP', null),

  // Re-scan interval (seconds) for new speakers.
  discoveryInterval: int('DISCOVERY_INTERVAL', 300),
  defaultMaxAge: int('DEFAULT_MAX_AGE', 1800),
  // Known speakers are checked directly this often (seconds); after this many missed
  // checks in a row one goes offline and its cast receiver stops.
  deviceCheckInterval: Math.max(5, int('DEVICE_CHECK_INTERVAL', 30)),
  deviceOfflineAfter: Math.max(1, int('DEVICE_OFFLINE_AFTER', 3)),

  // Only expose renderers whose friendly name matches INCLUDE and does not match EXCLUDE.
  include: regex('RENDERER_INCLUDE'),
  exclude: regex('RENDERER_EXCLUDE'),

  // Name shown in the YouTube cast menu. Placeholders: {name} {manufacturer} {model}
  nameTemplate: str('NAME_TEMPLATE', '🔊 {name}'),

  // yt-dlp
  ytdlpPath: str('YTDLP_PATH', 'yt-dlp'),
  ytdlpFormat: str('YTDLP_FORMAT', 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best'),
  ytdlpJsRuntime: str('YTDLP_JS_RUNTIME', 'node'),
  ytdlpExtraArgs: str('YTDLP_EXTRA_ARGS', '').split(' ').filter(Boolean),
  ytdlpTimeoutMs: int('YTDLP_TIMEOUT_MS', 45000),
  // Update yt-dlp every N hours (0 = never). YouTube breaks old yt-dlp versions regularly.
  ytdlpUpdateHours: int('YTDLP_UPDATE_HOURS', 24),
  ytdlpUpdateCmd: str('YTDLP_UPDATE_CMD', ''),

  // Stream format sent to renderers: auto | direct | mp4 | adts | flac | mp3 (see formats.js).
  // "auto" tries them in that order and remembers what works per renderer.
  // Legacy TRANSCODE=always|never maps to mp3|direct.
  outputFormat: (() => {
    const f = str('OUTPUT_FORMAT', '');
    if (f) {
      if (!['auto', 'direct', 'mp4', 'adts', 'flac', 'mp3'].includes(f)) throw new Error(`OUTPUT_FORMAT "${f}" is not valid`);
      return f;
    }
    return { always: 'mp3', never: 'direct' }[str('TRANSCODE', 'auto')] ?? 'auto';
  })(),
  ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
  mp3Bitrate: str('MP3_BITRATE', '192k'),
  // FLAC bit depth: 16 (CD, smaller, most compatible) or 24.
  flacBits: (() => {
    const b = int('FLAC_BITS', 16);
    if (b !== 16 && b !== 24) throw new Error('FLAC_BITS must be 16 or 24');
    return b;
  })(),

  // Disk cache for downloaded tracks and built mp4/flac files. Kept across restarts;
  // default DATA_DIR/cache.
  cacheDir: str('CACHE_DIR', null),
  cacheMb: int('CACHE_MB', 512),

  // Persistent data (screen IDs per renderer so phones remember them).
  dataDir: str('DATA_DIR', './data'),

  // How often to poll the renderer's transport state while something is playing (ms).
  pollIntervalMs: int('POLL_INTERVAL_MS', 2000),

  // Retry as MP3 if the renderer hasn't started playing this long after Play (ms).
  startTimeoutMs: int('START_TIMEOUT_MS', 12000),

  autoplayOnConnect: bool('AUTOPLAY', true),

  // SponsorBlock: skip community-marked segments (off by default; also switchable
  // on the status page, which then takes precedence).
  sponsorblock: bool('SPONSORBLOCK', false),
  sponsorblockCategories: str('SPONSORBLOCK_CATEGORIES', 'music_offtopic,sponsor,selfpromo,interaction')
    .split(',').map((c) => c.trim()).filter(Boolean),
  sponsorblockApi: str('SPONSORBLOCK_API', 'https://sponsor.ajay.app'),

  // Playback history (status page "History" view), in DATA_DIR/history.json. Play counts
  // are kept forever; the list of individual plays keeps the newest HISTORY_MAX entries.
  // A track counts once it has played HISTORY_MIN_PLAY_S seconds or half its length.
  history: bool('HISTORY', true),
  historyMax: int('HISTORY_MAX', 5000),
  historyMinPlayS: int('HISTORY_MIN_PLAY_S', 30),

  // Prepare the next track in the queue while the current one plays (instant skip).
  prefetch: bool('PREFETCH', true),
  // Also hand it to the renderer with SetNextAVTransportURI for gapless playback.
  gapless: bool('GAPLESS', true),
});
