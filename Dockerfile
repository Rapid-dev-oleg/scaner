# Sentinel Security Monitor — Full Stack Docker
#
# Multi-stage build:
#  1. Fetch pre-built Nuclei + Katana CLIs
#  2. Node stage — builds frontend
#  3. Runtime — serves everything

# --- Stage 1: Fetch Nuclei + Katana CLIs ---
FROM alpine:3.21 AS nuclei-builder
ARG NUCLEI_VERSION=3.11.0
ARG KATANA_VERSION=1.6.1
RUN apk add --no-cache wget unzip ca-certificates
RUN ARCH=$(uname -m); \
    case "$ARCH" in \
      x86_64) ARCH=amd64 ;; \
      aarch64) ARCH=arm64 ;; \
      *) echo "Unsupported architecture: $ARCH"; exit 1 ;; \
    esac && \
    wget -q "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VERSION}/nuclei_${NUCLEI_VERSION}_linux_${ARCH}.zip" -O /tmp/nuclei.zip && \
    unzip -o -j /tmp/nuclei.zip nuclei -d /usr/local/bin && \
    chmod +x /usr/local/bin/nuclei && \
    wget -q "https://github.com/projectdiscovery/katana/releases/download/v${KATANA_VERSION}/katana_${KATANA_VERSION}_linux_${ARCH}.zip" -O /tmp/katana.zip && \
    unzip -o -j /tmp/katana.zip katana -d /usr/local/bin && \
    chmod +x /usr/local/bin/katana && \
    rm /tmp/nuclei.zip /tmp/katana.zip && \
    nuclei -update-templates

# --- Stage 2: Build Frontend ---
FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# --- Stage 3: Production Runtime ---
# Debian slim (glibc) so better-sqlite3's prebuilt native binary works without
# a compile toolchain. (Alpine/musl needs a full glibc/musl source build and
# was hitting "fcntl64: symbol not found".)
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

# Copy Nuclei + Katana binaries + templates (static Go binaries — run on Debian)
COPY --from=nuclei-builder /usr/local/bin/nuclei /usr/local/bin/nuclei
COPY --from=nuclei-builder /usr/local/bin/katana /usr/local/bin/katana
COPY --from=nuclei-builder /root/nuclei-templates /root/nuclei-templates

# Copy built frontend
COPY --from=frontend-builder /app/dist ./dist

# Copy server (CommonJS). better-sqlite3 downloads a prebuilt binary; that
# download can time out, so retry a few times before giving up (the Debian slim
# image has no compiler, so we must get the prebuilt artifact).
COPY server/ ./server/
RUN cd server && (npm install --omit=dev || npm install --omit=dev || npm install --omit=dev)

ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_URL=/data/sentinel.db
ENV DATA_DIR=/data
ENV NUCLEI_TEMPLATES=/root/nuclei-templates

VOLUME ["/data"]
EXPOSE 3001

CMD ["node", "server/index.js"]
