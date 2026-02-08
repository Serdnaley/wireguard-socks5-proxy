FROM oven/bun:1 AS base
WORKDIR /app

# Install system dependencies for WireGuard
RUN apt-get update && apt-get install -y \
    wireguard \
    wireguard-tools \
    iptables \
    iproute2 \
    && rm -rf /var/lib/apt/lists/*

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
    && rm -rf /var/lib/apt/lists/*

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
