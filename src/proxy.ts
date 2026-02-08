import { logger } from './logger';
import { Config, getConfig, Proxy } from './config';
import { getClientState, initializeClientState, updateClientProxy } from './state';

let rotationInterval: ReturnType<typeof setInterval> | null = null;

export function startRotationScheduler(config: Config): void {
  const intervalDays = config.rotation?.interval_days || 7;
  const checkIntervalMs = 60 * 60 * 1000; // Check every hour

  logger.info({ component: 'proxy', interval_days: intervalDays }, 'Starting proxy rotation scheduler');

  // Check rotation schedule every hour
  rotationInterval = setInterval(async () => {
    await checkAndRotateProxies(config);
  }, checkIntervalMs);

  // Initial check
  checkAndRotateProxies(config).catch(err => {
    logger.error({ component: 'proxy', error: err }, 'Error in initial proxy rotation check');
  });
}

async function checkAndRotateProxies(config: Config): Promise<void> {
  const clients = config.clients;
  const intervalDays = config.rotation?.interval_days || 7;
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;

  for (const client of clients) {
    const clientState = getClientState(client.name);

    if (!clientState || !clientState.current_proxy) {
      // No proxy assigned yet, assign one
      await assignProxyToClient(client.name, config);
      continue;
    }

    const lastRotation = new Date(clientState.last_rotation);
    const now = new Date();
    const timeSinceRotation = now.getTime() - lastRotation.getTime();

    if (timeSinceRotation >= intervalMs) {
      logger.info(
        { component: 'proxy', client: client.name, days_since_rotation: timeSinceRotation / (24 * 60 * 60 * 1000) },
        'Rotation interval reached, rotating proxy'
      );
      await rotateProxyForClient(client.name);
    }
  }
}

export async function rotateProxyForClient(clientName: string, preferredLocation?: string): Promise<void> {
  const config = getConfig();
  const clientState = getClientState(clientName) || await initializeClientState(clientName);

  const oldProxy = clientState.current_proxy;
  const oldLocation = clientState.current_location;

  // Select freshest proxy
  const selectedProxy = await selectFreshestProxy(clientName, preferredLocation, config);

  if (!selectedProxy) {
    logger.warn({ component: 'proxy', client: clientName }, 'No proxy available for rotation');
    return;
  }

  // Update state
  await updateClientProxy(clientName, selectedProxy.url, selectedProxy.location, oldProxy, oldLocation);

  // Restart TUN2SOCKS if needed (implementation depends on your setup)
  logger.info(
    { component: 'proxy', client: clientName, old_proxy: oldProxy, new_proxy: selectedProxy.url, location: selectedProxy.location },
    'Proxy rotated for client'
  );
}

export async function assignProxyToClient(clientName: string, config: Config): Promise<void> {
  const selectedProxy = await selectFreshestProxy(clientName, undefined, config);

  if (!selectedProxy) {
    logger.warn({ component: 'proxy', client: clientName }, 'No proxy available for assignment');
    return;
  }

  await updateClientProxy(clientName, selectedProxy.url, selectedProxy.location);

  logger.info(
    { component: 'proxy', client: clientName, proxy: selectedProxy.url, location: selectedProxy.location },
    'Proxy assigned to client'
  );
}

async function selectFreshestProxy(clientName: string, preferredLocation?: string, config?: Config): Promise<Proxy | null> {
  const appConfig = config || getConfig();
  const clientState = getClientState(clientName) || await initializeClientState(clientName);

  // Filter proxies by location if specified
  let availableProxies = appConfig.proxies;

  if (preferredLocation) {
    availableProxies = availableProxies.filter(p => p.location === preferredLocation);
  } else {
    // Avoid repeating last location if possible
    if (clientState.last_location) {
      const differentLocationProxies = availableProxies.filter(p => p.location !== clientState.last_location);
      if (differentLocationProxies.length > 0) {
        availableProxies = differentLocationProxies;
      }
    }
  }

  if (availableProxies.length === 0) {
    return null;
  }

  // Find freshest proxy (oldest usage date)
  let freshestProxy: Proxy | null = null;
  let oldestDate: Date | null = null;

  for (const proxy of availableProxies) {
    const usageDateStr = clientState.proxy_usage_dates[proxy.url];
    let usageDate: Date;

    if (usageDateStr) {
      usageDate = new Date(usageDateStr);
    } else {
      // Never used, treat as epoch (oldest possible)
      usageDate = new Date(0);
    }

    if (!oldestDate || usageDate < oldestDate) {
      oldestDate = usageDate;
      freshestProxy = proxy;
    }
  }

  return freshestProxy;
}

export function getCurrentProxy(clientName: string): { url: string; location: string } | null {
  const clientState = getClientState(clientName);

  if (!clientState || !clientState.current_proxy) {
    return null;
  }

  return {
    url: clientState.current_proxy,
    location: clientState.current_location,
  };
}
