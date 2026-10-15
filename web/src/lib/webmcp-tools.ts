// The WebMCP tools the page registers on document.modelContext, kept apart
// from the page so a unit test can import them without a browser (#1503).
// Each tool stands for one API operation (`operationId`), the same operation
// the server's MCP tool of the same name covers. The parity test
// (webmcp-parity.test.ts) holds that list against api/openapi.yaml.
// https://github.com/alrayyes/forge-dashboard/issues/1503

export interface WebMCPToolDef {
  name: string;
  /** The api/openapi.yaml operation this tool covers. */
  operationId: string;
  description: string;
  inputSchema: object;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

export interface WebMCPToolDeps {
  /** The page's own dashboard fetch, which also syncs the visible UI. */
  getDashboard(): Promise<unknown>;
  /** Called on a 401, before the tool throws. The page goes to sign in. */
  onSessionExpired?: () => void;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

const FORGES = ['github', 'forgejo'];

const pullRequestSchema = {
  type: 'object',
  properties: {
    forge: {
      type: 'string',
      enum: FORGES,
      description: 'Which forge hosts the repository.',
    },
    fullName: {
      type: 'string',
      description: '"owner/repo", as Repo.fullName in get_dashboard.',
    },
    number: {
      type: 'integer',
      description: 'The pull request number, as PullRequest.number.',
    },
  },
  required: ['forge', 'fullName', 'number'],
  additionalProperties: false,
};

function pullRequestQuery(input: Record<string, unknown>): string {
  const { forge, fullName, number } = input;
  if (typeof forge !== 'string' || !FORGES.includes(forge)) {
    throw new Error('forge must be "github" or "forgejo"');
  }
  if (typeof fullName !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
    throw new Error('fullName must be "owner/repo"');
  }
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    throw new Error('number must be a positive integer');
  }

  return new URLSearchParams({
    forge,
    fullName,
    number: String(number),
  }).toString();
}

export function createWebMCPTools(deps: WebMCPToolDeps): WebMCPToolDef[] {
  const doFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init));

  // The page's own error handling, as in fetchDashboardData(): the session
  // cookie rides along, a 401 sends the person to sign in.
  async function getJSON(url: string): Promise<unknown> {
    const res = await doFetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401) {
      deps.onSessionExpired?.();
      throw new Error('session expired');
    }
    if (!res.ok) throw new Error(`backend answered ${res.status}`);

    return res.json();
  }

  return [
    {
      name: 'get_dashboard',
      operationId: 'getDashboard',
      description:
        'Fetch the aggregated open pull requests, issues, and CI/forge health this dashboard already tracks across GitHub and Forgejo -- the same read-only data currently rendered on this page. Read-only: this never writes to either forge.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => deps.getDashboard(),
    },
    {
      name: 'get_main_branches',
      operationId: 'getMainBranches',
      description:
        "The CI status of every tracked repository's default branch: one row per repository with its latest pipeline (failed, passed, running or none), failed first, plus a count per status. Rows from a forge that could not be reached are kept and marked stale. Read-only: this never calls a forge.",
      inputSchema: { type: 'object', properties: {} },
      execute: () => getJSON('/api/main-branches'),
    },
    {
      name: 'get_pull_request_checks',
      operationId: 'getPullRequestChecks',
      description:
        "List every job or check run against one pull request's head commit, fetched live from the forge: each check's name, status and link. Empty when the commit has none. Take forge, fullName and number from get_dashboard. Read-only.",
      inputSchema: pullRequestSchema,
      execute: async (input) =>
        getJSON(`/api/pull-requests/checks?${pullRequestQuery(input)}`),
    },
    {
      name: 'get_pull_request_details',
      operationId: 'getPullRequestDetails',
      description:
        "Read one pull request's description, its comments in order, the thumbs up and thumbs down reactions on each with who gave them, and, for a release pull request, the release notes. Fetched live from the forge. Text is Markdown as the forge stores it, cut at 20,000 characters, and the conversation keeps its first 50 comments. Take forge, fullName and number from get_dashboard. Read-only.",
      inputSchema: pullRequestSchema,
      execute: async (input) =>
        getJSON(`/api/pull-requests/details?${pullRequestQuery(input)}`),
    },
  ];
}
