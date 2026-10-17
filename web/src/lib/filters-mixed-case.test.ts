/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { populateChoices, populateSelect } from './filters';

// A saved author or label is lowercase (the filter compares lowercase), but
// the page offers it as written. Rebuilding the select must keep the pick, or
// "Ryan" is cleared the moment it is picked (#1620, cause 5).
// https://github.com/alrayyes/forge-dashboard/issues/1620

// Just enough DOM for populateChoices: a select whose first option is the
// fixed "All ..." entry.
interface FakeOption {
  value: string;
  textContent: string;
}
function fakeSelect() {
  const options: FakeOption[] = [{ value: '', textContent: 'All' }];
  const select = {
    options,
    value: '',
    remove(i: number) {
      options.splice(i, 1);
    },
    appendChild(o: FakeOption) {
      options.push(o);
    },
  };
  return select as unknown as HTMLSelectElement & { options: FakeOption[] };
}

const realDocument = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({ value: '', textContent: '' }),
  };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

describe('populateSelect with a saved lowercase pick', () => {
  test('keeps a pick whose option has capitals, showing the original text', () => {
    const select = fakeSelect();
    const stale = populateSelect(select, ['Ryan', 'bob'], 'ryan');
    expect(stale).toBe(false);
    expect(select.value).toBe('Ryan');
    expect(select.options.map((o) => o.textContent)).toEqual([
      'All',
      'Ryan',
      'bob',
    ]);
  });

  test('keeps a mixed-case label', () => {
    const select = fakeSelect();
    expect(populateSelect(select, ['Bug', 'docs'], 'bug')).toBe(false);
    expect(select.value).toBe('Bug');
  });

  test('still clears a pick nothing offers', () => {
    const select = fakeSelect();
    expect(populateSelect(select, ['Ryan'], 'carol')).toBe(true);
    expect(select.value).toBe('');
  });
});

describe('populateChoices', () => {
  test('matches case-insensitively and keeps the option value as offered', () => {
    const select = fakeSelect();
    expect(
      populateChoices(select, [{ value: 'Bug', label: 'Bug' }], 'bug'),
    ).toBe(false);
    expect(select.value).toBe('Bug');
  });
});

describe('populateChoices with no pick', () => {
  test('treats an undefined pick as none', () => {
    const select = fakeSelect();
    const none = undefined as unknown as string;
    expect(populateSelect(select, ['Ryan'], none)).toBe(false);
    expect(select.value).toBe('');
  });
});
