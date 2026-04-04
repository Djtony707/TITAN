# ─── Stage 1: Dependencies ───────────────────────────────────
# Separate deps stage for better layer caching — only changes when package.json changes
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

# ─── Stage 2: Build ──────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
COPY scripts ./scripts
COPY tsconfig.json ./

# Install all deps (including devDependencies for tsup + Vite build)
RUN npm ci

COPY src ./src
COPY ui ./ui
RUN npm run build && npm run build:ui

# ─── Stage 3: Production ─────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# Install runtime deps only — no build tools needed at runtime
RUN apk add --no-cache \
    curl bash git wget \
    python3 \
    ffmpeg sox libsndfile \
    && ln -sf python3 /usr/bin/python

# Copy production dependencies (from deps stage)
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./

# Copy built application (from builder stage)
COPY --from=builder /app/dist ./dist

# Copy static assets and UI build
COPY assets ./assets
COPY --from=builder /app/ui/dist ./ui/dist
COPY .env.example ./.env.example

# Copy voice components
COPY titan-voice-server ./titan-voice-server
COPY titan-voice-agent ./titan-voice-agent
COPY scripts/qwen3-tts-server.py ./scripts/qwen3-tts-server.py

# Create non-root titan user with home directory
RUN addgroup -g 1001 titan && \
    adduser -u 1001 -G titan -D -h /home/titan titan && \
    mkdir -p /home/titan/.titan && \
    chown -R titan:titan /home/titan

USER titan

ENV NODE_ENV=production
ENV TITAN_HOME=/home/titan/.titan
ENV TITAN_GATEWAY_HOST=0.0.0.0

EXPOSE 48420

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://127.0.0.1:48420/api/health || exit 1

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["gateway"]
