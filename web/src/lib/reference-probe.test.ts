/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { probeReference } from './reference-probe';

// https://github.com/alrayyes/forge-dashboard/issues/4269
// An item of a repository the dashboard doesn't track opens in the dialog only
// if the forge can show it; anything else sends the reader to the forge.
const ref = { forge: 'github', repo: 'o/r', number: 9 };
const reply = (status: number, body: unknown = {}) =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('probeReference', () => {
  test('asks the issues route and returns what it answered', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ state: 'closed' }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await probeReference(ref, fetcher)).toEqual({ state: 'closed' });
    expect(urls).toEqual([
      '/api/v1/issues/details?forge=github&fullName=o%2Fr&number=9',
    ]);
  });

  test.each([404, 403, 429, 502])('is null for a %i', async (status) => {
    expect(await probeReference(ref, reply(status))).toBeNull();
  });

  test('is null when the request fails or the body is not JSON', async () => {
    const down = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await probeReference(ref, down)).toBeNull();
    const junk = (async () =>
      new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    expect(await probeReference(ref, junk)).toBeNull();
  });
});
