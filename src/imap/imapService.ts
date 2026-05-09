import crypto from 'crypto';
import { ImapFlow } from 'imapflow';
import { formatErr } from '../utils/log';

function shortHash(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 8);
}

export interface Voicemail {
  uid: string;
  callerNumber: string;
  callerName?: string;
  durationSeconds: number;
  receivedAt: Date;
  audioAttachment?: {
    filename: string;
    contentType: string;
    content: Buffer;
  };
}

export interface MissedCall {
  uid: string;
  callerNumber: string;
  receivedAt: Date;
}

export interface ImapCredentials {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * UIDNEXT from SprachBox at registration time: messages with UID >= this value are new since snapshot
 * (reliable baseline vs. Telekom internalDate often being call time, before login).
 */
export async function getSprachBoxUidNext(credentials: ImapCredentials): Promise<number | null> {
  const client = new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: true,
    auth: {
      user: credentials.user,
      pass: credentials.pass,
    },
    socketTimeout: 30000,
    logger: false,
  });
  client.on('error', (err) => {
    console.error('[IMAP] Client error during UIDNEXT fetch:', formatErr(err));
  });

  try {
    await client.connect();
    const st = await client.status('SprachBox', { uidNext: true });
    const n = st.uidNext;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch (err) {
    console.warn('[IMAP] UIDNEXT fetch failed:', formatErr(err));
    return null;
  } finally {
    try {
      if (client.usable) {
        await client.logout();
      }
    } catch {
      // ignore
    }
  }
}

export async function validateImapCredentials(credentials: ImapCredentials): Promise<boolean> {
  const client = new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: true,
    auth: {
      user: credentials.user,
      pass: credentials.pass,
    },
    socketTimeout: 30000,
    logger: false,
  });
  client.on('error', (err) => {
    console.error('[IMAP] Client error event during auth validation:', formatErr(err));
  });

  try {
    await client.connect();
    await client.status('SprachBox', { unseen: true });
    return true;
  } catch (err) {
    console.warn('[IMAP] Credential validation failed:', formatErr(err));
    return false;
  } finally {
    try {
      if (client.usable) {
        await client.logout();
      }
    } catch {
      // Ignore logout errors in validation flow.
    }
  }
}

// Parse "Sprachnachricht 19s von 0151 2345678" → { duration: 19, number: "01512345678" }
function parseVoicemailSubject(subject: string): { duration: number; callerNumber: string } | null {
  const match = subject.match(/Sprachnachricht\s+(\d+)s\s+von\s+([\d+\s]+)/i);
  if (!match) return null;
  return {
    duration: parseInt(match[1], 10),
    callerNumber: match[2].trim().replace(/\s+/g, ''),
  };
}

/** Telekom also delivers missed-call lines as unread; these are returned separately from voicemails. */
function parseMissedCallSubject(subject: string): { callerNumber: string } | null {
  const match = subject.match(/^Anruf\s+von\s+([\d+\s]+)/i);
  if (!match) return null;
  return {
    callerNumber: match[1].trim().replace(/\s+/g, ''),
  };
}

export interface FetchSprachBoxResult {
  voicemails: Voicemail[];
  missedCalls: MissedCall[];
}

export async function fetchUnreadSprachBoxWithClient(
  client: ImapFlow,
  seenUids: Set<string>
): Promise<FetchSprachBoxResult> {
  const voicemails: Voicemail[] = [];
  const missedCalls: MissedCall[] = [];

  // Lock the SprachBox folder
  const lock = await client.getMailboxLock('SprachBox');

  try {
    // Fetch only unseen messages to reduce load and avoid timeouts on large mailboxes.
    const unseenResult = await client.search({ seen: false });
    const unseenUids = Array.isArray(unseenResult) ? unseenResult : [];
    if (unseenUids.length === 0) {
      return { voicemails, missedCalls };
    }

    for await (const message of client.fetch(unseenUids, {
      uid: true,
      envelope: true,
      internalDate: true,
    })) {
      const uid = String(message.uid);

      // Skip already-seen messages
      if (seenUids.has(uid)) continue;

      const subject = message.envelope?.subject || '';

      const subjectData = parseVoicemailSubject(subject);
      if (subjectData) {
        voicemails.push({
          uid,
          callerNumber: subjectData.callerNumber,
          durationSeconds: subjectData.duration,
          receivedAt: message.internalDate ? new Date(message.internalDate) : new Date(),
        });
        continue;
      }

      const missedCallData = parseMissedCallSubject(subject);
      if (missedCallData) {
        missedCalls.push({
          uid,
          callerNumber: missedCallData.callerNumber,
          receivedAt: message.internalDate ? new Date(message.internalDate) : new Date(),
        });
        continue;
      }

      console.warn(`[IMAP] Unknown SprachBox subject (sha256=${shortHash(subject)}, len=${subject.length})`);
    }
  } finally {
    lock.release();
  }

  return { voicemails, missedCalls };
}

export async function fetchNewVoicemails(
  credentials: ImapCredentials,
  seenUids: Set<string>
): Promise<FetchSprachBoxResult> {
  const client = new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: true,
    auth: {
      user: credentials.user,
      pass: credentials.pass,
    },
    socketTimeout: 60000,
    logger: false, // set to console for debugging
  });
  client.on('error', (err) => {
    // Prevent unhandled error events from crashing the process.
    console.error('[IMAP] Client error event:', formatErr(err));
  });

  try {
    await client.connect();
    return await fetchUnreadSprachBoxWithClient(client, seenUids);
  } catch (err) {
    console.error('[IMAP] Error fetching voicemails:', formatErr(err));
    throw err;
  } finally {
    try {
      if (client.usable) {
        await client.logout();
      }
    } catch (logoutErr) {
      console.warn('[IMAP] Logout warning:', formatErr(logoutErr));
    }
  }
}

// Quick check: just count unseen messages without downloading
export async function getUnseenCount(credentials: ImapCredentials): Promise<number> {
  const client = new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: true,
    auth: {
      user: credentials.user,
      pass: credentials.pass,
    },
    socketTimeout: 60000,
    logger: false,
  });
  client.on('error', (err) => {
    console.error('[IMAP] Client error event:', formatErr(err));
  });

  try {
    await client.connect();
    const status = await client.status('SprachBox', { unseen: true });
    return status.unseen || 0;
  } catch {
    return 0;
  } finally {
    try {
      if (client.usable) {
        await client.logout();
      }
    } catch {
      // Ignore logout errors for count-only checks.
    }
  }
}
