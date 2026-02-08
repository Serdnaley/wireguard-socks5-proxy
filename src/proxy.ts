import { logger } from './logger';
import { Config, getConfig, Proxy, getRotationIntervalMs } from './config';
import { getClientState, initializeClientState, updateClientProxy } from './state';
import { startTun2Socks, restartClientTunnel } from './tunnel';
import { notifyAutomaticRotation } from './telegram';

let rotationInterval: ReturnType<typeof setInterval> | null = null;

export function startRotationScheduler(config: Config): void {
  const rotationIntervalMs = getRotationIntervalMs(config.rotation);
  
  // Check interval: use the smaller of 1 hour or rotation interval / 10
  // This ensures we check frequently enough but not too often
  const checkIntervalMs = Math.min(60 * 60 * 1000, Math.max(60000, rotationIntervalMs / 10));

  // Format interval for logging
  let intervalDescription = '7 days (default)';
  if (config.rotation) {
    const { interval, interval_type } = config.rotation;
    // Use plural form for display
    const displayType = interval_type.endsWith('s') ? interval_type : `${interval_type}s`;
    intervalDescription = `${interval} ${displayType}`;
  }

  logger.info(
    { component: 'proxy', rotation_interval: intervalDescription, check_interval_ms: checkIntervalMs },
    'Starting proxy rotation scheduler'
  );

  // Check rotation schedule periodically
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
  const intervalMs = getRotationIntervalMs(config.rotation);

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
      const timeSinceRotationSeconds = timeSinceRotation / 1000;
      const timeSinceRotationMinutes = timeSinceRotationSeconds / 60;
      const timeSinceRotationHours = timeSinceRotationMinutes / 60;
      const timeSinceRotationDays = timeSinceRotationHours / 24;

      logger.info(
        {
          component: 'proxy',
          client: client.name,
          seconds_since_rotation: timeSinceRotationSeconds,
          minutes_since_rotation: timeSinceRotationMinutes,
          hours_since_rotation: timeSinceRotationHours,
          days_since_rotation: timeSinceRotationDays,
        },
        'Rotation interval reached, rotating proxy'
      );
      await rotateProxyForClient(client.name, undefined, true); // true = automatic rotation
    }
  }
}

export async function rotateProxyForClient(
  clientName: string, 
  preferredLocation?: string, 
  isAutomatic: boolean = false
): Promise<void> {
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

  // Restart TUN2SOCKS with new proxy
  if (oldProxy) {
    await restartClientTunnel(clientName, selectedProxy.url, config);
  } else {
    await startTun2Socks(clientName, selectedProxy.url, config);
  }

  logger.info(
    { component: 'proxy', client: clientName, old_proxy: oldProxy, new_proxy: selectedProxy.url, location: selectedProxy.location },
    'Proxy rotated for client'
  );

  // Send notification if this was an automatic rotation
  if (isAutomatic && oldProxy) {
    try {
      await notifyAutomaticRotation(clientName, oldLocation, selectedProxy.location, selectedProxy.url);
    } catch (error) {
      logger.error({ component: 'proxy', error, client: clientName }, 'Failed to send rotation notification');
    }
  }
}

export async function assignProxyToClient(clientName: string, config: Config): Promise<void> {
  const selectedProxy = await selectFreshestProxy(clientName, undefined, config);

  if (!selectedProxy) {
    logger.warn({ component: 'proxy', client: clientName }, 'No proxy available for assignment');
    return;
  }

  await updateClientProxy(clientName, selectedProxy.url, selectedProxy.location);

  // Start TUN2SOCKS tunnel for this client
  await startTun2Socks(clientName, selectedProxy.url, config);

  logger.info(
    { component: 'proxy', client: clientName, proxy: selectedProxy.url, location: selectedProxy.location },
    'Proxy assigned to client and tunnel started'
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
