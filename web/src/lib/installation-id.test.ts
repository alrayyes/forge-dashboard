/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { installationIdPayload } from './installation-id';

// The settings form sends a value that is not a number as typed, so the
// server can refuse it. Coercing it would clear the saved setting silently.

describe('installationIdPayload', () => {
  test('sends non-numeric text as the string typed', () => {
    expect(installationIdPayload('abc')).toBe('abc');
  });

  test('sends a numeric value as a number', () => {
    expect(installationIdPayload('123')).toBe(123);
  });

  test('trims before deciding', () => {
    expect(installationIdPayload('  123 ')).toBe(123);
    expect(installationIdPayload(' abc ')).toBe('abc');
  });

  test('sends 0 for an empty or whitespace value', () => {
    expect(installationIdPayload('')).toBe(0);
    expect(installationIdPayload('   ')).toBe(0);
  });

  test('keeps a non-finite numeric word as text', () => {
    expect(installationIdPayload('Infinity')).toBe('Infinity');
  });
});
