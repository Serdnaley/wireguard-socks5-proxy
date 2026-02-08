import pino from 'pino';
import { createWriteStream } from 'fs';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

let loggerInstance: pino.Logger | null = null;

export function initializeLogger(logFile?: string, level: string = 'info'): pino.Logger {
  const destination = logFile || './data/logs/app.log';
  
  // Ensure log directory exists
  const logDir = dirname(destination);
  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    // Directory might already exist
  }

  const fileStream = createWriteStream(destination, { flags: 'a' });

  // Use multi-stream to write to both file and stderr
  // This ensures errors are visible in systemd logs
  loggerInstance = pino(
    {
      level,
      formatters: {
        level: (label) => {
          return { level: label.toUpperCase() };
        },
      },
    },
    pino.multistream([
      { stream: fileStream },
      { level: 'error', stream: process.stderr },
      { level: 'warn', stream: process.stderr },
    ])
  );

  return loggerInstance;
}

// Initialize logger with defaults if not already initialized
if (!loggerInstance) {
  loggerInstance = initializeLogger();
}

export const logger = loggerInstance;
