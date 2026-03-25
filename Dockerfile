FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production image ──────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Create non-root user
RUN addgroup -g 1001 -S peercortex && \
    adduser -S peercortex -u 1001 -G peercortex
USER peercortex

# SQLite cache volume
VOLUME ["/app/data"]
ENV CACHE_DB_PATH=/app/data/peercortex-cache.db

ENTRYPOINT ["node", "dist/mcp-server/index.js"]
