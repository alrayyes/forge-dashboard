import type { Preview } from '@storybook/sveltekit';
// The app's own fonts and its one global stylesheet, as +layout.svelte and
// app.html load them, so a story looks like the page it comes from.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '../src/style.css';
import './preview.css';

const preview: Preview = {
  parameters: {
    layout: 'padded',
  },
};

export default preview;
