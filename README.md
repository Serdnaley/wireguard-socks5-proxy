# WireGuard SOCKS5 proxy

A Bun/TypeScript application that manages a WireGuard server with automatic proxy rotation for clients. Each client's traffic is routed through rotating SOCKS5 proxies with location-based selection.

## Features

- **WireGuard Server**: Runs a WireGuard server accepting multiple clients
- **Proxy Rotation**: Automatically rotates SOCKS5 proxies for each client on a configurable schedule
- **Location-Based Selection**: Selects proxies from different locations, preferring freshest (least recently used) proxies
- **Client Management**: Generates and manages WireGuard client configurations
- **HTTP API**: RESTful API for client configs, QR codes, and manual proxy rotation
- **JSON Logging**: Structured JSON logging with pino
- **File-Based Persistence**: All data stored in project directory

## Requirements

- Bun runtime (v1.0+)
- Linux with WireGuard kernel module
- Root/privileged access for WireGuard operations
- WireGuard tools (`wg`, `wg-quick`)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd wireguard-socks5-proxy
```

2. Install dependencies:
```bash
bun install
```

3. Copy and configure `config.yaml`:
```bash
cp config.example.yaml config.yaml
# Edit config.yaml with your settings
```

## Usage

### Run with Bun (Development)

```bash
bun run src/index.ts
```

Or use the start script:
```bash
bun start
```

### Run as Systemd Service (Production - Ubuntu)

1. Install the service:
```bash
sudo ./install-service.sh
```

This will:
- Create a systemd service file
- Enable the service to start on boot
- Start the service immediately
- Set up proper permissions and capabilities for WireGuard

2. Check and restart service (if needed):
```bash
sudo ./check-and-restart.sh
```

This script checks if the service is running and restarts it if not.

**Service Management Commands:**
```bash
# Check status
sudo systemctl status wireguard-socks5-proxy

# View logs
sudo journalctl -u wireguard-socks5-proxy -f

# Restart service
sudo systemctl restart wireguard-socks5-proxy

# Stop service
sudo systemctl stop wireguard-socks5-proxy

# Start service
sudo systemctl start wireguard-socks5-proxy

# Disable service (prevent auto-start on boot)
sudo systemctl disable wireguard-socks5-proxy
```

### Run with Docker

```bash
docker-compose up -d
```

## Project Structure

```
wireguard-socks5-proxy/
├── src/
│   ├── index.ts       # Entry point
│   ├── config.ts      # Configuration parsing
│   ├── wireguard.ts   # WireGuard management
│   ├── client.ts      # Client management
│   ├── proxy.ts       # Proxy rotation logic
│   ├── state.ts       # State management
│   ├── qr.ts          # QR code generation
│   ├── logger.ts      # Logging setup
│   └── http.ts        # HTTP server
├── data/              # Data directory (created at runtime)
│   ├── clients/       # Client config files
│   ├── wireguard/     # Server config and keys
│   ├── logs/          # Application logs
│   └── state.json     # Proxy rotation state
├── config.yaml        # Configuration file
├── config.example.yaml # Example configuration
├── package.json       # Dependencies
├── install-service.sh # Systemd service installer
├── check-and-restart.sh # Service health check script
└── README.md          # This file
```

## API Endpoints

### Health Check
```bash
GET /health
```

### List Clients
```bash
GET /clients
```

### Get Client Config
```bash
GET /client/{name}/config
```
Returns plain text WireGuard configuration.

### Get Client QR Code
```bash
GET /client/{name}/qr
```
Returns PNG QR code image for mobile setup.

### Rotate Proxy for Client
```bash
POST /client/{name}/rotate
Content-Type: application/json

{
  "location": "US"  # Optional: specify preferred location
}
```

## Data Persistence

All data is stored in the `./data/` directory:

- **Client configs**: `./data/clients/{name}.conf` - WireGuard client configurations
- **Server config**: `./data/wireguard/{interface}.conf` - WireGuard server configuration
- **Server keys**: `./data/wireguard/{interface}.key` - Server private key
- **State**: `./data/state.json` - Proxy rotation state and history
- **Logs**: `./data/logs/app.log` - Application logs (JSON format)

The application copies WireGuard configs to `/etc/wireguard/` at runtime for the kernel module to use.

## Proxy Rotation

- Proxies are rotated automatically based on `rotation.interval_days`
- When rotating, the system selects the freshest proxy (oldest last usage date) for each client
- Location-based filtering avoids repeating the same location consecutively
- Manual rotation via API endpoint supports optional location preference

## License

MIT.
Do whatever you want, feel free to contribute :)
