# ─── Stage 1: Build ──────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
COPY scripts ./scripts
COPY tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ─── Stage 2: Production ─────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# Install runtime tools + Python3 for voice (TTS/STT engines)
RUN apk add --no-cache \
    curl bash git wget \
    python3 py3-pip python3-dev \
    build-base linux-headers \
    ffmpeg sox libsndfile-dev \
    && ln -sf python3 /usr/bin/python

# Install only production dependencies
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application
COPY --from=builder /app/dist ./dist
COPY assets ./assets
COPY ui/dist ./ui/dist
COPY .env.example ./.env.example

# Copy voice server and agent
COPY titan-voice-server ./titan-voice-server
COPY titan-voice-agent ./titan-voice-agent
COPY scripts/qwen3-tts-server.py ./scripts/qwen3-tts-server.py

# Create non-root titan user
RUN addgroup -g 1001 titan && adduser -u 1001 -G titan -D titan
# Give titan user permission to install Python packages
RUN mkdir -p /home/titan/.titan && chown -R titan:titan /home/titan

USER titan

ENV NODE_ENV=production
ENV TITAN_HOME=/home/titan/.titan
# Bind to 0.0.0.0 for container networking
ENV TITAN_GATEWAY_HOST=0.0.0.0

EXPOSE 48420

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:48420/api/health || exit 1

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["gateway"]
