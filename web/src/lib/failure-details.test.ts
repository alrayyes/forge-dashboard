/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  type FailedRequest,
  failureDetails,
  MAX_RAW_TEXT,
} from './failure-details';

// What a failed action keeps of the server's answer for Copy (#1323). Reading
// the response is exercised by the page in copy-failure.spec.ts.
// https://github.com/alrayyes/forge-dashboard/issues/1323

const context = { action: 'merge', forge: 'github', repo: 'a/b', number: 1 };

const answered = (status: number, raw: unknown): FailedRequest =>
  Object.assign(new Error('a plain sentence'), { status, raw });

describe('the raw answer kept for Copy', () => {
  test('a JSON body is kept as received, raw error included', () => {
    const body = { error: 'forgejo: PUT /x: 405 raw', code: 'unknown' };

    expect(failureDetails(answered(405, body), context).response).toEqual(body);
  });

  test('a body that is not JSON is kept as its text', () => {
    expect(
      failureDetails(answered(502, '<html>Bad Gateway</html>'), context)
        .response,
    ).toBe('<html>Bad Gateway</html>');
  });

  // Finished failures are stored in sessionStorage, and one write over its
  // quota loses the whole list, so a proxy's long error page is cut.
  test('a long text body is cut, and says how much was left out', () => {
    const long = 'x'.repeat(MAX_RAW_TEXT + 500);

    expect(failureDetails(answered(502, long), context).response).toBe(
      `${'x'.repeat(MAX_RAW_TEXT)}… (500 more characters not kept)`,
    );
  });

  test('a text body at the limit is kept whole', () => {
    const exact = 'y'.repeat(MAX_RAW_TEXT);

    expect(failureDetails(answered(502, exact), context).response).toBe(exact);
  });

  test('an answer with no body is null, not missing', () => {
    expect(
      failureDetails(answered(500, undefined), context).response,
    ).toBeNull();
  });

  test('no answer at all has a null status and the browser’s own error', () => {
    expect(failureDetails(new Error('Failed to fetch'), context)).toMatchObject(
      {
        status: null,
        networkError: 'Failed to fetch',
      },
    );
  });
});
