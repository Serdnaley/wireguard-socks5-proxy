import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { logger } from './logger';

const ProxySchema = z.object({
  url: z.string().regex(/^socks5:\/\/.+:\d+$/, 'Must be a valid SOCKS5 URL'),
  location: z.string().min(1, 'Location is required'),
});

const ClientSchema = z.object({
  name: z.string().min(1, 'Client name is required'),
  privateKey: z.string().optional(),
  publicKey: z.string().optional(),
});

const WireGuardConfigSchema = z.object({
  interface: z.string().default('wg0'),
  subnet: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/, 'Must be a valid CIDR notation'),
  listen_port: z.number().int().min(1).max(65535),
  server_ip: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/, 'Must be a valid IP address'),
});

const DataConfigSchema = z.object({
  dir: z.string().default('./data'),
});

const RotationConfigSchema = z.object({
  interval: z.number().positive(),
  interval_type: z.enum(['seconds', 'second', 'minutes', 'minute', 'hours', 'hour', 'days', 'day']),
});

const LoggingConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  file: z.string().default('./data/logs/app.log'),
  max_size_mb: z.number().positive().optional(),
  max_backups: z.number().int().positive().optional(),
  max_age_days: z.number().positive().optional(),
});

const HttpConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(8000),
  host: z.string().default('0.0.0.0'),
});

const TelegramConfigSchema = z.object({
  bot_token: z.string().min(1, 'Bot token is required'),
  admin_user_ids: z.array(z.number().int().positive()).min(1, 'At least one admin user ID is required'),
});

const ConfigSchema = z.object({
  wireguard: WireGuardConfigSchema,
  data: DataConfigSchema.optional(),
  rotation: RotationConfigSchema.optional(),
  proxies: z.array(ProxySchema).min(1, 'At least one proxy is required'),
  logging: LoggingConfigSchema.optional(),
  http: HttpConfigSchema.optional(),
  telegram: TelegramConfigSchema.optional(),
  clients: z.array(ClientSchema).min(1, 'At least one client is required'),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Proxy = z.infer<typeof ProxySchema>;
export type Client = z.infer<typeof ClientSchema>;
export type WireGuardConfig = z.infer<typeof WireGuardConfigSchema>;
export type RotationConfig = z.infer<typeof RotationConfigSchema>;

/**
 * Convert rotation config to milliseconds
 */
export function getRotationIntervalMs(rotationConfig?: RotationConfig): number {
  if (!rotationConfig) {
    return 7 * 24 * 60 * 60 * 1000; // Default: 7 days
  }

  const { interval, interval_type } = rotationConfig;
  
  // Normalize interval_type (handle both singular and plural forms)
  const normalizedType = interval_type.toLowerCase();
  
  if (normalizedType === 'seconds' || normalizedType === 'second') {
    return interval * 1000;
  }
  if (normalizedType === 'minutes' || normalizedType === 'minute') {
    return interval * 60 * 1000;
  }
  if (normalizedType === 'hours' || normalizedType === 'hour') {
    return interval * 60 * 60 * 1000;
  }
  if (normalizedType === 'days' || normalizedType === 'day') {
    return interval * 24 * 60 * 60 * 1000;
  }

  // Fallback to default (should not reach here due to schema validation)
  return 7 * 24 * 60 * 60 * 1000;
}

let cachedConfig: Config | null = null;

export async function loadConfig(configPath?: string): Promise<Config> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const path = configPath || process.env.CONFIG_PATH || './config.yaml';

  try {
    logger.info({ component: 'config', path }, 'Loading configuration file');
    const fileContent = readFileSync(path, 'utf-8');
    const rawConfig = parse(fileContent);

    // Validate with Zod
    const config = ConfigSchema.parse(rawConfig);

    // Validate unique client names
    const clientNames = config.clients.map(c => c.name);
    const uniqueNames = new Set(clientNames);
    if (uniqueNames.size !== clientNames.length) {
      throw new Error('Duplicate client names found');
    }

    // Logger will be reinitialized in main() with config settings

    cachedConfig = config;
    logger.info({ component: 'config' }, 'Configuration loaded and validated');

    return config;
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error({ component: 'config', errors: error.errors }, 'Configuration validation failed');
      throw new Error(`Configuration validation failed: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    }
    logger.error({ component: 'config', error }, 'Failed to load configuration');
    throw error;
  }
}

export function getConfig(): Config {
  if (!cachedConfig) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return cachedConfig;
}
