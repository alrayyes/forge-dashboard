import type { Preview } from '@storybook/sveltekit';
import './app-styles.ts';
import './preview.css';

const preview: Preview = {
  parameters: {
    layout: 'padded',
  },
};

export default preview;
