# Tube2U[PnP]

Cast from the **YouTube** and **YouTube Music** apps to DLNA/UPnP renderers: Wi-Fi speakers, amplifiers, AV receivers, smart TVs.

Run Tube2U[PnP] on any always-on machine on your LAN. It discovers every UPnP/DLNA MediaRenderer and creates a YouTube cast receiver for each one. The receivers show up in the Cast menu of the YouTube apps on Android and iOS. You can play, pause, seek, skip, queue and change volume from the app. Playlists and autoplay continue on the speaker.

> Tube2U[PnP] is a fork of [**upnpTube**](https://github.com/mas94uk/upnpTube) by Mark Smith ([@mas94uk](https://github.com/mas94uk)), GPL-3.0. The original is no longer maintained and stopped working with current YouTube apps. This fork is a rewrite on top of it; see [What changed since upnpTube](#what-changed-since-upnptube).

## How it works

```
YouTube app ──DIAL/lounge──▶ Tube2U[PnP] (one cast receiver per renderer)
                                 │ yt-dlp resolves the video ID to a stream URL
                                 ▼
Renderer ◀──HTTP /stream/<token>── media server ──HTTPS──▶ googlevideo.com
         (as-is, losslessly remuxed with ffmpeg, or MP3 as a last resort)
```

### Stream formats

YouTube serves AAC audio in *fragmented* MP4 (DASH). Many renderers say they play `audio/mp4` but can't handle the fragmented variant. Tube2U[PnP] can deliver the same audio four ways:

| `OUTPUT_FORMAT` | What the renderer gets | Quality | Seeking |
|---|---|---|---|
| `direct` | YouTube's stream, proxied | original | native |
| `mp4` | Regular MP4, index at the front (remuxed, not re-encoded). yt-dlp downloads the track first, which takes a few seconds for a song, and the result is cached on disk. | original | native; if the renderer refuses, a new MP4 starting at the position |
| `adts` | Raw AAC stream, the format internet radios use (remuxed, not re-encoded). Starts immediately. | original | stream restarted at the position |
| `flac` | FLAC: the AAC decoded and stored losslessly (16- or 24-bit, `FLAC_BITS`). Built as a file like `mp4`. Roughly 6–8× the size of the AAC (about 25–35 MB for a 4-minute song, which a LAN doesn't notice), so consider raising `CACHE_MB`. | original (no second lossy encode) | native; if the renderer refuses, a new FLAC starting at the position |
| `mp3` | Re-encoded MP3 | lossy (`MP3_BITRATE`) | stream restarted at the position |

With `auto` (the default), Tube2U[PnP] tries them in that order, skipping formats the renderer says it doesn't support. If a renderer hasn't started playing after `START_TIMEOUT_MS`, the next format is tried. The first one that plays is remembered for that renderer, across restarts. To re-detect, delete the renderer's folder in `DATA_DIR`.

The renderer gets a short `http://<host>:8000/stream/<random>.m4a` URL. Tube2U[PnP] proxies it to YouTube's HTTPS stream and passes Range requests through, so seeking works. Most renderers can't do HTTPS and many choke on YouTube's 1–2 KB URLs.

### Next track prepared in advance, gapless playback

While a song plays, Tube2U[PnP] prepares the next one from the YouTube queue, or the autoplay pick: it resolves the video and, for `mp4`/`flac`, downloads and builds the file. Skipping to it, or the song ending, then starts it right away.

If the renderer supports `SetNextAVTransportURI`, the next track is also handed to it in advance, so it plays on with no gap (useful for live albums and mixes). Tube2U[PnP] notices the switch and moves the YouTube queue along. Renderers without it simply get the prepared track the moment the current one ends. If you edit the queue in the app, the prepared track is replaced. Turn it off with `PREFETCH=false` or `GAPLESS=false`.

### SponsorBlock (off by default)

[SponsorBlock](https://sponsor.ajay.app) is a community database of video segments: the talking before a music video starts, sponsor reads, intros and so on. When it's on, Tube2U[PnP] looks up each track's segments and seeks past them while the track plays:
- **Seekable formats** (direct, MP4, FLAC) jump within the track. MP3 and the AAC stream restart at the new position.
- **A segment that runs to the end** of the track skips straight to the next one.
- The YouTube app's progress bar follows the jump. Seeking back into a skipped part plays it.

Turn it on with `SPONSORBLOCK=true`, and choose what to skip with `SPONSORBLOCK_CATEGORIES`. The default is `music_offtopic,sponsor,selfpromo,interaction`; the full list is `music_offtopic`, `sponsor`, `selfpromo`, `interaction`, `intro`, `outro`, `preview` and `filler`. You can also switch it on the status page's **Settings** view. Changes made there are saved in `DATA_DIR/settings.json` and take precedence over `.env` until you choose **Use .env defaults**.

Lookups use SponsorBlock's privacy-preserving API: only the first 4 characters of a SHA-256 hash of the video ID are sent, and the results are filtered locally. If SponsorBlock is unreachable, tracks simply play without skips.

### Playback history

The status page's **History** view lists recently played tracks and the most played ones, for all speakers or one. A track counts once it has played for 30 seconds (`HISTORY_MIN_PLAY_S`) or half its length, whichever is shorter. Tracks skipped right away aren't counted, and seeking or a format change doesn't count a track twice. Each entry records the speaker and the YouTube account names connected to that speaker at the time. yt-cast-receiver doesn't say which of several connected phones started a track.

History is stored in `DATA_DIR/history.json`. Play counts are kept forever; the list of individual plays keeps the most recent `HISTORY_MAX` (5000). **Download CSV** exports that list (UTF-8, opens in Excel), and **Clear history** deletes everything. Because the history includes account names, set `HISTORY=false` if you don't want it stored.

## Quick start (Docker, Linux host)

```sh
git clone <your-repo-url> tube2upnp && cd tube2upnp
cp .env.example .env        # optional: your settings live here, not in docker-compose.yml
docker compose up -d --build
docker compose logs -f
```

Instead of building locally, you can use the image that CI publishes to GitHub Container Registry. Set `TUBE2UPNP_IMAGE=ghcr.io/<owner>/tube2upnp:latest` in `.env`, remove `build: .` from the compose file, and run `docker compose pull && docker compose up -d`.

Then open the YouTube app, tap Cast, and pick one of the "🔊 …" devices. The status page is at `http://<host>:8080/`.

### Host networking is required

SSDP and DIAL use LAN multicast, so the container needs `network_mode: host`.

**Docker Desktop on Windows or macOS does not work for this.** Its "host" network is a VM, and multicast never reaches your LAN. Use one of these instead:

- a Linux machine, Raspberry Pi or NAS with Docker; or
- run natively with Node (see below). This also works on Windows.

## Status page

Open `http://<host>:8080/` in a browser. It has five views:

- **Speakers** shows each renderer's display: cover, title, progress, the prepared next track, and the speaker's volume as it reports it. Speakers found once are remembered, with a fixed port, and stay on the list:
  - **Offline** when a remembered speaker stops answering (it's checked every `DEVICE_CHECK_INTERVAL` seconds). Its cast receiver stops, so it leaves the cast menu, and starts again on the same port when the speaker is back.
  - **Not working** when it answers but its receiver couldn't start (the reason is shown, and it's retried).
  - **Remove** forgets an offline speaker: its port and saved settings are freed, and it's set up as new if it comes back. **Ignore** stops a speaker and keeps it out until you choose **Allow again** under *Ignored speakers*.

  For a running speaker you can also:
  - choose the **stream format for that speaker**. Same as default, Detect automatically, or a fixed format. It's saved per speaker and applied immediately: a playing track reloads at its current position.
  - clear a detected format, so it's detected again.
  - get a **TV code** for the YouTube app.
- **History** shows recently played and most played tracks, per speaker or for all of them, with a CSV download (see [Playback history](#playback-history)).
- **Logs** is the last 2000 log lines, live. You can filter by level or text, pause following, and download what's shown.
- **Stats for nerds** covers:
  - CPU, memory and throughput graphs (last 10 minutes)
  - yt-dlp lookup times (median and 95th percentile) and cache hits
  - downloads, 403 retries, MP4/FLAC build times, and the disk cache
  - UPnP round trips
  - per speaker: accepted formats, gapless support, and SOAP errors
- **Settings:** SponsorBlock on or off, and which categories to skip.

The page is meant for your LAN. If other people or devices share that network, set `STATUS_TOKEN` and open the page as `/?token=<token>`. You can also limit it to one address with `STATUS_BIND`, or turn it off with `STATUS_PORT=0`. Requests that change settings must come from the page itself, so other websites can't send them from your browser.

The page only answers when it's opened by IP address, as `localhost`, or by this machine's name (`<hostname>` or `<hostname>.local`). This stops other websites from reaching it through a DNS trick (DNS rebinding). If you open it by another name, for example through a reverse proxy or your router's DNS, add that name to `STATUS_HOSTS`. Otherwise you'll get "Unknown host name".

## Running without Docker

You need Node.js 22 or later (24 recommended), yt-dlp, and optionally ffmpeg.

```sh
pip install -U "yt-dlp[default]"   # [default] pulls in yt-dlp-ejs, needed for YouTube
npm ci --omit=dev
npm start
```

yt-dlp needs a JavaScript runtime to solve YouTube's challenges. Tube2U[PnP] passes `--js-runtimes node` by default, so the Node you already have is enough.

**Firewall:** allow UDP 1900 inbound (SSDP). Also allow TCP 3000 and up (one port per renderer, for DIAL), TCP 8000 (media) and TCP 8080 (status page).

## Configuration (environment variables)

With Docker Compose, put these in `.env`; `docker-compose.yml` passes them all through, except `CACHE_DIR`, `DATA_DIR` and the yt-dlp paths and runtime, which the image sets. When running without Docker, set them as normal environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |
| `ADVERTISE_IP` | auto | IP that renderers and phones use to reach us. By default it's auto-detected per renderer from the routing table. Setting it also pins DIAL to that address. |
| `RECEIVER_BASE_PORT` | `3000` | First DIAL port. Each speaker gets its own port and keeps it across restarts (remembered in `DATA_DIR/devices.json`). A removed speaker's port is reused. |
| `MEDIA_PORT` | `8000` | Streaming port |
| `STATUS_PORT` | `8080` | Status page. `0` disables it. |
| `STATUS_TOKEN` | – | If set, the status page's API requires this token (open the page as `/?token=…`) |
| `STATUS_BIND` | all interfaces | Address the status page listens on, e.g. `127.0.0.1` |
| `STATUS_HOSTS` | – | Extra host names the status page may be opened by, comma-separated (e.g. `tube.home.lan`). IP addresses, `localhost` and this machine's name always work. `*` allows any name (turns off the DNS rebinding check). |
| `RENDERER_INCLUDE` / `RENDERER_EXCLUDE` | – | Case-insensitive regex on the renderer's friendly name |
| `NAME_TEMPLATE` | `🔊 {name}` | Cast menu name. Placeholders: `{name}`, `{manufacturer}`, `{model}` |
| `OUTPUT_FORMAT` | `auto` | `auto`, `direct`, `mp4`, `adts`, `flac` or `mp3` (see [Stream formats](#stream-formats)). The older `TRANSCODE=always`/`never` still works and means `mp3`/`direct`. |
| `CACHE_MB` | `512` | Size cap for the disk cache (downloaded tracks and built `mp4`/`flac` files). When it's exceeded, the least recently played files are removed first. Files being downloaded or played, and the track just built, are never removed, even if that track alone is bigger than the cap. |
| `CACHE_DIR` | `DATA_DIR/cache` | Where that cache lives. It's kept across restarts (in Docker, inside the data volume). Use **Clear cache** on the status page after changing `YTDLP_FORMAT`. |
| `MP3_BITRATE` | `192k` | Bitrate for `mp3` |
| `FLAC_BITS` | `16` | Bit depth for `flac`: `16` or `24` |
| `YTDLP_FORMAT` | `bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best` | yt-dlp format selector |
| `YTDLP_JS_RUNTIME` | `node` | Passed to `--js-runtimes`. Empty disables it. |
| `YTDLP_EXTRA_ARGS` | – | Extra yt-dlp arguments, e.g. `--cookies /data/cookies.txt` |
| `YTDLP_UPDATE_HOURS` | `24` | Self-update interval. `0` disables it. |
| `YTDLP_UPDATE_CMD` | `yt-dlp -U` | Docker image default: pip upgrade inside the venv |
| `YTDLP_UPDATE_ON_START` | `true` (Docker) | Update yt-dlp before every container start |
| `DATA_DIR` | `./data` (`/data` in Docker) | Remembered speakers and their ports, per-renderer screen IDs (so phones remember the receivers), settings, history and the cache |
| `START_TIMEOUT_MS` | `12000` | With `auto`, try the next format if the renderer hasn't started playing by then |
| `POLL_INTERVAL_MS` | `2000` | Transport-state polling while playing (used for end-of-track detection) |
| `AUTOPLAY` | `true` | Enable YouTube autoplay when a sender connects |
| `PREFETCH` | `true` | Prepare the next track while the current one plays |
| `GAPLESS` | `true` | Queue it on the renderer with `SetNextAVTransportURI` when supported |
| `SPONSORBLOCK` | `false` | Skip SponsorBlock segments (see [SponsorBlock](#sponsorblock-off-by-default)). The status page can override it. |
| `SPONSORBLOCK_CATEGORIES` | `music_offtopic,sponsor,selfpromo,interaction` | Comma-separated categories to skip |
| `SPONSORBLOCK_API` | `https://sponsor.ajay.app` | SponsorBlock server (or a mirror) |
| `HISTORY` | `true` | Keep a playback history (see [Playback history](#playback-history)) |
| `HISTORY_MAX` | `5000` | Individual plays kept in the history list. Play counts are kept regardless. |
| `HISTORY_MIN_PLAY_S` | `30` | Seconds a track must play (or half its length, if shorter) to count as played |
| `DISCOVERY_INTERVAL` | `300` | Seconds between SSDP searches for new speakers |
| `DEVICE_CHECK_INTERVAL` | `30` | Seconds between direct checks of remembered speakers (minimum 5) |
| `DEVICE_OFFLINE_AFTER` | `3` | Missed checks in a row before a speaker is shown offline and its receiver stops (twice as many during playback) |

## Troubleshooting

**The speaker doesn't appear in the Cast menu.**
- Check the logs or the status page first. If the renderer is listed there, discovery towards the speaker works, and the problem is between the phone and Tube2U[PnP].
- If the status page lists it as **Offline** although it's on, it isn't answering Tube2U[PnP]'s checks (its network may sleep in standby, or a firewall is in the way). It comes back on its own when it answers again; raise `DEVICE_OFFLINE_AFTER` if it drops out too eagerly. If it's under **Ignored speakers**, choose **Allow again**.
- Phone and server must be on the same L2 network. Guest Wi-Fi, client isolation and "multicast enhancement" on some access points all block DIAL.
- As a workaround, use **Link with TV code**. Tap "TV code" on the status page, then in the YouTube app go to Settings → Watch on TV → Link with TV code. This uses YouTube's servers instead of local discovery.

**It casts, but nothing plays.**
- Run with `LOG_LEVEL=debug`. You'll see whether the renderer ever requests `/stream/...`.
- If it never connects, set `ADVERTISE_IP` to the LAN address and check the firewall on `MEDIA_PORT`.
- With `OUTPUT_FORMAT=auto`, a renderer that doesn't start is tried with the next format, and the winner is remembered. To find the right one by hand, set `OUTPUT_FORMAT` to `mp4`, then `adts`, then `flac`, then `mp3`, and keep the first that plays.

**yt-dlp errors ("Sign in to confirm you're not a bot", HTTP 403).**
- Occasional `HTTP Error 403` on download is normal. YouTube sometimes hands out a format URL it then refuses to serve. Tube2U[PnP] discards it and retries with a fresh lookup (two retries, after 2 s and 5 s), which almost always succeeds.
- With `adts` and `mp3`, ffmpeg reads YouTube's stream itself. If YouTube refuses it, Tube2U[PnP] retries with a fresh lookup, then falls back to downloading the track with yt-dlp first (the stream then starts a few seconds later).
- If 403s happen on most tracks:
  - Update yt-dlp first. This happens automatically by default.
  - Next, add a PO-token provider: YouTube increasingly requires these tokens for downloads. yt-dlp's wiki has a PO Token Guide; the usual setup is the `bgutil-ytdlp-pot-provider` plugin plus its small companion container.
  - If the server's IP is flagged, pass browser cookies with `YTDLP_EXTRA_ARGS="--cookies /data/cookies.txt"`.

**Seeking.** With `direct`, `mp4` and `flac` the renderer seeks natively. With `adts` and `mp3`, Tube2U[PnP] restarts the stream from the new position, so a seek takes a second or two longer.

## What changed since upnpTube

- **Cast library:** ported from the abandoned yt-cast-receiver v1 fork to **yt-cast-receiver 2.x**. This fixes casting with current YouTube apps and adds YouTube Music.
- **yt-dlp:** current version with JS-runtime support, run via `execFile` with strict video-ID validation. The original passed the ID through a shell (command injection). Results are cached, concurrent lookups are coalesced, expired URLs are re-resolved, and yt-dlp self-updates.
- **Separate state per renderer:** the library's default store is shared, which would let a cast land on the wrong speaker.
- **Embedded MediaRenderers** (Sonos, Denon/Marantz, Yamaha, …) and non-standard serviceIds are supported. This fixes the "AVTransport not provided by device" crash.
- **Own SOAP client:** replaces `upnp-device-client`, which crashed the process on fault responses without `<errorDescription>` and sent a wrong `Content-Length` for non-ASCII (accented) metadata.
- **Crash fixes:** UPnP client errors no longer kill the process. Renderer setup failures are retried with a back-off.
- **Media server:** one shared server with short tokenised URLs. Unknown paths get a 404, so it can't be used as an open proxy. Range passthrough, DLNA headers, and the renderer is addressed by IP instead of `os.hostname()`.
- **Lossless format conversion** (non-fragmented MP4 or ADTS AAC via ffmpeg remux, or FLAC), MP3 only as a last resort; the working format is detected and remembered per renderer. Seeking works in every format.
- **Metadata:** title, artist and cover art are sent in DIDL-Lite, so they appear on renderer displays.
- **Queue and autoplay:** end of track is detected and the YouTube queue advances. The next track is prepared in advance, and played gaplessly where the renderer supports it.
- **Discovery:** SSDP runs on every interface, devices are keyed by UDN rather than URL, byebye messages work, and moved devices are recreated. Speakers are remembered with a fixed port, checked directly so switched-off ones leave the cast menu within a minute or two, and can be removed or ignored on the status page. Receivers are stopped cleanly on shutdown.
- **Mute** support, plus volume, position and duration via standard UPnP actions.
- **Status page:** now playing, per-speaker format setting, live logs, stats for nerds, pairing codes. JSON API and `/healthz`, optional token, CSRF protection.
- **Packaging:** Node 24 and ESM, tests (`npm test`), ESLint, and a non-root Docker image with tini and a healthcheck. GitHub Actions: tests, multi-arch image (amd64/arm64) pushed to GHCR, Trivy container scan, CodeQL, dependency review and Dependabot.

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

## Credits and license

Tube2U[PnP] is a fork of [upnpTube](https://github.com/mas94uk/upnpTube), created by Mark Smith ([@mas94uk](https://github.com/mas94uk)). The idea, the original implementation and the project's history up to the fork are his; the git history is preserved in this repository. Casting is built on [yt-cast-receiver](https://github.com/patrickkfkan/yt-cast-receiver) by [@patrickkfkan](https://github.com/patrickkfkan), and streams are resolved with [yt-dlp](https://github.com/yt-dlp/yt-dlp). Skip data comes from [SponsorBlock](https://sponsor.ajay.app).

GPL-3.0-only, the same as the original project. See [LICENSE.md](LICENSE.md).

Tube2U[PnP] is not affiliated with or endorsed by Google or YouTube.

## How this fork was built

Most of the code since the fork was written with an AI assistant (Anthropic’s Claude), directed by the maintainer, who tested it. It’s covered by automated tests (npm test) and was tested on a Yamaha RX-V4A over DLNA. Not yet tested on real hardware: gapless playback on renderers other than the RX-V4A, SponsorBlock against the live service, and running under WSL. Bug reports with logs (status page → Logs → Download) are very welcome.
