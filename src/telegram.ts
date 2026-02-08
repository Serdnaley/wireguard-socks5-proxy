import { Bot, Context, InputFile } from 'grammy';
import { logger } from './logger';
import { Config, getConfig } from './config';
import { getAllClients, getClientConfig } from './client';
import { generateQRCode } from './qr';
import { rotateProxyForClient, getCurrentProxy } from './proxy';
import { getWireGuardStatus } from './wireguard';
import { getState } from './state';

type AuthorizedContext = Context & {
  from: NonNullable<Context['from']>;
};

function isAuthorized(ctx: Context): ctx is AuthorizedContext {
  const config = getConfig();
  if (!config.telegram) {
    return false;
  }
  
  const userId = ctx.from?.id;
  if (!userId) {
    return false;
  }
  
  return config.telegram.admin_user_ids.includes(userId);
}

export function createTelegramBot(config: Config): void {
  if (!config.telegram) {
    logger.warn({ component: 'telegram' }, 'Telegram config not found, skipping bot initialization');
    return;
  }

  const bot = new Bot(config.telegram.bot_token);

  // Authorization middleware - must be first
  bot.use(async (ctx, next) => {
    if (isAuthorized(ctx)) {
      await next();
    } else {
      logger.warn(
        { component: 'telegram', user_id: ctx.from?.id, username: ctx.from?.username },
        'Unauthorized access attempt'
      );
      await ctx.reply('Whoe are you? 🤨');
    }
  });

  // Start command
  bot.command('start', async (ctx) => {
    const helpText = `Welcome to WireGuard Proxy Manager Bot! 🚀

Available commands:
/help - Show this help message
/clients - List all WireGuard clients
/client <name> - Get client info and config
/qr <name> - Get QR code for client config
/rotate <name> [location] - Rotate proxy for a client
/status - Get WireGuard server status
/proxies - List all available proxies

Example:
/client client1
/qr client1
/rotate client1 US`;

    await ctx.reply(helpText);
    logger.info({ component: 'telegram', user_id: ctx.from?.id, command: 'start' }, 'Start command executed');
  });

  // Help command
  bot.command('help', async (ctx) => {
    const helpText = `Available commands:

/clients - List all WireGuard clients
/client <name> - Get detailed client information including config and current proxy
/qr <name> - Generate and send QR code image for client configuration
/rotate <name> [location] - Rotate proxy for a client (optionally filter by location)
/status - Get WireGuard server status and interface information
/proxies - List all available proxies with their locations

Examples:
• /clients
• /client client1
• /qr client1
• /rotate client1
• /rotate client1 US
• /status
• /proxies`;

    await ctx.reply(helpText);
    logger.info({ component: 'telegram', user_id: ctx.from?.id, command: 'help' }, 'Help command executed');
  });

  // List clients command
  bot.command('clients', async (ctx) => {
    try {
      const clients = getAllClients();
      
      if (clients.length === 0) {
        await ctx.reply('No clients configured.');
        return;
      }

      const clientsList = clients.map((name, index) => `${index + 1}. ${name}`).join('\n');
      await ctx.reply(`WireGuard Clients:\n\n${clientsList}`);
      logger.info({ component: 'telegram', user_id: ctx.from?.id, command: 'clients' }, 'Clients list sent');
    } catch (error) {
      logger.error({ component: 'telegram', error, user_id: ctx.from?.id }, 'Error listing clients');
      await ctx.reply('Error retrieving clients list.');
    }
  });

  // Get client info command
  bot.command('client', async (ctx) => {
    try {
      const args = ctx.message?.text?.split(' ').slice(1);
      const clientName = args?.[0];

      if (!clientName) {
        await ctx.reply('Usage: /client <name>\nExample: /client client1');
        return;
      }

      const clientConfig = getClientConfig(clientName);
      if (!clientConfig) {
        await ctx.reply(`Client "${clientName}" not found.`);
        return;
      }

      const currentProxy = getCurrentProxy(clientName);
      const state = getState();
      const clientState = state.clients[clientName];

      let response = `*Client: ${clientName}*\n\n`;
      
      if (currentProxy) {
        response += `*Current Proxy:*\n`;
        response += `Location: ${currentProxy.location}\n`;
        response += `URL: \`${currentProxy.url}\`\n\n`;
      } else {
        response += `*Current Proxy:* Not assigned\n\n`;
      }

      if (clientState) {
        if (clientState.last_rotation) {
          const lastRotation = new Date(clientState.last_rotation);
          response += `*Last Rotation:* ${lastRotation.toLocaleString()}\n`;
        }
        if (clientState.rotation_history.length > 0) {
          response += `*Rotation History:* ${clientState.rotation_history.length} entries\n`;
        }
      }

      response += `\n*Config:*\n\`\`\`\n${clientConfig}\`\`\``;

      await ctx.reply(response, { parse_mode: 'Markdown' });
      logger.info({ component: 'telegram', user_id: ctx.from?.id, command: 'client', client: clientName }, 'Client info sent');
    } catch (error) {
      logger.error({ component: 'telegram', error, user_id: ctx.from?.id }, 'Error getting client info');
      await ctx.reply('Error retrieving client information.');
    }
  });

  // QR code command
  bot.command('qr', async (ctx) => {
    try {
      const args = ctx.message?.text?.split(' ').slice(1);
      const clientName = args?.[0];

      if (!clientName) {
        await ctx.reply('Usage: /qr <name>\nExample: /qr client1');
        return;
      }

      const qrBuffer = await generateQRCode(clientName);
      const inputFile = new InputFile(qrBuffer, `${clientName}_qr.png`);
      
      await ctx.replyWithPhoto(inputFile, {
        caption: `QR code for client: ${clientName}`,
      });
      
      logger.info({ component: 'telegram', user_id: ctx.from?.id, command: 'qr', client: clientName }, 'QR code sent');
    } catch (error) {
      logger.error({ component: 'telegram', error, user_id: ctx.from?.id }, 'Error generating QR code');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error generating QR code: ${errorMessage}`);
    }
  });

  // Rotate proxy command
  bot.command('rotate', async (ctx) => {
    try {
      const args = ctx.message?.text?.split(' ').slice(1);
      const clientName = args?.[0];
      const location = args?.[1];

      if (!clientName) {
        await ctx.reply('Usage: /rotate <name> [location]\nExample: /rotate client1\nExample: /rotate client1 US');
        return;
      }

      // Check if client exists
      const clientConfig = getClientConfig(clientName);
      if (!clientConfig) {
        await ctx.reply(`Client "${clientName}" not found.`);
        return;
      }

      await ctx.reply(`Rotating proxy for client "${clientName}"${location ? ` (location: ${location})` : ''}...`);

      await rotateProxyForClient(clientName, location);
      
      const currentProxy = getCurrentProxy(clientName);
      
      if (currentProxy) {
        await ctx.reply(
          `✅ Proxy rotated successfully!\n\n` +
          `*Client:* ${clientName}\n` +
          `*Location:* ${currentProxy.location}\n` +
          `*Proxy:* \`${currentProxy.url}\``,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(`Proxy rotation completed for "${clientName}", but no proxy is currently assigned.`);
      }

      logger.info(
        { component: 'telegram', user_id: ctx.from?.id, command: 'rotate', client: clientName, location },
        'Proxy rotated via bot'
      );
    } catch (error) {
      logger.error({ component: 'telegram', error, user_id: ctx.from?.id }, 'Error rotating proxy');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Error rotating proxy: ${errorMessage}`);
    }
  });

  // Status command
  bot.command('status', async (ctx) => {
    try {
      const config = getConfig();
      const wgStatus = getWireGuardStatus(config.wireguard.interface);
      
      let response = `*WireGuard Server Status*\n\n`;
      response += `*Interface:* ${config.wireguard.interface}\n`;
      response += `*Status:* ${wgStatus.status === 'up' ? '✅ Up' : '❌ Down'}\n`;
      
      if (wgStatus.status === 'up' && wgStatus.output) {
        response += `\n*Details:*\n\`\`\`\n${wgStatus.output}\`\`\``;
      } else if (wgStatus.error) {
        response += `\n*Error:* ${wgStatus.error}`;
      }

      await ctx.reply(response, { parse_mode: 'Markdown' });
      logger.info({ component: 'telegram', user_id: ctx.from?.id, command: 'status' }, 'Status sent');
    } catch (error) {
      logger.error({ component: 'telegram', error, user_id: ctx.from?.id }, 'Error getting status');
      await ctx.reply('Error retrieving WireGuard status.');
    }
  });

  // Proxies command
  bot.command('proxies', async (ctx) => {
    try {
      const config = getConfig();
      const proxies = config.proxies;
      
      if (proxies.length === 0) {
        await ctx.reply('No proxies configured.');
        return;
      }

      // Group by location
      const byLocation: Record<string, string[]> = {};
      for (const proxy of proxies) {
        if (!byLocation[proxy.location]) {
          byLocation[proxy.location] = [];
        }
        byLocation[proxy.location].push(proxy.url);
      }

      let response = `*Available Proxies*\n\n`;
      for (const [location, urls] of Object.entries(byLocation)) {
        response += `*${location}* (${urls.length}):\n`;
        for (const url of urls) {
          response += `  • \`${url}\`\n`;
        }
        response += '\n';
      }

      await ctx.reply(response, { parse_mode: 'Markdown' });
      logger.info({ component: 'telegram', user_id: ctx.from?.id, command: 'proxies' }, 'Proxies list sent');
    } catch (error) {
      logger.error({ component: 'telegram', error, user_id: ctx.from?.id }, 'Error listing proxies');
      await ctx.reply('Error retrieving proxies list.');
    }
  });

  // Error handler
  bot.catch((err) => {
    logger.error({ component: 'telegram', error: err.error }, 'Telegram bot error');
  });

  // Start bot
  bot.start().then(() => {
    logger.info({ component: 'telegram' }, 'Telegram bot started');
  }).catch((error) => {
    logger.error({ component: 'telegram', error }, 'Failed to start Telegram bot');
  });
}
