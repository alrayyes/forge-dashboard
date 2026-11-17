/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { registerForgeCapabilities, resetForgeCapabilities } from './forges';
import {
  DEFAULT_WEBHOOKS_FILTER,
  webhooksFilterFromState,
  webhooksFilterToState,
} from './webhooks-filter';

describe('the Webhooks filter in the saved state', () => {
  test('nothing saved reads as the defaults', () => {
    expect(webhooksFilterFromState(undefined)).toEqual(DEFAULT_WEBHOOKS_FILTER);
    expect(webhooksFilterFromState({})).toEqual(DEFAULT_WEBHOOKS_FILTER);
  });

  test('a filter round-trips', () => {
    const filter = {
      forge: 'forgejo',
      repo: 'infra',
      status: 'pending',
      sort: 'hasWebhook',
      dir: 'desc',
    } as const;
    expect(webhooksFilterFromState(webhooksFilterToState(filter))).toEqual(
      filter,
    );
  });

  test('values the page does not know read as the defaults', () => {
    expect(
      webhooksFilterFromState({
        forge: 'gitlab',
        status: 'maybe',
        sort: 'colour',
        dir: 'sideways',
        repo: 'ok',
      }),
    ).toEqual({ ...DEFAULT_WEBHOOKS_FILTER, repo: 'ok' });
  });

  test('a repo search that is not a string, or is very long, is bounded', () => {
    expect(webhooksFilterFromState({ repo: 5 as unknown as string }).repo).toBe(
      '',
    );
    expect(
      webhooksFilterFromState({ repo: 'x'.repeat(500) }).repo,
    ).toHaveLength(200);
  });
});

describe("the Webhooks filter and the server's forges", () => {
  afterEach(resetForgeCapabilities);

  test('a forge the server reported is a valid saved filter', () => {
    registerForgeCapabilities([{ forge: 'gitea' }]);

    expect(webhooksFilterFromState({ forge: 'gitea' }).forge).toBe('gitea');
  });
});
