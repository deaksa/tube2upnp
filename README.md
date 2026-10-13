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
         (or MP3 via ffmpeg if the renderer can't play AAC/M4A)
```

The renderer gets a short `http://<host>:8000/stream/<random>.m4a` URL. upnpTube proxies it to YouTube's HTTPS stream and passes Range requests through, so seeking works. Most renderers can't do HTTPS and many choke on YouTube's 1–2 KB URLs.

## Quick start (Docker, Linux host)

```sh
git clone <your-fork-url> upnpTube && cd upnpTube
docker compose up -d --build
docker compose logs -f
```

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

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |
| `ADVERTISE_IP` | auto | IP that renderers and phones use to reach us. By default it's auto-detected per renderer from the routing table. Setting it also pins DIAL to that address. |
| `RECEIVER_BASE_PORT` | `3000` | First DIAL port. Each renderer takes the next free port. |
| `MEDIA_PORT` | `8000` | Streaming port |
| `STATUS_PORT` | `8080` | Status page and pairing codes. `0` disables it. |
| `RENDERER_INCLUDE` / `RENDERER_EXCLUDE` | – | Case-insensitive regex on the renderer's friendly name |
| `NAME_TEMPLATE` | `🔊 {name}` | Cast menu name. Placeholders: `{name}`, `{manufacturer}`, `{model}` |
| `TRANSCODE` | `auto` | `auto` transcodes to MP3 only if the renderer doesn't advertise the source type. Other values: `always`, `never`. |
| `MP3_BITRATE` | `192k` | Bitrate used when transcoding |
| `YTDLP_FORMAT` | `bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best` | yt-dlp format selector |
| `YTDLP_JS_RUNTIME` | `node` | Passed to `--js-runtimes`. Empty disables it. |
| `YTDLP_EXTRA_ARGS` | – | Extra yt-dlp arguments, e.g. `--cookies /data/cookies.txt` |
| `YTDLP_UPDATE_HOURS` | `24` | Self-update interval. `0` disables it. |
| `YTDLP_UPDATE_CMD` | `yt-dlp -U` | Docker image default: pip upgrade inside the venv |
| `YTDLP_UPDATE_ON_START` | `true` (Docker) | Update yt-dlp before every container start |
| `DATA_DIR` | `./data` (`/data` in Docker) | Per-renderer screen IDs, so phones remember the receivers |
| `START_TIMEOUT_MS` | `12000` | Retry as MP3 if the renderer hasn't started playing by then |
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
- If the renderer accepts the URL but doesn't start within `START_TIMEOUT_MS` (12 s), upnpTube retries the track as MP3 and keeps using MP3 for that renderer until restart. Many renderers advertise `audio/mp4` but can't play YouTube's fragmented DASH M4A. If that happens every time, set `TRANSCODE=always` so playback starts right away.

**yt-dlp errors ("Sign in to confirm you're not a bot", HTTP 403).** Update yt-dlp first, which happens automatically by default. If the server's IP is flagged by YouTube, pass browser cookies with `YTDLP_EXTRA_ARGS="--cookies /data/cookies.txt"`.

**Seeking.** For direct (M4A) streams the renderer seeks natively, if it implements `Seek`. While transcoding, upnpTube restarts the MP3 stream from the new position, so a seek takes a second or two longer.

## What changed in v2

- **Cast library:** ported from the abandoned yt-cast-receiver v1 fork to **yt-cast-receiver 2.x**. This fixes casting with current YouTube apps and adds YouTube Music.
- **yt-dlp:** current version with JS-runtime support, run via `execFile` with strict video-ID validation. The original passed the ID through a shell (command injection). Results are cached, concurrent lookups are coalesced, expired URLs are re-resolved, and yt-dlp self-updates.
- **Separate state per renderer:** the library's default store is shared, which would let a cast land on the wrong speaker.
- **Embedded MediaRenderers** (Sonos, Denon/Marantz, Yamaha, …) and non-standard serviceIds are supported. This fixes the "AVTransport not provided by device" crash.
- **Own SOAP client:** replaces `upnp-device-client`, which crashed the process on fault responses without `<errorDescription>` and sent a wrong `Content-Length` for non-ASCII (accented) metadata.
- **Crash fixes:** UPnP client errors no longer kill the process. Renderer setup failures are retried with a back-off.
- **Media server:** one shared server with short tokenised URLs. Unknown paths get a 404, so it can't be used as an open proxy. Range passthrough, DLNA headers, and the renderer is addressed by IP instead of `os.hostname()`.
- **MP3 transcoding** when a renderer doesn't support the source format, with seeking (the stream is restarted at the new offset).
- **Metadata:** title, artist and cover art are sent in DIDL-Lite, so they appear on renderer displays.
- **Queue and autoplay:** end of track is detected and the YouTube queue advances.
- **Discovery:** SSDP runs on every interface, devices are keyed by UDN rather than URL, byebye messages work, moved devices are recreated, ports are reused, and receivers are stopped cleanly on shutdown.
- **Mute** support, plus volume, position and duration via standard UPnP actions.
- **Status page** with a JSON API (`/api/renderers`), pairing codes and `/healthz`.
- **Packaging:** Node 22 and ESM, tests (`npm test`), ESLint, and a non-root Docker image with tini and a healthcheck. GitLab CI with SAST, secret detection, dependency scanning and container scanning.

## Development

```sh
npm ci
npm run lint
npm test     # unit tests + fake UPnP renderer + media proxy tests, no network needed
```

## License

GPL-3.0-only, the same as the original project. See [LICENSE.md](LICENSE.md). Original author: Mark Smith ([@mas94uk](https://github.com/mas94uk)).
