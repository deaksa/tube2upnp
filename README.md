# upnpTube

Cast from the **YouTube** and **YouTube Music** apps to DLNA/UPnP renderers: Wi-Fi speakers, amplifiers, AV receivers, smart TVs.

Run upnpTube on any always-on machine on your LAN. It discovers every UPnP/DLNA MediaRenderer and creates a YouTube cast receiver for each one. The receivers show up in the Cast menu of the YouTube apps on Android and iOS. You can play, pause, seek, skip, queue and change volume from the app. Playlists and autoplay continue on the speaker.

> Fork of [mas94uk/upnpTube](https://github.com/mas94uk/upnpTube) (GPL-3.0), which stopped working in 2024. v2 is a rewrite; see [What changed](#what-changed-in-v2).

## How it works

```
YouTube app ──DIAL/lounge──▶ upnpTube (one cast receiver per renderer)
                                 │ yt-dlp resolves the video ID to a stream URL
                                 ▼
Renderer ◀──HTTP /stream/<token>── media server ──HTTPS──▶ googlevideo.com
         (as-is, losslessly remuxed with ffmpeg, or MP3 as a last resort)
```

### Stream formats

YouTube serves AAC audio in *fragmented* MP4 (DASH). Many renderers say they play `audio/mp4` but can't handle the fragmented variant. upnpTube can deliver the same audio four ways:

| `OUTPUT_FORMAT` | What the renderer gets | Quality | Seeking |
|---|---|---|---|
| `direct` | YouTube's stream, proxied | original | native |
| `mp4` | Regular MP4, index at the front (remuxed, not re-encoded). yt-dlp downloads the track first, which takes a few seconds for a song, and the result is cached on disk. | original | native; if the renderer refuses, a new MP4 starting at the position |
| `adts` | Raw AAC stream, the format internet radios use (remuxed, not re-encoded). Starts immediately. | original | stream restarted at the position |
| `flac` | FLAC: the AAC decoded and stored losslessly (16- or 24-bit, `FLAC_BITS`). Built as a file like `mp4`. Roughly 6–8× the size of the AAC (about 25–35 MB for a 4-minute song, which a LAN doesn't notice), so consider raising `CACHE_MB`. | original (no second lossy encode) | native; if the renderer refuses, a new FLAC starting at the position |
| `mp3` | Re-encoded MP3 | lossy (`MP3_BITRATE`) | stream restarted at the position |

With `auto` (the default), upnpTube tries them in that order, skipping formats the renderer says it doesn't support. If a renderer hasn't started playing after `START_TIMEOUT_MS`, the next format is tried. The first one that plays is remembered for that renderer, across restarts. To re-detect, delete the renderer's folder in `DATA_DIR`.

The renderer gets a short `http://<host>:8000/stream/<random>.m4a` URL. upnpTube proxies it to YouTube's HTTPS stream and passes Range requests through, so seeking works. Most renderers can't do HTTPS and many choke on YouTube's 1–2 KB URLs.

## Quick start (Docker, Linux host)

```sh
git clone <your-fork-url> upnpTube && cd upnpTube
cp .env.example .env        # optional: your settings live here, not in docker-compose.yml
docker compose up -d --build
docker compose logs -f
```

Instead of building locally, you can use the image that CI publishes to GitHub Container Registry. Set `UPNPTUBE_IMAGE=ghcr.io/<owner>/upnptube:latest` in `.env`, remove `build: .` from the compose file, and run `docker compose pull && docker compose up -d`.

Then open the YouTube app, tap Cast, and pick one of the "🔊 …" devices. The status page is at `http://<host>:8080/`.

### Host networking is required

SSDP and DIAL use LAN multicast, so the container needs `network_mode: host`.

**Docker Desktop on Windows or macOS does not work for this.** Its "host" network is a VM, and multicast never reaches your LAN. Use one of these instead:

- a Linux machine, Raspberry Pi or NAS with Docker; or
- run natively with Node (see below). This also works on Windows.

## Running without Docker

You need Node.js 20 or later (22 recommended), yt-dlp, and optionally ffmpeg.

```sh
pip install -U "yt-dlp[default]"   # [default] pulls in yt-dlp-ejs, needed for YouTube
npm ci --omit=dev
npm start
```

yt-dlp needs a JavaScript runtime to solve YouTube's challenges. upnpTube passes `--js-runtimes node` by default, so the Node you already have is enough.

**Firewall:** allow UDP 1900 inbound (SSDP). Also allow TCP 3000 and up (one port per renderer, for DIAL), TCP 8000 (media) and TCP 8080 (status page).

## Configuration (environment variables)

With Docker Compose, put these in `.env`; `docker-compose.yml` passes the common ones through. When running without Docker, set them as normal environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |
| `ADVERTISE_IP` | auto | IP that renderers and phones use to reach us. By default it's auto-detected per renderer from the routing table. Setting it also pins DIAL to that address. |
| `RECEIVER_BASE_PORT` | `3000` | First DIAL port. Each renderer takes the next free port. |
| `MEDIA_PORT` | `8000` | Streaming port |
| `STATUS_PORT` | `8080` | Status page and pairing codes. `0` disables it. |
| `RENDERER_INCLUDE` / `RENDERER_EXCLUDE` | – | Case-insensitive regex on the renderer's friendly name |
| `NAME_TEMPLATE` | `🔊 {name}` | Cast menu name. Placeholders: `{name}`, `{manufacturer}`, `{model}` |
| `OUTPUT_FORMAT` | `auto` | `auto`, `direct`, `mp4`, `adts`, `flac` or `mp3` (see [Stream formats](#stream-formats)). The older `TRANSCODE=always`/`never` still works and means `mp3`/`direct`. |
| `CACHE_MB` | `512` | Size cap for the `mp4` disk cache (downloaded and remuxed tracks), oldest evicted first. It's cleared on restart. |
| `CACHE_DIR` | temp dir | Where that cache lives |
| `MP3_BITRATE` | `192k` | Bitrate for `mp3` |
| `FLAC_BITS` | `16` | Bit depth for `flac`: `16` or `24` |
| `YTDLP_FORMAT` | `bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best` | yt-dlp format selector |
| `YTDLP_JS_RUNTIME` | `node` | Passed to `--js-runtimes`. Empty disables it. |
| `YTDLP_EXTRA_ARGS` | – | Extra yt-dlp arguments, e.g. `--cookies /data/cookies.txt` |
| `YTDLP_UPDATE_HOURS` | `24` | Self-update interval. `0` disables it. |
| `YTDLP_UPDATE_CMD` | `yt-dlp -U` | Docker image default: pip upgrade inside the venv |
| `YTDLP_UPDATE_ON_START` | `true` (Docker) | Update yt-dlp before every container start |
| `DATA_DIR` | `./data` (`/data` in Docker) | Per-renderer screen IDs, so phones remember the receivers |
| `START_TIMEOUT_MS` | `12000` | With `auto`, try the next format if the renderer hasn't started playing by then |
| `POLL_INTERVAL_MS` | `2000` | Transport-state polling while playing (used for end-of-track detection) |
| `AUTOPLAY` | `true` | Enable YouTube autoplay when a sender connects |
| `DISCOVERY_INTERVAL` | `300` | Seconds between SSDP searches |

## Troubleshooting

**The speaker doesn't appear in the Cast menu.**
- Check the logs or the status page first. If the renderer is listed there, discovery towards the speaker works, and the problem is between the phone and upnpTube.
- Phone and server must be on the same L2 network. Guest Wi-Fi, client isolation and "multicast enhancement" on some access points all block DIAL.
- As a workaround, use **Link with TV code**. Tap "TV code" on the status page, then in the YouTube app go to Settings → Watch on TV → Link with TV code. This uses YouTube's servers instead of local discovery.

**It casts, but nothing plays.**
- Run with `LOG_LEVEL=debug`. You'll see whether the renderer ever requests `/stream/...`.
- If it never connects, set `ADVERTISE_IP` to the LAN address and check the firewall on `MEDIA_PORT`.
- With `OUTPUT_FORMAT=auto`, a renderer that doesn't start is tried with the next format, and the winner is remembered. To find the right one by hand, set `OUTPUT_FORMAT` to `mp4`, then `adts`, then `flac`, then `mp3`, and keep the first that plays.

**yt-dlp errors ("Sign in to confirm you're not a bot", HTTP 403).** Update yt-dlp first, which happens automatically by default. If the server's IP is flagged by YouTube, pass browser cookies with `YTDLP_EXTRA_ARGS="--cookies /data/cookies.txt"`.

**Seeking.** With `direct`, `mp4` and `flac` the renderer seeks natively. With `adts` and `mp3`, upnpTube restarts the stream from the new position, so a seek takes a second or two longer.

## What changed in v2

- **Cast library:** ported from the abandoned yt-cast-receiver v1 fork to **yt-cast-receiver 2.x**. This fixes casting with current YouTube apps and adds YouTube Music.
- **yt-dlp:** current version with JS-runtime support, run via `execFile` with strict video-ID validation. The original passed the ID through a shell (command injection). Results are cached, concurrent lookups are coalesced, expired URLs are re-resolved, and yt-dlp self-updates.
- **Separate state per renderer:** the library's default store is shared, which would let a cast land on the wrong speaker.
- **Embedded MediaRenderers** (Sonos, Denon/Marantz, Yamaha, …) and non-standard serviceIds are supported. This fixes the "AVTransport not provided by device" crash.
- **Own SOAP client:** replaces `upnp-device-client`, which crashed the process on fault responses without `<errorDescription>` and sent a wrong `Content-Length` for non-ASCII (accented) metadata.
- **Crash fixes:** UPnP client errors no longer kill the process. Renderer setup failures are retried with a back-off.
- **Media server:** one shared server with short tokenised URLs. Unknown paths get a 404, so it can't be used as an open proxy. Range passthrough, DLNA headers, and the renderer is addressed by IP instead of `os.hostname()`.
- **Lossless format conversion** (non-fragmented MP4 or ADTS AAC via ffmpeg remux, or FLAC), MP3 only as a last resort; the working format is detected and remembered per renderer. Seeking works in every format.
- **Metadata:** title, artist and cover art are sent in DIDL-Lite, so they appear on renderer displays.
- **Queue and autoplay:** end of track is detected and the YouTube queue advances.
- **Discovery:** SSDP runs on every interface, devices are keyed by UDN rather than URL, byebye messages work, moved devices are recreated, ports are reused, and receivers are stopped cleanly on shutdown.
- **Mute** support, plus volume, position and duration via standard UPnP actions.
- **Status page** with a JSON API (`/api/renderers`), pairing codes and `/healthz`.
- **Packaging:** Node 22 and ESM, tests (`npm test`), ESLint, and a non-root Docker image with tini and a healthcheck. GitHub Actions: tests, multi-arch image (amd64/arm64) pushed to GHCR, Trivy container scan, CodeQL, dependency review and Dependabot.

## CI (GitHub Actions)

- **`CI` workflow:** lint and tests (with ffmpeg) plus `npm audit`. It then builds `linux/amd64` and `linux/arm64` images with SBOM and provenance, and pushes them to `ghcr.io/<owner>/<repo>`. Tags: `latest` on `main`, `X.Y.Z`/`X.Y` for `vX.Y.Z` tags, plus `sha-…`. Finally, Trivy scans the pushed image and uploads the results to the Security tab. It runs weekly too, so the image picks up new yt-dlp releases.
- **`CodeQL` workflow:** static analysis of the JavaScript and the workflow files.
- **Dependabot:** weekly updates for npm packages, GitHub Actions (pinned to commit SHAs) and the Docker base image.
- **Repository settings to enable:** Settings → Code security → Secret scanning and Push protection, plus Dependabot alerts.
- **GHCR visibility:** published packages are private by default. Make the package public under the repo's Packages settings if you want to pull without logging in.

## Development

```sh
npm ci
npm run lint
npm test     # unit tests + fake UPnP renderer + media proxy tests, no network needed
```

## License

GPL-3.0-only, the same as the original project. See [LICENSE.md](LICENSE.md). Original author: Mark Smith ([@mas94uk](https://github.com/mas94uk)).
