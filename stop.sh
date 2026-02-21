#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}Stopping TheFabVault services...${NC}"

# Kill API
if pkill -f "node api/dist/index.js"; then
    echo -e "${GREEN}✓ Stopped API${NC}"
else
    echo -e "${BLUE}ℹ API was not running${NC}"
fi

# Kill Web Server
if pkill -f "http-server"; then
    echo -e "${GREEN}✓ Stopped Web server${NC}"
else
    echo -e "${BLUE}ℹ Web server was not running${NC}"
fi

echo -e "${GREEN}Done!${NC}"
