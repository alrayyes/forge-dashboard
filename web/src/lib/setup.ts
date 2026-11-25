// The first-login setup page's own reading of GET /api/v1/setup. The server
// states facts (who is authorized, which installations exist, how many
// repositories the board sees) and this module decides what they mean: which
// step is current, which state a row is in, whether Continue is enabled, and
// what a failure says. The facts are never turned into a verdict on the
// server, so a client that wants other wording has everything it needs.

export type SetupInstallation = {
  id: number;
  accountLogin: string;
  saved: boolean;
};

export type SetupGitHub = {
  configured: boolean;
  installUrl: string;
  authorized: boolean;
  account: string;
  installations: SetupInstallation[];
  installationsUnavailable: boolean;
  repositoryCount: number;
};

export type SetupForgejo = {
  redirectUri: string;
  scopes: string[];
  instanceUrl: string;
  linked: boolean;
  account: string;
  repositoryCount: number;
  reachable: boolean;
};

export type SetupFacts = {
  github: SetupGitHub;
  forgejo: SetupForgejo;
  refreshed: boolean;
};

// The server's error codes are an extensible enum, so a code this table has
// never heard of still earns a plain sentence. Nothing here echoes the forge's
// own text: the redirect carries a code and no more.
const ERROR_MESSAGES: Record<string, string> = {
  access_denied:
    'Authorization was cancelled or denied, so nothing was saved. Start again when you are ready.',
  invalid_state:
    'That sign-in link had expired or was not started here, so nothing was saved. Start again.',
  exchange_failed:
    'The forge did not accept the sign-in, so nothing was saved. Check the Client ID and the redirect URI, then try again.',
  account_unreadable:
    'The sign-in worked but the account could not be read, so nothing was saved. Try again.',
  save_failed:
    'Something went wrong saving the link. Nothing was saved. Try again.',
  not_connected: 'Authorize first, then install the app. Nothing was saved.',
  installation_unverified:
    'That installation could not be matched to your account, so it was not saved. Install the app on your own account or an organization you belong to.',
  installations_unavailable:
    'Your installations could not be read from GitHub just now. Use Check again in a moment.',
};

export const UNKNOWN_ERROR_MESSAGE =
  'Something went wrong and nothing was saved. Try again.';

export function setupErrorMessage(code: string): string {
  const known = Object.hasOwn(ERROR_MESSAGES, code)
    ? ERROR_MESSAGES[code]
    : undefined;
  return known ?? UNKNOWN_ERROR_MESSAGE;
}

export type SetupQuery = {
  // The code of a failed attempt, or "" when there was none.
  error: string;
  // An organization owner still has to approve the install request.
  installRequested: boolean;
};

export function parseSetupQuery(search: string): SetupQuery {
  const params = new URLSearchParams(search);
  return {
    error: params.get('error') ?? '',
    installRequested: params.get('install') === 'requested',
  };
}

export type StepState = 'done' | 'current' | 'todo';

export type InstallState = 'not-installed' | 'waiting' | 'connected';

export type InstallRow = {
  key: string;
  account: string;
  state: InstallState;
  // An organization is not the signed-in account, so its icon differs.
  organization: boolean;
};

export type RepoState =
  // The board has not finished a refresh, so zero means "not known yet".
  'counting' | 'none' | 'ready' | 'blocked';

export type ForgeView = {
  steps: [StepState, StepState, StepState];
  // 1 to 3: the step the person acts on next, or 3 when everything is done.
  current: 1 | 2 | 3;
  repos: RepoState;
  ready: boolean;
  // The steps still open, for the hint beside a disabled Continue.
  open: number[];
};

function repoState(
  reachedStep3: boolean,
  count: number,
  refreshed: boolean,
): RepoState {
  if (!reachedStep3) return 'blocked';
  if (count > 0) return 'ready';
  return refreshed ? 'none' : 'counting';
}

function toSteps(done: [boolean, boolean, boolean]): ForgeView['steps'] {
  const firstOpen = done.indexOf(false);
  return done.map((d, i) =>
    d ? 'done' : i === firstOpen ? 'current' : 'todo',
  ) as ForgeView['steps'];
}

export function installRows(
  gh: SetupGitHub,
  installRequested: boolean,
): InstallRow[] {
  const rows: InstallRow[] = gh.installations.map((i) => ({
    key: `i${i.id}`,
    account: i.accountLogin,
    state: i.saved ? 'connected' : 'not-installed',
    organization: i.accountLogin !== gh.account,
  }));
  // The signed-in account always has a row, so "Not installed" has somewhere
  // to show and Install on GitHub something to belong to.
  if (
    gh.authorized &&
    gh.account &&
    !rows.some((r) => r.account === gh.account)
  ) {
    rows.unshift({
      key: 'own',
      account: gh.account,
      state: 'not-installed',
      organization: false,
    });
  }
  // GitHub gives no name for a request still waiting on an owner, so it is
  // one row for "an organization", until an install appears.
  if (installRequested && !rows.some((r) => r.state === 'connected')) {
    rows.push({
      key: 'requested',
      account: 'An organization',
      state: 'waiting',
      organization: true,
    });
  }
  return rows;
}

export function githubView(facts: SetupFacts): ForgeView {
  const gh = facts.github;
  const authorized = gh.authorized;
  const installed = gh.installations.some((i) => i.saved);
  const repos = repoState(installed, gh.repositoryCount, facts.refreshed);
  const done: [boolean, boolean, boolean] = [
    authorized,
    installed,
    installed && (repos === 'ready' || repos === 'counting'),
  ];
  const steps = toSteps(done);
  return {
    steps,
    current: (steps.indexOf('current') + 1 || 3) as ForgeView['current'],
    repos,
    ready: done[2],
    open: [1, 2, 3].filter((n) => !done[n - 1]),
  };
}

export function forgejoView(facts: SetupFacts): ForgeView {
  const fj = facts.forgejo;
  const linked = fj.linked;
  const repos = repoState(linked, fj.repositoryCount, facts.refreshed);
  const done: [boolean, boolean, boolean] = [
    linked,
    linked,
    linked && (repos === 'ready' || repos === 'counting'),
  ];
  const steps = toSteps(done);
  return {
    steps,
    current: (steps.indexOf('current') + 1 || 3) as ForgeView['current'],
    repos,
    ready: done[2],
    open: [1, 2, 3].filter((n) => !done[n - 1]),
  };
}

export type Continue = { enabled: boolean; hint: string };

function stepList(open: number[]): string {
  if (open.length === 0) return '';
  if (open.length === 1) return `step ${open[0]}`;
  return `steps ${open.slice(0, -1).join(', ')} and ${open.at(-1)}`;
}

// Continue opens once one forge is at its last step. While it is shut, the
// hint says which steps are left, naming the forge the person has started.
export function continueState(facts: SetupFacts): Continue {
  const gh = githubView(facts);
  const fj = forgejoView(facts);
  if (gh.ready || fj.ready) return { enabled: true, hint: '' };
  const ghStarted = facts.github.authorized;
  const fjStarted = facts.forgejo.linked;
  if (ghStarted && !fjStarted) {
    return {
      enabled: false,
      hint: `Finish ${stepList(gh.open)} for GitHub, or set up Forgejo.`,
    };
  }
  if (fjStarted && !ghStarted) {
    return {
      enabled: false,
      hint: `Finish ${stepList(fj.open)} for Forgejo, or set up GitHub.`,
    };
  }
  return {
    enabled: false,
    hint: 'Set up GitHub or Forgejo to continue. One is enough.',
  };
}

// Whether the board has anything to show: a linked Forgejo, or a GitHub
// account with an installation. The layout around every other page sends a
// person who has neither to the setup page.
export function isLinked(facts: SetupFacts): boolean {
  return (
    facts.forgejo.linked || facts.github.installations.some((i) => i.saved)
  );
}

// Parses an answer from GET /api/v1/setup, or null when it is not one, so a
// stand-in answer never sends anybody anywhere.
export function readSetupFacts(body: unknown): SetupFacts | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Partial<SetupFacts>;
  if (!b.github || !b.forgejo || !Array.isArray(b.github.installations)) {
    return null;
  }
  return {
    github: b.github,
    forgejo: b.forgejo,
    refreshed: b.refreshed === true,
  };
}

// Where the person creates the OAuth app on their own Forgejo, from the
// address they typed. Empty for anything that is not an http(s) address, so a
// link is never built from text like `javascript:`.
export function forgejoAppsUrl(instanceUrl: string): string {
  try {
    const u = new URL(instanceUrl.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}/user/settings/applications`;
  } catch {
    return '';
  }
}
