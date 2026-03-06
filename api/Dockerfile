FROM node:20-bookworm-slim

# Use the system-installed Chromium instead of Puppeteer's bundled x86-64 binary.
# This makes the image work on both amd64 and arm64 (Apple Silicon, Raspberry Pi, etc.)
# because apt installs the correct architecture automatically.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# System dependencies:
#  - chromium      → architecture-native Chromium (replaces Puppeteer bundled binary)
#  - nfs-common    → provides mount.nfs4 for NFS share mounting
#  - cifs-utils    → provides mount.cifs for SMB/CIFS share mounting
#  (Requires cap_add: [SYS_ADMIN] in docker-compose.yml for in-container mounting)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
    wget \
    nfs-common \
    cifs-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true (set above) prevents the ~300 MB bundled
# Chromium download during npm ci — we use the system package instead.
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Copy static files (Three.js, thumb-renderer.html) to dist
COPY src/static/ ./dist/static/

# Storage dirs + import mount points (in-app NFS/SMB mounts land here)
RUN mkdir -p /app/storage/thumbs /app/data /imports/1 /imports/2 /imports/3

EXPOSE 3000

CMD ["node", "dist/index.js"]
