/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { effectiveForge, failingFilters, filtersAreDefault } from './filters';

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

// The same rule for the other readers of the pick (#4171).
test('effectiveForge reads an unoffered pick as All', () => {
  expect(effectiveForge('gitea')).toBe('');
  expect(effectiveForge('')).toBe('');
  expect(effectiveForge('forgejo')).toBe('forgejo');
});

test('an unoffered forge pick does not enable Clear filters', () => {
  const page = {
    pullsView: true,
    settingsHideDependencyDashboard: false,
    settingsIgnoreTitles: false,
  };
  const state = (forge: string) => ({
    shared: { forge },
    pr: {},
    issue: { hideDependencyDashboard: '1' },
    view: {},
  });
  expect(filtersAreDefault(state('gitea'), page)).toBe(true);
  expect(filtersAreDefault(state('forgejo'), page)).toBe(false);
});
