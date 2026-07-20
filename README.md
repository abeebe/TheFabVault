# TheFabricatorsVault

A self-hosted digital asset vault for makers, hackers, and hobbyists. Organize your 3D print files, GCode, laser cut designs, SVGs, DXF patterns, and reference images in one place — with thumbnails, metadata extraction, folders, tags, full-text search, and more.

MIT licensed. Runs anywhere Docker runs — published images support both **linux/amd64** and **linux/arm64** (Raspberry Pi, Apple Silicon, etc).

---

## Run it (published images)

The fastest way to try TheFabVault: no Node toolchain, no build step, just Docker.

**Requirements:** Docker Engine 20.10+ and Docker Compose v2.

```bash
# 1. Grab the compose file and env template
mkdir thefabvault && cd thefabvault
curl -O https://raw.githubusercontent.com/abeebe/TheFabVault/v0.1.0/docker-compose.yml
curl -O https://raw.githubusercontent.com/abeebe/TheFabVault/v0.1.0/.env.example
cp .env.example .env

# 2. Edit .env: set AUTH_USERNAME, AUTH_PASSWORD, and (optionally) JWT_SECRET
#    (openssl rand -hex 32 for a good JWT_SECRET; if left blank one is
#    generated and persisted in the database on first boot)

# 3. Start it
docker compose up -d

# 4. Open the UI
open http://localhost:8080
```

Log in with the `AUTH_USERNAME` / `AUTH_PASSWORD` you set in `.env`. Your files and database persist under `./data/` on the host, so upgrades and restarts never lose data.

`docker-compose.yml` pulls versioned, multi-arch images from GHCR:

| Image | Contains |
|---|---|
| `ghcr.io/abeebe/thefabvault-api:v0.1.0` | Express API, SQLite, thumbnail generation |
| `ghcr.io/abeebe/thefabvault-web:v0.1.0` | React UI served by Nginx |

Each tag is a single manifest covering both `linux/amd64` and `linux/arm64` — Docker automatically pulls the variant that matches your host, no extra flags needed on either architecture.

**One thing to know before you deploy this on a home server and open it from your phone or another computer:** the published web image has its API URL compiled into the browser bundle at build time (`VITE_API_URL=http://localhost:3000`). That works perfectly if you always reach the UI at `http://localhost:8080` on the same machine running Docker, or through something that makes it look like localhost to your browser (an SSH tunnel, Tailscale, etc). It will not work if you open the UI from a different device using the server's LAN IP (e.g. `http://192.168.1.50:8080`), because your browser will still try to call `http://localhost:3000`, which does not exist on that device.

If that is your setup, build the web image yourself with your server's real IP baked in. It is one extra step: see [Build from source](#build-from-source-development) below.

To move to a newer release later, bump the two `image:` tags in `docker-compose.yml` and run `docker compose up -d` again; it pulls the new tag and recreates the containers without touching `./data/`.

---

## Features

**File Management**
- Upload, organize, rename, tag, and add notes to any asset
- Nested folder tree with drag-and-drop-friendly hierarchy
- Multi-tag system — apply multiple tags per asset; filter by any combination
- Full-text search across filenames, tags, and notes
- Bulk select and batch operations (delete, move, download)
- Trash / soft-delete with restore — nothing is permanently gone until you empty the trash
- Star ratings (1–5) per asset
- Version tracking — upload new versions of a file, restore any previous one
- Favorites — heart any asset and filter to just your favorites from the sidebar

**Viewing & Metadata**
- Interactive Three.js viewer for STL, OBJ, and 3MF files
- GCode viewer — syntax-highlighted with slicer stats panel (print time, filament, temps, layer info)
- DXF / SVG viewer — lightweight 2D preview for CNC and laser cut files
- Automatic thumbnail generation for 3D models, images, SVG, DXF, and GCode
- Metadata extraction — dimensions from images, triangle count + bounding box from 3D models, full slicer settings from GCode

**Slicer Handoff**
- "Open in Slicer" button on any 3D model (STL, OBJ, 3MF)
- Supports OrcaSlicer, PrusaSlicer, Bambu Studio, and Cura
- URI-scheme launch for OrcaSlicer and PrusaSlicer; direct download fallback for Bambu/Cura

**Projects**
- Group assets into named projects
- Per-project printer, laser, and vinyl settings that cascade to all files
- Per-file setting overrides on top of project defaults

**Storage & Import**
- Folder-tree project import — pick a local folder in the browser, preview the tree, and commit it into a project's build manifest (dedup by content hash across the whole vault)
- Configurable storage root — point `STORAGE_DIR` at any path, including a NAS mount
- Bulk download — download any selection as a ZIP archive
- Duplicate detection — find duplicates by filename or exact content hash (SHA-256)
- Hash check at upload — warns before adding a file that already exists in the vault
- Orphan detection — finds dead database records (file missing) and orphan storage directories; cleans them up in one click

**Admin & Auth**
- JWT authentication — single-user auth; disable entirely for LAN-only setups
- Admin Settings panel — storage path, network mounts (NFS/SMB), library tools, app restart
- Dark / light / system theme — persisted per browser
- Docker-first — ships as two containers (API + web) via Docker Compose

---

## Supported File Types

| Category | Extensions |
|---|---|
| 3D Models | `.stl` `.obj` `.3mf` |
| GCode | `.gcode` `.gc` `.g` |
| Vector / CAD | `.svg` `.dxf` |
| Images | `.png` `.jpg` `.jpeg` `.webp` |

Any other file type can be stored and downloaded; thumbnails and metadata are only generated for the types above.

---

## Architecture

```
┌─────────────────────┐     HTTP      ┌──────────────────────┐
│   Web (React/Vite)  │ ────────────► │  API (Express/Node)  │
│   Nginx · Port 80   │               │  Port 3000           │
└─────────────────────┘               └──────────┬───────────┘
                                                 │
                                    ┌────────────┼────────────┐
                                    │            │            │
                               SQLite DB    File Storage  Thumbnails
                               (SQLite3)    (STORAGE_DIR) (Chromium
                                                            + Three.js)
```

- **Frontend** — React 18, Vite, TypeScript, Tailwind CSS, Three.js, lucide-react
- **Backend** — Node.js, Express, TypeScript, better-sqlite3, Puppeteer/Chromium (thumbnails), Sharp (image processing), Archiver (ZIP export)
- **Database** — SQLite with schema-versioned migrations and WAL mode
- **Storage** — flat filesystem: `STORAGE_DIR/<uuid>/<filename>`. Defaults to `./data/storage` but can be any path.

---

## Build from source (development)

Use this path if you are changing code, need a web image built with your own `VITE_API_URL` (LAN-IP access from other devices), or just prefer building locally over pulling images.

### 1. Clone and configure your environment

```bash
git clone https://github.com/abeebe/TheFabVault.git
cd TheFabVault
cp .env.example .env
```

Open `.env` and set these required values:

```env
# Login credentials
AUTH_USERNAME=admin
AUTH_PASSWORD=yourpassword

# Generate a random secret: openssl rand -hex 32
JWT_SECRET=replace-with-64-char-random-secret

# Replace YOUR_SERVER_IP with the actual LAN IP of your server
# (use localhost if running on your local machine only)
VITE_API_URL=http://YOUR_SERVER_IP:3000
CORS_ORIGINS=http://YOUR_SERVER_IP:8080
```

> **Why the IP matters:** `VITE_API_URL` is baked into the web image at build time. It must be reachable from your **browser**, not just from inside Docker. Using `localhost` here will break things when accessing from another device on your network.

### 2. Build and start

```bash
docker compose -f docker-compose.build.yml up -d --build
```

The first build takes a few minutes — Chromium is installed for thumbnail generation. Subsequent builds are fast thanks to Docker layer caching.

### 3. Open the UI

```
http://YOUR_SERVER_IP:8080
```

Log in with the `AUTH_USERNAME` / `AUTH_PASSWORD` you set in `.env`.

---

## Port Reference

| Variable | Default | Description |
|---|---|---|
| `WEB_PORT` | `8080` | Host port for the browser UI |
| `API_PORT` | `3000` | Host port for the REST API |

To change ports, edit `.env`:
```env
WEB_PORT=9090
API_PORT=4000
VITE_API_URL=http://YOUR_SERVER_IP:4000
CORS_ORIGINS=http://YOUR_SERVER_IP:9090
```

If you are pulling published images, `docker compose up -d` picks up the new ports (the web image's baked-in API URL is unaffected, see the note in [Run it](#run-it-published-images)). If you are building from source, also rebuild: `docker compose -f docker-compose.build.yml up -d --build`.

---

## Common Commands

**Published images** (`docker-compose.yml`):
```bash
# Start
docker compose up -d

# View logs
docker compose logs -f api
docker compose logs -f web

# Stop everything
docker compose down

# Stop and remove volumes (destructive — deletes database and storage)
docker compose down -v
```

**Build from source** (`docker-compose.build.yml`):
```bash
# Start (after first build)
docker compose -f docker-compose.build.yml up -d

# Rebuild after code or .env changes
docker compose -f docker-compose.build.yml up -d --build

# View logs
docker compose -f docker-compose.build.yml logs -f api
docker compose -f docker-compose.build.yml logs -f web

# Stop everything
docker compose -f docker-compose.build.yml down

# Stop and remove volumes (destructive — deletes database and storage)
docker compose -f docker-compose.build.yml down -v
```

---

## Data Persistence

All data is stored on the host under `./data/` (relative to the project root):

```
./data/
├── storage/     # Uploaded files and version archives
│   └── <uuid>/
│       ├── <filename>
│       └── versions/
│           └── <versionId>_<filename>
└── db/          # SQLite database
    └── vault.db
```

This directory is bind-mounted into the containers, so your data survives container rebuilds and image upgrades.

---

## NAS / Network Storage

Network mounts (NFS and SMB/CIFS) can be configured from the Admin Settings panel in the UI — no manual config file editing required. Both `docker-compose.yml` and `docker-compose.build.yml` include `cap_add: [SYS_ADMIN]` so the container can mount shares directly.

Alternatively, Docker-managed NFS or SMB volumes are available via:
```bash
docker compose -f docker-compose.nfs.yml up -d
# or
docker compose -f docker-compose.smb.yml up -d
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for full NAS setup instructions.

---

## Disabling Authentication

For a trusted LAN-only setup where you don't want a login screen, leave `AUTH_USERNAME` and `AUTH_PASSWORD` blank in `.env`:

```env
AUTH_USERNAME=
AUTH_PASSWORD=
```

---

## Project Structure

```
TheFabricatorsVault/
├── api/                  # Express API server
│   └── src/
│       ├── routes/       # assets, folders, projects, auth, admin, thumbs
│       ├── services/     # fileStore, thumbGen, metaExtract, storageStats
│       ├── auth.ts       # JWT middleware
│       ├── config.ts     # environment config
│       └── db.ts         # SQLite + versioned migrations
├── web/                  # React frontend
│   └── src/
│       ├── components/   # UI components
│       ├── hooks/        # useAssets, useFolders, useProjects, useAuth, useTheme
│       └── lib/          # api client, dxf renderer, theme
├── data/                 # Created at runtime (gitignored)
│   ├── storage/          # Uploaded asset files
│   └── db/               # SQLite database
├── docker-compose.yml         # Published images (quickstart)
├── docker-compose.build.yml   # Build from source (development)
├── docker-compose.nfs.yml
├── docker-compose.smb.yml
├── .env.example
└── LICENSE
```

---

## Platform support

Published images (`ghcr.io/abeebe/thefabvault-api` and `-web`) are **multi-arch: linux/amd64 and linux/arm64**, built and pushed as a single manifest per tag from GitHub Actions using Docker Buildx with QEMU emulation for the arm64 leg.

The arm64 build compiles two native (non-JS) dependencies in the API image — `better-sqlite3` and Puppeteer/Chromium's native bindings — under emulation, which is the step most likely to be flaky on cross-arch CI. That leg was independently verified end-to-end (2026-07-20): a full `docker buildx build --platform linux/arm64` of the API image ran all stages to completion, including the `better-sqlite3` native compile, and a repeat run returned a clean exit 0 off the shared build cache. No native arm64 runner is required.

Docker resolves the correct architecture automatically when you `docker pull` or `docker compose up` a multi-arch tag — no platform flags needed on either amd64 or arm64 hosts.

---

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Aaron Beebe.
