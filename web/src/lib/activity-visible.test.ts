/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { activityControlVisible } from './feedback-ui';

describe('the Activity control', () => {
  test('is hidden when nothing is recent, in flight or queued', () => {
    expect(activityControlVisible(0, 0)).toBe(false);
  });

  test('shows for a recent or in-flight action', () => {
    expect(activityControlVisible(1, 0)).toBe(true);
  });

  test('shows for an action queued for a rate limit reset alone', () => {
    expect(activityControlVisible(0, 2)).toBe(true);
  });
});
