/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  copyLinesLabel,
  groupJsonBlocks,
  lineCopyText,
  lineNumberText,
  parseLogLines,
} from './run-log';

const group = (text: string) => groupJsonBlocks(parseLogLines(text));

describe('groupJsonBlocks', () => {
  test('joins consecutive lines that are one JSON value into one entry', () => {
    const lines = group(
      [
        'before',
        '2026-11-13T10:00:01.000Z {',
        '2026-11-13T10:00:01.001Z   "result": "success",',
        '2026-11-13T10:00:01.002Z   "needs": [1, 2]',
        '2026-11-13T10:00:01.003Z }',
        'after',
      ].join('\n'),
    );
    expect(lines).toHaveLength(3);
    const block = lines[1];
    expect(block.text).toBe('{\n  "result": "success",\n  "needs": [1, 2]\n}');
    expect(block.time).toBe('10:00:01.000');
    expect(block.from).toBe(2);
    expect(block.to).toBe(5);
    expect(block.json).toBe('{"result":"success","needs":[1,2]}');
  });

  test('gives every entry the number of its first and last raw line', () => {
    const lines = group('a\n{\n  "x": 1\n}\nb');
    expect(lines.map((l) => [l.from, l.to])).toEqual([
      [1, 1],
      [2, 4],
      [5, 5],
    ]);
  });

  test('groups an array and nested values', () => {
    const [arr, obj] = group('[\n  {"a": [1]},\n  2\n]\n{\n"a": {"b": {}}\n}');
    expect(arr.json).toBe('[{"a":[1]},2]');
    expect(arr.to).toBe(4);
    expect(obj.json).toBe('{"a":{"b":{}}}');
  });

  test('leaves text that looks like JSON but does not parse', () => {
    const lines = group('{\n  "a": 1,\n}');
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => !l.json)).toBe(true);
  });

  test('leaves unbalanced braces alone', () => {
    const lines = group('{\n  "a": {\n    "b": 1\n}\nmore text');
    expect(lines).toHaveLength(5);
    expect(lines.every((l) => !l.json)).toBe(true);
  });

  test('a brace inside a string does not end or open a value', () => {
    const [block] = group('{\n  "a": "}{ \\" ]",\n  "b": "["\n}');
    expect(block.json).toBe('{"a":"}{ \\" ]","b":"["}');
    expect(block.to).toBe(4);
  });

  test('leaves a value that is already on one line', () => {
    const [line] = group('{"a": 1}');
    expect(line.json).toBeUndefined();
    expect(line.text).toBe('{"a": 1}');
  });

  test('leaves an indented opening brace, which is not at the line start', () => {
    const lines = group('  {\n    "a": 1\n  }');
    expect(lines).toHaveLength(3);
  });

  test('does not swallow a flagged line inside the span', () => {
    const lines = group('{\n##[error]boom\n}');
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => !l.json)).toBe(true);
  });

  test('leaves a value longer than the limit', () => {
    const body = Array.from({ length: 600 }, (_, i) => `  "k${i}": ${i},`);
    const lines = group(['{', ...body, '  "end": 0', '}'].join('\n'));
    expect(lines.some((l) => l.json)).toBe(false);
    expect(lines).toHaveLength(603);
  });

  test('copying an entry gives its indented text', () => {
    const [block] = group('{\n  "a": 1\n}');
    expect(lineCopyText(block)).toBe('{\n  "a": 1\n}');
  });
});

describe('line number labels', () => {
  test('a range reads as one label and a single line as before', () => {
    expect(lineNumberText({ from: 299, to: 305 })).toBe('299-305');
    expect(lineNumberText({ from: 4, to: 4 })).toBe('4');
    expect(copyLinesLabel(299, 305)).toBe('Copy lines 299-305');
    expect(copyLinesLabel(4, 4)).toBe('Copy line 4');
  });
});
