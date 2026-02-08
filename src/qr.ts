import QRCode from 'qrcode';
import { logger } from './logger';
import { getClientConfig } from './client';

export async function generateQRCode(clientName: string): Promise<Buffer> {
  const config = getClientConfig(clientName);
  
  if (!config) {
    throw new Error(`Client config not found for ${clientName}`);
  }

  try {
    const qrCodeBuffer = await QRCode.toBuffer(config, {
      type: 'png',
      errorCorrectionLevel: 'M',
      width: 300,
      margin: 2,
    });

    logger.debug({ component: 'qr', client: clientName }, 'QR code generated');
    return qrCodeBuffer;
  } catch (error) {
    logger.error({ component: 'qr', client: clientName, error }, 'Failed to generate QR code');
    throw error;
  }
}
