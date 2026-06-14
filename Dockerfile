# Build stage — compile TypeScript
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc

# Runtime stage — production deps only
FROM node:22-alpine
# FFmpeg decodes the Opus on @discordjs/voice's inline-volume path (opusscript, already a
# dependency, does the re-encode) — used whenever a non-unity gain is applied: COACH_VOLUME
# or any per-voice volume in ELEVENLABS_VOICES. Unity volume uses the demux-only fast path
# and needs none of this, but the coach voices carry per-voice gains, so ffmpeg is required.
# (Pinned-version-free: Alpine's ffmpeg is fine for a stream transcode.)
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY assets ./assets
# GSI listener port (map/expose on the host; Discord needs no inbound ports)
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
