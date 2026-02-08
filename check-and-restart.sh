#!/bin/bash

# WireGuard SOCKS5 proxy - Service Check and Restart Script
# This script checks if the service is running and restarts it if needed

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SERVICE_NAME="wireguard-socks5-proxy"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (use sudo)${NC}"
    exit 1
fi

# Check if service exists
if [ ! -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
    echo -e "${YELLOW}Service not found. Run install-service.sh first.${NC}"
    exit 1
fi

# Check service status
if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    echo -e "${GREEN}✓ Service is running${NC}"
    exit 0
else
    echo -e "${YELLOW}Service is not running. Starting...${NC}"

    # Try to start the service
    if systemctl start "${SERVICE_NAME}.service"; then
        sleep 2

        if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
            echo -e "${GREEN}✓ Service started successfully${NC}"
            exit 0
        else
            echo -e "${RED}✗ Service failed to start${NC}"
            echo ""
            echo "Recent logs:"
            journalctl -u "${SERVICE_NAME}.service" -n 20 --no-pager
            exit 1
        fi
    else
        echo -e "${RED}✗ Failed to start service${NC}"
        echo ""
        echo "Recent logs:"
        journalctl -u "${SERVICE_NAME}.service" -n 20 --no-pager
        exit 1
    fi
fi
