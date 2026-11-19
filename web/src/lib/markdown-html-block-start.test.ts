/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { renderMarkdown } from './markdown';

// https://github.com/alrayyes/forge-dashboard/issues/4368
// Where an HTML block may start: the allow-list narrows markdown-it's own
// rule, and these pin the places where a one-character edit used to pass.
const opts = {
  repoUrl: 'https://github.com/alrayyes/forge-dashboard',
  imageSource: () => null,
};

describe('an HTML block starts after the indent, tabs included', () => {
  test('a tab after a list marker', async () => {
    expect(await renderMarkdown('-\t<details>x</details>', opts)).toBe(
      '<ul>\n<li>\n<details>x</details></li>\n</ul>\n',
    );
  });

  test('a tab after a list marker, for a pre', async () => {
    expect(await renderMarkdown('-\t<pre>x</pre>', opts)).toBe(
      '<ul>\n<li>\n<pre tabindex="0">x</pre></li>\n</ul>\n',
    );
  });

  test('a tab-indented line inside a list item', async () => {
    expect(await renderMarkdown('- a\n\t<pre>x</pre>', opts)).toBe(
      '<ul>\n<li>a  <pre tabindex="0">x</pre></li>\n</ul>\n',
    );
  });
});

describe('an HTML block interrupts what it follows', () => {
  test('a paragraph', async () => {
    expect(await renderMarkdown('a\n<details>x</details>', opts)).toBe(
      '<p>a</p>\n<details>x</details>',
    );
  });

  test('a blockquote', async () => {
    expect(await renderMarkdown('> q\n<details>x</details>', opts)).toBe(
      '<blockquote>\n<p>q</p>\n</blockquote>\n<details>x</details>',
    );
  });

  test('a reference definition still waiting for its address', async () => {
    // Without `reference` in the rule's list the tag is read as the address.
    expect(await renderMarkdown('[x]:\n<details>\n\n[x]', opts)).toBe(
      '<p>[x]:</p>\n<details>\n<p>[x]</p>\n</details>',
    );
  });
});

describe('the name after the angle bracket has to end', () => {
  test('a longer name than blockquote is text', async () => {
    expect(await renderMarkdown('</blockquotex>', opts)).toBe(
      '<p>&lt;/blockquotex&gt;</p>\n',
    );
  });

  test('blockquote itself, closing, is still a block start', async () => {
    expect(await renderMarkdown('</blockquote>x', opts)).toBe('x');
  });
});
