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
//   - every link opens in a new tab with rel="noopener noreferrer";
//   - `#12` and `owner/repo#12` in plain text link to the item on the same
//     forge when the caller says which repository the text belongs to;
//   - :shortcodes: such as :robot: become the Unicode emoji, the way the
//     forges draw them (#1995). Never an image, and the plugin skips code.
//     Emoticons like `:)` stay as typed: the forges don't expand them and
//     they would rewrite ordinary text.
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

// `#12` and `owner/repo#12` in running text, the forms both forges autolink:
// https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls
// The lookbehind keeps `abc#12`, `a/b/c#12` and `&#12` as text, and the
// lookahead keeps `#12abc` as text.
// The owner is the characters either forge allows in one (Forgejo adds `_`
// and `.` to GitHub's letters, digits and hyphen), and a repository of only
// digits is read as a fraction (`1/2#3`), not a repository. A mention
// (`@user/team#5`) is left to the forge. `and/or#3` still links: telling it
// from a real repository would take a lookup the page can't make.
const REFERENCE =
  /(?<![\w/&#.@-])([A-Za-z0-9][\w.-]*\/(?!\d+#)[\w.-]+)?#(\d+)(?![\w-])/g;

// Turns references into links to the item on the same forge. Only plain
// text tokens are touched: code spans and blocks are other token types, and
// text inside a link (an explicit one or a linkified URL) is skipped.
// Without a repository address the text stays as it is.
function references(state: StateCore): void {
  const repoUrl = (state.env as { repoUrl?: string } | undefined)?.repoUrl;
  if (!repoUrl) return;
  const host = new URL(repoUrl).origin;
  const { Token } = state;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const out: typeof block.children = [];
    let inLink = 0;
    for (const child of block.children) {
      if (child.type === 'link_open') inLink++;
      if (child.type === 'link_close') inLink--;
      if (child.type !== 'text' || inLink > 0) {
        out.push(child);
        continue;
      }
      let last = 0;
      for (const m of child.content.matchAll(REFERENCE)) {
        const text = new Token('text', '', 0);
        text.content = child.content.slice(last, m.index);
        const open = new Token('link_open', 'a', 1);
        open.attrSet(
          'href',
          m[1] ? `${host}/${m[1]}/issues/${m[2]}` : `${repoUrl}/issues/${m[2]}`,
        );
        const label = new Token('text', '', 0);
        label.content = m[0];
        const close = new Token('link_close', 'a', -1);
        out.push(text, open, label, close);
        last = m.index + m[0].length;
      }
      if (last === 0) {
        out.push(child);
      } else {
        const rest = new Token('text', '', 0);
        rest.content = child.content.slice(last);
        out.push(rest);
      }
    }
    block.children = out;
  }
}

const MONO_LABEL = /^(#\d+|[0-9a-f]{7,40})$/;

function create(
  MarkdownItCtor: typeof MarkdownIt,
  emoji: (
    md: Renderer,
    options?: { shortcuts?: Record<string, never> },
  ) => void,
): Renderer {
  const md = new MarkdownItCtor({ html: false, linkify: true });
  md.disable('image');
  emoji(md, { shortcuts: {} });
  md.core.ruler.after('inline', 'task-lists', taskLists);
  md.core.ruler.after('linkify', 'references', references);
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
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
    // Release notes ask for it: a link labelled `#123` or a commit hash is a
    // reference, not prose, so it gets the mono class. The label is matched,
    // never the surrounding text.
    if (
      (env as { monoReferences?: boolean } | undefined)?.monoReferences &&
      MONO_LABEL.test(tokens[idx + 1]?.content ?? '')
    ) {
      tokens[idx].attrSet('class', 'mono');
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
  renderer ??= Promise.all([import('markdown-it'), import('markdown-it-emoji')])
    .then(([{ default: MarkdownItCtor }, { full }]) =>
      create(MarkdownItCtor, full),
    )
    .catch((err) => {
      renderer = null;
      throw err;
    });
  return renderer;
}

// `repoUrl` is the repository the text belongs to; with it, `#12` and
// `owner/repo#12` link to the item on that forge. `monoReferences` gives a
// link labelled with a number or a commit hash the `mono` class.
export async function renderMarkdown(
  text: string,
  options: { repoUrl?: string | null; monoReferences?: boolean } = {},
): Promise<string> {
  const repoUrl = options.repoUrl ?? undefined;
  return (await load()).render(text, {
    repoUrl,
    monoReferences: options.monoReferences,
  });
}
