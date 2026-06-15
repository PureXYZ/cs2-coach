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
# Install ffmpeg. @discordjs/voice needs it to apply a non-unity playback gain
# (COACH_VOLUME, or any per-voice volume in ELEVENLABS_VOICES): it decodes the Opus to
# PCM, then opusscript re-encodes. Unity volume skips this (demux-only fast path), but
# the coach voices carry per-voice gains, so ffmpeg is required. Alpine's unpinned
# build is fine for a stream transcode.
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
