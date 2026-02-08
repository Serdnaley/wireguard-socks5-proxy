import { Hono } from 'hono';
import { logger } from './logger';
import { Config } from './config';
import { getClientConfig, getAllClients } from './client';
import { generateQRCode } from './qr';
import { rotateProxyForClient, getCurrentProxy } from './proxy';
import { getWireGuardStatus } from './wireguard';
import { z } from 'zod';

const ClientNameSchema = z.object({
  name: z.string().min(1),
});

const RotateRequestSchema = z.object({
  location: z.string().optional(),
});

export function createHttpServer(config: Config, port: number): void {
  const app = new Hono();

  // Health check endpoint
  app.get('/health', async (c) => {
    const wgStatus = getWireGuardStatus(config.wireguard.interface);
    return c.json({
      status: 'ok',
      wireguard: wgStatus.status,
      timestamp: new Date().toISOString(),
    });
  });

  // List all clients
  app.get('/clients', async (c) => {
    const clients = getAllClients();
    return c.json({ clients });
  });

  // Get client config (plain text)
  app.get('/client/:name/config', async (c) => {
    try {
      const { name } = ClientNameSchema.parse({ name: c.req.param('name') });
      const clientConfig = getClientConfig(name);

      if (!clientConfig) {
        return c.json({ error: 'Client not found' }, 404);
      }

      return c.text(clientConfig, 200, {
        'Content-Type': 'text/plain',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid client name', details: error.errors }, 400);
      }
      logger.error({ component: 'http', error }, 'Error getting client config');
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // Get client QR code
  app.get('/client/:name/qr', async (c) => {
    try {
      const { name } = ClientNameSchema.parse({ name: c.req.param('name') });
      const qrBuffer = await generateQRCode(name);

      return new Response(qrBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid client name', details: error.errors }, 400);
      }
      if (error instanceof Error && error.message.includes('not found')) {
        return c.json({ error: error.message }, 404);
      }
      logger.error({ component: 'http', error }, 'Error generating QR code');
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // Rotate proxy for client
  app.post('/client/:name/rotate', async (c) => {
    try {
      const { name } = ClientNameSchema.parse({ name: c.req.param('name') });
      const body = await c.req.json().catch(() => ({}));
      const { location } = RotateRequestSchema.parse(body);

      // Check if client exists
      const clientConfig = getClientConfig(name);
      if (!clientConfig) {
        return c.json({ error: 'Client not found' }, 404);
      }

      // Rotate proxy
      await rotateProxyForClient(name, location);

      // Get new proxy info
      const currentProxy = getCurrentProxy(name);

      return c.json({
        success: true,
        client: name,
        proxy: currentProxy,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid request', details: error.errors }, 400);
      }
      logger.error({ component: 'http', error }, 'Error rotating proxy');
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // Start server
  const host = config.http?.host || '0.0.0.0';
  
  Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
  });

  logger.info({ component: 'http', host, port }, 'HTTP server started');
}
