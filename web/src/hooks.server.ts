import criticalCss from 'virtual:critical-css';
import type { Handle } from '@sveltejs/kit/hooks';

// Only the build's prerender runs this (the Go binary serves the output), but
// the same rule holds: log the error, show a generic message (#1175).
export function handleError({ error }: { error: unknown }) {
  console.error(error);
  return { message: 'Something went wrong on our side' };
}

// SvelteKit leaves fonts out of its preload links by default. The Plex files
// the first paint uses arrive after it otherwise, and the swap from the
// fallback font reflows the footer (#1255). Only the latin 400 and 600
// weights, and only the woff2 files (every supported browser reads them):
// the ext subsets and the rest load when a glyph needs them.
export const handle: Handle = ({ event, resolve }) =>
  resolve(event, {
    transformPageChunk: ({ html }) =>
      html.replace(
        '<!--critical-css-->',
        () => `<style>${criticalCss}</style>`,
      ),
    preload: ({ type, path }) =>
      type !== 'font' ||
      /ibm-plex-(sans|mono)-latin-(400|600)-normal\.[\w-]+\.woff2$/.test(path),
  });
