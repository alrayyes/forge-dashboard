/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { renderMarkdown } from './markdown';

// https://github.com/alrayyes/forge-dashboard/issues/4241
// A seeded fuzz of the HTML allow-list: random mixes of tag fragments and
// Markdown must never put a tag, an attribute or an address outside the
// allow-list in the output, and must always leave it balanced. The seed and
// the count are fixed, so a failure reproduces.

const SEED = 4241;
const RUNS = 400;

// What the output may contain: the allow-list, and what Markdown makes.
const TAGS = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'details',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'input',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'summary',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]);
const VOID = new Set(['br', 'hr', 'img', 'input']);
const ATTRIBUTES = new Set([
  'alt',
  'checked',
  'class',
  'decoding',
  'disabled',
  'href',
  'loading',
  'referrerpolicy',
  'rel',
  'src',
  'start',
  'style',
  'tabindex',
  'target',
  'type',
]);

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  '<a href="https://example.test/x">',
  '<a href="javascript:alert(1)">',
  '<a title="https://e.example" href="https://ok.example">',
  '</a>',
  '<a href=x onclick=y>',
  '<a/href=https://e.com>',
  '<p>',
  '</p>',
  '<h1>',
  '</h1>',
  '<details>',
  '</details>',
  '<summary>',
  '</summary>',
  '<ul>',
  '</ul>',
  '<ol>',
  '<li>',
  '</li>',
  '<blockquote>',
  '</blockquote>',
  '<pre>',
  '</pre>',
  '<br>',
  '<br/>',
  '<em>',
  '</em>',
  '<strong>',
  '</strong>',
  '<code>',
  '</code>',
  '<script>alert(1)</script>',
  '<img src=x onerror=y>',
  '<iframe src=x>',
  '<svg onload=x>',
  '<style>',
  '<!--',
  '-->',
  '<!-- x -->',
  '<![CDATA[',
  '<',
  '>',
  '"',
  "'",
  '&lt;',
  '&#106;',
  '&',
  '\0',
  '[link](https://a.example)',
  '[bad](javascript:1)',
  '![img](https://i.example/a.png)',
  '**b**',
  '`c`',
  '# head',
  '- item',
  '> quote',
  '```',
  '1. one',
  '| a | b |',
  '<https://auto.example>',
  'text',
  ' ',
  '\n',
  '\n',
  '\n\n',
  '    ',
];

function generate(rand: () => number): string {
  const count = 1 + Math.floor(rand() * 40);
  let out = '';
  for (let i = 0; i < count; i++) {
    out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
  }
  return out;
}

// Every problem in one rendered string, empty when it is fine.
function problems(html: string): string[] {
  const found: string[] = [];
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9]*)([^>]*)>/g)) {
    const [, closing, name, rest] = m;
    const tag = name.toLowerCase();
    if (!TAGS.has(tag)) found.push(`tag ${tag}`);
    for (const attr of rest.matchAll(/\s([^\s=/]+)(?:="([^"]*)")?/g)) {
      const key = attr[1].toLowerCase();
      if (!ATTRIBUTES.has(key)) found.push(`attribute ${key}`);
      // The proxy address is the one relative link, on an image.
      if (
        key === 'href' &&
        !/^(https?:|mailto:|\/api\/image\?u=)/i.test(attr[2] ?? '')
      ) {
        found.push(`href ${attr[2]}`);
      }
    }
    if (VOID.has(tag)) continue;
    if (!closing) {
      stack.push(tag);
    } else if (stack.pop() !== tag) {
      found.push(`unbalanced </${tag}>`);
    }
  }
  if (stack.length > 0) found.push(`unclosed ${stack.join(',')}`);
  return found;
}

describe('the HTML allow-list under random input', () => {
  test('nothing outside the allow-list, and always balanced', async () => {
    const rand = mulberry32(SEED);
    const failures: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const input = generate(rand);
      const html = await renderMarkdown(input, {
        imageSource: (src) => `/api/image?u=${encodeURIComponent(src)}`,
      });
      const found = problems(html);
      if (found.length > 0) {
        failures.push(`${JSON.stringify(input)} -> ${found.join('; ')}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('a large input takes linear time', async () => {
    const unit = '<a href="https://e.example"><p><em><details>[x](y)\n\n';
    const time = async (n: number) => {
      const start = performance.now();
      await renderMarkdown(unit.repeat(n));
      return performance.now() - start;
    };
    await time(10);
    const small = await time(500);
    const large = await time(4000);
    // 8x the input: a quadratic renderer would take about 64x as long.
    expect(large).toBeLessThan(Math.max(small, 5) * 24);
    expect(large).toBeLessThan(5000);
  });
});
