/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { announceChange, checkKeys, keepOrder } from './pipeline-live';

describe('keepOrder', () => {
  const c = (name: string, state: string) => ({ name, state, url: '' });

  test('keeps the order checks already have, whatever the new order says', () => {
    const prev = [c('lint', 'running'), c('test', 'running')];
    const next = [c('test', 'failure'), c('lint', 'success')];
    expect(keepOrder(prev, next).map((x) => x.name)).toEqual(['lint', 'test']);
  });

  test('puts a new check last', () => {
    const prev = [c('lint', 'running')];
    const next = [c('new', 'queued'), c('lint', 'success')];
    expect(keepOrder(prev, next).map((x) => x.name)).toEqual(['lint', 'new']);
  });

  test('drops a check that is gone', () => {
    const prev = [c('a', 'running'), c('b', 'running')];
    expect(keepOrder(prev, [c('b', 'success')]).map((x) => x.name)).toEqual([
      'b',
    ]);
  });

  test('keeps two checks with the same name apart', () => {
    const prev = [c('job', 'running'), c('job', 'success')];
    const next = [c('job', 'failure'), c('job', 'success')];
    expect(keepOrder(prev, next).map((x) => x.state)).toEqual([
      'failure',
      'success',
    ]);
  });
});

describe('announceChange', () => {
  const c = (name: string, state: string) => ({ name, state, url: '' });

  test('says nothing when no check changed state', () => {
    expect(announceChange([c('a', 'running')], [c('a', 'running')])).toBe('');
  });

  test('names a single change', () => {
    expect(announceChange([c('a', 'running')], [c('a', 'success')])).toBe(
      'Checks updated: a is now Passed.',
    );
  });

  test('counts several changes', () => {
    expect(
      announceChange(
        [c('a', 'running'), c('b', 'running'), c('c', 'running')],
        [c('a', 'success'), c('b', 'failure'), c('c', 'running')],
      ),
    ).toBe('Checks updated: 2 checks changed.');
  });
});

describe('checkKeys', () => {
  const c = (name: string) => ({ name, state: 'running', url: '' });

  test('is the name for a name that stands alone', () => {
    expect(checkKeys([c('build'), c('test')])).toEqual(['build', 'test']);
  });

  test('counts the nth check of a shared name', () => {
    expect(checkKeys([c('job'), c('x'), c('job')])).toEqual([
      'job',
      'x',
      'job#2',
    ]);
  });

  test('does not depend on where in the list a check stands', () => {
    expect(checkKeys([c('x'), c('job')])[1]).toBe(checkKeys([c('job')])[0]);
  });
});
