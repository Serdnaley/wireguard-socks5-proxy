import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { logger } from './logger';
import { join, dirname } from 'path';
import { getConfig } from './config';

export interface ProxyUsageDates {
  [proxyUrl: string]: string; // ISO timestamp
}

export interface RotationHistoryEntry {
  timestamp: string;
  old_proxy: string;
  new_proxy: string;
  old_location: string;
  new_location: string;
}

export interface ClientState {
  current_proxy: string;
  current_location: string;
  last_location: string;
  last_rotation: string;
  proxy_usage_dates: ProxyUsageDates;
  rotation_history: RotationHistoryEntry[];
}

export interface State {
  clients: {
    [clientName: string]: ClientState;
  };
}

let cachedState: State | null = null;

function getStateFilePath(): string {
  const config = getConfig();
  const dataDir = config.data?.dir || './data';
  return join(dataDir, 'state.json');
}

export function loadState(): State {
  if (cachedState) {
    return cachedState;
  }

  const statePath = getStateFilePath();
  
  if (!existsSync(statePath)) {
    logger.info({ component: 'state', path: statePath }, 'State file does not exist, initializing empty state');
    cachedState = { clients: {} };
    // Save state synchronously on initial load (before async functions are available)
    try {
      const stateDir = dirname(statePath);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(statePath, JSON.stringify(cachedState, null, 2), 'utf-8');
    } catch (error) {
      // Ignore errors on initial state creation
    }
    return cachedState;
  }

  try {
    const fileContent = readFileSync(statePath, 'utf-8');
    cachedState = JSON.parse(fileContent) as State;
    logger.info({ component: 'state', path: statePath }, 'State loaded from file');
    return cachedState;
  } catch (error) {
    logger.error({ component: 'state', error, path: statePath }, 'Failed to load state file, initializing empty state');
    cachedState = { clients: {} };
    // Save state synchronously on initial load
    try {
      const stateDir = dirname(statePath);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(statePath, JSON.stringify(cachedState, null, 2), 'utf-8');
    } catch (error) {
      // Ignore errors on initial state creation
    }
    return cachedState;
  }
}

export async function saveState(): Promise<void> {
  if (!cachedState) {
    return;
  }

  const statePath = getStateFilePath();
  
  try {
    // Ensure directory exists
    const stateDir = dirname(statePath);
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }

    writeFileSync(statePath, JSON.stringify(cachedState, null, 2), 'utf-8');
    logger.debug({ component: 'state', path: statePath }, 'State saved to file');
  } catch (error) {
    logger.error({ component: 'state', error, path: statePath }, 'Failed to save state file');
    throw error;
  }
}

export function getClientState(clientName: string): ClientState | undefined {
  const state = loadState();
  return state.clients[clientName];
}

export async function initializeClientState(clientName: string): Promise<ClientState> {
  const state = loadState();
  
  if (!state.clients[clientName]) {
    state.clients[clientName] = {
      current_proxy: '',
      current_location: '',
      last_location: '',
      last_rotation: '',
      proxy_usage_dates: {},
      rotation_history: [],
    };
    saveState();
    logger.info({ component: 'state', client: clientName }, 'Initialized state for client');
  }
  
  return state.clients[clientName];
}

export async function updateClientProxy(
  clientName: string,
  proxyUrl: string,
  location: string,
  oldProxy?: string,
  oldLocation?: string
): Promise<void> {
  const state = loadState();
  const clientState = await initializeClientState(clientName);
  
  const now = new Date().toISOString();
  
  // Update current proxy and location
  clientState.current_proxy = proxyUrl;
  clientState.current_location = location;
  clientState.last_rotation = now;
  
  // Update last location if different
  if (location !== clientState.last_location) {
    clientState.last_location = clientState.current_location;
  }
  
  // Update proxy usage date
  clientState.proxy_usage_dates[proxyUrl] = now;
  
  // Add to rotation history if this is a rotation (not initial assignment)
  if (oldProxy && oldProxy !== proxyUrl) {
    clientState.rotation_history.push({
      timestamp: now,
      old_proxy: oldProxy,
      new_proxy: proxyUrl,
      old_location: oldLocation || '',
      new_location: location,
    });
    
    // Keep only last 100 rotation history entries
    if (clientState.rotation_history.length > 100) {
      clientState.rotation_history = clientState.rotation_history.slice(-100);
    }
  }
  
  await saveState();
  logger.info(
    { component: 'state', client: clientName, proxy: proxyUrl, location },
    'Updated client proxy assignment'
  );
}

export function getState(): State {
  return loadState();
}
