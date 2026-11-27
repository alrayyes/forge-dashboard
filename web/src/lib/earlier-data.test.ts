import { describe, expect, test } from 'bun:test';
import {
  EARLIER_DATA_BANNER_LINE,
  earlierDataNotice,
  isEarlierData,
} from './earlier-data';

const ago = () => '10m ago';
const text = (n: ReturnType<typeof earlierDataNotice>) =>
  `${n.before}${n.age?.text ?? ''}${n.after}`;

describe('isEarlierData', () => {
  test('is the status the server gives a carried-over row', () => {
    expect(isEarlierData({ code: 'forge_unreachable' })).toBe(true);
  });

  test('is not a row-specific status, or none', () => {
    expect(isEarlierData({ code: 'held' })).toBe(false);
    expect(isEarlierData(undefined)).toBe(false);
  });
});

describe('earlierDataNotice', () => {
  test('names the forge and how old the answer is', () => {
    const notice = earlierDataNotice(
      [{ label: 'GitHub', staleSince: '2026-01-01T10:00:00Z' }],
      ago,
    );
    expect(text(notice)).toBe(
      "GitHub isn't answering yet, so rows marked Earlier data may be an earlier answer from 10m ago, and no action can run on them until it does.",
    );
    expect(notice.age?.since).toBe('2026-01-01T10:00:00Z');
  });

  test('leaves the age out when it is not known', () => {
    const notice = earlierDataNotice([{ label: 'Forgejo' }], ago);
    expect(text(notice)).toBe(
      "Forgejo isn't answering yet, so rows marked Earlier data may be an earlier answer, and no action can run on them until it does.",
    );
    expect(notice.age).toBeUndefined();
  });

  test('names two forges once, with the oldest age', () => {
    const notice = earlierDataNotice(
      [
        { label: 'GitHub', staleSince: '2026-01-01T10:00:00Z' },
        { label: 'Forgejo', staleSince: '2026-01-01T09:00:00Z' },
      ],
      ago,
    );
    expect(text(notice)).toStartWith(
      "GitHub and Forgejo aren't answering yet, so",
    );
    expect(text(notice)).toEndWith('until they do.');
    expect(notice.age?.since).toBe('2026-01-01T09:00:00Z');
  });

  test("the banner's line does not repeat the forge or the age", () => {
    expect(EARLIER_DATA_BANNER_LINE).toBe(
      'Rows marked Earlier data may be an earlier answer, and no action can run on them while this lasts.',
    );
  });
});
