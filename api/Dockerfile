FROM node:20-bookworm-slim

# System dependencies that Puppeteer's bundled Chromium needs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Let Puppeteer download its own Chromium (includes SwiftShader for WebGL)
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Copy static files (Three.js, thumb-renderer.html) to dist
COPY src/static/ ./dist/static/

RUN mkdir -p /app/storage/thumbs /app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
