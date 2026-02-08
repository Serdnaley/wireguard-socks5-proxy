#!/usr/bin/env bun

import { logger, initializeLogger } from './logger';
import { loadConfig } from './config';
import { initializeWireGuard } from './wireguard';
import { initializeClients } from './client';
import { startRotationScheduler } from './proxy';
import { createHttpServer } from './http';

async function main() {
  try {
    // Load configuration first (before initializing logger with config)
    const config = await loadConfig();
    
    // Reinitialize logger with config settings
    const logFile = config.logging?.file || './data/logs/app.log';
    const logLevel = config.logging?.level || 'info';
    initializeLogger(logFile, logLevel);
    
    logger.info({ component: 'main' }, 'Starting WireGuard SOCKS5 proxy');
    logger.info({ component: 'main' }, 'Configuration loaded');

    // Initialize WireGuard server
    await initializeWireGuard(config);
    logger.info({ component: 'main' }, 'WireGuard server initialized');

    // Initialize clients
    await initializeClients(config);
    logger.info({ component: 'main' }, 'Clients initialized');

    // Start proxy rotation scheduler
    startRotationScheduler(config);
    logger.info({ component: 'main' }, 'Proxy rotation scheduler started');

    // Start HTTP server
    const port = config.http?.port || 8000;
    createHttpServer(config, port);
    logger.info({ component: 'main', port }, 'HTTP server started');

  } catch (error) {
    logger.error({ component: 'main', error }, 'Failed to start application');
    process.exit(1);
  }
}

main();
