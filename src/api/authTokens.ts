import crypto from 'crypto';
import { createRefreshSession, getTokenVersion, rotateRefreshSession } from '../db/database';

export interface AccessTokenPayload {
  type: 'access';
  sub: string;
  iat: number;
  exp: number;
  /** Token version snapshot at issue time; used for revocation. */
  tv: number;
}

type TokenPayload = AccessTokenPayload;

const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

function getTokenSecret(): string {
  const secret = process.env.AUTH_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_TOKEN_SECRET must be set with at least 32 characters');
  }
  return secret;
}

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(input: string): Buffer {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function sign(data: string): string {
  return toBase64Url(
    crypto.createHmac('sha256', getTokenSecret()).update(data, 'utf8').digest()
  );
}

function makeToken(payload: TokenPayload): string {
  const payloadEncoded = toBase64Url(JSON.stringify(payload));
  const signature = sign(payloadEncoded);
  return `${payloadEncoded}.${signature}`;
}

function verifyToken<T extends TokenPayload['type']>(
  token: string,
  expectedType: T
): Extract<TokenPayload, { type: T }> | null {
  const [payloadEncoded, signature] = token.split('.');
  if (!payloadEncoded || !signature) return null;

  const expectedSignature = sign(payloadEncoded);
  const sigA = Buffer.from(signature);
  const sigB = Buffer.from(expectedSignature);
  if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) {
    return null;
  }

  try {
    const decoded = JSON.parse(fromBase64Url(payloadEncoded).toString('utf8')) as TokenPayload;
    const now = Math.floor(Date.now() / 1000);
    if (decoded.type !== expectedType || decoded.exp <= now || !decoded.sub) {
      return null;
    }
    if (decoded.type === 'access') {
      const currentTv = getTokenVersion(decoded.sub);
      if (typeof decoded.tv !== 'number' || decoded.tv !== currentTv) {
        return null;
      }
    }
    return decoded as Extract<TokenPayload, { type: T }>;
  } catch {
    return null;
  }
}

function normalizeImapUser(subject: string): string {
  return subject.trim().toLowerCase();
}

export function issueTokenPair(subject: string): { accessToken: string; refreshToken: string } {
  const imapUser = normalizeImapUser(subject);
  const now = Math.floor(Date.now() / 1000);
  const accessTtl = parseInt(process.env.AUTH_ACCESS_TTL_SECONDS || '', 10) || DEFAULT_ACCESS_TTL_SECONDS;
  const refreshTtl =
    parseInt(process.env.AUTH_REFRESH_TTL_SECONDS || '', 10) || DEFAULT_REFRESH_TTL_SECONDS;

  const accessToken = makeToken({
    type: 'access',
    sub: imapUser,
    iat: now,
    exp: now + accessTtl,
    tv: getTokenVersion(imapUser),
  });
  const refreshToken = createRefreshSession(imapUser, refreshTtl);

  return { accessToken, refreshToken };
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  return verifyToken(token, 'access');
}

export function refreshTokenPair(refreshToken: string): { accessToken: string; refreshToken: string } | null {
  const rotated = rotateRefreshSession(refreshToken);
  if (!rotated) return null;
  return issueTokenPair(rotated.imapUser);
}
