import { execSync, spawn, ChildProcess } from 'child_process';
import { logger } from './logger';
import { Config, getConfig } from './config';
import { join } from 'path';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'fs';

const TUN2SOCKS_BIN = '/usr/local/bin/tun2socks';
const TUN_POOL_BASE = '10.210.0.0/16'; // Base pool for TUN interfaces
const ROUTE_TABLE_BASE = 100;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAY_MS = 5000; // 5 seconds between restart attempts

interface TunnelProcess {
  process: ChildProcess;
  clientName: string;
  tunInterface: string;
  proxyUrl: string;
  restartAttempts: number;
  restartTimer?: ReturnType<typeof setTimeout>;
}

const activeTunnels = new Map<string, TunnelProcess>();

/**
 * Calculate TUN subnet for a client based on client index
 */
function getTunSubnet(clientIndex: number): string {
  const baseOctet = Math.floor(clientIndex / 256);
  const subOctet = clientIndex % 256;
  return `10.210.${baseOctet}.${subOctet}/24`;
}

/**
 * Calculate route table number for a client
 */
function getRouteTable(clientIndex: number): number {
  return ROUTE_TABLE_BASE + clientIndex;
}

/**
 * Get client IP from WireGuard config
 */
function getClientIP(clientName: string, config: Config): string | null {
  const dataDir = config.data?.dir || './data';
  const clientsDir = join(dataDir, 'clients');
  const clientConfigPath = join(clientsDir, `${clientName}.conf`);
  
  try {
    if (!existsSync(clientConfigPath)) {
      return null;
    }
    
    const clientConfig = readFileSync(clientConfigPath, 'utf-8');
    const match = clientConfig.match(/Address\s*=\s*(\d+\.\d+\.\d+\.\d+)\/\d+/);
    return match ? match[1] : null;
  } catch (error) {
    logger.error({ component: 'tunnel', client: clientName, error }, 'Failed to get client IP');
    return null;
  }
}

/**
 * Setup TUN interface and routing for a client
 */
export async function setupClientTunnel(clientName: string, config: Config): Promise<void> {
  const clientIndex = config.clients.findIndex(c => c.name === clientName);
  if (clientIndex === -1) {
    throw new Error(`Client ${clientName} not found in config`);
  }

  const tunInterface = `tun-${clientName}`;
  const tunSubnet = getTunSubnet(clientIndex);
  const routeTable = getRouteTable(clientIndex);
  const clientIP = getClientIP(clientName, config);

  if (!clientIP) {
    throw new Error(`Could not determine IP for client ${clientName}`);
  }

  logger.info(
    { component: 'tunnel', client: clientName, tun: tunInterface, subnet: tunSubnet },
    'Setting up TUN interface for client'
  );

  // Parse subnet to get TUN IP
  const subnetParts = tunSubnet.split('/');
  const baseIP = subnetParts[0].split('.');
  const tunIP = `${baseIP[0]}.${baseIP[1]}.${baseIP[2]}.2`;
  const peerGW = `${baseIP[0]}.${baseIP[1]}.${baseIP[2]}.1`;

  try {
    // Create TUN interface if it doesn't exist
    try {
      execSync(`ip link show ${tunInterface}`, { stdio: 'ignore' });
      // Interface exists, flush addresses
      execSync(`ip addr flush dev ${tunInterface}`, { stdio: 'ignore' });
    } catch (error) {
      // Interface doesn't exist, create it
      execSync(`ip tuntap add dev ${tunInterface} mode tun`, { stdio: 'pipe' });
    }

    // Configure TUN interface
    execSync(`ip addr add ${tunIP}/24 peer ${peerGW} dev ${tunInterface}`, { stdio: 'pipe' });
    execSync(`ip link set dev ${tunInterface} up`, { stdio: 'pipe' });

    // Setup routing table
    execSync(`ip route replace default dev ${tunInterface} table ${routeTable}`, { stdio: 'pipe' });

    // Setup policy-based routing rule
    const prio = 200 + (clientIndex % 100);
    try {
      execSync(`ip rule del from ${clientIP}/32 table ${routeTable}`, { stdio: 'ignore' });
    } catch (error) {
      // Rule might not exist, ignore
    }
    execSync(`ip rule add priority ${prio} from ${clientIP}/32 lookup ${routeTable}`, { stdio: 'pipe' });

    // Setup iptables forwarding rules
    const wgInterface = config.wireguard.interface;
    try {
      execSync(`iptables -D FORWARD -i ${wgInterface} -o ${tunInterface} -j ACCEPT`, { stdio: 'ignore' });
      execSync(`iptables -D FORWARD -i ${tunInterface} -o ${wgInterface} -j ACCEPT`, { stdio: 'ignore' });
      execSync(`iptables -t nat -D POSTROUTING -o ${tunInterface} -j MASQUERADE`, { stdio: 'ignore' });
    } catch (error) {
      // Rules might not exist, ignore
    }
    execSync(`iptables -I FORWARD -i ${wgInterface} -o ${tunInterface} -j ACCEPT`, { stdio: 'pipe' });
    execSync(`iptables -I FORWARD -i ${tunInterface} -o ${wgInterface} -j ACCEPT`, { stdio: 'pipe' });
    execSync(`iptables -t nat -I POSTROUTING -o ${tunInterface} -j MASQUERADE`, { stdio: 'pipe' });

    logger.info({ component: 'tunnel', client: clientName, tun: tunInterface }, 'TUN interface configured');
  } catch (error) {
    logger.error({ component: 'tunnel', client: clientName, error }, 'Failed to setup TUN interface');
    throw error;
  }
}

/**
 * Find TUN2SOCKS binary path
 */
function findTun2SocksBinary(): string | null {
  try {
    const whichOutput = execSync(`which tun2socks`, { encoding: 'utf-8' }).trim();
    if (whichOutput) {
      return whichOutput;
    }
  } catch (error) {
    // which failed, try direct path
  }

  try {
    execSync(`test -f ${TUN2SOCKS_BIN}`, { stdio: 'ignore' });
    return TUN2SOCKS_BIN;
  } catch (error) {
    return null;
  }
}

/**
 * Start TUN2SOCKS process for a client with auto-restart on failure
 */
async function startTun2SocksProcess(clientName: string, proxyUrl: string, config: Config, isRestart: boolean = false): Promise<void> {
  const tunInterface = `tun-${clientName}`;
  
  // Find TUN2SOCKS binary
  const tun2socksPath = findTun2SocksBinary();
  if (!tun2socksPath) {
    logger.warn({ component: 'tunnel', client: clientName }, 'TUN2SOCKS binary not found. Install tun2socks to enable proxy routing.');
    return;
  }

  logger.info(
    { component: 'tunnel', client: clientName, proxy: proxyUrl, tun: tunInterface, is_restart: isRestart },
    'Starting TUN2SOCKS process'
  );

  try {
    const dataDir = config.data?.dir || './data';
    const logsDir = join(dataDir, 'logs');
    const logFile = join(logsDir, `tun2socks-${clientName}.log`);

    // Ensure log directory exists
    try {
      mkdirSync(logsDir, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }

    // Start tun2socks process
    const tun2socksProcess = spawn(tun2socksPath, [
      '-device', tunInterface,
      '-proxy', proxyUrl,
      '-loglevel', 'info'
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    // Redirect output to log file
    const logStream = createWriteStream(logFile, { flags: 'a' });
    tun2socksProcess.stdout?.pipe(logStream);
    tun2socksProcess.stderr?.pipe(logStream);

    const tunnelInfo: TunnelProcess = {
      process: tun2socksProcess,
      clientName,
      tunInterface,
      proxyUrl,
      restartAttempts: isRestart ? (activeTunnels.get(clientName)?.restartAttempts || 0) + 1 : 0,
    };

    tun2socksProcess.on('error', (error) => {
      logger.error({ component: 'tunnel', client: clientName, error }, 'TUN2SOCKS process error');
      handleTunnelFailure(clientName, config, tunnelInfo);
    });

    tun2socksProcess.on('exit', (code, signal) => {
      logger.warn({ component: 'tunnel', client: clientName, code, signal }, 'TUN2SOCKS process exited');
      
      // Only attempt restart if exit was unexpected (not SIGTERM/SIGKILL)
      if (signal !== 'SIGTERM' && signal !== 'SIGKILL' && code !== 0) {
        handleTunnelFailure(clientName, config, tunnelInfo);
      } else {
        activeTunnels.delete(clientName);
      }
    });

    activeTunnels.set(clientName, tunnelInfo);

    logger.info({ component: 'tunnel', client: clientName, proxy: proxyUrl }, 'TUN2SOCKS process started');
  } catch (error) {
    logger.error({ component: 'tunnel', client: clientName, error }, 'Failed to start TUN2SOCKS');
    throw error;
  }
}

/**
 * Handle tunnel failure and attempt restart
 */
function handleTunnelFailure(clientName: string, config: Config, tunnelInfo: TunnelProcess): void {
  activeTunnels.delete(clientName);

  if (tunnelInfo.restartAttempts >= MAX_RESTART_ATTEMPTS) {
    logger.error(
      { component: 'tunnel', client: clientName, attempts: tunnelInfo.restartAttempts },
      'Max restart attempts reached, giving up'
    );
    return;
  }

  logger.info(
    { component: 'tunnel', client: clientName, attempt: tunnelInfo.restartAttempts + 1, max: MAX_RESTART_ATTEMPTS },
    'Scheduling TUN2SOCKS restart'
  );

  const restartTimer = setTimeout(() => {
    startTun2SocksProcess(clientName, tunnelInfo.proxyUrl, config, true).catch(err => {
      logger.error({ component: 'tunnel', client: clientName, error: err }, 'Failed to restart TUN2SOCKS');
    });
  }, RESTART_DELAY_MS);

  tunnelInfo.restartTimer = restartTimer;
}

/**
 * Start TUN2SOCKS process for a client
 */
export async function startTun2Socks(clientName: string, proxyUrl: string, config: Config): Promise<void> {
  // Stop existing tunnel if any
  await stopClientTunnel(clientName);

  // Ensure TUN interface is set up
  await setupClientTunnel(clientName, config);

  // Start TUN2SOCKS process
  await startTun2SocksProcess(clientName, proxyUrl, config, false);
}

/**
 * Stop TUN2SOCKS process and cleanup for a client
 */
export async function stopClientTunnel(clientName: string): Promise<void> {
  const tunnel = activeTunnels.get(clientName);
  
  if (tunnel) {
    logger.info({ component: 'tunnel', client: clientName }, 'Stopping TUN2SOCKS process');
    
    // Clear restart timer if exists
    if (tunnel.restartTimer) {
      clearTimeout(tunnel.restartTimer);
    }
    
    try {
      tunnel.process.kill('SIGTERM');
      // Wait a bit, then force kill if still running
      setTimeout(() => {
        if (!tunnel.process.killed) {
          tunnel.process.kill('SIGKILL');
        }
      }, 2000);
    } catch (error) {
      logger.warn({ component: 'tunnel', client: clientName, error }, 'Error stopping TUN2SOCKS process');
    }
    
    activeTunnels.delete(clientName);
  }

  // Also kill any orphaned processes
  try {
    execSync(`pkill -f "tun2socks.*tun-${clientName}"`, { stdio: 'ignore' });
  } catch (error) {
    // Process might not exist, ignore
  }
}

/**
 * Initialize tunnels for all clients with their assigned proxies
 * Note: This function is kept for potential future use, but tunnels are now
 * initialized automatically when proxies are assigned via assignProxyToClient()
 */
export async function initializeClientTunnels(config: Config): Promise<void> {
  logger.info({ component: 'tunnel' }, 'Initializing client tunnels');

  // Import getCurrentProxy dynamically to avoid circular dependency
  const { getCurrentProxy } = await import('./proxy');
  
  for (const client of config.clients) {
    const currentProxy = getCurrentProxy(client.name);
    
    if (currentProxy) {
      await startTun2Socks(client.name, currentProxy.url, config);
    } else {
      logger.warn({ component: 'tunnel', client: client.name }, 'No proxy assigned, skipping tunnel setup');
    }
  }
}

/**
 * Restart tunnel with new proxy (used during rotation)
 */
export async function restartClientTunnel(clientName: string, newProxyUrl: string, config: Config): Promise<void> {
  await stopClientTunnel(clientName);
  await startTun2Socks(clientName, newProxyUrl, config);
}

/**
 * Cleanup all tunnels on shutdown
 */
export async function cleanupAllTunnels(): Promise<void> {
  logger.info({ component: 'tunnel' }, 'Cleaning up all tunnels');

  const clientNames = Array.from(activeTunnels.keys());
  
  for (const clientName of clientNames) {
    await stopClientTunnel(clientName);
  }

  // Cleanup TUN interfaces and routing rules
  const config = getConfig();
  for (const client of config.clients) {
    const tunInterface = `tun-${client.name}`;
    const clientIndex = config.clients.findIndex(c => c.name === client.name);
    const routeTable = getRouteTable(clientIndex);
    const clientIP = getClientIP(client.name, config);

    if (clientIP) {
      try {
        // Remove routing rule
        execSync(`ip rule del from ${clientIP}/32 table ${routeTable}`, { stdio: 'ignore' });
      } catch (error) {
        // Rule might not exist, ignore
      }

      // Remove iptables rules
      const wgInterface = config.wireguard.interface;
      try {
        execSync(`iptables -D FORWARD -i ${wgInterface} -o ${tunInterface} -j ACCEPT`, { stdio: 'ignore' });
        execSync(`iptables -D FORWARD -i ${tunInterface} -o ${wgInterface} -j ACCEPT`, { stdio: 'ignore' });
        execSync(`iptables -t nat -D POSTROUTING -o ${tunInterface} -j MASQUERADE`, { stdio: 'ignore' });
      } catch (error) {
        // Rules might not exist, ignore
      }

      // Optionally remove TUN interface (or leave it for reuse)
      try {
        execSync(`ip link delete ${tunInterface}`, { stdio: 'ignore' });
      } catch (error) {
        // Interface might not exist or be in use, ignore
      }
    }
  }

  logger.info({ component: 'tunnel' }, 'All tunnels cleaned up');
}
