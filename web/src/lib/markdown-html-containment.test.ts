/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
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
