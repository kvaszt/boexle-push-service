import cron from 'node-cron';
import type { Statement } from 'better-sqlite3';
import {
  getDb,
  getDevices,
  deleteDeviceById,
  purgeExpiredRefreshSessions,
  purgeOldSeenMessages,
  Device,
} from '../db/database';
import { fetchNewVoicemails, ImapCredentials, Voicemail } from '../imap/imapService';
import { sendVoicemailPush } from '../push/pushService';
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

function voicemailReceivedUnix(v: Voicemail): number {
  return Math.floor(v.receivedAt.getTime() / 1000);
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
    console.error('[Poller] IMAP error for device ' + device.id + ':', formatErr(err));
    return;
  }

  const insertSeen = db.prepare(
    'INSERT OR IGNORE INTO seen_messages (device_id, message_uid) VALUES (?, ?)'
  );

  for (const uid of fetchResult.silentAckUids) {
    insertSeen.run(device.id, uid);
  }

  const newVoicemails = fetchResult.voicemails;

  if (newVoicemails.length === 0) {
    db.prepare('UPDATE devices SET last_poll = datetime(\'now\') WHERE id = ?').run(device.id);
    return;
  }

  console.log('[Poller] Found ' + newVoicemails.length + ' new voicemail(s) for device ' + device.id);

  // First poll (no seen_messages yet): baseline = no push for backlog.
  // Prefer IMAP UID vs UIDNEXT at registration (Telekom internalDate is often call time, not mail time).
  // Fallback: time-based baseline_cutoff. Legacy: no metadata => all baseline.
  if (seenRows.length === 0) {
    const uidThreshold = device.imap_uid_next_at_register;
    const cutoff = device.baseline_cutoff;

    let baseline: Voicemail[] = [];
    let afterBaseline: Voicemail[] = [];

    if (uidThreshold != null) {
      for (const v of newVoicemails) {
        const n = parseInt(v.uid, 10);
        if (!Number.isFinite(n) || n < uidThreshold) baseline.push(v);
        else afterBaseline.push(v);
      }
      if (baseline.length > 0) {
        console.log(
          '[Poller] Baseline (uid < UIDNEXT@register=' +
            uidThreshold +
            '): device ' +
            device.id +
            ', ' +
            baseline.length +
            ' voicemail(s) skipped push'
        );
      }
    } else if (cutoff != null) {
      for (const v of newVoicemails) {
        if (voicemailReceivedUnix(v) <= cutoff) baseline.push(v);
        else afterBaseline.push(v);
      }
      if (baseline.length > 0) {
        console.log(
          '[Poller] Baseline (<= register time, no UIDNEXT): device ' +
            device.id +
            ', ' +
            baseline.length +
            ' voicemail(s) skipped push'
        );
      }
    } else {
      baseline = [...newVoicemails];
      for (const voicemail of baseline) {
        insertSeen.run(device.id, voicemail.uid);
      }
      console.log(
        '[Poller] Baseline (legacy, no cutoff/UID): device ' +
          device.id +
          ', ' +
          baseline.length +
          ' message(s) skipped push'
      );
      db.prepare('UPDATE devices SET last_poll = datetime(\'now\') WHERE id = ?').run(device.id);
      return;
    }

    for (const v of baseline) {
      insertSeen.run(device.id, v.uid);
    }

    if (afterBaseline.length === 0) {
      db.prepare('UPDATE devices SET last_poll = datetime(\'now\') WHERE id = ?').run(device.id);
      return;
    }

    const pushed = await pushVoicemailListAndMarkSeen(device, afterBaseline, insertSeen);
    if (!pushed) return;

    db.prepare('UPDATE devices SET last_poll = datetime(\'now\') WHERE id = ?').run(device.id);
    return;
  }

  const pushed = await pushVoicemailListAndMarkSeen(device, newVoicemails, insertSeen);
  if (!pushed) return;

  db.prepare('UPDATE devices SET last_poll = datetime(\'now\') WHERE id = ?').run(device.id);
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

export function startPoller(): void {
  console.log('[Poller] Starting — interval: every ' + POLL_INTERVAL + ' minute(s), jitter: ' + POLL_JITTER_SECONDS + 's');

  // Run immediately on start
  pollAllDevices().catch(console.error);

  // Then on schedule
  cron.schedule('*/' + POLL_INTERVAL + ' * * * *', () => {
    pollAllDevices().catch(console.error);
  });
}
