# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-alpine
# ffmpeg: optional MP3 transcoding for picky renderers. tini: reaps ffmpeg children, forwards signals.
RUN apk add --no-cache python3 ffmpeg tini \
 && python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir -U "yt-dlp[default]" \
 && chown -R node:node /opt/yt-dlp

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY LICENSE.md ./
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    DATA_DIR=/data \
    YTDLP_PATH=/opt/yt-dlp/bin/yt-dlp \
    YTDLP_JS_RUNTIME=node \
    YTDLP_UPDATE_CMD="/opt/yt-dlp/bin/pip install -q -U yt-dlp[default]" \
    YTDLP_UPDATE_ON_START=true

USER node
VOLUME /data
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- "http://127.0.0.1:${STATUS_PORT:-8080}/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/bin/sh", "-c", \
  "set -f; if [ \"$YTDLP_UPDATE_ON_START\" = true ]; then $YTDLP_UPDATE_CMD || echo 'yt-dlp update failed, continuing'; fi; exec node src/index.js"]
