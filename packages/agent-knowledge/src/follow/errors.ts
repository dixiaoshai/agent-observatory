/** One classified follow failure: transient failures retry, permanent ones stop. */
export type FollowErrorClass = 'transient' | 'permanent';

export class FollowError extends Error {
  constructor(
    public readonly code: string,
    public readonly klass: FollowErrorClass,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'FollowError';
  }
}

export function errorClassOf(error: unknown): FollowErrorClass {
  return error instanceof FollowError ? error.klass : 'permanent';
}

export function errorCodeOf(error: unknown): string {
  return error instanceof FollowError ? error.code : 'INTERNAL';
}
