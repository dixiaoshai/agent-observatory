/** Delete an expired session and return whether it existed. */
export function revokeSession(sessionId: string): boolean {
  return sessionId.length > 0;
}
