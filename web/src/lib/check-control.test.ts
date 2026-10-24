/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { checkControl } from './run-log';

const checksUrl = '/api/checks?forge=github&fullName=a/b&number=1';
const url = 'https://example.test/run/1';

// What the pipeline dialog offers beside a check, decided with no browser. A
// queued job has no log yet, so it never offers View run.
describe('checkControl', () => {
  test('a queued job links to the forge, with or without a job id', () => {
    expect(checkControl({ state: 'queued', url, jobId: 7 }, checksUrl)).toBe(
      'open-on-forge',
    );
    expect(checkControl({ state: 'queued', url }, checksUrl)).toBe(
      'open-on-forge',
    );
  });

  test('a running or finished job with an id opens its output', () => {
    for (const state of ['running', 'success', 'failure']) {
      expect(checkControl({ state, url, jobId: 7 }, checksUrl)).toBe('output');
    }
  });

  test('a job with no id, or no checks address, gets the plain link', () => {
    expect(checkControl({ state: 'success', url }, checksUrl)).toBe('link');
    expect(checkControl({ state: 'running', url, jobId: 7 }, undefined)).toBe(
      'link',
    );
  });

  test('a held workflow links to its page, where the approve button is', () => {
    expect(
      checkControl({ state: 'awaiting_approval', url, jobId: 7 }, checksUrl),
    ).toBe('link');
  });

  test('a skipped job, or one with no page, offers nothing', () => {
    expect(checkControl({ state: 'skipped', url, jobId: 7 }, checksUrl)).toBe(
      'none',
    );
    expect(checkControl({ state: 'queued', url: '' }, checksUrl)).toBe('none');
    expect(checkControl({ state: 'running', jobId: 7 }, checksUrl)).toBe(
      'none',
    );
  });
});
