import { expect, test } from 'bun:test';
import { logoAnswer } from './storybook-logo-route';

// https://github.com/alrayyes/forge-dashboard/issues/3890
//
// The screenshot script answers the image proxy for the stories' logo host.
// A story that is meant to fail must still fail.
const ask = (u: string) => `/api/v1/images?url=${encodeURIComponent(u)}`;

test('serves the one logo the "With a logo" story asks for', () => {
  expect(
    logoAnswer(ask('https://logos.example.test/forge-dashboard.svg')),
  ).toBe('logo');
});

test('aborts a missing path on the same host, so the failed-load story fails', () => {
  expect(logoAnswer(ask('https://logos.example.test/missing.png'))).toBe(
    'abort',
  );
});

test('aborts an insecure URL and another host', () => {
  expect(logoAnswer(ask('http://logos.example.test/forge-dashboard.svg'))).toBe(
    'abort',
  );
  expect(
    logoAnswer(ask('https://elsewhere.example.test/forge-dashboard.svg')),
  ).toBe('abort');
});

test('aborts a request with no url', () => {
  expect(logoAnswer('/api/v1/images')).toBe('abort');
});
