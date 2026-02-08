import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from './logger';
import { Config } from './config';
import { execSync } from 'child_process';

const WG_DIR = '/etc/wireguard';

export async function initializeWireGuard(config: Config): Promise<void> {
  const dataDir = config.data?.dir || './data';
  const wgDir = join(dataDir, 'wireguard');
  const interfaceName = config.wireguard.interface;
  const keyPath = join(wgDir, `${interfaceName}.key`);
  const configPath = join(wgDir, `${interfaceName}.conf`);
  const runtimeConfigPath = join(WG_DIR, `${interfaceName}.conf`);

  logger.info({ component: 'wireguard', interface: interfaceName }, 'Initializing WireGuard server');

  // Ensure directories exist
  try {
    mkdirSync(wgDir, { recursive: true });
  } catch (error) {
    logger.error({ component: 'wireguard', error }, 'Failed to create wireguard directory');
    throw error;
  }

  // Generate server keypair if it doesn't exist
  if (!existsSync(keyPath)) {
    logger.info({ component: 'wireguard' }, 'Generating server keypair');
    try {
      const privateKey = execSync('wg genkey', { encoding: 'utf-8' }).trim();
      const publicKey = execSync('wg pubkey', { input: privateKey, encoding: 'utf-8' }).trim();

      writeFileSync(keyPath, privateKey + '\n', { mode: 0o600 });
      logger.info({ component: 'wireguard' }, 'Server keypair generated');
    } catch (error) {
      logger.error({ component: 'wireguard', error }, 'Failed to generate server keypair');
      throw error;
    }
  }

  // Read server private key
  const serverPrivateKey = readFileSync(keyPath, 'utf-8').trim();

  // Create or update server config
  const serverConfig = generateServerConfig(config, serverPrivateKey);
  writeFileSync(configPath, serverConfig, { mode: 0o600 });
  logger.info({ component: 'wireguard', path: configPath }, 'Server config written to project directory');

  // Copy to /etc/wireguard/ for kernel module
  try {
    mkdirSync(WG_DIR, { recursive: true });
    writeFileSync(runtimeConfigPath, serverConfig, { mode: 0o600 });
    logger.info({ component: 'wireguard', path: runtimeConfigPath }, 'Server config copied to /etc/wireguard/');
  } catch (error) {
    logger.error({ component: 'wireguard', error }, 'Failed to copy config to /etc/wireguard/');
    throw error;
  }

  // Bring up WireGuard interface
  try {
    execSync(`wg-quick down ${interfaceName}`, { stdio: 'ignore' });
  } catch (error) {
    // Interface might not exist, ignore error
  }

  try {
    execSync(`wg-quick up ${interfaceName}`, { stdio: 'pipe' });
    logger.info({ component: 'wireguard', interface: interfaceName }, 'WireGuard interface brought up');
  } catch (error) {
    logger.error({ component: 'wireguard', error }, 'Failed to bring up WireGuard interface');
    throw error;
  }
}

export function generateServerConfig(config: Config, serverPrivateKey: string): string {
  const { interface: iface, subnet, listen_port, server_ip } = config.wireguard;

  let configContent = `[Interface]
PrivateKey = ${serverPrivateKey}
Address = ${server_ip}/${subnet.split('/')[1]}
ListenPort = ${listen_port}

`;

  // Peers will be added by updateWireGuardConfig when clients are initialized
  return configContent;
}

export async function updateWireGuardConfig(config: Config): Promise<void> {
  const dataDir = config.data?.dir || './data';
  const wgDir = join(dataDir, 'wireguard');
  const clientsDir = join(dataDir, 'clients');
  const interfaceName = config.wireguard.interface;
  const keyPath = join(wgDir, `${interfaceName}.key`);
  const configPath = join(wgDir, `${interfaceName}.conf`);
  const runtimeConfigPath = join(WG_DIR, `${interfaceName}.conf`);

  if (!existsSync(keyPath)) {
    throw new Error('Server key not found. Initialize WireGuard first.');
  }

  const serverPrivateKey = readFileSync(keyPath, 'utf-8').trim();
  let serverConfig = generateServerConfig(config, serverPrivateKey);

  // Read all client configs and extract public keys
  const clientConfigs = config.clients;
  for (const client of clientConfigs) {
    const clientConfigPath = join(clientsDir, `${client.name}.conf`);
    if (existsSync(clientConfigPath)) {
      const clientConfig = readFileSync(clientConfigPath, 'utf-8');
      const privateKeyMatch = clientConfig.match(/PrivateKey\s*=\s*([A-Za-z0-9+/=]+)/);
      if (privateKeyMatch) {
        const clientPrivateKey = privateKeyMatch[1];
        try {
          const clientPublicKey = execSync('wg pubkey', { input: clientPrivateKey, encoding: 'utf-8' }).trim();
          const allowedIPsMatch = clientConfig.match(/Address\s*=\s*(\d+\.\d+\.\d+\.\d+)\/\d+/);
          const clientIP = allowedIPsMatch ? allowedIPsMatch[1] : '';

          if (clientIP) {
            serverConfig += `[Peer]
PublicKey = ${clientPublicKey}
AllowedIPs = ${clientIP}/32

`;
          }
        } catch (error) {
          logger.warn({ component: 'wireguard', client: client.name, error }, 'Failed to extract client public key');
        }
      }
    }
  }

  // Write updated config to project directory
  writeFileSync(configPath, serverConfig, { mode: 0o600 });
  logger.info({ component: 'wireguard', path: configPath }, 'Server config updated in project directory');

  // Copy to /etc/wireguard/ and reload
  try {
    writeFileSync(runtimeConfigPath, serverConfig, { mode: 0o600 });
    execSync(`wg-quick down ${interfaceName}`, { stdio: 'ignore' });
    execSync(`wg-quick up ${interfaceName}`, { stdio: 'pipe' });
    logger.info({ component: 'wireguard', interface: interfaceName }, 'WireGuard config reloaded');
  } catch (error) {
    logger.error({ component: 'wireguard', error }, 'Failed to reload WireGuard config');
    throw error;
  }
}

export function getWireGuardStatus(interfaceName: string): any {
  try {
    const output = execSync(`wg show ${interfaceName}`, { encoding: 'utf-8' });
    return { status: 'up', output };
  } catch (error) {
    return { status: 'down', error: String(error) };
  }
}
