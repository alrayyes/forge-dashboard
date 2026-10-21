/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { renderMarkdown } from './markdown';
import { repoUrlOf } from './repo-url';

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

// Ticket and pull request references in running text become links to the
// item on the same forge, the way GitHub autolinks them:
// https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls
describe('ticket references', () => {
  const repoUrl = 'https://github.com/alrayyes/forge-dashboard';

  test('link #N to the item in the same repository', async () => {
    const html = await renderMarkdown('Closes #1859 today', { repoUrl });
    expect(html).toContain(
      'Closes <a href="https://github.com/alrayyes/forge-dashboard/issues/1859" target="_blank" rel="noopener noreferrer">#1859</a> today',
    );
  });

  test('link owner/repo#N against the same forge host', async () => {
    const html = await renderMarkdown('See other/repo#12.', { repoUrl });
    expect(html).toContain(
      '<a href="https://github.com/other/repo/issues/12" target="_blank" rel="noopener noreferrer">other/repo#12</a>.',
    );
  });

  test('build Forgejo links from the Forgejo host', async () => {
    const html = await renderMarkdown('Fixes #7', {
      repoUrl: 'https://git.example.org/me/app',
    });
    expect(html).toContain('href="https://git.example.org/me/app/issues/7"');
  });

  test('leave references as text without a repository address', async () => {
    const html = await renderMarkdown('Closes #1859');
    expect(html).toBe('<p>Closes #1859</p>\n');
  });

  test('leave code, words, fragments and existing links alone', async () => {
    for (const src of [
      'use `#123` here',
      '```\n#123\n```',
      'abc#12 and abc/def/ghi#12',
      'a [fragment](#12) and https://example.org/page#12',
      '[Closes #12](https://example.org/x)',
      '&#123;',
    ]) {
      const html = await renderMarkdown(src, { repoUrl });
      expect(html).not.toContain(`${repoUrl}/issues/`);
      expect(html).not.toContain('/issues/12"');
    }
  });

  test('read owner/repo#N as a repository, but not a fraction or a mention', async () => {
    const link = await renderMarkdown('see and/or#3', { repoUrl });
    expect(link).toContain('href="https://github.com/and/or/issues/3"');
    for (const src of ['1/2#3', '@user/team#5']) {
      const html = await renderMarkdown(src, { repoUrl });
      expect(html).not.toContain('<a ');
    }
  });

  test('link a Forgejo owner with an underscore or a dot', async () => {
    for (const [src, owner] of [
      ['see my_org/repo#3', 'my_org/repo'],
      ['see a.b/repo#3', 'a.b/repo'],
    ]) {
      const html = await renderMarkdown(src, { repoUrl });
      expect(html).toContain(`href="https://github.com/${owner}/issues/3"`);
    }
  });

  test('leave a reference that continues into a word as text', async () => {
    const html = await renderMarkdown('#12abc', { repoUrl });
    expect(html).not.toContain('<a ');
  });
});

describe('repoUrlOf', () => {
  test('strips the item part of a GitHub or Forgejo address', () => {
    expect(repoUrlOf('https://github.com/o/r/pull/12')).toBe(
      'https://github.com/o/r',
    );
    expect(repoUrlOf('https://github.com/o/r/issues/12')).toBe(
      'https://github.com/o/r',
    );
    expect(repoUrlOf('https://git.example.org/o/r/pulls/3')).toBe(
      'https://git.example.org/o/r',
    );
  });

  test('refuses anything that is not an http(s) item address', () => {
    for (const bad of ['', 'javascript:alert(1)', 'https://x.org/o/r', 'x']) {
      expect(repoUrlOf(bad)).toBeNull();
    }
  });
});

// The changelog page marks a link whose label is a pull request number or a
// commit hash, so digits line up and a hash reads as one.
describe('reference links', () => {
  test('get the mono class only when asked, and only by their label', async () => {
    const src =
      '* **web:** fix ([#12](https://example.org/12)) ([6bf88c3](https://example.org/c)) see [docs](https://example.org/d)\n';
    const plain = await renderMarkdown(src);
    expect(plain).not.toContain('class="mono"');

    const html = await renderMarkdown(src, { monoReferences: true });
    expect(html).toContain('<strong>web:</strong>');
    expect(html).toContain('<a href="https://example.org/12" class="mono"');
    expect(html).toContain('<a href="https://example.org/c" class="mono"');
    expect(html).not.toContain('<a href="https://example.org/d" class="mono"');
  });
});
