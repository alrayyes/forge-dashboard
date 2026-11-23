/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { webhookNote } from './webhook-reason';

const at = (iso: string) => `at ${iso}`;

describe('the note on a row that has no webhook', () => {
  test('a repo with no reason has none', () => {
    expect(webhookNote({}, at)).toBeNull();
  });

  test('a repo the token cannot administer is left to the existing lock text', () => {
    expect(webhookNote({ webhookReason: 'no_permission' }, at)).toBeNull();
  });

  test('an unreachable or rate limited forge says it will be tried again', () => {
    const note = webhookNote({ webhookReason: 'forge_unavailable' }, at);

    expect(note?.line).toBe(
      "The forge didn't answer. The dashboard will try again.",
    );
    expect(note?.detail).toContain('rate limited or unreachable');
  });

  test('a refusal gives the next attempt time and the forge reason on hover', () => {
    const note = webhookNote(
      {
        webhookReason: 'forge_refused',
        webhookReasonDetail: 'Resource not accessible by integration',
        webhookNextAttemptAt: '2026-11-23T13:00:00Z',
      },
      at,
    );

    expect(note?.line).toBe(
      'The forge refused to create it. Next try at 2026-11-23T13:00:00Z.',
    );
    expect(note?.detail).toBe(
      'The forge said: Resource not accessible by integration',
    );
  });

  test('a refusal with no time still says it will try again', () => {
    const note = webhookNote({ webhookReason: 'forge_refused' }, at);

    expect(note?.line).toBe(
      'The forge refused to create it. The dashboard will try again.',
    );
  });

  test('a reason a newer server invents shows nothing', () => {
    expect(webhookNote({ webhookReason: 'something_new' }, at)).toBeNull();
  });
});
