#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "${RED}Error: .env file not found.${NC}"
    echo "Please copy .env.example to .env and configure the values:"
    echo "  cp .env.example .env"
    echo "  # Edit .env with your settings"
    exit 1
fi

# Load environment variables
export $(grep -v '^#' .env | xargs)

echo -e "${BLUE}Starting TheFabVault...${NC}"
echo ""

# Kill existing processes if running
pkill -f "node api/dist/index.js" 2>/dev/null || true
pkill -f "http-server" 2>/dev/null || true
sleep 1

# Build and start API
echo -e "${BLUE}Building API...${NC}"
cd api
npm run build > /dev/null 2>&1
echo -e "${GREEN}✓ API built${NC}"

echo -e "${BLUE}Starting API on port ${API_PORT:-3000}...${NC}"
nohup node dist/index.js > api.log 2>&1 &
API_PID=$!
sleep 2

# Check if API started successfully
if ! kill -0 $API_PID 2>/dev/null; then
    echo -e "${RED}✗ API failed to start. Check api.log:${NC}"
    tail -20 api.log
    exit 1
fi
echo -e "${GREEN}✓ API started (PID: $API_PID)${NC}"

# Build and start Web
cd ../web
echo -e "${BLUE}Building Web frontend...${NC}"
npm run build > /dev/null 2>&1
echo -e "${GREEN}✓ Web built${NC}"

echo -e "${BLUE}Starting Web server on port ${WEB_PORT:-8080}...${NC}"
nohup npx http-server dist -p ${WEB_PORT:-8080} > web.log 2>&1 &
WEB_PID=$!
sleep 2

if ! kill -0 $WEB_PID 2>/dev/null; then
    echo -e "${RED}✗ Web server failed to start. Check web.log:${NC}"
    tail -20 web.log
    kill $API_PID 2>/dev/null || true
    exit 1
fi
echo -e "${GREEN}✓ Web server started (PID: $WEB_PID)${NC}"

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ TheFabVault is running!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "  API:  http://localhost:${API_PORT:-3000}"
echo -e "  Web:  http://localhost:${WEB_PORT:-8080}"
echo ""
echo -e "Logs:"
echo -e "  API:  ${PWD}/api/api.log"
echo -e "  Web:  ${PWD}/web/web.log"
echo ""
echo -e "${BLUE}To stop services, run:${NC}"
echo -e "  kill $API_PID $WEB_PID"
echo ""
