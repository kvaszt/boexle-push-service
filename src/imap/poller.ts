import cron from 'node-cron';
import type { Statement } from 'better-sqlite3';
import {
  getDb,
  getDevices,
  deleteDeviceById,
  purgeExpiredRefreshSessions,
  purgeOldSeenMessages,
  recordDeviceAuthFailure,
  clearDeviceAuthFailures,
  Device,
} from '../db/database';
import { fetchNewVoicemails, ImapCredentials, MissedCall, Voicemail } from '../imap/imapService';
import { sendMissedCallPush, sendVoicemailPush } from '../push/pushService';
import { decrypt } from '../utils/crypto';
import { formatErr } from '../utils/log';

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(raw || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

// Cron step syntax supports 1..59 minutes; clamp to safe range.
const POLL_INTERVAL = clampInt(process.env.POLL_INTERVAL_MINUTES, 2, 1, 59);
const POLL_JITTER_SECONDS = clampInt(process.env.POLL_JITTER_SECONDS, 15, 0, 300);
const SEEN_MESSAGES_RETENTION_DAYS = clampInt(process.env.SEEN_MESSAGES_RETENTION_DAYS, 90, 1, 3650);
const IMAP_AUTH_FAIL_THRESHOLD = clampInt(process.env.IMAP_AUTH_FAIL_THRESHOLD, 3, 1, 20);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomJitterMs(): number {
  const jitterSeconds = Number.isFinite(POLL_JITTER_SECONDS) ? Math.max(0, POLL_JITTER_SECONDS) : 0;
  if (jitterSeconds <= 0) return 0;
  return Math.floor(Math.random() * (jitterSeconds * 1000));
}

function shouldPruneDeviceForApnsReason(reason?: string): boolean {
  return reason === 'BadDeviceToken' || reason === 'Unregistered';
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

/** Sends pushes and inserts seen rows; returns false if device was hard-deleted (bad APNs token). */
async function pushVoicemailListAndMarkSeen(
  device: Device,
  list: Voicemail[],
  insertSeen: Statement
): Promise<boolean> {
  for (let i = 0; i < list.length; i++) {
    const voicemail = list[i];
    const badgeCount = list.length - i;
    const pushResult = await sendVoicemailPush(device.device_token, voicemail, badgeCount);
    if (!pushResult.ok && shouldPruneDeviceForApnsReason(pushResult.apnsReason)) {
      const removed = deleteDeviceById(device.id);
      console.warn(
        '[Poller] Removed stale device ' +
          device.id +
          ' after APNs reason ' +
          pushResult.apnsReason +
          ' (removed=' +
          String(removed) +
          ')'
      );
      return false;
    }
    insertSeen.run(device.id, voicemail.uid);
  }
  return true;
}

/** Sends pushes and inserts seen rows; returns false if device was hard-deleted (bad APNs token). */
async function pushMissedCallListAndMarkSeen(
  device: Device,
  list: MissedCall[],
  insertSeen: Statement
): Promise<boolean> {
  for (let i = 0; i < list.length; i++) {
    const missedCall = list[i];
    const badgeCount = list.length - i;
    const pushResult = await sendMissedCallPush(device.device_token, missedCall, badgeCount);
    if (!pushResult.ok && shouldPruneDeviceForApnsReason(pushResult.apnsReason)) {
      const removed = deleteDeviceById(device.id);
      console.warn(
        '[Poller] Removed stale device ' +
          device.id +
          ' after APNs reason ' +
          pushResult.apnsReason +
          ' (removed=' +
          String(removed) +
          ')'
      );
      return false;
    }
    insertSeen.run(device.id, missedCall.uid);
  }
  return true;
}

function splitByBaseline<T extends { uid: string; receivedAt: Date }>(
  list: T[],
  uidThreshold: number | null,
  cutoff: number | null
): { baseline: T[]; afterBaseline: T[] } {
  const baseline: T[] = [];
  const afterBaseline: T[] = [];
  if (uidThreshold != null) {
    for (const item of list) {
      const n = parseInt(item.uid, 10);
      if (!Number.isFinite(n) || n < uidThreshold) baseline.push(item);
      else afterBaseline.push(item);
    }
    return { baseline, afterBaseline };
  }
  if (cutoff != null) {
    for (const item of list) {
      const ts = Math.floor(item.receivedAt.getTime() / 1000);
      if (ts <= cutoff) baseline.push(item);
      else afterBaseline.push(item);
    }
    return { baseline, afterBaseline };
  }
  return { baseline: [...list], afterBaseline: [] };
}

export async function syncFetchedSprachBoxToPushAndSeen(
  device: Device,
  fetchResult: { voicemails: Voicemail[]; missedCalls: MissedCall[] },
  seenRowsCount: number
): Promise<boolean> {
  const db = getDb();
  const insertSeen = db.prepare(
    'INSERT OR IGNORE INTO seen_messages (device_id, message_uid) VALUES (?, ?)'
  );

  const newVoicemails = fetchResult.voicemails;
  const newMissedCalls = fetchResult.missedCalls;
  const shouldPushMissedCalls = device.push_missed_calls === 1;

  if (newVoicemails.length === 0 && newMissedCalls.length === 0) {
    db.prepare("UPDATE devices SET last_poll = datetime('now') WHERE id = ?").run(device.id);
    return true;
  }

  if (newVoicemails.length > 0) {
    console.log('[Poller] Found ' + newVoicemails.length + ' new voicemail(s) for device ' + device.id);
  }
  if (newMissedCalls.length > 0) {
    console.log('[Poller] Found ' + newMissedCalls.length + ' new missed-call event(s) for device ' + device.id);
  }

  // First poll (no seen_messages yet): baseline = no push for backlog.
  // Prefer IMAP UID vs UIDNEXT at registration (Telekom internalDate is often call time, not mail time).
  // Fallback: time-based baseline_cutoff. Legacy: no metadata => all baseline.
  if (seenRowsCount === 0) {
    const uidThreshold = device.imap_uid_next_at_register;
    const cutoff = device.baseline_cutoff;

    const voicemailSplit = splitByBaseline(newVoicemails, uidThreshold, cutoff);
    const missedCallSplit = splitByBaseline(newMissedCalls, uidThreshold, cutoff);

    const baselineCount = voicemailSplit.baseline.length + missedCallSplit.baseline.length;
    if (baselineCount > 0) {
      if (uidThreshold != null) {
        console.log(
          '[Poller] Baseline (uid < UIDNEXT@register=' +
            uidThreshold +
            '): device ' +
            device.id +
            ', ' +
            baselineCount +
            ' event(s) skipped push'
        );
      } else if (cutoff != null) {
        console.log(
          '[Poller] Baseline (<= register time, no UIDNEXT): device ' +
            device.id +
            ', ' +
            baselineCount +
            ' event(s) skipped push'
        );
      } else {
        console.log(
          '[Poller] Baseline (legacy, no cutoff/UID): device ' +
            device.id +
            ', ' +
            baselineCount +
            ' event(s) skipped push'
        );
      }
    }

    for (const v of voicemailSplit.baseline) {
      insertSeen.run(device.id, v.uid);
    }
    for (const c of missedCallSplit.baseline) {
      insertSeen.run(device.id, c.uid);
    }

    if (voicemailSplit.afterBaseline.length === 0 && missedCallSplit.afterBaseline.length === 0) {
      db.prepare("UPDATE devices SET last_poll = datetime('now') WHERE id = ?").run(device.id);
      return true;
    }

    if (voicemailSplit.afterBaseline.length > 0) {
      const pushedVoicemails = await pushVoicemailListAndMarkSeen(
        device,
        voicemailSplit.afterBaseline,
        insertSeen
      );
      if (!pushedVoicemails) return false;
    }
    if (missedCallSplit.afterBaseline.length > 0) {
      if (shouldPushMissedCalls) {
        const pushedMissedCalls = await pushMissedCallListAndMarkSeen(
          device,
          missedCallSplit.afterBaseline,
          insertSeen
        );
        if (!pushedMissedCalls) return false;
      } else {
        for (const missedCall of missedCallSplit.afterBaseline) {
          insertSeen.run(device.id, missedCall.uid);
        }
      }
    }

    db.prepare("UPDATE devices SET last_poll = datetime('now') WHERE id = ?").run(device.id);
    return true;
  }

  if (newVoicemails.length > 0) {
    const pushedVoicemails = await pushVoicemailListAndMarkSeen(device, newVoicemails, insertSeen);
    if (!pushedVoicemails) return false;
  }
  if (newMissedCalls.length > 0) {
    if (shouldPushMissedCalls) {
      const pushedMissedCalls = await pushMissedCallListAndMarkSeen(device, newMissedCalls, insertSeen);
      if (!pushedMissedCalls) return false;
    } else {
      for (const missedCall of newMissedCalls) {
        insertSeen.run(device.id, missedCall.uid);
      }
    }
  }

  db.prepare("UPDATE devices SET last_poll = datetime('now') WHERE id = ?").run(device.id);
  return true;
}

async function pollDevice(device: Device): Promise<void> {
  const db = getDb();

  // Load seen UIDs for this device
  const seenRows = db
    .prepare('SELECT message_uid FROM seen_messages WHERE device_id = ?')
    .all(device.id) as { message_uid: string }[];
  const seenUids = new Set(seenRows.map((r) => r.message_uid));

  // Decrypt credentials only here (per-device); not stored anywhere outside this scope.
  const credentials: ImapCredentials = {
    host: device.imap_host,
    port: device.imap_port,
    user: decrypt(device.imap_user),
    pass: decrypt(device.imap_pass),
  };

  let fetchResult;
  try {
    fetchResult = await fetchNewVoicemails(credentials, seenUids);
  } catch (err) {
    if (isInvalidLoginError(err)) {
      const result = recordDeviceAuthFailure(device.id, IMAP_AUTH_FAIL_THRESHOLD);
      if (result.paused) {
        console.warn(
          '[Poller] Paused device ' +
            device.id +
            ' after repeated invalid IMAP login (' +
            result.count +
            '/' +
            IMAP_AUTH_FAIL_THRESHOLD +
            ')'
        );
      } else {
        console.warn(
          '[Poller] Invalid IMAP login for device ' +
            device.id +
            ' (' +
            result.count +
            '/' +
            IMAP_AUTH_FAIL_THRESHOLD +
            ')'
        );
      }
      return;
    }
    console.error('[Poller] IMAP error for device ' + device.id + ':', formatErr(err));
    return;
  }
  clearDeviceAuthFailures(device.id);
  await syncFetchedSprachBoxToPushAndSeen(device, fetchResult, seenRows.length);
}

function runMaintenance(): void {
  const removedSessions = purgeExpiredRefreshSessions();
  if (removedSessions > 0) {
    console.log('[Poller] Purged ' + removedSessions + ' expired refresh session(s)');
  }
  const removedSeen = purgeOldSeenMessages(SEEN_MESSAGES_RETENTION_DAYS);
  if (removedSeen > 0) {
    console.log('[Poller] Purged ' + removedSeen + ' old seen_message row(s) (retention ' + SEEN_MESSAGES_RETENTION_DAYS + 'd)');
  }
}

export async function pollAllDevices(): Promise<void> {
  runMaintenance();

  // Keep imap_user/imap_pass encrypted at this layer; pollDevice decrypts per call only.
  const devices = getDevices();

  if (devices.length === 0) return;

  console.log('[Poller] Polling ' + devices.length + ' device(s) with up to ' + POLL_JITTER_SECONDS + 's jitter...');

  // Poll all devices in parallel, but spread each device start by random jitter.
  await Promise.allSettled(
    devices.map(async (device) => {
      const jitterMs = randomJitterMs();
      if (jitterMs > 0) {
        await sleep(jitterMs);
      }
      await pollDevice(device);
    })
  );
}

export function startHousekeeping(): void {
  console.log(
    '[Poller] Housekeeping — interval: every ' + POLL_INTERVAL + ' minute(s) (no IMAP polling)'
  );

  // Run immediately on start
  runMaintenance();

  // Then periodically
  cron.schedule('*/' + POLL_INTERVAL + ' * * * *', () => {
    runMaintenance();
  });
}

export function startPoller(): void {
  // Kept for backwards compatibility. IMAP polling is disabled; use idleManager + housekeeping.
  startHousekeeping();
}
