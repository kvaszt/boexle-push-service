/**
 * Formats an unknown error for safe logging:
 * - Only name/code + first 120 chars of message
 * - Redacts common credential patterns (auth=, pass=, password=, user=)
 * - Never serializes full stack traces or nested objects
 */
export function formatErr(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err).slice(0, 120);
  }
  const code = (err as { code?: unknown }).code;
  const codePart = typeof code === 'string' && code ? ` ${code}` : '';
  const redacted = err.message.replace(/(auth|pass|password|user)[=:]\S+/gi, '$1=[REDACTED]');
  const truncated = redacted.length > 120 ? redacted.slice(0, 120) + '...' : redacted;
  return `${err.name}${codePart}: ${truncated}`;
}
