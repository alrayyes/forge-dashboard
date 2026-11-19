/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderMarkdown } from './markdown';

// https://github.com/alrayyes/forge-dashboard/issues/4241
// A raw tag that the author never closed ends where its own run of HTML ends.
// It never carries into the Markdown that follows: one unclosed tag must not
// turn the rest of a description into a single link or heading.

const body = [
  '# Heading',
  '',
  'Some [real](https://github.com/x/y) link.',
  '',
  '- one',
  '- two',
  '',
  '```',
  'code',
  '```',
].join('\n');

describe('an unclosed raw tag ends with its block', () => {
  test('an unclosed link does not wrap the blocks after it', async () => {
    const html = await renderMarkdown(
      `<p><a href="https://example.test/x">\n\n${body}`,
    );
    expect(html.match(/<a /g)).toHaveLength(1 + 1);
    expect(html).toContain('<a href="https://github.com/x/y"');
    expect(html).toMatch(/<h1>Heading<\/h1>/);
    const link = html.slice(
      html.indexOf('<a href="https://example.test/x"'),
      html.indexOf('</a>') + 4,
    );
    expect(link).not.toContain('Heading');
    expect(link).not.toContain('<ul>');
    expect(link).not.toContain('<pre');
  });

  test('an unclosed heading does not make the rest of the body a heading', async () => {
    const html = await renderMarkdown(`<h1>Giant\n\n${body}`);
    expect(html.startsWith('<h1>Giant\n</h1><h1>Heading</h1>')).toBe(true);
    expect(html).toContain('<a href="https://github.com/x/y"');
  });

  test('an unclosed paragraph is not adopted by the paragraph after it', async () => {
    const html = await renderMarkdown('<p>unclosed\n\nnext **x**');
    expect(html).toBe('<p>unclosed\n</p><p>next <strong>x</strong></p>\n');
  });

  test('an unclosed inline tag ends with its line of text', async () => {
    const html = await renderMarkdown('a <em>b\n\nc\n\nd');
    expect(html).toBe('<p>a <em>b</em></p>\n<p>c</p>\n<p>d</p>\n');
  });
});

describe('a link that is not a link', () => {
  test('a refused link inside a refused link closes every span it opened', async () => {
    const html = await renderMarkdown(
      '<a href="javascript:1"><a href="https://e.com">x</a></a>',
    );
    expect(html).not.toContain('</a>');
    expect(html.match(/<span>/g)?.length).toBe(html.match(/<\/span>/g)?.length);
  });
});

describe('attributes and links in links', () => {
  test('another attribute before href is not read as the address', async () => {
    const html = await renderMarkdown(
      '<a title="https://evil.example" href="javascript:1">x</a> and <a title="t" href="https://ok.example">y</a>',
    );
    expect(html).not.toContain('evil.example');
    expect(html).toContain('<a href="https://ok.example"');
    expect(html).not.toContain('title');
  });

  test('a raw link inside a Markdown link is not a second link', async () => {
    const html = await renderMarkdown(
      '[see <a href="https://b.example">b</a>](https://a.example)',
    );
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain('b.example');
  });
});

// A container tag may span blank lines, because Markdown sits inside it in
// the real Dependabot body. It still ends with its own Markdown container.
describe('a container tag that spans blank lines', () => {
  const inside = (html: string, tag: string) => {
    const open = html.indexOf(`<${tag}`);
    const close = html.indexOf(`</${tag}>`);
    return open === -1 || close === -1 ? '' : html.slice(open, close);
  };

  test('the real Dependabot commands section keeps its text inside', async () => {
    const dependabot = readFileSync(
      new URL('./fixtures/dependabot-body.txt', import.meta.url),
      'utf8',
    );
    const html = await renderMarkdown(dependabot);
    const commands = html.slice(html.lastIndexOf('<details>'));
    expect(commands).toContain(
      '<summary>Dependabot commands and options</summary>',
    );
    expect(commands.slice(0, commands.indexOf('</details>'))).toContain(
      '@dependabot rebase',
    );
  });

  test('details, blockquote and lists hold the Markdown between their tags', async () => {
    for (const tag of ['details', 'blockquote', 'ul', 'ol', 'li']) {
      const html = await renderMarkdown(
        `<${tag}>\n\nsome **text** and [a link](https://a.example)\n\n</${tag}>\n\nafter`,
      );
      const held = inside(html, tag);
      expect(held).toContain('<strong>text</strong>');
      expect(held).toContain('<a href="https://a.example"');
      expect(html.slice(html.indexOf(`</${tag}>`))).toContain('after');
      expect(html).not.toContain('&lt;/');
    }
  });

  test('(a) a summary then text then the closer', async () => {
    const html = await renderMarkdown(
      '<details>\n<summary>S</summary>\n\ntext\n\n</details>',
    );
    expect(html).toBe(
      '<details>\n<summary>S</summary>\n<p>text</p>\n</details>',
    );
  });

  test('(b) one never closed ends with its container, real links survive', async () => {
    const html = await renderMarkdown(
      '<details>\n<summary>S</summary>\n\ntext [one](https://one.example)\n\n- item [two](https://two.example)',
    );
    expect(html).toContain('<a href="https://one.example"');
    expect(html).toContain('<a href="https://two.example"');
    expect(html.match(/<details>/g)).toHaveLength(1);
    expect(html.match(/<\/details>/g)).toHaveLength(1);
    expect(html.endsWith('</details>')).toBe(true);
  });

  test('(b) one never closed in a quote does not take what follows the quote', async () => {
    const html = await renderMarkdown(
      '> <details>\n> <summary>S</summary>\n>\n> inside\n\noutside [link](https://o.example)',
    );
    const quote = html.slice(0, html.indexOf('</blockquote>'));
    expect(quote).toContain('inside');
    expect(quote).toContain('</details>');
    expect(html.slice(html.indexOf('</blockquote>'))).toContain(
      '<a href="https://o.example"',
    );
    expect(html.slice(html.indexOf('</blockquote>'))).not.toContain('details');
  });

  test('(c) an unclosed link inside it still ends with its block', async () => {
    const html = await renderMarkdown(
      '<details>\n<p><a href="https://example.test/x">\n\nrest [real](https://r.example)\n\n</details>',
    );
    expect(html).toContain('<a href="https://r.example"');
    const link = html.slice(
      html.indexOf('<a href="https://example.test/x"'),
      html.indexOf('</a>') + 4,
    );
    expect(link).not.toContain('rest');
  });

  test('(d) inside a list item and a quote', async () => {
    const item = await renderMarkdown(
      '- <details>\n  <summary>S</summary>\n\n  text\n\n  </details>\n- next',
    );
    expect(item).toMatch(
      /<li>[\s\S]*<details>[\s\S]*text[\s\S]*<\/details>[\s\S]*<\/li>\s*<li>\s*<p>next<\/p>/,
    );
    const quote = await renderMarkdown(
      '> <details>\n> <summary>S</summary>\n>\n> text\n>\n> </details>\n\nout',
    );
    const q = quote.slice(0, quote.indexOf('</blockquote>'));
    expect(q).toMatch(/<details>[\s\S]*text[\s\S]*<\/details>/);
    expect(quote.slice(quote.indexOf('</blockquote>'))).toContain('out');
  });
});

// Which tags may stay open across a blank line is a list of six names. Each
// test here fails if one is added to it or dropped from it, and if the pass
// that closes the others picks the wrong tag.
describe('only the container tags stay open across a blank line', () => {
  const after = (html: string, text: string) => html.slice(html.indexOf(text));

  test('an unclosed link in a details ends with its block', async () => {
    const html = await renderMarkdown(
      '<details>\n<a href="https://example.test/x">\n\nrest [real](https://r.example)\n\n</details>',
    );
    const link = html.slice(
      html.indexOf('<a href="https://example.test/x"'),
      html.indexOf('</a>') + 4,
    );
    expect(link).not.toContain('rest');
    expect(html).toContain('<a href="https://r.example"');
  });

  test('an unclosed summary does not take the text after it', async () => {
    const html = await renderMarkdown(
      '<details>\n<summary>S\n\nrest\n\n</details>',
    );
    expect(html.indexOf('</summary>')).toBeLessThan(html.indexOf('rest'));
  });

  test('a list item holds the Markdown after a blank line', async () => {
    const html = await renderMarkdown(
      '<ul>\n<li>one\n\nmore text\n\n</li>\n</ul>',
    );
    expect(html.indexOf('more text')).toBeLessThan(html.indexOf('</li>'));
  });

  test('a paragraph around an unclosed link closes, and so does what it holds', async () => {
    // The pass closes from the outermost tag that may not span blocks, not
    // the innermost: the p, the list inside it and the link all end here.
    const html = await renderMarkdown(
      '<details>\n<p>\n<ul>\n<li>\n<a href="https://example.test/x">\n\nrest\n\n</details>',
    );
    const rest = html.indexOf('rest');
    expect(html.indexOf('</p>')).toBeLessThan(rest);
    expect(html.indexOf('</ul>')).toBeLessThan(rest);
    expect(html.indexOf('</li>')).toBeLessThan(rest);
    expect(html.indexOf('</a>')).toBeLessThan(rest);
    expect(after(html, 'rest')).not.toContain('<a ');
  });
});

describe('the limits on a tag', () => {
  test('sixteen open tags nest and a seventeenth is text', async () => {
    const sixteen = '<details>'.repeat(16);
    const html = await renderMarkdown(`${sixteen}<em>x`);
    expect(html.match(/<details>/g)).toHaveLength(16);
    expect(html).toContain('&lt;em&gt;');
    const fifteen = await renderMarkdown(`${'<details>'.repeat(15)}<em>x`);
    expect(fifteen).toContain('<em>');
  });

  test('a tag of exactly the longest length is a tag, one longer is text', async () => {
    const tag = (pad: number) =>
      `<a title="${'x'.repeat(pad)}" href="https://e.example">y</a>`;
    const base = tag(0).length - 'y</a>'.length;
    const html = await renderMarkdown(tag(4096 - base));
    // Linkify also links the address in text, so the text is what tells.
    expect(html).not.toContain('&lt;a title');
    const longer = await renderMarkdown(tag(4096 - base + 1));
    expect(longer).toContain('&lt;a title');
  });
});

describe('an unclosed pre', () => {
  test('is shown as text, so it takes nothing after it', async () => {
    for (const open of [
      '<pre><a href="https://example.test/x">',
      '<pre><h1>',
    ]) {
      const html = await renderMarkdown(
        `${open}\n\nrest [real](https://r.example)\n\n- item`,
      );
      expect(html).not.toContain('<pre');
      // The inline link closes with its line, so it is an empty one.
      expect(html).not.toMatch(/example\.test[^>]*>[^<]/);
      expect(html).toContain('<a href="https://r.example"');
      expect(html).toContain('<li>item</li>');
    }
  });

  test('a closed one keeps its text and is focusable', async () => {
    const html = await renderMarkdown('<pre>\nline <b>x</b>\n</pre>');
    expect(html).toContain('<pre tabindex="0">');
    expect(html).toContain('line ');
    expect(html).toContain('</pre>');
  });
});

describe('a tag too long to be a tag', () => {
  test('stays text, however well formed', async () => {
    const long = `<a title="${'x'.repeat(4100)}" href="https://e.example">y</a>`;
    const html = await renderMarkdown(long);
    expect(html).not.toMatch(/<a [^>]*title/);
    expect(html).toContain('&lt;a title');
  });

  test('one just under the limit is a tag', async () => {
    const ok = `<a title="${'x'.repeat(3900)}" href="https://e.example">y</a>`;
    const html = await renderMarkdown(ok);
    expect(html).toContain('<a href="https://e.example"');
    expect(html).not.toContain('&lt;a title');
  });
});
