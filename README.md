# TheFabricatorsVault

A self-hosted digital asset vault for makers, hackers, and hobbyists. Organize your 3D print files, GCode, laser cut designs, SVGs, DXF patterns, and reference images in one place — with thumbnails, metadata extraction, folders, tags, full-text search, and more.

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
- NAS / network mount import — point the API at a mounted share; files are moved into storage (zero-copy rename), preserving folder structure
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

## Quick Start

### 1. Configure your environment

```bash
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
docker compose up -d --build
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

Then rebuild: `docker compose up -d --build`

---

## Common Commands

```bash
# Start (after first build)
docker compose up -d

# Rebuild after code or .env changes
docker compose up -d --build

# View API logs
docker compose logs -f api

# View web logs
docker compose logs -f web

# Stop everything
docker compose down

# Stop and remove volumes (destructive — deletes database and storage)
docker compose down -v
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

This directory is bind-mounted into the containers, so your data survives container rebuilds and updates.

---

## NAS / Network Storage

Network mounts (NFS and SMB/CIFS) can be configured from the Admin Settings panel in the UI — no manual config file editing required. The `SYS_ADMIN` capability in `docker-compose.yml` enables the container to mount shares directly.

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
│       ├── services/     # fileStore, thumbGen, mountImport, metaExtract, storageStats
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
├── docker-compose.yml
├── docker-compose.nfs.yml
├── docker-compose.smb.yml
└── .env.example
```

---

## License

MIT
