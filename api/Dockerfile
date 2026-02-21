FROM node:20-alpine

# Chromium and dependencies for Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# Use system Chromium instead of Puppeteer's bundled version
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Copy static files to dist
COPY src/static/ ./dist/static/

RUN mkdir -p /app/storage/thumbs /app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
