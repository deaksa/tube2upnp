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

  // IP address renderers should use to reach us. Auto-detected per renderer if unset.
  advertiseIp: str('ADVERTISE_IP', null),

  // Re-scan interval and stale-renderer check interval (seconds).
  discoveryInterval: int('DISCOVERY_INTERVAL', 300),
  pruneInterval: int('PRUNE_INTERVAL', 60),
  defaultMaxAge: int('DEFAULT_MAX_AGE', 1800),

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

  // Transcoding: "auto" (only if the renderer doesn't advertise the source type),
  // "always" (always send MP3) or "never".
  transcode: str('TRANSCODE', 'auto'),
  ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
  mp3Bitrate: str('MP3_BITRATE', '192k'),

  // Persistent data (screen IDs per renderer so phones remember them).
  dataDir: str('DATA_DIR', './data'),

  // How often to poll the renderer's transport state while something is playing (ms).
  pollIntervalMs: int('POLL_INTERVAL_MS', 2000),

  // Retry as MP3 if the renderer hasn't started playing this long after Play (ms).
  startTimeoutMs: int('START_TIMEOUT_MS', 12000),

  autoplayOnConnect: bool('AUTOPLAY', true),
});
