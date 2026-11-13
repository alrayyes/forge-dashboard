// Renders the Markdown a forge hands back (a pull request description, a
// comment, release notes) to HTML that is safe to insert. The server doesn't
// sanitise it (#1506), so the safety lives here:
//   - markdown-it with `html: false` escapes raw HTML as text;
//   - its default link validator refuses javascript:, vbscript: and data:
//     links, which stay as plain text;
//   - an image loads only when the caller's `imageSource` maps its address to
//     the server's proxy (#3405). Any other image shows as a link or as its
//     alt text, so no <img> loads from a stranger's URL and no tracking pixel
//     fires on open;
//   - an HTML comment (`<!-- ... -->`, the bookkeeping bots such as Renovate
//     leave in a description) is dropped by two parser rules, never a regex
//     over the source, so a code span or fenced block keeps its text. Nothing
//     of the comment reaches the output, and `html` stays off (#3668);
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
import type { ImageSource } from './image-source';

type Renderer = InstanceType<typeof MarkdownIt>;
type StateInline = Parameters<
  Parameters<Renderer['inline']['ruler']['push']>[1]
>[0];
type StateBlock = Parameters<
  Parameters<Renderer['block']['ruler']['push']>[1]
>[0];
type StateCore = Parameters<
  Parameters<Renderer['core']['ruler']['push']>[1]
>[0];

let renderer: Promise<Renderer> | null = null;

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
// CommonMark also reads `<!-->` and `<!--->` as (empty) comments, so the
// closing marker is searched for from just after `<!`.
const COMMENT_SEARCH_FROM = 2;

// Where `-->` is searched for, per parse, so a document of unclosed openers
// costs one scan, not one per opener. The value is the first position after
// which a search found nothing.
const noCloseFrom = new WeakMap<object, Map<string, number>>();
// Closers that made a block comment fail, so the openers before them skip
// the line scan too.
const failedClose = new WeakMap<object, Set<string>>();

function findClose(env: unknown, src: string, from: number): number {
  const key = typeof env === 'object' && env !== null ? env : null;
  let seen: Map<string, number> | undefined;
  if (key) {
    seen = noCloseFrom.get(key) ?? new Map<string, number>();
    noCloseFrom.set(key, seen);
    const known = seen.get(src);
    if (known !== undefined && from >= known) return -1;
  }
  const end = src.indexOf(COMMENT_CLOSE, from);
  if (end === -1 && seen) {
    seen.set(src, Math.min(seen.get(src) ?? from, from));
  }
  return end;
}

// An inline `<!-- ... -->`, on one line or several inside one paragraph: it
// advances past the comment and emits no token. Code spans are matched by
// their own rule at their own backtick, so a comment inside one never gets
// here. An unclosed comment stays text.
function commentInline(state: StateInline): boolean {
  if (!state.src.startsWith(COMMENT_OPEN, state.pos)) return false;
  const end = findClose(state.env, state.src, state.pos + COMMENT_SEARCH_FROM);
  if (end === -1) return false;
  state.pos = end + COMMENT_CLOSE.length;
  return true;
}

// The last line whose start is at or before `pos` (bMarks only grows).
function lineAt(state: StateBlock, pos: number, endLine: number): number {
  let lo = 0;
  let hi = endLine - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (state.bMarks[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// A comment that opens a line and closes on a later one, possibly across
// blank lines (which would otherwise split it into paragraphs). A comment
// that closes on its first line is left to the inline rule, since text may
// follow it. Text after the closing `-->` leaves it to the inline rule too.
// Indented code and fences never reach this rule.
function commentBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const lineStart = state.bMarks[startLine] + state.tShift[startLine];
  if (!state.src.startsWith(COMMENT_OPEN, lineStart)) return false;
  const close = findClose(
    state.env,
    state.src,
    lineStart + COMMENT_SEARCH_FROM,
  );
  if (close === -1) return false;
  const closeLine = lineAt(state, close, endLine);
  if (closeLine <= startLine) return false;
  const failKey = `${close}:${state.blkIndent}`;
  const failed = failedClose.get(state) ?? new Set<string>();
  failedClose.set(state, failed);
  if (failed.has(failKey)) return false;
  const fail = () => {
    failed.add(failKey);
    return false;
  };
  const after = state.src.slice(
    close + COMMENT_CLOSE.length,
    state.eMarks[closeLine],
  );
  if (after.trim() !== '') return fail();
  for (let line = startLine + 1; line <= closeLine; line++) {
    if (!state.isEmpty(line) && state.sCount[line] < state.blkIndent) {
      return fail();
    }
  }
  if (!silent) state.line = closeLine + 1;
  return true;
}

// Text that is nothing once the comments are gone.
const blank = (c: { type: string; content: string }) =>
  c.type === 'softbreak' ||
  c.type === 'hardbreak' ||
  (c.type === 'text' && c.content.trim() === '');

// A paragraph or heading that held only comments is empty once they're gone:
// drop it, so no empty <p> or <h1> is drawn.
function dropEmptyBlocks(state: StateCore): void {
  const { tokens } = state;
  for (let i = tokens.length - 3; i >= 0; i--) {
    const open = tokens[i].type;
    if (open !== 'paragraph_open' && open !== 'heading_open') continue;
    const inline = tokens[i + 1];
    if (
      inline.type === 'inline' &&
      tokens[i + 2].type === open.replace('_open', '_close') &&
      (inline.children ?? []).every(blank)
    ) {
      tokens.splice(i, 3);
    }
  }
}

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
/**
 * Which references open a dialog on the dashboard: the forge the text came
 * from, and whether a repository (`owner/name`) is one the dashboard tracks.
 */
export type ReferenceOptions = {
  forge: string;
  tracked: (repo: string) => boolean;
};

const REFERENCE =
  /(?<![\w/&#.@-])([A-Za-z0-9][\w.-]*\/(?!\d+#)[\w.-]+)?#(\d+)(?![\w-])/g;

// Turns references into links to the item on the same forge. Only plain
// text tokens are touched: code spans and blocks are other token types, and
// text inside a link (an explicit one or a linkified URL) is skipped.
// Without a repository address the text stays as it is.
function references(state: StateCore): void {
  const env = state.env as
    | { repoUrl?: string; dashboardRefs?: ReferenceOptions }
    | undefined;
  const repoUrl = env?.repoUrl;
  if (!repoUrl) return;
  const url = new URL(repoUrl);
  const host = url.origin;
  const ownRepo = url.pathname.replace(/^\/+|\/+$/g, '');
  const dashboard = env?.dashboardRefs;
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
        const repo = m[1] || ownRepo;
        const forgeUrl = `${host}/${repo}/issues/${m[2]}`;
        if (
          dashboard &&
          /^[a-z]+$/.test(dashboard.forge) &&
          dashboard.tracked(repo)
        ) {
          // The dashboard opens it in place; the address keeps middle-click
          // and copy-link working. Built here, not as a link token: the link
          // rule below turns an address that is not absolute http(s) into
          // text. Every part is a number or the characters REFERENCE allows.
          const link = new Token('html_inline', '', 0);
          link.content = `<a href="/issues.html?issue=${dashboard.forge}/${repo}/${m[2]}" data-ref-repo="${repo}" data-ref-number="${m[2]}" data-ref-url="${forgeUrl}">${m[0]}</a>`;
          out.push(text, link);
        } else {
          // Nothing to open here: a repository the dashboard does not track
          // goes to the forge, and says so.
          const open = new Token('link_open', 'a', 1);
          open.attrSet('href', forgeUrl);
          const label = new Token('text', '', 0);
          label.content = m[0];
          const note = new Token('html_inline', '', 0);
          note.content =
            '<span class="sr-only"> (opens on the forge in a new tab)</span>';
          const close = new Token('link_close', 'a', -1);
          out.push(text, open, label, note, close);
        }
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
  emoji(md, { shortcuts: {} });
  md.block.ruler.before('paragraph', 'html-comment', commentBlock);
  md.inline.ruler.before('autolink', 'html-comment', commentInline);
  md.core.ruler.after('inline', 'drop-empty-blocks', dropEmptyBlocks);
  md.core.ruler.after('inline', 'task-lists', taskLists);
  md.core.ruler.after('linkify', 'references', references);
  // A code block can scroll sideways, and a keyboard can only scroll what
  // takes focus.
  for (const rule of ['fence', 'code_block'] as const) {
    const base = md.renderer.rules[rule];
    if (!base) continue;
    md.renderer.rules[rule] = (...args) =>
      base(...args).replace('<pre', '<pre tabindex="0"');
  }
  md.renderer.rules.image = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    const src = String(token.attrGet('src') ?? '');
    const alt = token.children
      ? md.renderer.renderInlineAsText(token.children, md.options, env)
      : token.content;
    const esc = md.utils.escapeHtml;
    const imageSource = (env as { imageSource?: ImageSource } | undefined)
      ?.imageSource;
    let inLink = 0;
    for (const t of tokens.slice(0, idx)) {
      if (t.type === 'link_open') inLink++;
      if (t.type === 'link_close') inLink--;
    }
    const proxy = imageSource?.(src) ?? null;
    if (!proxy) {
      // Never loaded: a link to it where a link may go, else its text.
      const label = esc(alt || src);
      return inLink === 0 && /^https?:/i.test(src)
        ? `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
    }
    const img = `<img src="${esc(proxy)}" alt="${esc(alt)}" class="md-image" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    // A decorative image (no alt) or one already in a link gets no link of
    // its own: an empty link has no name for a screen reader.
    return alt && inLink === 0
      ? `<a href="${esc(proxy)}" target="_blank" rel="noopener noreferrer">${img}</a>`
      : img;
  };
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
// `imageSource` maps an image address to where the page loads it from, or
// null to refuse it; without one no image loads.
export async function renderMarkdown(
  text: string,
  options: {
    repoUrl?: string | null;
    references?: ReferenceOptions;
    monoReferences?: boolean;
    imageSource?: ImageSource;
  } = {},
): Promise<string> {
  const repoUrl = options.repoUrl ?? undefined;
  return (await load()).render(text, {
    repoUrl,
    dashboardRefs: options.references,
    monoReferences: options.monoReferences,
    imageSource: options.imageSource,
  });
}
