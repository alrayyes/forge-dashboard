import { describe, expect, test } from 'bun:test';
import {
  EARLIER_DATA_BANNER_LINE,
  earlierDataNotice,
  earlierForges,
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

describe('earlierForges', () => {
  const marked = { forge: 'github', status: { code: 'forge_unreachable' } };
  const down = { forge: 'github', reachable: false };
  const up = { forge: 'github', reachable: true };

  test('names a forge once while it does not answer', () => {
    expect(earlierForges([marked, marked], [down])).toEqual(['github']);
    expect(
      earlierForges(
        [marked],
        [{ forge: 'github', reachable: true, starting: true }],
      ),
    ).toEqual(['github']);
  });

  test('names none once the forge answers, whatever the held rows say', () => {
    expect(earlierForges([marked], [up])).toEqual([]);
    expect(earlierForges([marked], [])).toEqual([]);
  });

  test('names none while another host of the kind answers', () => {
    expect(earlierForges([marked], [down, up])).toEqual([]);
  });

  test('names none for rows without the status', () => {
    expect(earlierForges([{ forge: 'github' }], [down])).toEqual([]);
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

  test('is short beside a banner that already carries the sentence', () => {
    const notice = earlierDataNotice(
      [{ label: 'Forgejo', staleSince: '2026-01-01T10:00:00Z' }],
      ago,
      true,
    );
    expect(text(notice)).toBe(
      "Forgejo isn't answering yet either, and its rows are from 10m ago.",
    );
    expect(text(earlierDataNotice([{ label: 'Forgejo' }], ago, true))).toBe(
      "Forgejo isn't answering yet either.",
    );
  });

  test("the banner's line does not repeat the forge or the age", () => {
    expect(EARLIER_DATA_BANNER_LINE).toBe(
      'Rows marked Earlier data may be an earlier answer, and no action can run on them while this lasts.',
    );
  });
});
