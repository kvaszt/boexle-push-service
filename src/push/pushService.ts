import * as apn from '@parse/node-apn';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Voicemail } from '../imap/imapService';
import { formatErr } from '../utils/log';

dotenv.config();

/** Default off: keep caller numbers out of the APNs payload (privacy). Set PUSH_INCLUDE_CALLER=1 to include. */
const PUSH_INCLUDE_CALLER = process.env.PUSH_INCLUDE_CALLER === '1' || process.env.PUSH_INCLUDE_CALLER === 'true';

export function assertApnsConfig(): void {
  const keyId = (process.env.APN_KEY_ID || '').trim();
  const teamId = (process.env.APN_TEAM_ID || '').trim();
  const bundleId = (process.env.APN_BUNDLE_ID || '').trim();
  const keyPath = (process.env.APN_KEY_PATH || '').trim();

  if (!keyId) throw new Error('APN_KEY_ID is required');
  if (!teamId) throw new Error('APN_TEAM_ID is required');
  if (!bundleId) throw new Error('APN_BUNDLE_ID is required');
  if (!keyPath) throw new Error('APN_KEY_PATH is required');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(path.resolve(keyPath));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`APN_KEY_PATH not readable (${keyPath}): ${msg}`);
  }
  if (!stat.isFile()) {
    throw new Error(`APN_KEY_PATH is not a regular file: ${keyPath}`);
  }
  if (process.platform !== 'win32') {
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `APN_KEY_PATH has insecure permissions (${keyPath}, mode=${mode.toString(8)}). Set 0600 or 0400 (e.g. chmod 400 ${keyPath}).`
      );
    }
  }
}

let provider: apn.Provider | null = null;

function getProvider(): apn.Provider {
  if (!provider) {
    provider = new apn.Provider({
      token: {
        key: path.resolve(process.env.APN_KEY_PATH || './certs/AuthKey.p8'),
        keyId: process.env.APN_KEY_ID || '',
        teamId: process.env.APN_TEAM_ID || '',
      },
      production: process.env.APN_PRODUCTION === 'true',
    });
  }
  return provider;
}

function formatCallerNumber(callerNumber: string): string {
  const digits = (callerNumber || '').replace(/\D/g, '');
  if (!digits) return 'Unbekannt';

  let normalized = digits;
  if (normalized.startsWith('00')) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith('0') && normalized.length > 1) {
    normalized = '49' + normalized.slice(1);
  }

  if (normalized.length <= 2) {
    return callerNumber || 'Unbekannt';
  }

  const countryCode = normalized.startsWith('49') ? '49' : normalized.slice(0, 2);
  const local = normalized.slice(countryCode.length);
  if (!local) {
    return '+' + countryCode;
  }

  const firstGroup = local.slice(0, 3);
  const rest = local.slice(3);
  const restGroups: string[] = [];
  let i = 0;
  while (i < rest.length) {
    const remaining = rest.length - i;
    if (remaining <= 4) {
      restGroups.push(rest.slice(i));
      break;
    }
    restGroups.push(rest.slice(i, i + 3));
    i += 3;
  }

  const grouped = [firstGroup, ...restGroups].filter(Boolean).join(' ');
  return ('+' + countryCode + ' ' + grouped).trim();
}

function formatDuration(durationSeconds: number): string {
  const safe = Number.isFinite(durationSeconds) ? durationSeconds : 0;
  const total = Math.max(0, Math.floor(safe));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return String(minutes) + ':' + String(seconds).padStart(2, '0');
}

export async function sendVoicemailPush(
  deviceToken: string,
  voicemail: Voicemail,
  badgeCount: number
): Promise<{ ok: boolean; apnsReason?: string }> {
  const notification = new apn.Notification();

  notification.topic = process.env.APN_BUNDLE_ID || '';
  notification.expiry = Math.floor(Date.now() / 1000) + 3600;
  notification.badge = badgeCount;
  notification.sound = 'default';

  const caller = formatCallerNumber(voicemail.callerNumber || '');
  const duration = formatDuration(voicemail.durationSeconds);

  notification.alert = {
    title: 'Neue Voicemail',
    body: caller + ' · ' + duration,
  };

  const payload: Record<string, unknown> = {
    type: 'new_voicemail',
    uid: voicemail.uid,
    durationSeconds: voicemail.durationSeconds,
    receivedAt: voicemail.receivedAt.toISOString(),
  };
  if (PUSH_INCLUDE_CALLER) {
    payload.callerNumber = voicemail.callerNumber;
  }
  notification.payload = payload;

  try {
    const result = await getProvider().send(notification, deviceToken);

    // @parse/node-apn: successes land in `sent`; failures in `failed` (mixed shapes).
    if (result.sent && result.sent.length > 0) {
      console.log('[APNs] Push sent to ' + deviceToken.substring(0, 8) + '...');
      return { ok: true };
    }

    if (result.failed.length > 0) {
      const f = result.failed[0] as { response?: { reason?: string }; status?: number; error?: { message?: string } };
      const reason = f.response?.reason;
      const detail =
        f.error?.message ??
        (reason != null
          ? `HTTP ${f.status ?? '?'} ${reason}`
          : JSON.stringify(f));
      console.error('[APNs] Push failed:', detail);
      return { ok: false, apnsReason: reason };
    }

    console.log('[APNs] Push sent to ' + deviceToken.substring(0, 8) + '...');
    return { ok: true };
  } catch (err) {
    console.error('[APNs] Error sending push:', formatErr(err));
    return { ok: false };
  }
}

export function closeProvider() {
  provider?.shutdown();
  provider = null;
}
