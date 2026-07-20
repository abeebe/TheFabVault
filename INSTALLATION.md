# Installation Guide

> This guide covers building TheFabVault from source. If you just want to run
> it without touching code, see the README's "Run it (published images)"
> section instead: pull two GHCR images and `docker compose up -d`, no
> cloning or building required.

## Requirements

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) (v2)
- A Linux host, NAS (e.g. Synology, TrueNAS), or any machine that can run Docker
- Ports 80 and 3000 available (or change them in `.env`)

---

## 1. Clone the Repository

```bash
git clone https://github.com/abeebe/TheFabVault.git
cd TheFabVault
```

---

## 2. Configure Environment

Copy the example file and edit it:

```bash
cp .env.example .env
```

Open `.env` and set the following — at minimum:

```env
AUTH_USERNAME=admin
AUTH_PASSWORD=your-strong-password

# Generate with: openssl rand -hex 32
JWT_SECRET=replace-with-64-char-random-secret

# Your server's IP or hostname — must be reachable from the browser
VITE_API_URL=http://192.168.1.100:3000
CORS_ORIGINS=http://192.168.1.100:8080
```

> **Important:** `VITE_API_URL` is baked into the frontend at build time. It must be the address your **browser** uses to reach the API — not a Docker-internal address.

---

## 3. Build and Start

```bash
docker compose -f docker-compose.build.yml up -d --build
```

The first build takes a few minutes (Puppeteer downloads Chromium). Subsequent starts are fast.

Check that both containers are running:

```bash
docker compose -f docker-compose.build.yml ps
```

View logs:

```bash
docker compose -f docker-compose.build.yml logs -f
```

---

## 4. Access the UI

Open your browser to:

```
http://YOUR_SERVER_IP:8080
```

Log in with the `AUTH_USERNAME` and `AUTH_PASSWORD` you set in `.env`.

---

## 5. Stopping and Updating

```bash
# Stop
docker compose -f docker-compose.build.yml down

# Update (after pulling new code)
docker compose -f docker-compose.build.yml up -d --build
```

Your data in `./data/` is persisted via volume mounts and is not affected by rebuilds.

---

## Environment Variable Reference

| Variable | Default | Description |
|---|---|---|
| `AUTH_USERNAME` | _(empty)_ | Login username. Leave both username and password empty to disable auth entirely. |
| `AUTH_PASSWORD` | _(empty)_ | Login password. |
| `JWT_SECRET` | `changeme-replace-in-production` | Secret used to sign JWT tokens. Must be changed in production. |
| `JWT_TTL` | `43200` | JWT lifetime in seconds (default: 12 hours). |
| `API_PORT` | `3000` | Host port for the API container. |
| `WEB_PORT` | `80` | Host port for the web container. |
| `VITE_API_URL` | `http://localhost:3000` | URL the **browser** uses to reach the API. Baked into the frontend at build time. |
| `CORS_ORIGINS` | `http://localhost` | Comma-separated origins the API allows. Must match how the browser loads the UI. |
| `STORAGE_DIR` | `./data/storage` | Where asset files and thumbnails are stored. Can be any path — including a NAS mount (see [NAS Storage](#nas-storage) below). |
| `DATA_DIR` | `./data/db` | Directory for the SQLite database file. |

---

## Storage

TheFabricatorsVault stores all asset files in a single configurable root directory: `STORAGE_DIR`. Each asset is placed in its own UUID-named subdirectory to prevent filename collisions:

```
STORAGE_DIR/
├── a1b2c3d4-.../
│   └── dragon.stl
├── e5f6g7h8-.../
│   └── my_print.gcode
└── thumbs/
    ├── a1b2c3d4-....jpg
    └── e5f6g7h8-....jpg
```

### Local Storage (Default)

By default `STORAGE_DIR` points to `./data/storage` inside the project. For Docker, this is volume-mounted from the host, so files persist across container rebuilds.

### NAS Storage

To store files directly on a NAS, point `STORAGE_DIR` at the mounted share. All uploads and imports will then write straight to the NAS — no copying between locations:

```bash
# Mount your NAS share on the host first
sudo mount -t nfs 192.168.1.50:/volume1/vault /mnt/nas/vault
# or
sudo mount -t cifs //192.168.1.50/vault /mnt/nas/vault -o username=user,password=pass
```

Then in `docker-compose.build.yml` (or `docker-compose.yml` if you are using published images), add a volume mount so the container can reach it, and set `STORAGE_DIR` to the container-internal path:

```yaml
services:
  api:
    volumes:
      - ./data/db:/app/data/db
      - /mnt/nas/vault:/vault   # mount NAS into container
    environment:
      - STORAGE_DIR=/vault      # use NAS as storage root
      - DATA_DIR=/app/data/db
```

With this setup:
- Files you upload through the web UI go directly to `/mnt/nas/vault/<uuid>/filename`
- Files added via the folder-tree project import (see the in-app Import flow) are moved into this structure the same way
- No duplication — there is one copy of every file, on the NAS

---

## Deleting Assets

When you delete an asset from the vault, you have two options:

- **Remove from vault** — removes the database record and generated thumbnail, but leaves the original file on disk untouched. Useful when storage is on a NAS and you want to keep the file.
- **Delete file from disk** — removes the database record, thumbnail, and the actual file. This is permanent.

Both options are available in the asset card's context menu (single asset) and in the batch action bar when multiple assets are selected.

---

## Disabling Authentication

If the vault is running on a trusted LAN and you don't want a login screen, simply leave `AUTH_USERNAME` and `AUTH_PASSWORD` empty in `.env`:

```env
AUTH_USERNAME=
AUTH_PASSWORD=
```

The API will serve all endpoints without requiring a token and the login page will not appear.

---

## Running Behind a Reverse Proxy

If you use Nginx, Caddy, or Traefik in front of the containers, update `VITE_API_URL` and `CORS_ORIGINS` to match your public domain/path:

```env
VITE_API_URL=https://vault.example.com/api
CORS_ORIGINS=https://vault.example.com
```

Make sure your proxy forwards the `Authorization` header and does not strip it.

---

## Local Development (Without Docker)

### Prerequisites

- Node.js 20+
- npm

### API

```bash
cd api
npm install
# Set environment variables (or create a .env file)
export AUTH_USERNAME=admin
export AUTH_PASSWORD=dev
export JWT_SECRET=devsecret
export STORAGE_DIR=./dev-data/storage
export DATA_DIR=./dev-data/db
npm run dev
# API runs on http://localhost:3000
```

### Web

```bash
cd web
npm install
# Vite reads VITE_API_URL from environment or .env
echo "VITE_API_URL=http://localhost:3000" > .env.local
npm run dev
# UI runs on http://localhost:5173
```

---

## Data Storage

All persistent data lives under `STORAGE_DIR` (files) and `DATA_DIR` (database):

```
data/                         # default locations
├── storage/
│   ├── <uuid>/               # one directory per asset
│   │   └── filename.stl
│   └── thumbs/
│       └── <uuid>.jpg
└── db/
    └── thefabricatorsvault.db
```

To back up your vault, copy both `STORAGE_DIR` and `DATA_DIR`. Restoring is as simple as copying them back and running `docker compose up`.
