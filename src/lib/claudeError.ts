const QUOTA_MARKER = "QUOTA_EXCEEDED::";

export interface ClaudeErrorInfo {
  isQuotaExceeded: boolean;
  message: string;
  /** Best-effort "resets in N hours/minutes" extracted from the CLI's own message. */
  resetHint: string | null;
}

export function parseClaudeError(raw: string): ClaudeErrorInfo {
  if (raw.includes(QUOTA_MARKER)) {
    const message = raw.slice(raw.indexOf(QUOTA_MARKER) + QUOTA_MARKER.length).trim();
    const match = message.match(/(\d+)\s*(hours?|hrs?|minutes?|mins?)/i);
    return {
      isQuotaExceeded: true,
      message,
      resetHint: match ? `${match[1]} ${match[2].toLowerCase()}` : null,
    };
  }
  return { isQuotaExceeded: false, message: raw, resetHint: null };
}
