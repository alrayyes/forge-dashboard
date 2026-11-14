// Test fixture: the forge entries the API sends, enough for the labels. Import
// it for its effect, as a page does by reading the API. Not used by the app.
import { registerForgeCapabilities } from './forges';

registerForgeCapabilities([
  { forge: 'github', capabilities: { label: 'GitHub' } },
  { forge: 'forgejo', capabilities: { label: 'Forgejo' } },
]);
