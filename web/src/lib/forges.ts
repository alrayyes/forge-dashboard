// The one place the forge names map to what a page shows: the label, and the
// .forge-badge modifier that colours the pill. A module of its own so a page
// that needs just these (webhooks, Main branches) doesn't pull in the filter
// module with them (#1366).

// What a forge says it can do, as the API sends it in each forge's health
// (components.schemas.ForgeCapabilities). Only the part a page reads here.
export type ForgeCapabilities = { label: string };

// The label of each forge. Seeded with the two forges the app ships with, so a
// page that asks before the first read of the API, or a read whose forge entry
// carries no capabilities, still names them. A read's capabilities override
// these, and a forge added server-side shows its name through them; one this
// table has never heard of falls back to its id.
export const FORGE_LABELS: Record<string, string> = {
  github: 'GitHub',
  forgejo: 'Forgejo',
};

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
