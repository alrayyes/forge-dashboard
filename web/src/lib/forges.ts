// The one place the forge names map to what a page shows: the label, and the
// .forge-badge modifier that colours the pill. A module of its own so a page
// that needs just these (webhooks, Main branches) doesn't pull in the filter
// module with them (#1366).
export const FORGE_LABELS: Record<string, string> = {
  github: 'GitHub',
  forgejo: 'Forgejo',
};

export const FORGE_CLASSES: Record<string, string> = {
  github: 'gh',
  forgejo: 'fj',
};
