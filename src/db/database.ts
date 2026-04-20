import crypto from 'crypto';
import Database from 'better-sqlite3';
import path from 'path';
import dotenv from 'dotenv';
import { TELEKOM_IMAP_HOST, TELEKOM_IMAP_PORT } from '../config/telekomImap';
import { decrypt, encrypt } from '../utils/crypto';

dotenv.config();

const DB_PATH = process.env.DB_PATH || './boexle.db';

let db: Database.Database | undefined;

export interface SaveDeviceInput {
  deviceToken: string;
  encryptedImapUser: string;
  encryptedImapPass: string;
  imapHost: string;
  imapPort: number;
  /** IMAP UIDNEXT at register; messages with uid >= this are pushed on first poll (not baseline). */
  sprachboxUidNextAtRegister: number | null;
}

interface DeviceRow {
  id: number;
  device_token: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_pass: string;
  baseline_cutoff: number | null;
  imap_uid_next_at_register: number | null;
}

export interface Device {
  id: number;
  device_token: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_pass: string;
  /** Unix seconds at device registration; fallback if imap_uid_next_at_register is null */
  baseline_cutoff: number | null;
  /** IMAP UIDNEXT at registration; preferred for first-poll baseline (see poller) */
  imap_uid_next_at_register: number | null;
}

export function getDb(): Database.Database {
  if (db === undefined) {
    db = new Database(path.resolve(DB_PATH));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  getDb().exec(`
    -- Registered devices / users
    CREATE TABLE IF NOT EXISTS devices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_token TEXT NOT NULL UNIQUE,         -- APNs device token
      imap_host   TEXT NOT NULL DEFAULT 'secureimap.t-online.de',
      imap_port   INTEGER NOT NULL DEFAULT 993,
      imap_user   TEXT NOT NULL,                 -- Telekom email address
      imap_pass   TEXT NOT NULL,                 -- Telekom app password (encrypted)
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_poll   TEXT,
      active      INTEGER NOT NULL DEFAULT 1
    );

    -- Track which voicemails we've already pushed
    -- so we don't send duplicate notifications
    CREATE TABLE IF NOT EXISTS seen_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      message_uid TEXT NOT NULL,                 -- IMAP UID
      seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(device_id, message_uid)
    );

    -- imap_user is AES-GCM ciphertext; imap_user_hash (sha256 of normalized email) used for lookups.
    CREATE TABLE IF NOT EXISTS refresh_sessions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      imap_user       TEXT NOT NULL,
      imap_user_hash  TEXT,
      token_hash      TEXT NOT NULL UNIQUE,
      expires_at      INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_sessions_expires_at ON refresh_sessions(expires_at);

    -- Per-user access-token version. Bumping invalidates all outstanding access tokens.
    CREATE TABLE IF NOT EXISTS token_versions (
      imap_user  TEXT PRIMARY KEY,
      version    INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  migrateDevicesBaselineCutoff();
  migrateImapHostsToTelekomOnly();
  migrateDevicesImapUidNext();
  migrateRefreshSessionsEncryptUser();

  // Ensure imap_user_hash index exists on both fresh installs and migrated DBs.
  getDb().exec(
    `CREATE INDEX IF NOT EXISTS idx_refresh_sessions_imap_user_hash ON refresh_sessions(imap_user_hash)`
  );
}

/**
 * One-time migration: introduce imap_user_hash column and switch imap_user to ciphertext.
 * Existing plaintext sessions are dropped (users get a new refresh token on next login).
 */
function migrateRefreshSessionsEncryptUser(): void {
  const cols = getDb()
    .prepare(`PRAGMA table_info(refresh_sessions)`)
    .all() as { name: string }[];
  if (cols.some((c) => c.name === 'imap_user_hash')) return;

  const db = getDb();
  db.exec(`ALTER TABLE refresh_sessions ADD COLUMN imap_user_hash TEXT`);
  // Plaintext rows cannot be converted in-place (no SQLite crypto); clear them.
  db.exec(`DELETE FROM refresh_sessions`);
  db.exec(`DROP INDEX IF EXISTS idx_refresh_sessions_imap_user`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_refresh_sessions_imap_user_hash ON refresh_sessions(imap_user_hash)`
  );
}

function migrateDevicesImapUidNext(): void {
  const cols = getDb().prepare(`PRAGMA table_info(devices)`).all() as { name: string }[];
  if (cols.some((c) => c.name === 'imap_uid_next_at_register')) return;
  getDb().exec(`ALTER TABLE devices ADD COLUMN imap_uid_next_at_register INTEGER`);
}

/** Force Telekom IMAP endpoint (mitigate SSRF from legacy client-supplied host/port). */
function migrateImapHostsToTelekomOnly(): void {
  getDb()
    .prepare(
      `UPDATE devices SET imap_host = ?, imap_port = ? WHERE imap_host != ? OR imap_port != ?`
    )
    .run(TELEKOM_IMAP_HOST, TELEKOM_IMAP_PORT, TELEKOM_IMAP_HOST, TELEKOM_IMAP_PORT);
}

function migrateDevicesBaselineCutoff(): void {
  const cols = getDb().prepare(`PRAGMA table_info(devices)`).all() as { name: string }[];
  if (cols.some((c) => c.name === 'baseline_cutoff')) return;
  getDb().exec(`ALTER TABLE devices ADD COLUMN baseline_cutoff INTEGER`);
  getDb().exec(
    `UPDATE devices SET baseline_cutoff = CAST(strftime('%s', created_at) AS INTEGER) WHERE baseline_cutoff IS NULL`
  );
}

export function hashRefreshTokenOpaque(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Stable lookup hash for an IMAP user (normalized + sha256). */
export function hashImapUser(imapUser: string): string {
  const normalized = imapUser.trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** Creates a new opaque refresh session; returns the plaintext token (store only the hash in DB). */
export function createRefreshSession(imapUser: string, ttlSeconds: number): string {
  const normalized = imapUser.trim().toLowerCase();
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashRefreshTokenOpaque(token);
  const userHash = hashImapUser(normalized);
  const userCipher = encrypt(normalized);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;
  getDb()
    .prepare(
      `INSERT INTO refresh_sessions (imap_user, imap_user_hash, token_hash, expires_at) VALUES (?, ?, ?, ?)`
    )
    .run(userCipher, userHash, tokenHash, expiresAt);
  return token;
}

/**
 * Validates the presented refresh token, removes that session (rotation), returns the user.
 * Expired or unknown tokens yield null.
 */
export function rotateRefreshSession(presentedToken: string): { imapUser: string } | null {
  const tokenHash = hashRefreshTokenOpaque(presentedToken);
  const now = Math.floor(Date.now() / 1000);
  const row = getDb()
    .prepare(
      `SELECT id, imap_user, expires_at FROM refresh_sessions WHERE token_hash = ?`
    )
    .get(tokenHash) as { id: number; imap_user: string; expires_at: number } | undefined;

  if (!row) return null;

  const expired = row.expires_at <= now;
  getDb().prepare(`DELETE FROM refresh_sessions WHERE id = ?`).run(row.id);

  if (expired) return null;

  let imapUser: string;
  try {
    imapUser = decrypt(row.imap_user);
  } catch {
    return null;
  }

  return { imapUser };
}

export function purgeExpiredRefreshSessions(): number {
  const now = Math.floor(Date.now() / 1000);
  const result = getDb().prepare(`DELETE FROM refresh_sessions WHERE expires_at <= ?`).run(now);
  return result.changes;
}

/** Deletes seen_messages rows older than retention (by seen_at). */
export function purgeOldSeenMessages(retentionDays: number): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const result = getDb()
    .prepare(
      `DELETE FROM seen_messages WHERE datetime(seen_at) < datetime('now', ?)`
    )
    .run(`-${Math.floor(retentionDays)} days`);
  return result.changes;
}

export type SaveDeviceResult = 'ok' | 'conflict';

/**
 * Registers or re-registers a device.
 * If a row for `deviceToken` already exists, it may only be overwritten when
 * the existing `imap_user` matches the new one (ownership check).
 * Returns `'conflict'` when the token is already bound to another account.
 */
export function saveDevice(input: SaveDeviceInput, imapUserPlaintext: string): SaveDeviceResult {
  const baselineCutoff = Math.floor(Date.now() / 1000);
  const uidNext = input.sprachboxUidNextAtRegister;
  const normalizedNew = imapUserPlaintext.trim().toLowerCase();

  const existing = getDb()
    .prepare(`SELECT imap_user FROM devices WHERE device_token = ?`)
    .get(input.deviceToken) as { imap_user: string } | undefined;

  if (existing) {
    let existingUser = '';
    try {
      existingUser = decrypt(existing.imap_user).trim().toLowerCase();
    } catch {
      // Unreadable row => treat as conflict rather than silently overwrite.
      return 'conflict';
    }
    if (existingUser !== normalizedNew) {
      return 'conflict';
    }
  }

  getDb().prepare(`
    INSERT INTO devices (device_token, imap_user, imap_pass, imap_host, imap_port, baseline_cutoff, imap_uid_next_at_register)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_token) DO UPDATE SET
      imap_user = excluded.imap_user,
      imap_pass = excluded.imap_pass,
      imap_host = excluded.imap_host,
      imap_port = excluded.imap_port,
      active = 1,
      baseline_cutoff = COALESCE(devices.baseline_cutoff, excluded.baseline_cutoff),
      imap_uid_next_at_register = COALESCE(devices.imap_uid_next_at_register, excluded.imap_uid_next_at_register)
  `).run(
    input.deviceToken,
    input.encryptedImapUser,
    input.encryptedImapPass,
    input.imapHost,
    input.imapPort,
    baselineCutoff,
    uidNext
  );

  return 'ok';
}

export function getDevices(): Device[] {
  return getDb()
    .prepare('SELECT * FROM devices WHERE active = 1')
    .all() as DeviceRow[];
}

export function deleteDeviceById(deviceId: number): boolean {
  const result = getDb().prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
  return result.changes > 0;
}

/** Hard-delete device only if JWT subject matches stored IMAP user. */
export function deleteDeviceForOwner(deviceToken: string, jwtSubject: string): boolean | 'forbidden' {
  const row = getDb()
    .prepare(`SELECT id, imap_user FROM devices WHERE device_token = ?`)
    .get(deviceToken) as { id: number; imap_user: string } | undefined;
  if (!row) return false;

  let email: string;
  try {
    email = decrypt(row.imap_user);
  } catch {
    return false;
  }

  const normalizedSubject = jwtSubject.trim().toLowerCase();
  if (email.trim().toLowerCase() !== normalizedSubject) {
    return 'forbidden';
  }

  const result = getDb().prepare(`DELETE FROM devices WHERE id = ? AND device_token = ?`).run(row.id, deviceToken);
  if (result.changes > 0) {
    // Invalidate any outstanding access tokens for this user.
    bumpTokenVersion(normalizedSubject);
    deleteRefreshSessionsForUser(normalizedSubject);
  }
  return result.changes > 0;
}

/** Returns the current access-token version for `imapUser` (creates row at version 1 on first read). */
export function getTokenVersion(imapUser: string): number {
  const normalized = imapUser.trim().toLowerCase();
  const row = getDb()
    .prepare(`SELECT version FROM token_versions WHERE imap_user = ?`)
    .get(normalized) as { version: number } | undefined;
  if (row) return row.version;
  getDb()
    .prepare(`INSERT OR IGNORE INTO token_versions (imap_user, version) VALUES (?, 1)`)
    .run(normalized);
  return 1;
}

/** Increments the token version for `imapUser`; future access tokens with old `tv` will fail verification. */
export function bumpTokenVersion(imapUser: string): number {
  const normalized = imapUser.trim().toLowerCase();
  const current = getTokenVersion(normalized);
  const next = current + 1;
  getDb()
    .prepare(
      `INSERT INTO token_versions (imap_user, version, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(imap_user) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`
    )
    .run(normalized, next);
  return next;
}

/** Removes all stored refresh sessions for a user (e.g. on logout/delete). */
export function deleteRefreshSessionsForUser(imapUser: string): number {
  const userHash = hashImapUser(imapUser);
  const result = getDb().prepare(`DELETE FROM refresh_sessions WHERE imap_user_hash = ?`).run(userHash);
  return result.changes;
}

export function closeDb(): void {
  if (db !== undefined) {
    db.close();
    db = undefined;
  }
}
