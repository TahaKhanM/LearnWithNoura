const MAX_STRING_LENGTH = 240;

type IncidentField = string | number | boolean | null | undefined;

/** One-line, bounded JSON for production diagnostics. Callers deliberately
 * supply only identifiers, closed reason/stage values, and numeric counts. */
export function formatRealtimeIncident(
  event: string,
  fields: Record<string, IncidentField>,
): string {
  const payload: Record<string, Exclude<IncidentField, undefined>> = {
    event: sanitizeString(event),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    payload[key] = typeof value === 'string' ? sanitizeString(value) : value;
  }
  return JSON.stringify(payload);
}

/** Error messages are useful for setup failures, but credentials embedded in
 * connection URLs must never reach deployment logs. */
export function safeIncidentReason(error: unknown): string {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  return sanitizeString(raw)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1[redacted]@')
    .replace(/\b(api[_-]?key|token|password|secret)=([^&\s]+)/giu, '$1=[redacted]');
}

function sanitizeString(value: string): string {
  let normalized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    normalized += codePoint <= 31 || codePoint === 127 ? ' ' : character;
    if (normalized.length >= MAX_STRING_LENGTH) break;
  }
  return normalized.trim().slice(0, MAX_STRING_LENGTH);
}
