# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tube2U[PnP] (package `tube2upnp`): a Node.js (ESM, Node ≥22, CI and Docker use 24) service that discovers UPnP/DLNA MediaRenderers on the LAN and exposes each one as a YouTube cast receiver (via `yt-cast-receiver` 2.x). yt-dlp resolves video IDs; ffmpeg remuxes/transcodes. Fork of upnpTube; the README is the user-facing spec for behaviour and all env vars.

## Commands

```sh
npm ci
npm run lint                                   # eslint src test
npm test                                       # node --test 'test/**/*.test.js'
node --test test/renderer.test.js              # single file
node --test --test-name-pattern="gapless" test/renderer.test.js   # single test by name
npm start                                      # node src/index.js (needs yt-dlp on PATH; ffmpeg optional)
```

Tests need no network. `test/remux.test.js` runs real ffmpeg/ffprobe round-trips and skips itself when ffmpeg isn't installed (CI installs it). No build step; plain JS with no TypeScript.

Running the actual service needs multicast on the LAN (SSDP/DIAL), so Docker Desktop on Windows/macOS won't work. Run natively or on a Linux host with `network_mode: host`.

## Architecture

`src/index.js` is the composition root. It builds singletons (`Resolver`, `MediaServer`, `Ssdp`, `Settings`, `SponsorBlock`, `DeviceManager`) and feeds SSDP alive/byebye to the `DeviceManager`.

**`DeviceManager` (src/devices.js)** owns the speakers. Each one found is remembered in `DATA_DIR/devices.json` with a fixed DIAL port (`RECEIVER_BASE_PORT` and up), because YouTube apps cache a receiver's address and discovery order is a race. Devices are keyed by UDN, not URL; a changed LOCATION restarts the renderer on the same port. Remembered speakers are probed directly (GET of their description) every `DEVICE_CHECK_INTERVAL` s: `DEVICE_OFFLINE_AFTER` misses (twice that while playing) or a byebye take one offline, which destroys its `Renderer` so the receiver leaves the cast menu; an answer brings it back. States: starting, online, offline, error (retried after 5 min, 30 s after a receiver `terminate`), ignored. Filtered devices (`init()` false) and new devices that fail are not listed or remembered. A port remembered for an offline speaker is never handed to another; **Remove** (offline only) and **Ignore** free it and delete the speaker's data dir (`removeRendererData`, which refuses anything but a renderer dir right under `DATA_DIR`, since the UDN comes from the network). State changes per speaker are serialized (`#serial`). The manager takes `createRenderer` and `probe`, so tests run without a network.

**`Renderer` (src/renderer.js)** is the core. It extends yt-cast-receiver's `Player` and implements `doPlay/doPause/doResume/doStop/doSeek/doSetVolume/doGetPosition/...` by issuing SOAP calls to the device. Key points that span the file:
- **Polling, not GENA eventing.** `#poll()` (every `POLL_INTERVAL_MS`) drives everything: end-of-track detection (calls `this.next()` to advance the YouTube queue), start-failure fallback to the next format, gapless-switch detection, next-track prefetch (`#maintainNext`), and SponsorBlock skips (`#checkSkip`).
- **Unplayable tracks:** when `#prepareItem` fails in `doPlay` (yt-dlp, download: `#trackFailed`), `#skipUnplayable` calls `this.next()` once `Player.play()` has reported STOPPED. At most `MAX_UNPLAYABLE_IN_A_ROW` (5) in a row, reset by any track that loads. Device errors (a SOAP fault on Play) are not skipped.
- **`#loadSeq`** invalidates stale async loads when the user skips quickly. Any new async path that loads media must check it after each await.
- **`#destroyed`**: after `destroy()` (device gone), in-flight loads, prefetches and polls must not restart polling or touch the device.
- **`#expectStop`** suppresses poll reactions while *we* are stopping or switching the renderer.
- **Format selection:** per-renderer override (status page) → global `OUTPUT_FORMAT` → in `auto`, the learned format, else the first in `FALLBACK_CHAIN` the renderer's sink protocols accept. A format is "learned" (persisted) once the renderer reaches PLAYING.
- **Gapless:** the next track is prepared via `#prepareItem` and sent with `SetNextAVTransportURI`. When the renderer's URI switches to the queued stream path, `#advanced` is set and `this.next()` is called. `doPlay` then *adopts* the track instead of reloading it.
- **Offset streams:** non-seekable formats (and file formats when the renderer rejects Seek) restart ffmpeg at `startAt`. Renderer-reported positions are relative to the stream, so `startAt` is added back. `#isStale(trackUri)` ignores renderer numbers that belong to the previous track.

**`MediaServer` (src/mediaServer.js)** is one HTTP server for all renderers. `register(entry)` returns a short `/stream/<32-hex-token>.<ext>` path; unknown tokens get a 404 (it must never become an open proxy). Per format (`src/formats.js` is the single source of truth for formats, MIME types, DLNA flags and fallback order):
- `direct`: proxies googlevideo with Range passthrough. It re-resolves once on 403/410.
- `adts` / `mp3`: an ffmpeg pipe from the URL. If YouTube refuses ffmpeg before any audio is sent, it retries with a fresh extraction, then from the yt-dlp download. Headers go out with the first audio byte, so a total failure is a 502.
- `mp4` / `flac` (`FILE_FORMATS`): yt-dlp downloads `<id>.source` into the disk cache, then ffmpeg builds `<id>-<format>-<startAt>.<ext>`. Served with byte ranges. Jobs are coalesced per key (`#once`). Writes go to `.download`/`.part` and are then renamed. The LRU prune uses mtime (touched on every use) and `CACHE_MB`. Files being downloaded, built from or served are pinned (`#pin`), and the file just built is kept, so neither eviction nor `clearCache()` removes them. A file that vanished anyway is rebuilt. `prepare()` builds the file *before* the renderer is told to play.
- Covers: `registerArt(thumbnailUrl)` (HTTPS YouTube image hosts only) returns `/art/<token>.jpg`: the thumbnail fetched once, without redirects, and converted by ffmpeg into a 480×480 JPEG (`JPEG_SM`). It's kept in memory, 64 covers at most. If conversion fails, the route redirects to the original.

**`Resolver` (src/resolver.js)** runs yt-dlp via `execFile` (never a shell) with strict 11-char video-ID validation. It caches results until the URL's `expire` param, coalesces concurrent lookups, and schedules yt-dlp self-updates.

**UPnP plumbing:** `ssdp.js` (multicast on every interface), `upnp.js` (device description parsing, including embedded MediaRenderers and non-standard serviceIds; DIDL-Lite metadata), `soap.js` (an own SOAP client replacing upnp-device-client. It handles fault responses without `errorDescription` and uses a byte-correct Content-Length for non-ASCII metadata).

**Persistence:** `dataStore.js` gives each renderer its own node-persist dir under `DATA_DIR`, because the library's default store is shared and casts would land on the wrong speaker. Per-renderer keys are `tube2upnp.*`, with read fallback to legacy `upnptube.*`. `settings.js` stores status-page overrides (currently SponsorBlock) in `DATA_DIR/settings.json`; these win over env until reset. `devices.js` keeps `devices.json` (see above). `history.js` keeps playback history in `DATA_DIR/history.json`, with serialized, coalesced atomic writes. `Renderer.#countListen()` (called from `#poll`) records a play after `HISTORY_MIN_PLAY_S` of real PLAYING time. `#listen` is reset only in `doPlay`, so internal `#load` reloads (seek restart, format fallback) never double-count.

**Status page:** `statusServer.js` serves the single-file UI `src/ui/index.html` (inline JS/CSS, strict CSP) plus a JSON API and `/healthz`. It supports an optional `STATUS_TOKEN`, CSRF protection on mutating requests, and a Host check against DNS rebinding (IPs, localhost, this host's name, `STATUS_HOSTS`). Speaker icons are fetched once by the `Renderer` (`fetchIcon`: PNG/JPEG/GIF only, max 256 KB) and served from `/api/renderers/:id/icon`, because the page's CSP doesn't allow LAN http images. `Renderer.refreshStatus()` (called by the device checks) reads the volume (and dB, scaled by `GetVolumeDBRange`), the allowed transport actions, and, while we're idle, whether the renderer plays another source. Optional actions are only called when the service's SCPD lists them (`parseScpd`). On Yamaha MusicCast devices, `yamaha.js` (YXC, an HTTP JSON API; base URL from the description's `yamaha:X_yxcControlURL`, on the device's own host only, or the standard path on a Yamaha that doesn't announce it) adds power, input, what plays on it (with cover art, fetched by the `Renderer` like the icon and served from `/api/renderers/:id/art?v=<version>`) and the master volume in dB. UPnP only sees the receiver's own `server` input; a failing YXC falls back to the UPnP numbers. Data comes from `Renderer.statusInfo()`, the global `stats` singleton (`stats.js`), and the in-memory log ring in `logger.js` (2000 lines). `Logger` also implements yt-cast-receiver's logger interface.

**Config:** everything comes from env vars, parsed and validated once in `src/config.js` into a frozen object. A new option needs updating in `config.js`, the README table, and, if commonly used, `docker-compose.yml` / `.env.example`.

## Testing approach

- `test/fakeRenderer.js` is an in-process fake UPnP device. It is deliberately an *embedded* device with non-standard serviceId spelling, and has knobs such as `neverPlay`, `noGapless`, `bareFaultOn` and `sink`.
- Renderer tests inject `deps.createReceiver` (a fake receiver), a stub resolver and a stub mediaServer, with tiny `pollIntervalMs`/`startTimeoutMs`.
- `MediaServer` accepts `opts.download` so tests avoid yt-dlp.

## Conventions

- ESLint flat config: recommended rules; unused args are allowed when prefixed with `_`.
- Private state uses `#fields`. Comments explain *why* (renderer quirks, YouTube behaviour) and should be kept that way.
- Third-party GitHub Actions are pinned to commit SHAs (Dependabot updates them).
