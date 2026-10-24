/** An error from the auth API that keeps the HTTP status it came with. */
export class ApiError extends Error {
  readonly status: number;
  /** Seconds the server asked the client to wait, from Retry-After. */
  readonly retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * The error for a response that was not ok, with the server's own message
 * from `body` (or `fallback`) and the seconds in Retry-After when it sent a
 * count of them. A date in Retry-After is ignored: the server sends seconds.
 */
export function failedRequest(
  res: Response,
  fallback: string,
  body: { error?: string },
): ApiError {
  const header = res.headers.get('Retry-After') ?? '';
  const seconds = /^\d+$/.test(header) ? Number(header) : undefined;
  return new ApiError(body.error || fallback, res.status, seconds);
}

function rateLimited(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 429;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** What to tell a visitor whose address the server has limited. */
function waitMessage(err: ApiError): string {
  const seconds = err.retryAfter;
  if (seconds === undefined || seconds < 1) {
    return 'Too many sign-in attempts. Wait a moment, then try again.';
  }
  const wait =
    seconds >= 120
      ? plural(Math.ceil(seconds / 60), 'minute')
      : plural(seconds, 'second');
  return `Too many sign-in attempts. Try again in ${wait}.`;
}

/** The message for a registration that failed, a limited one included. */
export function registrationFailure(err: unknown): string {
  if (rateLimited(err)) return waitMessage(err);
  return (err instanceof Error && err.message) || 'Registration failed.';
}

/** What the login page does when sign-in cannot start. */
export type LoginFailure = { action: 'register' | 'show'; message: string };

/**
 * Whether self-registration is open, as the server says it right now. A failed
 * request counts as closed: the answer could not be confirmed, so nothing is
 * offered on it.
 */
export async function checkRegistrationOpen(
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn('/api/auth/registration-status', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { open?: boolean };
    return data.open === true;
  } catch {
    return false;
  }
}

/**
 * A 404 from login/begin means no passkey is registered, which is the state an
 * operator leaves behind with reset-passkeys. Registration is open then, so the
 * page switches to it; leaving the visitor on a sign-in that cannot work is a
 * dead end. A cancelled or timed-out prompt gets a short retry line; the
 * browser gives the same error when no passkey is saved, so only a repeat
 * (`repeated`) gets the longer one, which names the reset command. Any other
 * failure is shown as it came.
 */
export function loginFailure(
  err: unknown,
  registrationOpen: boolean,
  repeated = false,
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
      message: repeated
        ? 'This device may have no passkey saved for this site. If every passkey is lost, run forge-dashboard reset-passkeys on the server. Otherwise add a new passkey in Settings from a device that is signed in.'
        : 'Sign-in was cancelled or timed out. Try again.',
    };
  }
  if (rateLimited(err)) {
    return { action: 'show', message: waitMessage(err) };
  }
  const message = err instanceof Error ? err.message : '';
  return { action: 'show', message: message || 'Sign-in failed.' };
}

/**
 * Keeps count of failed prompts for one login page. The browser reports a
 * cancelled prompt and a missing passkey the same way, so the second
 * NotAllowedError in a row is taken as the missing passkey. Any other
 * outcome starts the count again.
 */
export function loginFailureTracker(): (
  err: unknown,
  registrationOpen: boolean,
) => LoginFailure {
  let notAllowedBefore = false;
  return (err, registrationOpen) => {
    const notAllowed = err instanceof Error && err.name === 'NotAllowedError';
    const failure = loginFailure(
      err,
      registrationOpen,
      notAllowed && notAllowedBefore,
    );
    notAllowedBefore = notAllowed;
    return failure;
  };
}
