import { expect, test } from 'bun:test';
import { findUnversionedRoutes } from './check-spec-api-routes';

const lines = (src: string) => findUnversionedRoutes(src).map((f) => f.line);

test('flags a string, a glob and a regex route with their lines', () => {
  expect(lines("a\npage.route('**/api/dashboard', h)")).toEqual([2]);
  expect(lines("page.request.get('/api/settings/x')")).toEqual([1]);
  expect(lines('page.route(/\\/api\\/dashboard/, h)')).toEqual([1]);
  expect(lines("startsWith('/api/sharing')")).toEqual([1]);
});

test('passes versioned routes and the unversioned exceptions', () => {
  expect(lines("page.route('**/api/v1/dashboard', h)")).toEqual([]);
  expect(lines('page.route(/\\/api\\/v1\\/dashboard/, h)')).toEqual([]);
  expect(lines("get('/api/version')")).toEqual([]);
  expect(lines("post('/api/webhooks/github/x')")).toEqual([]);
  expect(lines("post('/api/webhooks/forgejo/x')")).toEqual([]);
});

test('ignores paths that only contain /api/ and bare prefixes', () => {
  expect(lines('see internal/api/tokens_test.go')).toEqual([]);
  expect(lines("url 'https://forge.example/api/swagger'")).toEqual([]);
  expect(lines("if (!p.startsWith('/api/')) return;")).toEqual([]);
});

test('allows a deliberate legacy route', () => {
  expect(lines("get('/api/nope')")).toEqual([]);
  expect(lines("get('/api/dashboard') // legacy-api-route")).toEqual([]);
});
