import { ImapFlow } from 'imapflow';
import {
  clearDeviceAuthFailures,
  getActiveDeviceById,
  getActiveDeviceByToken,
  getDb,
  getDevices,
  recordDeviceAuthFailure,
  type Device,
} from '../db/database';
import { fetchUnreadSprachBoxWithClient, type ImapCredentials } from './imapService';
import { decrypt } from '../utils/crypto';
import { formatErr } from '../utils/log';
import { syncFetchedSprachBoxToPushAndSeen } from './poller';

const MAX_IDLE_TIME_MS = 29 * 60 * 1000;
const SOCKET_TIMEOUT_MS = 32 * 60 * 1000;
const BASE_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 15 * 60 * 1000;
const IMAP_AUTH_FAIL_THRESHOLD = clampInt(process.env.IMAP_AUTH_FAIL_THRESHOLD, 3, 1, 20);

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(raw || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

function jitter(ms: number): number {
  const spread = Math.max(250, Math.floor(ms * 0.2));
  const delta = Math.floor(Math.random() * spread);
  return ms + delta;
}

function nextBackoffMs(attempt: number): number {
  const exp = BASE_RECONNECT_DELAY_MS * Math.pow(2, Math.max(0, attempt));
  const capped = Math.min(MAX_RECONNECT_DELAY_MS, Math.floor(exp));
  return jitter(capped);
}

function isInvalidLoginError(err: unknown): boolean {
  const maybe = err as { responseText?: unknown; response?: unknown; message?: unknown };
  const responseText = typeof maybe.responseText === 'string' ? maybe.responseText.toLowerCase() : '';
  const response = typeof maybe.response === 'string' ? maybe.response.toLowerCase() : '';
  const message = typeof maybe.message === 'string' ? maybe.message.toLowerCase() : '';
  return (
    responseText.includes('invalid login') ||
    response.includes('invalid login') ||
    message.includes('invalid login')
  );
}

async function loadSeenState(deviceId: number): Promise<{ seenUids: Set<string>; seenRowsCount: number }> {
  const db = getDb();
  const rows = db
    .prepare('SELECT message_uid FROM seen_messages WHERE device_id = ?')
    .all(deviceId) as { message_uid: string }[];
  return { seenUids: new Set(rows.map((r) => r.message_uid)), seenRowsCount: rows.length };
}

function imapCredentialsForDevice(device: Device): ImapCredentials {
  return {
    host: device.imap_host,
    port: device.imap_port,
    user: decrypt(device.imap_user),
    pass: decrypt(device.imap_pass),
  };
}

type DeviceHandle = {
  deviceToken: string;
  deviceId: number;
  abort: AbortController;
  loopPromise: Promise<void>;
};

async function runDeviceLoop(deviceToken: string, deviceId: number, signal: AbortSignal): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    const device = getActiveDeviceById(deviceId);
    if (!device) {
      console.log(`[Idle device=${deviceId}] Stop: device not active (or deleted).`);
      return;
    }

    const credentials = imapCredentialsForDevice(device);
    const client = new ImapFlow({
      host: credentials.host,
      port: credentials.port,
      secure: true,
      auth: {
        user: credentials.user,
        pass: credentials.pass,
      },
      maxIdleTime: MAX_IDLE_TIME_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      logger: false,
    });

    client.on('error', (err) => {
      console.error(`[Idle device=${deviceId}] IMAP client error event:`, formatErr(err));
    });

    let releaseLock: (() => void) | null = null;
    const onExists = async () => {
      // handled by the closure below; this is replaced after mailbox lock is acquired
    };

    try {
      console.log(`[Idle device=${deviceId}] Connecting...`);
      await client.connect();

      const lock = await client.getMailboxLock('SprachBox', { description: `idle device=${deviceId}` });
      releaseLock = lock.release;

      let syncInFlight = false;
      let syncPending = true; // sync once on first connect (baseline)

      const doSync = async (): Promise<void> => {
        if (syncInFlight) {
          syncPending = true;
          return;
        }
        syncInFlight = true;
        try {
          while (syncPending && !signal.aborted) {
            syncPending = false;

            const freshDevice = getActiveDeviceById(deviceId);
            if (!freshDevice) {
              return;
            }

            const { seenUids, seenRowsCount } = await loadSeenState(deviceId);
            const fetchResult = await fetchUnreadSprachBoxWithClient(client, seenUids);
            clearDeviceAuthFailures(deviceId);

            const ok = await syncFetchedSprachBoxToPushAndSeen(freshDevice, fetchResult, seenRowsCount);
            if (!ok) {
              console.warn(`[Idle device=${deviceId}] Device removed (stale APNs token).`);
              return;
            }
          }
        } finally {
          syncInFlight = false;
        }
      };

      const existsListener = (data: { path: string; count: number; prevCount: number }) => {
        if (signal.aborted) return;
        if (typeof data?.count === 'number' && typeof data?.prevCount === 'number' && data.count > data.prevCount) {
          syncPending = true;
          void doSync().catch((err) => {
            console.error(`[Idle device=${deviceId}] Sync error:`, formatErr(err));
            try {
              client.close();
            } catch {
              // ignore
            }
          });
        }
      };

      client.on('exists', existsListener);

      // baseline sync and then stay connected; imapflow auto-idles when idle
      console.log(`[Idle device=${deviceId}] Connected; baseline sync...`);
      await doSync();
      console.log(`[Idle device=${deviceId}] Idling.`);

      attempt = 0;
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        const onClose = () => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
        client.once('close', onClose);
      });

      client.off('exists', existsListener);
      if (releaseLock) {
        releaseLock();
        releaseLock = null;
      }

      if (client.usable) {
        try {
          await client.logout();
        } catch {
          // ignore
        }
      }
      return;
    } catch (err) {
      if (isInvalidLoginError(err)) {
        const result = recordDeviceAuthFailure(deviceId, IMAP_AUTH_FAIL_THRESHOLD);
        if (result.paused) {
          console.warn(
            `[Idle device=${deviceId}] Paused after repeated invalid IMAP login (${result.count}/${IMAP_AUTH_FAIL_THRESHOLD}).`
          );
          return;
        }
        console.warn(
          `[Idle device=${deviceId}] Invalid IMAP login (${result.count}/${IMAP_AUTH_FAIL_THRESHOLD}).`
        );
      } else {
        console.error(`[Idle device=${deviceId}] Connection/loop error:`, formatErr(err));
      }
    } finally {
      try {
        if (releaseLock) releaseLock();
      } catch {
        // ignore
      }
      try {
        client.close();
      } catch {
        // ignore
      }
    }

    attempt++;
    const delay = nextBackoffMs(attempt);
    console.warn(`[Idle device=${deviceId}] Reconnecting in ${delay}ms (attempt=${attempt}).`);
    await sleep(delay, signal);
  }
}

class IdleManager {
  private handlesByToken = new Map<string, DeviceHandle>();

  startAll(): void {
    const devices = getDevices();
    for (const device of devices) {
      this.addOrRestart(device.device_token);
    }
  }

  addOrRestart(deviceToken: string): void {
    const device = getActiveDeviceByToken(deviceToken);
    if (!device) {
      return;
    }

    const existing = this.handlesByToken.get(deviceToken);
    if (existing) {
      existing.abort.abort();
      this.handlesByToken.delete(deviceToken);
    }

    const abort = new AbortController();
    const loopPromise = runDeviceLoop(deviceToken, device.id, abort.signal).finally(() => {
      const current = this.handlesByToken.get(deviceToken);
      if (current && current.abort === abort) {
        this.handlesByToken.delete(deviceToken);
      }
    });

    this.handlesByToken.set(deviceToken, {
      deviceToken,
      deviceId: device.id,
      abort,
      loopPromise,
    });
  }

  removeByToken(deviceToken: string): void {
    const existing = this.handlesByToken.get(deviceToken);
    if (!existing) return;
    existing.abort.abort();
    this.handlesByToken.delete(deviceToken);
  }

  async stopAll(): Promise<void> {
    const handles = Array.from(this.handlesByToken.values());
    this.handlesByToken.clear();
    for (const h of handles) {
      h.abort.abort();
    }
    await Promise.allSettled(handles.map((h) => h.loopPromise));
  }
}

export const idleManager = new IdleManager();
