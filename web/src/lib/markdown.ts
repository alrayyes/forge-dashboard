// Renders the Markdown a forge hands back (a pull request description, a
// comment, release notes) to HTML that is safe to insert. The server doesn't
// sanitise it (#1506), so the safety lives here:
//   - markdown-it with `html: false` escapes raw HTML as text;
//   - its default link validator refuses javascript:, vbscript: and data:
//     links, which stay as plain text;
//   - images are switched off, so an <img> never loads from a stranger's URL
//     and no hidden tracking pixel fires on open;
//   - task list items (`- [x] done`) become read-only checkboxes: a disabled
//     <input type="checkbox"> inside a <label> with the item's text, built
//     from the parsed tokens, so the text stays escaped (#1655);
//   - every link opens in a new tab with rel="noopener noreferrer".
// The library is imported on first use, so the dashboard's own chunk doesn't
// carry it.
import type MarkdownIt from 'markdown-it';

type Renderer = InstanceType<typeof MarkdownIt>;
type StateCore = Parameters<
  Parameters<Renderer['core']['ruler']['push']>[1]
>[0];

let renderer: Promise<Renderer> | null = null;

const TASK = /^\[([ xX])\](?=\s)\s*/;

// GFM task list items: only a list item whose first paragraph starts with
// `[ ]` or `[x]` and a space (`- [x]` then a newline is a task in GFM but
// stays literal here: a rare form, left out on purpose). markdown-it parses
// code spans, link labels and mid-sentence text as their own tokens, so none
// of those match.
function taskLists(state: StateCore): void {
  const { tokens, Token } = state;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (
      inline.type !== 'inline' ||
      tokens[i - 1].type !== 'paragraph_open' ||
      tokens[i - 2].type !== 'list_item_open'
    ) {
      continue;
    }
    const first = inline.children?.[0];
    const m = first?.type === 'text' ? TASK.exec(first.content) : null;
    if (!first || !inline.children || !m) continue;
    first.content = first.content.slice(m[0].length);
    inline.content = inline.content.slice(m[0].length);
    const open = new Token('html_inline', '', 0);
    open.content = `<label class="task"><input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
    const close = new Token('html_inline', '', 0);
    close.content = '</label>';
    inline.children = [open, ...inline.children, close];
    tokens[i - 2].attrJoin('class', 'task-list-item');
  }
}

function create(MarkdownItCtor: typeof MarkdownIt): Renderer {
  const md = new MarkdownItCtor({ html: false, linkify: true });
  md.disable('image');
  md.core.ruler.after('inline', 'task-lists', taskLists);
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const href = String(tokens[idx].attrGet('href') ?? '');
    // Only absolute http(s) and mailto links are links. A relative or
    // protocol-relative href would resolve against the dashboard's own
    // origin, so it stays as plain text instead.
    if (!/^(https?:|mailto:)/i.test(href)) {
      tokens[idx].tag = 'span';
      tokens[idx].attrs = null;
      const close = tokens.slice(idx + 1).find((t) => t.type === 'link_close');
      if (close) close.tag = 'span';
      return self.renderToken(tokens, idx, options);
    }
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return self.renderToken(tokens, idx, options);
  };
  return md;
}

function load(): Promise<Renderer> {
  // A failed import is not cached: Try again must be able to fetch the chunk
  // once the network is back.
  renderer ??= import('markdown-it')
    .then(({ default: MarkdownItCtor }) => create(MarkdownItCtor))
    .catch((err) => {
      renderer = null;
      throw err;
    });
  return renderer;
}

export async function renderMarkdown(text: string): Promise<string> {
  return (await load()).render(text);
}
