import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { logger } from './logger';
import { Config, getConfig } from './config';
import { updateWireGuardConfig } from './wireguard';

export async function initializeClients(config: Config): Promise<void> {
  const dataDir = config.data?.dir || './data';
  const clientsDir = join(dataDir, 'clients');

  logger.info({ component: 'client' }, 'Initializing clients');

  // Ensure clients directory exists
  try {
    mkdirSync(clientsDir, { recursive: true });
  } catch (error) {
    logger.error({ component: 'client', error }, 'Failed to create clients directory');
    throw error;
  }

  // Validate unique client names
  const clientNames = config.clients.map(c => c.name);
  const uniqueNames = new Set(clientNames);
  if (uniqueNames.size !== clientNames.length) {
    throw new Error('Duplicate client names found');
  }

  // Initialize each client
  for (const client of config.clients) {
    await initializeClient(client, config);
  }

  // Update WireGuard config with all clients
  await updateWireGuardConfig(config);
  logger.info({ component: 'client' }, 'All clients initialized');
}

async function initializeClient(client: { name: string; privateKey?: string; publicKey?: string }, config: Config): Promise<void> {
  const dataDir = config.data?.dir || './data';
  const clientsDir = join(dataDir, 'clients');
  const clientConfigPath = join(clientsDir, `${client.name}.conf`);

  // If config already exists, skip (unless keys are provided)
  if (existsSync(clientConfigPath) && !client.privateKey) {
    logger.info({ component: 'client', client: client.name }, 'Client config already exists, skipping');
    return;
  }

  logger.info({ component: 'client', client: client.name }, 'Initializing client');

  // Generate or use provided keys
  let clientPrivateKey: string;
  let clientPublicKey: string;

  if (client.privateKey) {
    clientPrivateKey = client.privateKey;
    try {
      clientPublicKey = execSync('wg pubkey', { input: clientPrivateKey, encoding: 'utf-8' }).trim();
    } catch (error) {
      logger.error({ component: 'client', client: client.name, error }, 'Failed to generate public key from provided private key');
      throw error;
    }
  } else {
    try {
      clientPrivateKey = execSync('wg genkey', { encoding: 'utf-8' }).trim();
      clientPublicKey = execSync('wg pubkey', { input: clientPrivateKey, encoding: 'utf-8' }).trim();
    } catch (error) {
      logger.error({ component: 'client', client: client.name, error }, 'Failed to generate client keypair');
      throw error;
    }
  }

  // Get server public key
  const wgDir = join(dataDir, 'wireguard');
  const interfaceName = config.wireguard.interface;
  const serverKeyPath = join(wgDir, `${interfaceName}.key`);
  
  if (!existsSync(serverKeyPath)) {
    throw new Error('Server key not found. Initialize WireGuard first.');
  }

  const serverPrivateKey = readFileSync(serverKeyPath, 'utf-8').trim();
  const serverPublicKey = execSync('wg pubkey', { input: serverPrivateKey, encoding: 'utf-8' }).trim();

  // Assign client IP (simple sequential assignment starting from .2)
  const subnetParts = config.wireguard.subnet.split('/');
  const baseIP = subnetParts[0].split('.');
  const clientIndex = config.clients.findIndex(c => c.name === client.name);
  const baseIPLastOctet = parseInt(baseIP[3]);
  const clientIP = `${baseIP[0]}.${baseIP[1]}.${baseIP[2]}.${baseIPLastOctet + clientIndex + 2}`;

  // Generate client config
  const clientConfig = generateClientConfig(
    clientPrivateKey,
    clientIP,
    config.wireguard.server_ip,
    config.wireguard.listen_port,
    serverPublicKey
  );

  // Write client config
  writeFileSync(clientConfigPath, clientConfig, { mode: 0o600 });
  logger.info({ component: 'client', client: client.name, path: clientConfigPath }, 'Client config written');
}

export function generateClientConfig(
  clientPrivateKey: string,
  clientIP: string,
  serverIP: string,
  serverPort: number,
  serverPublicKey: string,
  dns?: string
): string {
  const dnsServer = dns || '1.1.1.1'; // Default to Cloudflare DNS
  
  return `[Interface]
PrivateKey = ${clientPrivateKey}
Address = ${clientIP}/32
DNS = ${dnsServer}

[Peer]
PublicKey = ${serverPublicKey}
Endpoint = ${serverIP}:${serverPort}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
`;
}

export function getClientConfig(clientName: string): string | null {
  const config = getConfig();
  const dataDir = config.data?.dir || './data';
  const clientsDir = join(dataDir, 'clients');
  const clientConfigPath = join(clientsDir, `${clientName}.conf`);

  if (!existsSync(clientConfigPath)) {
    return null;
  }

  return readFileSync(clientConfigPath, 'utf-8');
}

export function getAllClients(): string[] {
  const config = getConfig();
  return config.clients.map(c => c.name);
}
