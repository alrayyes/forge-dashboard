// Renders the Markdown a forge hands back (a pull request description, a
// comment, release notes) to HTML that is safe to insert. The server doesn't
// sanitise it (#1506), so the safety lives here:
//   - markdown-it with `html: false` escapes raw HTML as text;
//   - its default link validator refuses javascript:, vbscript: and data:
//     links, which stay as plain text;
//   - images are switched off, so an <img> never loads from a stranger's URL
//     and no hidden tracking pixel fires on open;
//   - every link opens in a new tab with rel="noopener noreferrer".
// The library is imported on first use, so the dashboard's own chunk doesn't
// carry it.
import type MarkdownIt from 'markdown-it';

type Renderer = InstanceType<typeof MarkdownIt>;

let renderer: Promise<Renderer> | null = null;

function load(): Promise<Renderer> {
  renderer ??= import('markdown-it').then(({ default: MarkdownItCtor }) => {
    const md = new MarkdownItCtor({
      html: false,
      linkify: true,
      breaks: false,
    });
    md.disable('image');
    const fallback =
      md.renderer.rules.link_open ??
      ((tokens, idx, options, _env, self) =>
        self.renderToken(tokens, idx, options));
    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
      return fallback(tokens, idx, options, env, self);
    };
    return md;
  });
  return renderer;
}

export async function renderMarkdown(text: string): Promise<string> {
  return (await load()).render(text);
}
