import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { assertEncryptionKey } from './utils/crypto';
import { closeDb, getDb } from './db/database';
import { router } from './api/routes';
import { startPoller } from './imap/poller';
import { assertApnsConfig, closeProvider } from './push/pushService';

try {
  assertEncryptionKey();
} catch (err) {
  const message = err instanceof Error ? err.message : 'Unknown ENCRYPTION_KEY error';
  console.error(`[Böxle Backend] Invalid ENCRYPTION_KEY: ${message}`);
  process.exit(1);
}

try {
  assertApnsConfig();
} catch (err) {
  const message = err instanceof Error ? err.message : 'Unknown APNs config error';
  console.error(`[Böxle Backend] Invalid APNs config: ${message}`);
  process.exit(1);
}

const app = express();

const trustProxy = process.env.TRUST_PROXY;
if (trustProxy === '1' || trustProxy === 'true') {
  app.set('trust proxy', 1);
}

const helmetHsts = process.env.HELMET_HSTS;
app.use(
  helmet({
    contentSecurityPolicy: false,
    hsts:
      helmetHsts === '0' || helmetHsts === 'false'
        ? false
        : { maxAge: 15552000, includeSubDomains: true, preload: true },
  })
);

const corsOriginsRaw = process.env.CORS_ORIGINS?.trim();
if (corsOriginsRaw) {
  const origins = corsOriginsRaw.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(
    cors({
      origin: origins,
      credentials: false,
    })
  );
}

app.use(express.json({ limit: '10kb' }));
app.use('/api', router);

// Init DB
getDb();

// Start polling loop
startPoller();

const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, () => {
  console.log(`[Böxle Backend] Running on port ${PORT}`);
  console.log(`[Böxle Backend] Environment: ${process.env.APN_PRODUCTION === 'true' ? 'Production' : 'Sandbox'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Böxle Backend] Shutting down...');
  try {
    closeProvider();
  } catch {
    /* ignore */
  }
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  process.exit(0);
});
