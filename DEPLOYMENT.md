# TheFabVault Deployment Guide

This guide covers deploying TheFabVault in various environments: Docker (recommended), local development, and production non-Docker setups.

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Environment Configuration](#environment-configuration)
4. [Docker Deployment](#docker-deployment)
5. [Local Development](#local-development)
6. [Production Non-Docker Deployment](#production-non-docker-deployment)
7. [Troubleshooting](#troubleshooting)
8. [Architecture Notes](#architecture-notes)

## Prerequisites

### For Docker Deployment
- Docker Engine 20.10+
- Docker Compose 2.0+

### For Local/Non-Docker Deployment
- Node.js 20.14.0 or later
- npm 10.x or later
- For web server: npx (included with npm)
- Bash shell (for start.sh script)

### System Requirements
- Minimum 512 MB RAM (1GB recommended)
- 500 MB disk space (varies with file storage)
- Ports 3000 (API) and 8080 (Web) available (configurable)

## Quick Start

### Docker (Recommended)
```bash
# Clone or navigate to the repository
cd TheFabVault

# Copy and configure environment
cp .env.example .env
# Edit .env with your settings (especially change AUTH_PASSWORD)

# Start services
docker compose up -d --build

# Check logs
docker compose logs -f
```

Access the application at `http://localhost:8080` (or your configured WEB_PORT).

### Local/Non-Docker
```bash
# Clone or navigate to the repository
cd TheFabVault

# Copy and configure environment
cp .env.example .env
# Edit .env with your settings

# Install dependencies
cd api && npm install
cd ../web && npm install && cd ..

# Start both services
./start.sh
```

Access the application at `http://localhost:8080` (or your configured WEB_PORT).

## Environment Configuration

### Creating the .env File

```bash
cp .env.example .env
# Edit .env with your configuration
```

### Required Environment Variables

| Variable | Default | Description | Required |
|----------|---------|-------------|----------|
| `AUTH_USERNAME` | - | Login username | Yes* |
| `AUTH_PASSWORD` | - | Login password | Yes* |
| `JWT_SECRET` | changeme | Secret key for JWT tokens - MUST be changed in production | Yes |
| `API_PORT` | 3000 | Port for API server | No |
| `WEB_PORT` | 8080 | Port for web server | No |
| `VITE_API_URL` | http://localhost:3000 | URL where browser reaches the API | Yes** |
| `CORS_ORIGINS` | http://localhost:8080 | Comma-separated list of allowed origins | Yes** |

*Note: Leave both empty to disable authentication (not recommended for production)
**Note: Must match actual deployment URLs and ports

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_TTL` | 43200 | JWT token lifetime in seconds (12 hours) |
| `STORAGE_DIR` | ./data/storage | Directory for uploaded files |
| `DATA_DIR` | ./data/db | Directory for database files |
| `IMPORT_MOUNT_PATH` | - | Path to NAS mount for file imports |
| `IMPORT_MOUNT_PATH_HOST` | - | Host path for NAS mount (Docker only) |
| `IMPORT_MOUNT_ON_STARTUP` | true | Auto-scan NAS mount at startup |
| `IMPORT_MOUNT_EXTS` | stl,obj,3mf,svg,dxf,png,jpg,jpeg,webp,gcode,gc,g | File extensions to import |
| `IMPORT_MAX_MB` | 512 | Maximum file size per upload in MB |

### Example Configuration for Development

```env
# .env
AUTH_USERNAME=admin
AUTH_PASSWORD=changeme
JWT_SECRET=dev-secret-change-in-production
API_PORT=3000
WEB_PORT=8080
VITE_API_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:8080
```

### Example Configuration for Production

```env
# .env
AUTH_USERNAME=admin
AUTH_PASSWORD=secure-password-here-change-this
JWT_SECRET=<output-of: openssl rand -hex 32>
API_PORT=3000
WEB_PORT=80
VITE_API_URL=https://thefabvault.example.com
CORS_ORIGINS=https://thefabvault.example.com
STORAGE_DIR=/data/storage
DATA_DIR=/data/db
```

## Docker Deployment

### Using Docker Compose (Recommended)

Docker Compose automatically handles:
- Building both API and web images
- Setting environment variables during web build
- Running both services with proper networking
- Volume persistence for data
- Health checks and automatic restarts
- Port mapping

```bash
# Start services in background
docker compose up -d --build

# View logs
docker compose logs -f api
docker compose logs -f web

# Stop services
docker compose down

# Remove volumes too (WARNING: deletes all data)
docker compose down -v
```

### Docker Compose Environment Variables

The `docker-compose.yml` file automatically reads from `.env` and:
1. Passes variables to the API container at runtime
2. Passes `VITE_API_URL` to the web build process (at image build time)
3. Maps volumes for persistent storage

**Important:** The web image must be rebuilt if you change `VITE_API_URL`:
```bash
docker compose up -d --build
```

### Accessing the Application

- **Web UI:** `http://localhost:${WEB_PORT}` (default: 8080)
- **API:** `http://localhost:${API_PORT}` (default: 3000)
- **Default credentials:** admin / changeme

## Local Development

### Setup for Development

```bash
# Install dependencies
cd api && npm install
cd ../web && npm install

# Build API
cd ../api && npm run build

# Build web
cd ../web && npm run build
```

### Running Development Servers

#### Option 1: Using start.sh (Recommended for testing)
```bash
./start.sh
```

#### Option 2: Separate Terminal Sessions

**Terminal 1 - API (with file watching):**
```bash
cd api
export $(grep -v '^#' ../.env | xargs)
npm run dev
```

**Terminal 2 - Web Frontend:**
```bash
cd web
export VITE_API_URL=http://localhost:3000
npm run dev
```

The web dev server will be available at `http://localhost:5173` with hot reload.

### Building for Production (Non-Docker)

```bash
# Ensure .env is configured
# Build API
cd api && npm run build

# Build Web - MUST set VITE_API_URL before building
cd ../web
VITE_API_URL=http://your-server-ip:3000 npm run build

# Start services
cd ..
./start.sh
```

## Production Non-Docker Deployment

### Prerequisites
1. Node.js 20.14+ installed
2. Reverse proxy (nginx/Apache) configured (optional but recommended)
3. `.env` file configured with production values
4. Ports 3000 and 8080 available (or adjust in .env)

### Deployment Steps

```bash
# 1. Clone repository
git clone <repo-url> /opt/thefabvault
cd /opt/thefabvault

# 2. Configure environment
cp .env.example .env
# Edit .env with production settings
nano .env

# 3. Install dependencies
cd api && npm install
cd ../web && npm install
cd ..

# 4. Start services
./start.sh
```

### Running as System Service (Optional)

Create `/etc/systemd/system/thefabvault.service`:

```ini
[Unit]
Description=TheFabVault
After=network.target

[Service]
Type=forking
WorkingDirectory=/opt/thefabvault
ExecStart=/opt/thefabvault/start.sh
ExecReload=/bin/kill -HUP $MAINPID
KillMode=process
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable thefabvault
sudo systemctl start thefabvault
sudo systemctl status thefabvault
```

### Reverse Proxy Configuration (nginx)

```nginx
upstream thefabvault_api {
    server localhost:3000;
}

upstream thefabvault_web {
    server localhost:8080;
}

server {
    listen 80;
    server_name thefabvault.example.com;

    # Web UI
    location / {
        proxy_pass http://thefabvault_web;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API - if accessing at /api prefix (optional)
    location /api/ {
        proxy_pass http://thefabvault_api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Troubleshooting

### Port Already in Use
```bash
# Find process using port 3000
lsof -i :3000

# Kill process
kill -9 <PID>

# Or change port in .env
API_PORT=3001
```

### CORS Errors in Browser Console
**Error:** "Origin http://... is not allowed by Access-Control-Allow-Origin"

**Causes:**
1. `VITE_API_URL` doesn't match API address
2. `CORS_ORIGINS` doesn't match browser origin
3. Web build was created with wrong `VITE_API_URL`

**Solutions:**
```bash
# Check .env values match your actual URLs
grep VITE_API_URL .env
grep CORS_ORIGINS .env

# If changed, rebuild web
cd web && VITE_API_URL=http://your-ip:3000 npm run build && cd ..

# Restart services
./start.sh
```

### Auth Not Working / "Invalid username or password"
**Causes:**
1. AUTH_USERNAME or AUTH_PASSWORD not set in .env
2. .env not being loaded by API

**Solutions:**
```bash
# Check .env has credentials
grep AUTH_ .env

# Check API logs for "Auth: enabled"
tail -20 api/api.log

# Verify variables were exported
echo $AUTH_USERNAME
echo $AUTH_PASSWORD
```

### API Won't Start
```bash
# Check API logs
tail -50 api/api.log

# Check npm dependencies are installed
cd api && npm install && npm run build

# Check port isn't in use
lsof -i :3000
```

### Web Won't Load
```bash
# Check web logs
tail -50 web/web.log

# Verify web server is running
ps aux | grep http-server

# Check logs for build errors
cd web && npm run build
```

### Database Lock Issues
The SQLite database uses WAL (Write-Ahead Logging) mode for concurrency. If you see lock errors:

```bash
# Stop services
./stop.sh  # or manually kill processes

# Remove WAL files
rm data/db/thefabvault.db-wal
rm data/db/thefabvault.db-shm

# Restart
./start.sh
```

## Architecture Notes

### Build-Time vs Runtime Variables

**Build-time Variables (Web):**
- `VITE_API_URL` - Embedded in the JavaScript bundle during build
- Changing this requires rebuilding the web bundle
- Must be available when running `npm run build`

**Runtime Variables (API):**
- `AUTH_USERNAME`, `AUTH_PASSWORD`, `CORS_ORIGINS`, etc.
- Read from `.env` file or process.env when API starts
- Can change by updating `.env` and restarting API
- No rebuild needed

### How Environment Variables Flow

**Docker:**
```
.env → docker-compose.yml → containers (both at build and runtime)
```

**Non-Docker:**
```
.env → export $(grep ... .env | xargs) → process.env
       API reads at startup (via dotenv)
       Web embeds at build time (via npm scripts)
```

### Data Storage

**Docker:**
- Volumes mapped in docker-compose.yml
- Data persists even when containers stop
- Location in container: `/app/storage`, `/app/data`
- Host location: `./data/storage`, `./data/db`

**Non-Docker:**
- Configured in .env via `STORAGE_DIR`, `DATA_DIR`
- Default: `./data/storage`, `./data/db`
- Accessible directly from host filesystem

### File Upload Limits

Set `IMPORT_MAX_MB` in `.env` to limit file size:
```env
IMPORT_MAX_MB=512  # 512 MB per file
```

## Support & Debugging

### Enable Debug Logging

The application logs to:
- **API:** `api.log` (if using start.sh) or stdout
- **Web:** `web.log` (if using start.sh) or stdout

To see real-time logs:
```bash
tail -f api/api.log
tail -f web/web.log
```

### Collecting System Info for Support

```bash
# Export info that might be helpful
node --version
npm --version
docker --version
docker compose --version
cat .env  # Be careful with passwords!
tail -100 api/api.log
tail -100 web/web.log
```
