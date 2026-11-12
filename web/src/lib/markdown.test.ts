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

// https://github.com/alrayyes/forge-dashboard/issues/3668
// An HTML comment is the author's bookkeeping, not text: the forges hide it.
describe('HTML comments', () => {
  test('a comment before text is hidden and the text stays', async () => {
    const html = await renderMarkdown(
      '<!-- rebase-check -->If you want to rebase/retry this PR, check this box\n',
    );
    expect(html).toContain(
      'If you want to rebase/retry this PR, check this box',
    );
    expect(html).not.toContain('rebase-check');
    expect(html).not.toContain('&lt;!--');
  });

  test('a long trailing comment leaves nothing behind', async () => {
    const debug = `<!--renovate-debug:${'eyJjcmVhdGVkSW5WZXIiOiIxIn0='.repeat(8)}-->`;
    const html = await renderMarkdown(`Body text.\n\n${debug}\n`);
    expect(html).toBe('<p>Body text.</p>\n');
  });

  test('a multi-line comment is hidden, inline or as its own block', async () => {
    const inline = await renderMarkdown('before <!-- one\ntwo --> after\n');
    expect(inline).toContain('before');
    expect(inline).toContain('after');
    expect(inline).not.toContain('one');
    expect(inline).not.toContain('two');
    const block = await renderMarkdown(
      'first\n\n<!--\nhidden\n\nstill hidden\n-->\n\nlast\n',
    );
    expect(block).toBe('<p>first</p>\n<p>last</p>\n');
  });

  test('a comment alone on a line draws no empty paragraph', async () => {
    expect(await renderMarkdown('<!-- note -->\n')).toBe('');
  });

  test('comment-looking text in a code span or fenced block stays', async () => {
    const span = await renderMarkdown('use `<!-- keep -->` to hide\n');
    expect(span).toContain('<code>&lt;!-- keep --&gt;</code>');
    const fence = await renderMarkdown('```html\n<!-- keep -->\n```\n');
    expect(fence).toContain('&lt;!-- keep --&gt;');
    const indented = await renderMarkdown('    <!-- keep -->\n');
    expect(indented).toContain('&lt;!-- keep --&gt;');
  });

  test('a comment between list items leaves both items', async () => {
    const html = await renderMarkdown('- one\n<!-- gap -->\n- two\n');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).not.toContain('gap');
    const loose = await renderMarkdown('- one\n\n<!-- gap -->\n\n- two\n');
    expect(loose).toContain('one');
    expect(loose).toContain('two');
    expect(loose).not.toContain('gap');
  });

  test('a comment next to a task checkbox keeps the checkbox and its text', async () => {
    const html = await renderMarkdown(
      '- [ ] <!-- rebase-check -->If you want to rebase, check this box\n',
    );
    expect(html).toContain(
      '<label class="task"><input type="checkbox" disabled> If you want to rebase, check this box</label>',
    );
    expect(html).not.toContain('rebase-check');
  });

  test('comments on consecutive lines draw no empty paragraph', async () => {
    expect(await renderMarkdown('<!-- a -->\n<!-- b -->\n')).toBe('');
    expect(await renderMarkdown('<!-- a -->  \n<!-- b -->\n')).toBe('');
  });

  test('a heading that held only a comment is dropped, other headings stay', async () => {
    expect(await renderMarkdown('# <!-- x -->\n')).toBe('');
    expect(await renderMarkdown('# Title <!-- x -->\n')).toContain('Title');
  });

  test('<!--> and <!---> are empty comments, and what follows is text', async () => {
    const html = await renderMarkdown('<!-->\nfoo\n-->x\n');
    expect(html).toContain('foo');
    expect(html).not.toContain('&lt;!--');
    const dash = await renderMarkdown('a <!---> b\n');
    expect(dash).toBe('<p>a  b</p>\n');
  });

  test('text after --> on the closing line of a multi-line comment stays', async () => {
    const html = await renderMarkdown('<!--\nhidden\n-->tail\n');
    expect(html).toContain('tail');
    expect(html).not.toContain('hidden');
  });

  test('a block comment never swallows the lines of the next list item', async () => {
    const html = await renderMarkdown('- <!--\n  x\n- y\n-->\n');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('y');
  });

  test('a multi-line comment inside a list item or a blockquote is hidden', async () => {
    const item = await renderMarkdown(
      '- one\n\n  <!--\n  hidden\n  -->\n\n  two\n',
    );
    expect(item).toContain('one');
    expect(item).toContain('two');
    expect(item).not.toContain('hidden');
    const quote = await renderMarkdown('> <!--\n> hidden\n> -->\n\nafter\n');
    expect(quote).not.toContain('hidden');
    expect(quote).toContain('after');
    const open = await renderMarkdown('> <!--\n> a\n\nafter -->\n');
    expect(open).toContain('after');
  });

  test('many comment openers that never close stay fast', async () => {
    for (const src of [
      `<!-- ${'x'.repeat(100)}\n\n`.repeat(20_000),
      '<!-- x\n'.repeat(20_000),
      'a <!-- b '.repeat(20_000),
    ]) {
      const start = performance.now();
      const html = await renderMarkdown(src);
      expect(performance.now() - start).toBeLessThan(2000);
      expect(html).toContain('&lt;!--');
    }
  });

  test('an unclosed comment and raw HTML stay escaped text', async () => {
    const open = await renderMarkdown('a <!-- never closed\n');
    expect(open).toContain('&lt;!-- never closed');
    const tag = await renderMarkdown('<b>x</b> <!-- c -->\n');
    expect(tag).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(tag).not.toContain('<b>');
  });
});

describe('code blocks', () => {
  test('take keyboard focus, so a block that scrolls sideways can be read', async () => {
    for (const src of ['```\ncode\n```\n', '    indented\n']) {
      const html = await renderMarkdown(src);
      expect(html).toContain('<pre tabindex="0">');
    }
  });
});

// https://github.com/alrayyes/forge-dashboard/issues/3405
// An image loads only through the caller's imageSource, which says where from
// (the server's proxy) or refuses. Otherwise it shows as a link or as text.
describe('images', () => {
  const imageSource = (src: string) =>
    src.startsWith('https://git.example/')
      ? `/api/v1/images?forge=forgejo&url=${encodeURIComponent(src)}`
      : null;
  const render = (text: string) => renderMarkdown(text, { imageSource });

  test('an allowed image is drawn from the proxy with its alt text', async () => {
    const html = await render('![a mockup](https://git.example/attachments/1)');
    expect(html).toContain(
      '<img src="/api/v1/images?forge=forgejo&amp;url=https%3A%2F%2Fgit.example%2Fattachments%2F1" alt="a mockup"',
    );
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).not.toContain('src="https://git.example');
  });

  test('a blank alt is decorative', async () => {
    expect(await render('![](https://git.example/a.png)')).toContain('alt=""');
  });

  test('an image opens full size in a new tab, unless it is already in a link', async () => {
    const plain = await render('![shot](https://git.example/a.png)');
    expect(plain).toContain('target="_blank" rel="noopener noreferrer"');
    const linked = await render(
      '[![shot](https://git.example/a.png)](https://example.org/x)',
    );
    expect(linked.match(/<a /g)?.length).toBe(1);
    expect(linked).toContain('<img');
  });

  test('a refused host is never loaded and shows as a link', async () => {
    const html = await render('![chart](https://example.org/tracker.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.org/tracker.png"');
    expect(html).toContain('>chart</a>');
  });

  test('without an imageSource no image is drawn', async () => {
    const html = await renderMarkdown('![x](https://git.example/a.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('x');
  });

  test('alt text is escaped', async () => {
    const html = await render('![a "quote" <b>](https://git.example/a.png)');
    expect(html).not.toContain('<b>');
    expect(html).toContain('alt="a &quot;quote&quot; &lt;b&gt;"');
  });

  test('a javascript: or data: image is text, not an image', async () => {
    for (const src of [
      '![x](javascript:alert(1))',
      '![x](data:image/png;base64,AAAA)',
    ]) {
      const html = await render(src);
      expect(html).not.toContain('<img');
      expect(html).not.toContain('href="javascript');
      expect(html).not.toContain('href="data');
    }
  });

  test('the title attribute is not carried over', async () => {
    const html = await render('![x](https://git.example/a.png "hover")');
    expect(html).not.toContain('title=');
  });
});
