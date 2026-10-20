/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { renderMarkdown } from './markdown';

// https://github.com/alrayyes/forge-dashboard/issues/1655
// GFM task list items: https://github.github.com/gfm/#task-list-items-extension-
describe('task list items', () => {
  test('render as read-only checkboxes named by their text', async () => {
    const html = await renderMarkdown('- [x] done\n- [ ] open\n');
    expect(html).toContain(
      '<li class="task-list-item"><label class="task"><input type="checkbox" disabled checked> done</label></li>',
    );
    expect(html).toContain(
      '<li class="task-list-item"><label class="task"><input type="checkbox" disabled> open</label></li>',
    );
    expect(html).not.toContain('[x]');
    expect(html).not.toContain('[ ]');
  });

  test('also work in a loose list and accept an uppercase X', async () => {
    const html = await renderMarkdown('- [X] one\n\n- [ ] two\n');
    expect(html.match(/<input /g)).toHaveLength(2);
    expect(html).toContain('checked');
  });

  test('keep the item text escaped and links intact', async () => {
    const html = await renderMarkdown(
      '- [x] <b>bold</b> see [docs](https://example.org/d)\n',
    );
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('href="https://example.org/d"');
  });

  test('leave [x] in code, link labels and mid-sentence untouched', async () => {
    for (const src of [
      '- `[x]` code\n',
      '- [[x]](https://example.org) label\n',
      '- tick [x] here\n',
      'plain [x] paragraph\n',
      '[x] not a list\n',
      '- [x]no space\n',
      '- [x]\n',
    ]) {
      const html = await renderMarkdown(src);
      expect(html).not.toContain('<input');
      expect(html).toContain('[x]');
    }
  });
});

// https://github.com/alrayyes/forge-dashboard/issues/1995
// GitHub turns :name: into an emoji:
// https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#using-emojis
describe('emoji shortcodes', () => {
  test('render as Unicode characters', async () => {
    const html = await renderMarkdown(
      ':robot: :tada: :bug: :warning: :white_check_mark:',
    );
    expect(html).toContain('🤖');
    expect(html).toContain('🎉');
    expect(html).toContain('🐛');
    expect(html).toContain('⚠');
    expect(html).toContain('✅');
    expect(html).not.toContain(':robot:');
  });

  test('draw the release pull request opening line', async () => {
    const html = await renderMarkdown(
      ':robot: I have created a release *beep* *boop*',
    );
    expect(html).toContain('🤖 I have created a release');
    expect(html).toContain('<em>beep</em>');
  });

  test('leave unknown codes and clock times as written', async () => {
    for (const src of [':not_an_emoji:', 'at 10:30:45 today', 'a:zzzz:c']) {
      const html = await renderMarkdown(src);
      expect(html).toContain(src);
    }
  });

  test('leave codes in code spans and code blocks alone', async () => {
    const span = await renderMarkdown('use `:robot:` here');
    expect(span).toContain('<code>:robot:</code>');
    const block = await renderMarkdown('```\n:robot:\n```');
    expect(block).toContain(':robot:');
    expect(block).not.toContain('🤖');
  });

  test('output Unicode only, never an image', async () => {
    const html = await renderMarkdown(':robot: :tada:');
    expect(html).not.toContain('<img');
  });

  test('leave emoticons as typed', async () => {
    for (const src of [':) hello', 'ok :-( maybe', 'what :P ever']) {
      const html = await renderMarkdown(src);
      expect(html).toContain(src.split(' ')[0]);
      expect(html).not.toMatch(/😃|😊|😞|😛|🙂|😦/u);
    }
  });
});
