/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { FilterableItem } from './filters';
import { choicesChange, offerAction, shownList } from './shown-list';

function item(over: Record<string, unknown> = {}): FilterableItem {
  return {
    forge: 'github',
    repo: 'a/b',
    author: 'ann',
    title: 'Fix it',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    labels: [],
    ...over,
  } as unknown as FilterableItem;
}

describe('shownList', () => {
  test('starts empty and not landed', () => {
    const list = shownList<FilterableItem>();
    expect(list.items).toEqual([]);
    expect(list.landed).toBe(false);
  });

  test('landing an empty list still marks it landed', () => {
    const list = shownList<FilterableItem>();
    list.land([]);
    expect(list.landed).toBe(true);
  });

  test('land replaces the items', () => {
    const list = shownList<FilterableItem>();
    const a = [item()];
    list.land(a);
    expect(list.items).toBe(a);
  });
});

describe('choicesChange', () => {
  test('identical lists change nothing', () => {
    expect(choicesChange([item()], [item()])).toBe('none');
  });

  test('order alone changes nothing', () => {
    const a = item({ title: 'a' });
    const b = item({ title: 'b' });
    expect(choicesChange([a, b], [b, a])).toBe('none');
  });

  test('a title-only change reports titles', () => {
    expect(choicesChange([item()], [item({ title: 'Other' })])).toBe('titles');
  });

  test('any other field reports all', () => {
    expect(choicesChange([item()], [item({ author: 'bob' })])).toBe('all');
    expect(choicesChange([item()], [item({ labels: [{ name: 'x' }] })])).toBe(
      'all',
    );
  });

  test('a title with a pipe or newline never collides with another set', () => {
    const two = [item({ title: 'a' }), item({ title: 'b' })];
    expect(choicesChange([item({ title: 'a|b' })], two)).not.toBe('none');
    expect(choicesChange([item({ title: 'a\nb' })], two)).not.toBe('none');
    expect(
      choicesChange(
        [item({ author: 'ann|x', title: 'y' })],
        [item({ author: 'ann', title: 'x|y' })],
      ),
    ).not.toBe('none');
  });
});
