// The one place the forge names map to what a page shows: the label, and the
// .forge-badge modifier that colours the pill. A module of its own so a page
// that needs just these (webhooks, Main branches) doesn't pull in the filter
// module with them (#1366).

// What a forge says it can do, as the API sends it in each forge's health
// (components.schemas.ForgeCapabilities). Only the part a page reads here.
export type ForgeCapabilities = {
  label: string;
  // The forge's public status page, empty when it has none.
  statusPageUrl: string;
  advisorySource: string;
  advisoryUnknownNeedsReason: boolean;
  // A job's log can be read while it runs.
  servesRunningLog: boolean;
  // The failed-job excerpt is read from the log endpoint, not the check list.
  serverLogExcerpts: boolean;
  // A run can be held until a person approves it.
  approvalGatedRuns: boolean;
  // This app, not the forge, holds an armed auto-merge and performs the merge.
  autoMergeHeldByApp: boolean;
  // The forge sends the user's permissions with each repo it lists, so a repo
  // without them is the forge's omission, not the user's role.
  reportsRepoPermissions: boolean;
  // How the forge budgets requests: 'graphql_and_rest' (two allowances the
  // forge counts itself) or 'rest'. Open-ended.
  rateLimitModel: string;
};

export type ForgeFlag =
  | 'servesRunningLog'
  | 'serverLogExcerpts'
  | 'approvalGatedRuns'
  | 'autoMergeHeldByApp'
  | 'reportsRepoPermissions';

const FLAGS: ForgeFlag[] = [
  'servesRunningLog',
  'serverLogExcerpts',
  'approvalGatedRuns',
  'autoMergeHeldByApp',
  'reportsRepoPermissions',
];

// The flags of the two shipped forges, so a page that asks before the first
// read behaves as it will after it. tests/generated/forge-capabilities.json
// is the Go table; forges.test.ts keeps the two equal.
const SEED_FLAGS: Record<string, Partial<Record<ForgeFlag, boolean>>> = {
  github: {
    servesRunningLog: false,
    serverLogExcerpts: false,
    approvalGatedRuns: true,
    autoMergeHeldByApp: false,
    reportsRepoPermissions: false,
  },
  forgejo: {
    servesRunningLog: true,
    serverLogExcerpts: true,
    approvalGatedRuns: false,
    autoMergeHeldByApp: true,
    reportsRepoPermissions: true,
  },
};

let FORGE_FLAGS = structuredClone(SEED_FLAGS);

// Whether forge can do what flag names. False for a forge never heard of or
// not named: behaviour comes from here, never from the forge's name.
export function forgeCan(forge: string | undefined, flag: ForgeFlag): boolean {
  return !!forge && FORGE_FLAGS[forge]?.[flag] === true;
}

const SEED_RATE_LIMIT_MODELS: Record<string, string> = {
  github: 'graphql_and_rest',
  forgejo: 'rest',
};

let RATE_LIMIT_MODELS = { ...SEED_RATE_LIMIT_MODELS };

// How a forge budgets requests, or '' for one nobody described.
export function rateLimitModelOf(forge: string | undefined): string {
  return (forge && RATE_LIMIT_MODELS[forge]) || '';
}

// What a forge said about a flag: undefined when it never did, so a caller can
// keep a safe default for a forge nobody described.
export function forgeFlag(
  forge: string | undefined,
  flag: ForgeFlag,
): boolean | undefined {
  return forge ? FORGE_FLAGS[forge]?.[flag] : undefined;
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

// Which images a forge's text may embed, and how the server must fetch them
// (#4156). `hosts` are the fixed public hosts, reached over https on the
// default port; empty means the item's own instance, whatever origin its
// repository lives on. `signedAttachmentPrefix` is the address prefix of an
// attachment the forge serves only at a signed link the server finds in the
// item's rendered body, so the page must name the item; absent when none is.
// The server holds the same rules and is the one that enforces them.
export type ImagePolicy = {
  hosts: readonly string[];
  signedAttachmentPrefix?: string;
};

const SEED_IMAGE_POLICIES: Record<string, ImagePolicy> = {
  github: {
    hosts: [
      'github.com',
      'user-images.githubusercontent.com',
      'private-user-images.githubusercontent.com',
      'raw.githubusercontent.com',
      'gist.githubusercontent.com',
    ],
    signedAttachmentPrefix: 'https://github.com/user-attachments/',
  },
  forgejo: { hosts: [] },
};

const IMAGE_POLICIES: Record<string, ImagePolicy> =
  structuredClone(SEED_IMAGE_POLICIES);

// The image rules of forge, or undefined for one nobody described: its images
// are then never asked for.
export function imagePolicyOf(forge: string): ImagePolicy | undefined {
  return IMAGE_POLICIES[forge];
}

export function registerImagePolicy(forge: string, policy: ImagePolicy) {
  IMAGE_POLICIES[forge] = policy;
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

// The forges a page may offer or accept, in display order: the two shipped
// ones, then any the server reports. The one list the filters, the saved
// state and the WebMCP tools read instead of naming github and forgejo.
const SEED_FORGE_IDS = ['github', 'forgejo'];

let FORGE_IDS = [...SEED_FORGE_IDS];

export function forgeIds(): string[] {
  return [...FORGE_IDS];
}

export function isKnownForge(forge: unknown): forge is string {
  return typeof forge === 'string' && FORGE_IDS.includes(forge);
}

// The forges as an error message names them: "a", "b" or "c".
export function forgeListText(): string {
  const quoted = FORGE_IDS.map((f) => `"${f}"`);
  const last = quoted.pop();

  return quoted.length ? `${quoted.join(', ')} or ${last}` : (last ?? '');
}

export const FORGE_LABELS: Record<string, string> = { ...SEED_LABELS };

// Each forge's public status page, seeded and overridden like the labels. A
// forge with none, or one never heard of, has no entry.
const SEED_STATUS_PAGES: Record<string, string> = {
  github: 'https://www.githubstatus.com/',
};

const STATUS_PAGES: Record<string, string> = { ...SEED_STATUS_PAGES };

// Where to link a forge's own status report, or '' when it has none.
export function statusPageUrlOf(forge: string): string {
  return STATUS_PAGES[forge] ?? '';
}

// Learns the labels from the forge entries of a dashboard or Main branches
// answer. Every read calls it, so a forge added server-side shows its name
// without a change here.
export function registerForgeCapabilities(
  forges:
    | readonly { forge: string; capabilities?: Partial<ForgeCapabilities> }[]
    | undefined,
) {
  for (const f of forges ?? []) {
    if (f.forge && !FORGE_IDS.includes(f.forge)) FORGE_IDS.push(f.forge);
    const label = f.capabilities?.label;
    if (label) FORGE_LABELS[f.forge] = label;
    const statusPage = f.capabilities?.statusPageUrl;
    if (typeof statusPage === 'string') STATUS_PAGES[f.forge] = statusPage;
    const flags = { ...FORGE_FLAGS[f.forge] };
    for (const flag of FLAGS) {
      const v = f.capabilities?.[flag];
      if (typeof v === 'boolean') flags[flag] = v;
    }
    if (f.capabilities) FORGE_FLAGS[f.forge] = flags;
    const model = f.capabilities?.rateLimitModel;
    if (model) RATE_LIMIT_MODELS[f.forge] = model;
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
  FORGE_IDS = [...SEED_FORGE_IDS];
  FORGE_FLAGS = structuredClone(SEED_FLAGS);
  RATE_LIMIT_MODELS = { ...SEED_RATE_LIMIT_MODELS };
  for (const k of Object.keys(ADVISORY_FACTS)) delete ADVISORY_FACTS[k];
  Object.assign(ADVISORY_FACTS, structuredClone(SEED_ADVISORY_FACTS));
  for (const k of Object.keys(FORGE_LABELS)) delete FORGE_LABELS[k];
  Object.assign(FORGE_LABELS, SEED_LABELS);
  for (const k of Object.keys(IMAGE_POLICIES)) delete IMAGE_POLICIES[k];
  Object.assign(IMAGE_POLICIES, structuredClone(SEED_IMAGE_POLICIES));
  for (const k of Object.keys(STATUS_PAGES)) delete STATUS_PAGES[k];
  Object.assign(STATUS_PAGES, SEED_STATUS_PAGES);
}
