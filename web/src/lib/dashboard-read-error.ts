// What the banner says when the /api/v1/dashboard read fails. An HTTP error
// means the backend was reached and answered; "could not reach" is only true
// for a network failure or the read timeout. Kept in its own module so the
// Insights and Webhooks pages can reuse the wording.
// https://github.com/alrayyes/forge-dashboard/issues/3211

export class BackendStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`backend answered ${status}`);
    this.name = 'BackendStatusError';
    this.status = status;
  }
}

export function dashboardReadFailureMessage(
  err: Error,
  timedOut: boolean,
): string {
  if (err instanceof BackendStatusError) {
    return `The backend answered with an error (${err.status}).`;
  }
  return `Could not reach the backend: ${
    timedOut ? 'it did not answer in time' : err.message
  }`;
}
