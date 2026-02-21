# Installation Guide

## Requirements

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) (v2)
- A Linux host, NAS (e.g. Synology, TrueNAS), or any machine that can run Docker
- Ports 80 and 3000 available (or change them in `.env`)

---

## 1. Clone the Repository

```bash
git clone https://github.com/youruser/TheFabricatorsVault.git
cd TheFabricatorsVault
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
docker compose up -d --build
```

The first build takes a few minutes (Puppeteer downloads Chromium). Subsequent starts are fast.

Check that both containers are running:

```bash
docker compose ps
```

View logs:

```bash
docker compose logs -f
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
docker compose down

# Update (after pulling new code)
docker compose up -d --build
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
| `IMPORT_MOUNT_PATH_HOST` | _(empty)_ | Host path of your NAS or external mount to import from (see NAS Import below). |
| `IMPORT_MOUNT_PATH` | `/imports` | Container-internal path — do not change. |
| `IMPORT_MOUNT_ON_STARTUP` | `true` | Automatically scan the mount when the API starts. |
| `IMPORT_MOUNT_EXTS` | _(empty = defaults)_ | Comma-separated extensions to import. Empty = `stl,obj,3mf,svg,dxf,png,jpg,jpeg,webp`. Use `*` for all. |
| `IMPORT_MAX_MB` | `512` | Maximum file size to import (in MB). Larger files are skipped. |

---

## NAS / Mount Import

TheFabricatorsVault can scan a mounted network share and automatically import files into the vault while preserving directory structure as folders.

### Setup

1. Mount your NAS share on the host:

```bash
# Example: NFS
sudo mount -t nfs 192.168.1.50:/volume1/3dprints /mnt/nas/3dprints

# Example: SMB (requires cifs-utils)
sudo mount -t cifs //192.168.1.50/3dprints /mnt/nas/3dprints -o username=user,password=pass
```

2. Set the host path in `.env`:

```env
IMPORT_MOUNT_PATH_HOST=/mnt/nas/3dprints
IMPORT_MOUNT_PATH=/imports
IMPORT_MOUNT_ON_STARTUP=true
```

3. Rebuild and start:

```bash
docker compose up -d --build
```

On startup the API will scan the mount, copy matching files into storage, and queue thumbnails for generation. Files already imported (tracked by source path) are skipped on subsequent scans.

### Manual Re-scan

Trigger a scan at any time from the sidebar's import button in the UI, or via the API:

```bash
curl -X POST http://localhost:3000/import/scan \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

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

All persistent data is written to `./data/` on the host:

```
data/
├── storage/          # Uploaded files and generated thumbnails
└── db/
    └── thefabricatorsvault.db   # SQLite database
```

Back up the entire `./data/` directory to preserve your vault. Restoring is as simple as copying it back and running `docker compose up`.
