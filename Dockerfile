FROM oven/bun:1 AS base
WORKDIR /app

# Install system dependencies for WireGuard and TUN2SOCKS
RUN apt-get update && apt-get install -y \
    wireguard \
    wireguard-tools \
    iptables \
    iproute2 \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install TUN2SOCKS (xjasonlyu/tun2socks)
RUN mkdir -p /tmp/t2s && cd /tmp/t2s \
    && curl -fsSL -o tun2socks.zip \
       https://github.com/xjasonlyu/tun2socks/releases/download/v2.6.0/tun2socks-linux-amd64.zip \
    && unzip tun2socks.zip \
    && install -m 0755 tun2socks-linux-amd64 /usr/local/bin/tun2socks \
    && cd / && rm -rf /tmp/t2s

# Copy package files
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Create data directories
RUN mkdir -p /app/data/clients /app/data/wireguard /app/data/logs

# Build the application
RUN bun build src/index.ts --outdir dist --target bun

# Runtime stage
FROM oven/bun:1
WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    wireguard \
    wireguard-tools \
    iptables \
    iproute2 \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install TUN2SOCKS (xjasonlyu/tun2socks)
RUN mkdir -p /tmp/t2s && cd /tmp/t2s \
    && curl -fsSL -o tun2socks.zip \
       https://github.com/xjasonlyu/tun2socks/releases/download/v2.6.0/tun2socks-linux-amd64.zip \
    && unzip tun2socks.zip \
    && install -m 0755 tun2socks-linux-amd64 /usr/local/bin/tun2socks \
    && cd / && rm -rf /tmp/t2s

# Copy built application and dependencies
COPY --from=base /app/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./
COPY --from=base /app/config.yaml.example ./config.yaml.example

# Create data directories with proper permissions
RUN mkdir -p /app/data/clients /app/data/wireguard /app/data/logs && \
    chmod 755 /app/data && \
    chmod 700 /app/data/clients /app/data/wireguard /app/data/logs

# Expose HTTP port
EXPOSE 8000

# Run the application
CMD ["bun", "run", "src/index.ts"]
