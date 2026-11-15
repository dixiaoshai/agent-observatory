/** Errors produced by agent-journal itself. The class is intentionally small:
 * consumers only need code, class and a human message for logs. */
export type JournalErrorClass = 'transient' | 'permanent' | 'config';

export class JournalError extends Error {
  readonly code: string;
  readonly klass: JournalErrorClass;

  constructor(code: string, klass: JournalErrorClass, message: string) {
    super(message);
    this.name = 'JournalError';
    this.code = code;
    this.klass = klass;
  }
}

export function asJournalError(error: unknown): JournalError {
  if (error instanceof JournalError) return error;
  if (error instanceof Error) return new JournalError('INTERNAL', 'permanent', error.message);
  return new JournalError('INTERNAL', 'permanent', String(error));
}

/** Map HTTP status codes to the shared consumer-follow classification. */
export function classifyHttpStatus(status: number, detail: string): JournalError {
  if (status === 408 || status === 429 || status >= 500) {
    return new JournalError(status === 429 ? 'RATE_LIMITED' : 'REMOTE_UNAVAILABLE', 'transient', `${detail} (HTTP ${status})`);
  }
  if (status === 413) return new JournalError('PAGE_TOO_LARGE', 'permanent', `${detail} (HTTP 413)`);
  if (status === 401) return new JournalError('UNAUTHORIZED', 'permanent', `${detail} (HTTP 401)`);
  if (status === 403) return new JournalError('FORBIDDEN', 'permanent', `${detail} (HTTP 403)`);
  return new JournalError('REMOTE_ERROR', 'permanent', `${detail} (HTTP ${status})`);
}
