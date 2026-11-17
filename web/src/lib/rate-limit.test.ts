/// <reference types="bun" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

// rate-limit.ts reaches the timezone store, which needs the Svelte compiler.
mock.module('./time.svelte', () => ({ formatTime: (t: string) => t }));
const {
  isRateLimited,
  isRunningLow,
  rateLimitSeverity,
  rateLimitWhy,
  showsOnOverview,
} = await import('./rate-limit');
const { registerForgeCapabilities, resetForgeCapabilities } = await import(
  './forges'
);

const now = Date.parse('2030-01-01T12:00:00Z');
const future = '2030-01-01T12:10:00Z';
const past = '2030-01-01T11:50:00Z';

const grade = (limit: number, remaining: number, resetsAt: string) =>
  rateLimitSeverity({ limit, remaining, resetsAt }, now);

describe('rateLimitSeverity', () => {
  test('plenty left is ok', () => {
    expect(grade(5000, 4000, future)).toBe('ok');
  });

  test('exactly 20% left is still ok', () => {
    expect(grade(5000, 1000, future)).toBe('ok');
  });

  test('just under 20% is a warning', () => {
    expect(grade(5000, 999, future)).toBe('warning');
  });

  test('exactly 5% left is a warning, not low yet', () => {
    expect(grade(5000, 250, future)).toBe('warning');
  });

  test('just under 5% is low', () => {
    expect(grade(5000, 249, future)).toBe('low');
  });

  test('one request left is low', () => {
    expect(grade(5000, 1, future)).toBe('low');
  });

  test('spent with the reset ahead is exceeded', () => {
    expect(grade(5000, 0, future)).toBe('exceeded');
  });

  test('spent but already reset is low, not exceeded', () => {
    expect(grade(5000, 0, past)).toBe('low');
  });

  test('spent with no usable reset time is exceeded', () => {
    expect(grade(5000, 0, '')).toBe('exceeded');
    expect(grade(5000, 0, 'not a date')).toBe('exceeded');
  });

  test('the clock decides, so the same reading flips at the reset', () => {
    const rl = { limit: 5000, remaining: 0, resetsAt: future };
    expect(rateLimitSeverity(rl, Date.parse(future) - 1)).toBe('exceeded');
    expect(rateLimitSeverity(rl, Date.parse(future))).toBe('low');
  });

  test('a zero limit with requests left is ok, not a division by zero', () => {
    expect(grade(0, 3, future)).toBe('ok');
  });
});

describe('isRateLimited', () => {
  test('is true only for a spent budget ahead of its reset', () => {
    const spent = { limit: 5000, remaining: 0, resetsAt: future };
    expect(isRateLimited(spent, now)).toBe(true);
    expect(isRateLimited({ ...spent, remaining: 10 }, now)).toBe(false);
    expect(isRateLimited(spent, Date.parse(future) + 1)).toBe(false);
    expect(isRateLimited(undefined, now)).toBe(false);
  });
});

describe('isRunningLow', () => {
  test('is true for a low budget with something left', () => {
    expect(
      isRunningLow({ limit: 5000, remaining: 100, resetsAt: future }, now),
    ).toBe(true);
  });

  test('is false for a spent budget, even one past its reset', () => {
    expect(
      isRunningLow({ limit: 5000, remaining: 0, resetsAt: past }, now),
    ).toBe(false);
    expect(
      isRunningLow({ limit: 5000, remaining: 0, resetsAt: future }, now),
    ).toBe(false);
  });

  test('is false for a warning', () => {
    expect(
      isRunningLow({ limit: 5000, remaining: 500, resetsAt: future }, now),
    ).toBe(false);
  });
});

describe('showsOnOverview', () => {
  const at = (remaining: number) => ({
    limit: 5000,
    remaining,
    resetsAt: future,
  });

  test('a budget with 20% or more left stays off the overview', () => {
    expect(showsOnOverview(at(5000), now)).toBe(false);
    expect(showsOnOverview(at(1000), now)).toBe(false);
  });

  test('under 20% left it shows, and so does a spent one', () => {
    expect(showsOnOverview(at(999), now)).toBe(true);
    expect(showsOnOverview(at(100), now)).toBe(true);
    expect(showsOnOverview(at(0), now)).toBe(true);
  });
});

describe('rateLimitWhy', () => {
  afterEach(resetForgeCapabilities);

  test('a forge with its own request budget says so and links to its rules', () => {
    const why = rateLimitWhy('github', 'GitHub');

    expect(why.text).toContain('gives each token a request budget');
    expect(why.docsUrl).toContain('docs.github.com');
  });

  test('a forge behind a proxy blames the proxy and links nowhere', () => {
    const why = rateLimitWhy('forgejo', 'Forgejo');

    expect(why.text).toContain('a proxy in front of it does');
    expect(why.docsUrl).toBeNull();
  });

  test('a third forge follows its rate limit model, not its name', () => {
    registerForgeCapabilities([
      { forge: 'gitea', capabilities: { rateLimitModel: 'graphql_and_rest' } },
      { forge: 'plain', capabilities: { rateLimitModel: 'rest' } },
    ]);

    expect(rateLimitWhy('gitea', 'Gitea').text).toContain(
      'gives each token a request budget',
    );
    expect(rateLimitWhy('plain', 'Plain').docsUrl).toBeNull();
  });

  test('a forge nobody described gets the proxy wording', () => {
    expect(rateLimitWhy('nowhere', 'Nowhere').docsUrl).toBeNull();
  });
});
