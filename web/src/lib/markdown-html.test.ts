/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fastest } from './cpu-time';
import { renderMarkdown } from './markdown';

// https://github.com/alrayyes/forge-dashboard/issues/4241
// A Dependabot description is HTML inside Markdown. Only an allow-list of
// elements renders; every tag is rebuilt from the parse, so none of the
// author's HTML source reaches the output.
const dependabot = readFileSync(
  new URL('./fixtures/dependabot-body.txt', import.meta.url),
  'utf8',
);

const opts = {
  repoUrl: 'https://github.com/alrayyes/forge-dashboard',
  imageSource: (src: string) =>
    src.startsWith('https://dependabot-badges')
      ? `/api/image?u=${encodeURIComponent(src)}`
      : null,
};

describe('a Dependabot description', () => {
  test('renders as structure, not as tags', async () => {
    const html = await renderMarkdown(dependabot, opts);
    expect(html).not.toContain('&lt;details');
    expect(html).not.toContain('&lt;summary');
    expect(html).not.toContain('&lt;li');
    expect(html).not.toContain('&lt;a href');
    expect(html.match(/<details>/g)).toHaveLength(3);
    expect(html.match(/<\/details>/g)).toHaveLength(3);
    expect(html).toContain('<summary>Release notes</summary>');
    expect(html).toContain('<summary>Commits</summary>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<h2>Create Pull Request v8.1.3</h2>');
    expect(html).toContain('<li>');
    expect(html).toContain('<br>');
  });

  test('keeps an escaped entity as text, never as a tag', async () => {
    const html = await renderMarkdown(dependabot, opts);
    expect(html).toContain('<code>&lt;detached&gt;</code>');
  });

  test('gives every link the usual rules and no nested link', async () => {
    const html = await renderMarkdown(dependabot, opts);
    for (const a of html.match(/<a [^>]*>/g) ?? []) {
      expect(a).toMatch(/^<a href="https?:\/\//);
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>)[\s\S])*<a /);
    // The label of a raw link is not turned into a reference link.
    expect(html).toContain('>#4521</a>');
    expect(html).not.toContain('opens on the forge');
  });

  test('keeps the badge image on the server proxy', async () => {
    const html = await renderMarkdown(dependabot, opts);
    expect(html).toContain('src="/api/image?u=');
    expect(html).not.toContain('src="https://');
  });

  test('closes everything it opens, in order', async () => {
    const html = await renderMarkdown(dependabot, opts);
    const stack: string[] = [];
    for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>/g)) {
      if (['br', 'img', 'input', 'hr'].includes(m[2])) continue;
      if (m[1]) expect(stack.pop()).toBe(m[2]);
      else stack.push(m[2]);
    }
    expect(stack).toEqual([]);
  });
});

describe('allow-listed tags in any body', () => {
  test('render the same way for a human body', async () => {
    const html = await renderMarkdown(
      '<details><summary>More</summary>\n\ntext\n\n</details>\n',
    );
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>More</summary>');
    expect(html).toContain('</details>');
  });

  test('render inline in a paragraph', async () => {
    const html = await renderMarkdown(
      'a <strong>b</strong> <code>c</code><br>d',
    );
    expect(html).toBe('<p>a <strong>b</strong> <code>c</code><br>d</p>\n');
  });
});

describe('everything else stays text, as before', () => {
  test('unlisted tags and stray angle brackets', async () => {
    for (const [src, shown] of [
      ['Vec<String> and a < b > c', 'Vec&lt;String&gt; and a &lt; b &gt; c'],
      ['<div>hi</div>', '&lt;div&gt;hi&lt;/div&gt;'],
      ['x <span>y</span>', 'x &lt;span&gt;y&lt;/span&gt;'],
      ['<table><tr><td>x</td></tr></table>', '&lt;table&gt;'],
    ]) {
      expect(await renderMarkdown(src)).toContain(shown);
    }
  });

  test('comments are still dropped', async () => {
    const html = await renderMarkdown(
      '<details>\n<!-- bot note -->\n<summary>s</summary>\n</details>',
    );
    expect(html).not.toContain('bot note');
    expect(html).toContain('<summary>s</summary>');
  });

  test('a code span or fence keeps its tags as text', async () => {
    const html = await renderMarkdown('`<details>`\n\n```\n<details>\n```\n');
    expect(html).not.toContain('<details>');
    expect(html.match(/&lt;details&gt;/g)).toHaveLength(2);
  });
});

// Every case: nothing executable or loadable, whatever else is shown.
const attacks: Record<string, string> = {
  script: '<script>alert(1)</script>',
  'script after block': '<details>\n<script>alert(1)</script>\n</details>',
  onclick: '<p onclick="alert(1)">x</p>',
  'onclick inline': 'a <em onclick="alert(1)">x</em>',
  style: '<p style="position:fixed;inset:0">x</p>',
  'style tag': '<style>body{display:none}</style>',
  'javascript href': '<a href="javascript:alert(1)">x</a>',
  'javascript href with entity': '<a href="java&#115;cript:alert(1)">x</a>',
  'javascript href with tab': '<a href="java&#9;script:alert(1)">x</a>',
  'data href': '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>',
  'relative href': '<a href="/admin">x</a>',
  'protocol-relative href': '<a href="//evil.example/x">x</a>',
  'img remote': '<img src="https://evil.example/p.gif">',
  'img onerror': '<img src=x onerror=alert(1)>',
  'img in block':
    '<details>\n<img src="https://evil.example/p.gif">\n</details>',
  iframe: '<iframe src="https://evil.example"></iframe>',
  'svg onload': '<svg onload=alert(1)></svg>',
  form: '<form action="https://evil.example"><input name=p></form>',
  noscript:
    '<noscript><p title="</noscript><img src onerror=alert(1)>"></noscript>',
  'math style':
    '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src onerror=alert(1)&gt;">',
  'svg style': '<svg><style><img src=x onerror=alert(1)></style></svg>',
  'attribute with gt':
    '<a href="https://ok.example" title=">" onfocus="alert(1)">x</a>',
  'unquoted attribute': '<a href=https://ok.example onmouseover=alert(1)>x</a>',
  'slash attribute separator':
    '<a/onclick=alert(1)/href="https://ok.example">x</a>',
  'uppercase tag': '<DETAILS ONTOGGLE=alert(1) OPEN>x</DETAILS>',
  'summary handler':
    '<details open ontoggle=alert(1)><summary>s</summary></details>',
  'br handler': 'a<br onclick=alert(1)>b',
  'base tag': '<base href="https://evil.example/">',
  meta: '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  object: '<object data="https://evil.example"></object>',
};

describe('attacks stay inert', () => {
  for (const [name, src] of Object.entries(attacks)) {
    test(name, async () => {
      const html = await renderMarkdown(src, opts);
      expect(html).not.toMatch(
        /<(script|style|iframe|svg|math|form|input|noscript|base|meta|object|embed)\b/i,
      );
      expect(html).not.toMatch(/<img\b[^>]*(evil|onerror|src="x")/i);
      expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/<[^>]*\sstyle\s*=/i);
      expect(html).not.toMatch(
        /<[^>]*\s(?:href|src)="(?:javascript|data|vbscript|\/)/i,
      );
      expect(html).not.toMatch(/<[^>]*\s(?:title|open|action)\b/i);
    });
  }

  test('only the allow-listed element names are ever emitted', async () => {
    const allowed = new Set(
      'p br ul ol li blockquote code pre em strong a details summary h1 h2 h3 h4 h5 h6 span label input img hr table thead tbody tr th td s del'.split(
        ' ',
      ),
    );
    for (const src of Object.values(attacks)) {
      const html = await renderMarkdown(src, opts);
      for (const m of html.matchAll(/<\/?([a-z0-9]+)/gi)) {
        expect(allowed.has(m[1].toLowerCase())).toBe(true);
      }
    }
  });
});

describe('a tag that closes wrongly stays inside its container', () => {
  test('an unclosed details is closed at the end', async () => {
    const html = await renderMarkdown(
      '<details>\n<summary>s</summary>\ntext\n',
    );
    expect(html.match(/<details>/g)).toHaveLength(1);
    expect(html.match(/<\/details>/g)).toHaveLength(1);
  });

  test('stray closers are dropped', async () => {
    const html = await renderMarkdown('</details>\n\n</div></p></li>\n\ntext');
    expect(html).not.toMatch(/<\/(details|li|p)>[\s\S]*<\/p>[\s\S]*<\/p>/);
    expect(html).not.toContain('</details>');
    expect(html).not.toContain('</li>');
  });

  test('a raw tag opened in a list item closes with the item', async () => {
    const html = await renderMarkdown(
      '- <details>\n  <summary>s</summary>\n\nafter',
    );
    const open = html.indexOf('<details>');
    const close = html.indexOf('</details>');
    expect(close).toBeGreaterThan(open);
    expect(close).toBeLessThan(html.indexOf('</li>'));
    expect(html.indexOf('after')).toBeGreaterThan(html.indexOf('</ul>'));
  });

  test('a raw tag opened in a quote closes with the quote', async () => {
    const html = await renderMarkdown('> <blockquote>\n> x\n\nafter');
    expect(html.indexOf('</blockquote>')).toBeLessThan(
      html.lastIndexOf('</blockquote>') + 1,
    );
    const stack: string[] = [];
    for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>/g)) {
      if (m[1]) expect(stack.pop()).toBe(m[2]);
      else stack.push(m[2]);
    }
    expect(stack).toEqual([]);
  });

  test('deep nesting is capped and still balanced', async () => {
    const html = await renderMarkdown(`${'<details>\n'.repeat(500)}x`);
    expect(html.match(/<details>/g)?.length ?? 0).toBeLessThan(50);
    expect(html.match(/<details>/g)?.length).toBe(
      html.match(/<\/details>/g)?.length,
    );
  });

  test('a link does not nest in a link', async () => {
    const html = await renderMarkdown(
      '[x <a href="https://b.example">y</a>](https://a.example) <a href="https://c.example">p <a href="https://d.example">q</a></a>',
    );
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>)[\s\S])*<a /);
  });

  test('a huge unclosed input renders quickly', async () => {
    const took = await fastest(async () => {
      await renderMarkdown('<a href="x" '.repeat(20000));
      await renderMarkdown('<em>'.repeat(20000));
    }, 3);
    expect(took).toBeLessThan(5000);
  }, 60_000);
});
