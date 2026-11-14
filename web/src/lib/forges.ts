// The one place the forge names map to what a page shows: the label, and the
// .forge-badge modifier that colours the pill. A module of its own so a page
// that needs just these (webhooks, Main branches) doesn't pull in the filter
// module with them (#1366).

// What a forge says it can do, as the API sends it in each forge's health
// (components.schemas.ForgeCapabilities). Only the part a page reads here.
export type ForgeCapabilities = { label: string };

// The label of each forge a read has named, read from its capabilities so no
// page keeps a table of its own. Empty until the first read of the API, and a
// page that asks before then falls back to the forge's id, as it does for a
// forge it has not heard of.
export const FORGE_LABELS: Record<string, string> = {};

// Learns the labels from the forge entries of a dashboard or Main branches
// answer. Every read calls it, so a forge added server-side shows its name
// without a change here.
export function registerForgeCapabilities(
  forges:
    | readonly { forge: string; capabilities?: Partial<ForgeCapabilities> }[]
    | undefined,
) {
  for (const f of forges ?? []) {
    const label = f.capabilities?.label;
    if (label) FORGE_LABELS[f.forge] = label;
  }
}

export const FORGE_CLASSES: Record<string, string> = {
  github: 'gh',
  forgejo: 'fj',
};
