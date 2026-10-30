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

test('a legacy-api-route comment no longer exempts a line', () => {
  expect(lines("get('/api/dashboard') // legacy-api-route")).toEqual([1]);
  const src = "get('/api/a') // legacy-api-route\nget('/api/b')";
  expect(lines(src)).toEqual([1, 2]);
});

test('flags a double-escaped route in a string or RegExp', () => {
  expect(lines("get('\\\\/api\\\\/pull-requests')")).toEqual([1]);
  expect(lines("new RegExp('\\\\/api\\\\/dashboard')")).toEqual([1]);
});

test('flags an absolute URL on localhost or a single-label host', () => {
  expect(lines("goto('http://localhost:8080/api/dashboard')")).toEqual([1]);
  expect(lines("goto('http://127.0.0.1/api/dashboard')")).toEqual([1]);
  expect(lines("goto('http://h/api/dashboard')")).toEqual([1]);
  expect(lines("goto('http://localhost:8080/api/v1/dashboard')")).toEqual([]);
});

test('an allowed name must end at a boundary', () => {
  expect(lines("get('/api/version-x')")).toEqual([1]);
  expect(lines("get('/api/webhooks-x')")).toEqual([1]);
  expect(lines("get('/api/v1x/dashboard')")).toEqual([1]);
  expect(lines("get('/api/version/x')")).toEqual([]);
});

test('flags names that start with a digit or underscore', () => {
  expect(lines("get('/api/_x')")).toEqual([1]);
  expect(lines("get('/api/2x')")).toEqual([1]);
});

test('/api/nope is not exempt, no spec uses it', () => {
  expect(lines("get('/api/nope')")).toEqual([1]);
});
