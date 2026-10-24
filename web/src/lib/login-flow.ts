/** An error from the auth API that keeps the HTTP status it came with. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** What the login page does when sign-in cannot start. */
export type LoginFailure = { action: 'register' | 'show'; message: string };

/**
 * A 404 from login/begin means no passkey is registered, which is the state an
 * operator leaves behind with reset-passkeys. Registration is open then, so the
 * page switches to it; leaving the visitor on a sign-in that cannot work is a
 * dead end. Any other failure is shown as it came.
 */
export function loginFailure(
  err: unknown,
  registrationOpen: boolean,
): LoginFailure {
  if (err instanceof ApiError && err.status === 404 && registrationOpen) {
    return {
      action: 'register',
      message: 'No passkey is registered yet. Create the first one.',
    };
  }
  if (err instanceof Error && err.name === 'NotAllowedError') {
    return {
      action: 'show',
      message:
        'Sign-in was cancelled, or this device has no passkey saved for this site. ' +
        'A passkey kept only on a security key can no longer sign in: sign in on a device that has a saved one and add a new passkey in Settings.',
    };
  }
  const message = err instanceof Error ? err.message : '';
  return { action: 'show', message: message || 'Sign-in failed.' };
}
