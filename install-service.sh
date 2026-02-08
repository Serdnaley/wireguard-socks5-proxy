#!/bin/bash

# WireGuard SOCKS5 proxy - Systemd Service Installer
# This script installs and manages the Bun application as a systemd service

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SERVICE_NAME="wireguard-socks5-proxy"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER="${SUDO_USER:-$USER}"
BUN_PATH=$(which bun)

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (use sudo)${NC}"
    exit 1
fi

# Check if bun is installed
if [ -z "$BUN_PATH" ]; then
    echo -e "${YELLOW}Bun not found in PATH. Attempting to find bun...${NC}"
    # Try common locations
    if [ -f "/home/${USER}/.bun/bin/bun" ]; then
        BUN_PATH="/home/${USER}/.bun/bin/bun"
    elif [ -f "/usr/local/bin/bun" ]; then
        BUN_PATH="/usr/local/bin/bun"
    else
        echo -e "${RED}Bun is not installed. Please install Bun first.${NC}"
        echo "Visit: https://bun.sh/docs/installation"
        echo "Or run: curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi
fi

echo -e "${GREEN}Using Bun at: ${BUN_PATH}${NC}"

# Check if WireGuard tools are installed
if ! command -v wg &> /dev/null || ! command -v wg-quick &> /dev/null; then
    echo -e "${YELLOW}WireGuard tools (wg, wg-quick) not found. Attempting to install...${NC}"
    
    # Detect package manager and install WireGuard
    if command -v apt-get &> /dev/null; then
        apt-get update
        apt-get install -y wireguard wireguard-tools
        echo -e "${GREEN}✓ WireGuard tools installed${NC}"
    elif command -v yum &> /dev/null; then
        yum install -y wireguard-tools
        echo -e "${GREEN}✓ WireGuard tools installed${NC}"
    elif command -v dnf &> /dev/null; then
        dnf install -y wireguard-tools
        echo -e "${GREEN}✓ WireGuard tools installed${NC}"
    elif command -v pacman &> /dev/null; then
        pacman -S --noconfirm wireguard-tools
        echo -e "${GREEN}✓ WireGuard tools installed${NC}"
    else
        echo -e "${RED}Could not detect package manager. Please install WireGuard tools manually.${NC}"
        echo "For Ubuntu/Debian: sudo apt-get install wireguard wireguard-tools"
        echo "For CentOS/RHEL: sudo yum install wireguard-tools"
        echo "For Fedora: sudo dnf install wireguard-tools"
        echo "For Arch: sudo pacman -S wireguard-tools"
        exit 1
    fi
    
    # Verify installation
    if ! command -v wg &> /dev/null || ! command -v wg-quick &> /dev/null; then
        echo -e "${RED}WireGuard tools installation failed. Please install manually.${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓ WireGuard tools found${NC}"
fi

echo -e "${GREEN}Installing ${SERVICE_NAME} systemd service...${NC}"

# Ensure /etc/wireguard directory exists for mount namespacing
if [ ! -d "/etc/wireguard" ]; then
    echo -e "${YELLOW}Creating /etc/wireguard directory...${NC}"
    mkdir -p /etc/wireguard
    chmod 755 /etc/wireguard
    echo -e "${GREEN}✓ /etc/wireguard directory created${NC}"
fi

# Ensure data directory exists for mount namespacing
if [ ! -d "${APP_DIR}/data" ]; then
    echo -e "${YELLOW}Creating data directory...${NC}"
    mkdir -p "${APP_DIR}/data"
    chmod 755 "${APP_DIR}/data"
    echo -e "${GREEN}✓ Data directory created${NC}"
fi

# Create systemd service file
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=WireGuard SOCKS5 proxy
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
Group=${USER}
WorkingDirectory=${APP_DIR}
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/${USER}/.bun/bin"
Environment="CONFIG_PATH=${APP_DIR}/config.yaml"
ExecStart=${BUN_PATH} run ${APP_DIR}/src/index.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Security settings (commented out for WireGuard to work)
# NoNewPrivileges=true
# PrivateTmp=true
# ProtectSystem=strict
# ProtectHome=read-only
ReadWritePaths=${APP_DIR}/data
ReadWritePaths=/etc/wireguard

# Capabilities for WireGuard
CapabilityBoundingSet=CAP_NET_ADMIN CAP_SYS_MODULE
AmbientCapabilities=CAP_NET_ADMIN CAP_SYS_MODULE

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}Service file created at ${SERVICE_FILE}${NC}"

# Reload systemd
systemctl daemon-reload
echo -e "${GREEN}Systemd daemon reloaded${NC}"

# Enable service
systemctl enable "${SERVICE_NAME}.service"
echo -e "${GREEN}Service enabled${NC}"

# Check if service is running
if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    echo -e "${YELLOW}Service is already running. Restarting...${NC}"
    systemctl restart "${SERVICE_NAME}.service"
else
    echo -e "${GREEN}Starting service...${NC}"
    systemctl start "${SERVICE_NAME}.service"
fi

# Wait a moment for service to start
sleep 2

# Check service status
if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    echo -e "${GREEN}✓ Service is running${NC}"
    echo ""
    echo "Service status:"
    systemctl status "${SERVICE_NAME}.service" --no-pager -l
else
    echo -e "${RED}✗ Service failed to start${NC}"
    echo ""
    echo "Service logs:"
    journalctl -u "${SERVICE_NAME}.service" -n 20 --no-pager
    exit 1
fi

echo ""
echo -e "${GREEN}Installation complete!${NC}"
echo ""
echo "Useful commands:"
echo "  Check status:    sudo systemctl status ${SERVICE_NAME}"
echo "  View logs:       sudo journalctl -u ${SERVICE_NAME} -f"
echo "  Restart:         sudo systemctl restart ${SERVICE_NAME}"
echo "  Stop:            sudo systemctl stop ${SERVICE_NAME}"
echo "  Start:           sudo systemctl start ${SERVICE_NAME}"
echo "  Disable:         sudo systemctl disable ${SERVICE_NAME}"
