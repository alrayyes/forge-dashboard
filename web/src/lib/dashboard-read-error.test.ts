/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  BackendStatusError,
  dashboardReadFailureMessage,
} from './dashboard-read-error';

// The banner must say what went wrong: an HTTP error means the backend was
// reached and answered, so "could not reach" is only true for a network
// failure or the read timeout.
// https://github.com/alrayyes/forge-dashboard/issues/3211

describe('dashboardReadFailureMessage', () => {
  test('an HTTP error status names the status and does not claim the backend was unreachable', () => {
    const message = dashboardReadFailureMessage(
      new BackendStatusError(500),
      false,
    );
    expect(message).toBe('The backend answered with an error (500).');
    expect(message).not.toContain('Could not reach');
  });

  test('keeps the status for other 4xx and 5xx codes', () => {
    expect(
      dashboardReadFailureMessage(new BackendStatusError(503), false),
    ).toContain('(503)');
    expect(
      dashboardReadFailureMessage(new BackendStatusError(403), false),
    ).toContain('(403)');
  });

  test('a network failure says the backend could not be reached', () => {
    expect(
      dashboardReadFailureMessage(new TypeError('Failed to fetch'), false),
    ).toBe('Could not reach the backend: Failed to fetch');
  });

  test('a timeout says the backend did not answer in time', () => {
    expect(
      dashboardReadFailureMessage(
        new DOMException('aborted', 'AbortError'),
        true,
      ),
    ).toBe('Could not reach the backend: it did not answer in time');
  });

  test('the error carries its status and the legacy message', () => {
    const err = new BackendStatusError(502);
    expect(err.status).toBe(502);
    expect(err.message).toBe('backend answered 502');
  });
});
