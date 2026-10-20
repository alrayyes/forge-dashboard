// markdown-it-emoji ships no types. Only the part markdown.ts uses is
// declared: the `full` plugin (every GitHub-style :shortcode:) and its
// `shortcuts` option, which markdown.ts empties so `:)` stays text.
declare module 'markdown-it-emoji' {
  import type MarkdownIt from 'markdown-it';

  export const full: (
    md: MarkdownIt,
    options?: { shortcuts?: Record<string, string | string[]> },
  ) => void;
}
