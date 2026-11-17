/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { failingFilters } from './filters';

// A saved forge pick no pill offers reads as All, so it must not filter
// (#4167).
const item = {
  forge: 'github',
  repo: 'a/b',
  title: 't',
  author: 'x',
  labels: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as unknown as Parameters<typeof failingFilters>[0];

test('a forge pick no pill offers does not hide a row', () => {
  expect(failingFilters(item, true, { forge: 'gitea' }, undefined)).toEqual([]);
});

test('a forge pick a pill offers still hides other forges', () => {
  expect(failingFilters(item, true, { forge: 'forgejo' }, undefined)).toEqual([
    'forge',
  ]);
});
