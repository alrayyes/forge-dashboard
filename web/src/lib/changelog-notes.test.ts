/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  createNoteRenderer,
  createPlainNotes,
  withoutHeading,
} from './changelog-notes';

const release = (version: string) => ({
  version,
  notes: `## ${version}\n* note ${version}`,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('withoutHeading', () => {
  test('drops the release heading line and keeps the rest', () => {
    expect(
      withoutHeading('## [1.0.0](x) (2026-01-01)\n### Features\n* a'),
    ).toBe('### Features\n* a');
  });

  test('treats missing notes as empty', () => {
    expect(withoutHeading(null)).toBe('');
  });

  test('keeps a "## " line inside a fenced code block', () => {
    const notes = '## 1.0.0\n```md\n## not a heading\n```\ntext';
    expect(withoutHeading(notes)).toBe('```md\n## not a heading\n```\ntext');
  });

  test('a fence closes only on a fence at least as long as the opener', () => {
    const notes = '## 1.0.0\n````md\n```\n## inside\n````\ntext';
    expect(withoutHeading(notes)).toBe('````md\n```\n## inside\n````\ntext');
  });

  test('a fence with text after it does not close the block', () => {
    const notes = '## 1.0.0\n```\n``` not a close\n## inside\n```\ntext';
    expect(withoutHeading(notes)).toBe(
      '```\n``` not a close\n## inside\n```\ntext',
    );
  });

  test('drops only the leading heading, not a "## " line in prose', () => {
    const notes = '## 1.0.0\n\nintro\n## later heading\n* a';
    expect(withoutHeading(notes)).toBe('\nintro\n## later heading\n* a');
  });
});

describe('createPlainNotes', () => {
  test('strips the heading once per release however often it is asked', () => {
    const calls: string[] = [];
    const plain = createPlainNotes((body) => {
      calls.push(body);
      return body.toUpperCase();
    });
    const a = { version: '1.0.0', notes: 'a' };
    const b = { version: '0.9.0', notes: 'b' };
    expect([plain(a), plain(b), plain(a), plain(b)]).toEqual([
      'A',
      'B',
      'A',
      'B',
    ]);
    expect(calls).toEqual(['a', 'b']);
  });
});

describe('createNoteRenderer', () => {
  test('renders each of 20 releases exactly once, however often it is asked', async () => {
    const calls: string[] = [];
    const results: Record<string, string | null> = {};
    const request = createNoteRenderer(
      async (text) => {
        calls.push(text);
        return `<p>${text}</p>`;
      },
      (version, html) => {
        results[version] = html;
      },
    );
    const releases = Array.from({ length: 20 }, (_, i) => release(`1.0.${i}`));
    request(releases);
    // Each release that resolves makes the page ask again.
    for (let i = 0; i < 20; i++) {
      await flush();
      request(releases);
    }
    await flush();
    expect(calls).toHaveLength(20);
    expect(Object.keys(results)).toHaveLength(20);
  });

  test('only renders releases it has not seen when more are revealed', async () => {
    const calls: string[] = [];
    const request = createNoteRenderer(
      async (text) => {
        calls.push(text);
        return text;
      },
      () => {},
    );
    request([release('1.0.0')]);
    await flush();
    request([release('1.0.0'), release('0.9.0')]);
    await flush();
    expect(calls).toEqual(['* note 1.0.0', '* note 0.9.0']);
  });

  test('reports a failed render and tries it again on the next ask', async () => {
    const got: (string | null)[] = [];
    let fail = true as boolean;
    const request = createNoteRenderer(
      async () => {
        if (fail) throw new Error('chunk failed');
        return '<p>ok</p>';
      },
      (_version, html) => {
        got.push(html);
      },
    );
    request([release('1.0.0')]);
    await flush();
    expect(got).toEqual([null]);
    fail = false;
    request([release('1.0.0')]);
    await flush();
    expect(got).toEqual([null, '<p>ok</p>']);
  });

  test('a failed render is asked again after the retry delay, without a new ask', async () => {
    const got: (string | null)[] = [];
    let attempts = 0;
    const request = createNoteRenderer(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error('chunk failed');
        return '<p>ok</p>';
      },
      (_version, html) => {
        got.push(html);
      },
      5,
    );
    request([release('1.0.0')]);
    await flush();
    expect(got).toEqual([null]);
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual([null, '<p>ok</p>']);
    expect(attempts).toBe(2);
    request.stop();
  });

  test('stop() cancels a pending retry', async () => {
    let attempts = 0;
    const request = createNoteRenderer(
      async () => {
        attempts++;
        throw new Error('chunk failed');
      },
      () => {},
      5,
    );
    request([release('1.0.0')]);
    await flush();
    request.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(attempts).toBe(1);
  });
});
