import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { TELEKOM_IMAP_HOST, TELEKOM_IMAP_PORT } from '../config/telekomImap';
import { deleteDeviceForOwner, getDb, saveDevice } from '../db/database';
import { encrypt } from '../utils/crypto';
import { issueTokenPair, refreshTokenPair, verifyAccessToken } from './authTokens';
import { getSprachBoxUidNext, validateImapCredentials } from '../imap/imapService';

export const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

type AuthenticatedRequest = express.Request & {
  auth?: {
    subject: string;
    via: 'bearer';
  };
};

function invalidBody(res: express.Response): void {
  res.status(400).json({ error: 'Invalid request' });
}

// Bearer token auth only (legacy API key fallback removed).
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    const payload = verifyAccessToken(token);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    (req as AuthenticatedRequest).auth = {
      subject: payload.sub,
      via: 'bearer',
    };
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

const AuthTokenSchema = z.object({
  imapUser: z.string().email().max(254),
  imapPass: z.string().min(1).max(256),
});

const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(10).max(512),
});

// POST /api/devices/register
// Called by the iOS app on first launch / when APNs token refreshes
const RegisterSchema = z.object({
  deviceToken: z
    .string()
    .regex(/^[0-9a-fA-F]+$/, 'deviceToken must be hex')
    .min(64)
    .max(256),
  imapUser: z.string().email().max(254),
  imapPass: z.string().min(1).max(256),
});

router.post('/auth/token', authLimiter, async (req, res) => {
  const parsed = AuthTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res);
    return;
  }

  const { imapUser, imapPass } = parsed.data;
  const isValid = await validateImapCredentials({
    host: TELEKOM_IMAP_HOST,
    port: TELEKOM_IMAP_PORT,
    user: imapUser,
    pass: imapPass,
  });
  if (!isValid) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const tokens = issueTokenPair(imapUser);
  res.json(tokens);
});

router.post('/auth/refresh', refreshLimiter, (req, res) => {
  const parsed = RefreshTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res);
    return;
  }

  const refreshed = refreshTokenPair(parsed.data.refreshToken);
  if (!refreshed) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  res.json(refreshed);
});

router.post('/devices/register', writeLimiter, requireAuth, async (req, res) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res);
    return;
  }

  const { deviceToken, imapUser, imapPass } = parsed.data;
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth || auth.subject.toLowerCase() !== imapUser.toLowerCase()) {
    res.status(403).json({ error: 'Token subject does not match imapUser' });
    return;
  }

  const encryptedImapUser = encrypt(imapUser);
  const encryptedImapPass = encrypt(imapPass);

  const sprachboxUidNextAtRegister = await getSprachBoxUidNext({
    host: TELEKOM_IMAP_HOST,
    port: TELEKOM_IMAP_PORT,
    user: imapUser,
    pass: imapPass,
  });
  if (sprachboxUidNextAtRegister == null) {
    console.warn('[API] Could not read SprachBox UIDNEXT; first-poll baseline falls back to time-based cutoff');
  }

  const saveResult = saveDevice(
    {
      deviceToken,
      encryptedImapUser,
      encryptedImapPass,
      imapHost: TELEKOM_IMAP_HOST,
      imapPort: TELEKOM_IMAP_PORT,
      sprachboxUidNextAtRegister,
    },
    imapUser
  );

  if (saveResult === 'conflict') {
    console.warn(`[API] Device register conflict (token already bound to another account): ${deviceToken.substring(0, 8)}...`);
    res.status(409).json({ error: 'Device token already registered to another account' });
    return;
  }

  console.log(`[API] Device registered: ${deviceToken.substring(0, 8)}...`);
  res.json({ success: true });
});

// DELETE /api/devices/:token — hard delete (device + seen_messages); matches privacy policy.
// Only the owning account (JWT subject vs. stored imap user) may delete.
router.delete('/devices/:token', writeLimiter, requireAuth, (req, res) => {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const token = req.params.token;
  const deleted = deleteDeviceForOwner(token, auth.subject);
  const prefix = token.length >= 8 ? token.substring(0, 8) : token;
  if (deleted === true) {
    console.log(`[API] Device removed (logout): ${prefix}...`);
  } else if (deleted === 'forbidden') {
    console.warn(`[API] Device delete forbidden (not owner): ${prefix}...`);
    res.status(403).json({ error: 'Forbidden' });
    return;
  } else {
    console.warn(`[API] Device delete: no row for token ${prefix}... (already gone or wrong token)`);
  }
  res.json({ success: true, deleted: deleted === true });
});

// GET /api/health — no sensitive metrics (avoid reconnaissance).
router.get('/health', (_req, res) => {
  getDb();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});
