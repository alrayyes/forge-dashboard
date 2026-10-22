/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { isReadOnlyLock } from './lock-info';

test('a spent budget or an unreachable forge makes a forge read-only, any other lock does not', () => {
  expect(isReadOnlyLock({ reason: 'x', code: 'rate_limited' })).toBe(true);
  expect(isReadOnlyLock({ reason: 'x', code: 'forge_unreachable' })).toBe(true);
  expect(isReadOnlyLock({ reason: 'x', code: 'permission' })).toBe(false);
  expect(isReadOnlyLock({ reason: 'x' })).toBe(false);
  expect(isReadOnlyLock(null)).toBe(false);
});
