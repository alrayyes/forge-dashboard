// The one place the forge names map to what a page shows: the label, and the
// .forge-badge modifier that colours the pill. A module of its own so a page
// that needs just these (webhooks, Main branches) doesn't pull in the filter
// module with them (#1366).

// What a forge says it can do, as the API sends it in each forge's health
// (components.schemas.ForgeCapabilities). Only the part a page reads here.
export type ForgeCapabilities = {
  label: string;
  advisorySource: string;
  advisoryUnknownNeedsReason: boolean;
  // A job's log can be read while it runs.
  servesRunningLog: boolean;
  // The failed-job excerpt is read from the log endpoint, not the check list.
  serverLogExcerpts: boolean;
  // A run can be held until a person approves it.
  approvalGatedRuns: boolean;
};

export type ForgeFlag =
  | 'servesRunningLog'
  | 'serverLogExcerpts'
  | 'approvalGatedRuns';

const FLAGS: ForgeFlag[] = [
  'servesRunningLog',
  'serverLogExcerpts',
  'approvalGatedRuns',
];

// The flags of the two shipped forges, so a page that asks before the first
// read behaves as it will after it. tests/generated/forge-capabilities.json
// is the Go table; forges.test.ts keeps the two equal.
const SEED_FLAGS: Record<string, Partial<Record<ForgeFlag, boolean>>> = {
  github: {
    servesRunningLog: false,
    serverLogExcerpts: false,
    approvalGatedRuns: true,
  },
  forgejo: {
    servesRunningLog: true,
    serverLogExcerpts: true,
    approvalGatedRuns: false,
  },
};

let FORGE_FLAGS = structuredClone(SEED_FLAGS);

// Whether forge can do what flag names. False for a forge never heard of or
// not named: behaviour comes from here, never from the forge's name.
export function forgeCan(forge: string | undefined, flag: ForgeFlag): boolean {
  return !!forge && FORGE_FLAGS[forge]?.[flag] === true;
}

// What a forge's advisories are, as a page needs it: where they come from, and
// whether an unknown answer is worth saying only when the row names a reason.
export type AdvisoryFacts = { source: string; unknownNeedsReason: boolean };

// Seeded like the labels, and overridden by what the API sends. A forge in
// neither has no entry, so a page says nothing about its advisories rather than
// guessing they read like GitHub's.
const SEED_ADVISORY_FACTS: Record<string, AdvisoryFacts> = {
  github: { source: 'dependabot', unknownNeedsReason: false },
  forgejo: { source: 'osv', unknownNeedsReason: true },
};

const ADVISORY_FACTS: Record<string, AdvisoryFacts> =
  structuredClone(SEED_ADVISORY_FACTS);

export function advisoryFactsOf(forge: string): AdvisoryFacts | undefined {
  return ADVISORY_FACTS[forge];
}

// The label of each forge. Seeded with the two forges the app ships with, so a
// page that asks before the first read of the API, or a read whose forge entry
// carries no capabilities, still names them. A read's capabilities override
// these, and a forge added server-side shows its name through them; one this
// table has never heard of falls back to its id.
const SEED_LABELS: Record<string, string> = {
  github: 'GitHub',
  forgejo: 'Forgejo',
};

export const FORGE_LABELS: Record<string, string> = { ...SEED_LABELS };

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
    const flags = { ...FORGE_FLAGS[f.forge] };
    for (const flag of FLAGS) {
      const v = f.capabilities?.[flag];
      if (typeof v === 'boolean') flags[flag] = v;
    }
    if (f.capabilities) FORGE_FLAGS[f.forge] = flags;
    const source = f.capabilities?.advisorySource;
    if (source) {
      ADVISORY_FACTS[f.forge] = {
        source,
        unknownNeedsReason: f.capabilities?.advisoryUnknownNeedsReason ?? false,
      };
    }
  }
}

export const FORGE_CLASSES: Record<string, string> = {
  github: 'gh',
  forgejo: 'fj',
};

// Forgets what reads taught and restores the seeded forges. For tests: the
// registries are module state, and one test's forge must not leak into the
// next.
export function resetForgeCapabilities() {
  FORGE_FLAGS = structuredClone(SEED_FLAGS);
  for (const k of Object.keys(ADVISORY_FACTS)) delete ADVISORY_FACTS[k];
  Object.assign(ADVISORY_FACTS, structuredClone(SEED_ADVISORY_FACTS));
  for (const k of Object.keys(FORGE_LABELS)) delete FORGE_LABELS[k];
  Object.assign(FORGE_LABELS, SEED_LABELS);
}
