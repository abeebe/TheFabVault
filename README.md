# TheFabricatorsVault

A self-hosted digital asset vault for makers, hackers, and hobbyists. Organize your 3D print files, laser cut designs, SVGs, DXF patterns, and reference images in one place — with thumbnails, folders, tags, and full-text search.

---

## Features

- **File management** — upload, organize, rename, tag, and add notes to any asset
- **Folder tree** — nested folders with drag-and-drop-friendly hierarchy
- **Tag system** — apply multiple tags per asset; filter by any combination
- **Full-text search** — search across filenames, tags, and notes
- **Thumbnail generation** — automatic previews for 3D models (STL, OBJ, 3MF), images (PNG, JPG, WEBP), SVG, and DXF files
- **3D model viewer** — interactive Three.js viewer for STL, OBJ, and 3MF files directly in the browser
- **DXF viewer** — lightweight 2D preview for CNC and laser cut DXF files
- **Bulk download** — download any selection of assets as a ZIP archive
- **NAS / mount import** — point the API at a mounted network share and it will scan and import files automatically, preserving folder structure
- **JWT authentication** — simple single-user auth; disable it entirely for LAN-only setups
- **Dark / light / system theme** — persisted per browser
- **Docker-first** — ships as two containers (API + web) wired together with Docker Compose

## Supported File Types

| Category | Extensions |
|---|---|
| 3D Models | `.stl` `.obj` `.3mf` |
| Vector / CAD | `.svg` `.dxf` |
| Images | `.png` `.jpg` `.jpeg` `.webp` |

Any other file type can be stored and downloaded; thumbnails are generated only for the types listed above.

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
                               (SQLite3)    (./data/storage) (Puppeteer
                                                              + Three.js)
```

- **Frontend** — React 18, Vite, TypeScript, Tailwind CSS, Three.js, lucide-react
- **Backend** — Node.js, Express, TypeScript, better-sqlite3, Puppeteer (headless Chromium for thumbnail rendering), Sharp (image processing), Archiver (ZIP export)
- **Database** — SQLite, schema-versioned migrations, WAL mode

## Quick Start

```bash
# 1. Copy and configure environment
cp .env.example .env
# Edit .env — set AUTH_USERNAME, AUTH_PASSWORD, JWT_SECRET, and your server IP

# 2. Build and start
docker compose up -d --build

# 3. Open the UI
# http://YOUR_SERVER_IP:8080
```

See [INSTALLATION.md](INSTALLATION.md) for full setup instructions, environment variable reference, NAS import configuration, and local development setup.

## Project Structure

```
TheFabricatorsVault/
├── api/                  # Express API server
│   └── src/
│       ├── routes/       # assets, folders, auth, thumbs
│       ├── services/     # fileStore, thumbGen, mountImport
│       ├── auth.ts       # JWT middleware
│       ├── config.ts     # environment config
│       └── db.ts         # SQLite + migrations
├── web/                  # React frontend
│   └── src/
│       ├── components/   # UI components
│       ├── hooks/        # useAssets, useFolders, useAuth, useTheme
│       └── lib/          # api client, dxf renderer, theme
├── data/                 # Created at runtime (gitignored)
│   ├── storage/          # Uploaded asset files + thumbnails
│   └── db/               # SQLite database
├── docker-compose.yml
└── .env.example
```

## License

MIT
