/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createNoteRenderer, withoutHeading } from './changelog-notes';

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
    const notes = '## 1.0.0\n```md\n## not a heading\n```\n## 0.9.0\ntext';
    expect(withoutHeading(notes)).toBe('```md\n## not a heading\n```\ntext');
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
});
