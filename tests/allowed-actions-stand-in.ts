// A stand-in for the server's `allowedActions`, `status` and `kind` on mocked
// snapshots (#805, #1375).
//
// The real server works out which actions each pull request offers
// (internal/dashboard/allowed_actions.go), why it is held back
// (pull_request_status.go) and what kind it is (bot_pr.go) and puts them on
// every pull request. Most specs here mock /api/dashboard with hand-written
// pull requests that carry only raw fields, so this fills them in on any
// mocked pull request that doesn't state its own. A mock that sets
// `allowedActions` itself (tests/allowed-actions.spec.ts) is left alone, which
// is how a spec says exactly what the server answered.
//
// There is no port of the rules here (#1437). The answers come from
// tests/generated/allowed-actions.json, which a Go test builds by running the
// real functions over every combination of the inputs they read, and fails on
// when the rules change and the file isn't regenerated. All this file does is
// name which combination a mocked pull request is, from its raw fields.
//
// outputFor is pure and refers to nothing outside itself, so the same source
// runs in the browser (fixtures.ts passes it to the installer) and in a spec's
// own Node-side snapshot builder.

import fixture from './generated/allowed-actions.json';

export type StandInPR = {
  forge: string;
  author?: string;
  labels?: { name: string }[];
  empty?: boolean;
  behind?: boolean;
  draft?: boolean;
  ci?: string;
  mergeStatus?: string;
  autoMergeEnabled?: boolean | null;
  autoMergeAllowed?: boolean | null;
  allowedActions?: unknown;
  status?: StandInStatus | null;
  kind?: string;
  stackedOn?: { number?: number } | null;
  headBranch?: string;
};

// What the server says holds a pull request back (#1375): the same shape as
// a blocked action.
export type StandInStatus = { code: string; message: string; next?: string };

export type StandInEntry = {
  action: string;
  blocked?: { code: string; message: string; next?: string };
};

export type Fixture = {
  axes: { name: string; values: string[] }[];
  outputs: {
    allowedActions: StandInEntry[];
    status: StandInStatus | null;
    kind: string;
  }[];
  table: number[];
};

// The server's answer for one mocked pull request, looked up in the generated
// table. A raw field the table has no value for is an error, not a guess:
// regenerate the table with a wider axis instead.
export function outputFor(fixture: Fixture, pr: StandInPR) {
  // Inputs that change the server's answer but are not axes of the table. A
  // mock that has one states its own allowedActions, status and kind.
  if ((pr.headBranch ?? '').startsWith('renovate/'))
    throw new Error(
      'allowed-actions fixture: a renovate/ head branch is not an axis; state allowedActions, status and kind in the mock',
    );
  if (pr.stackedOn && pr.stackedOn.number === undefined)
    throw new Error(
      'allowed-actions fixture: stackedOn needs a number to name the parent',
    );
  // The same author rules as bot_pr.go: the GitHub App's two spellings are
  // exact, and "renovatebot" is the one name matched without case.
  const named: Record<string, string> = {
    forge: pr.forge,
    author:
      pr.author === 'dependabot' || pr.author === 'dependabot[bot]'
        ? 'dependabot'
        : pr.author === 'renovate' ||
            pr.author === 'renovate[bot]' ||
            (pr.author ?? '').toLowerCase() === 'renovatebot'
          ? 'renovate'
          : 'person',
    release: (pr.labels ?? []).some((l) => l.name.startsWith('autorelease:'))
      ? 'yes'
      : 'no',
    empty: pr.empty ? 'yes' : 'no',
    behind: pr.behind ? 'yes' : 'no',
    draft: pr.draft ? 'yes' : 'no',
    ci: pr.ci ?? 'none',
    mergeStatus: pr.mergeStatus ?? 'unknown',
    autoMergeEnabled: pr.autoMergeEnabled === true ? 'on' : 'off',
    autoMergeAllowed: pr.autoMergeAllowed === false ? 'no' : 'yes',
    stacked: pr.stackedOn ? 'yes' : 'no',
  };
  let index = 0;
  for (const axis of fixture.axes) {
    const at = axis.values.indexOf(named[axis.name]);
    if (at < 0)
      throw new Error(
        `allowed-actions fixture has no ${axis.name} value "${named[axis.name]}" (has ${axis.values.join(', ')})`,
      );
    index = index * axis.values.length + at;
  }
  const output = fixture.outputs[fixture.table[index]];
  // The one message that names another pull request carries the generator's
  // placeholder number; say the mocked parent's instead.
  const parent = pr.stackedOn?.number;
  return parent === undefined
    ? output
    : JSON.parse(JSON.stringify(output).split('#999999999').join(`#${parent}`));
}

const fixtureData = fixture as Fixture;

export function allowedActionsFor(pr: StandInPR): StandInEntry[] {
  return structuredClone(outputFor(fixtureData, pr).allowedActions);
}

// The server's `status` for a pull request (internal/dashboard
// PullRequestStatus, #1375): why it is waiting or can't be merged, or null.
export function statusFor(pr: StandInPR): StandInStatus | null {
  return structuredClone(outputFor(fixtureData, pr).status);
}

export function kindFor(pr: StandInPR): string {
  return outputFor(fixtureData, pr).kind;
}

export { fixtureData as allowedActionsFixture };

// Runs in the browser. Self-contained apart from the table and the lookup it
// is handed, because it's sent over as source text.
export function installAllowedActionsStandIn(
  table: Fixture,
  lookup: (fixture: Fixture, pr: StandInPR) => ReturnType<typeof outputFor>,
) {
  function enrich<T>(data: T): T {
    const snapshot = data as unknown as {
      pullRequests?: StandInPR[];
      issues?: { title: string; housekeeping?: boolean }[];
      openIssueCount?: number;
      readIntervalSeconds?: number;
    };
    // The server tells the page how often to re-read (#809). A mock that
    // doesn't say gets the server's own default.
    if (snapshot && snapshot.readIntervalSeconds === undefined)
      snapshot.readIntervalSeconds = 30;
    if (snapshot && Array.isArray(snapshot.pullRequests))
      for (const pr of snapshot.pullRequests) {
        // Looked up only for what the mock leaves out, so a mock that states
        // all three is never held to the table's axes.
        const answer = () => lookup(table, pr);
        if (pr.allowedActions === undefined)
          pr.allowedActions = structuredClone(answer().allowedActions);
        // The server always sends a status: null when nothing holds the pull
        // request back. A mock that states its own is left alone.
        if (pr.status === undefined)
          pr.status = structuredClone(answer().status);
        // A mock that states its own kind is left alone.
        if (pr.kind === undefined) pr.kind = answer().kind;
      }
    // The server flags a bot's housekeeping issue and counts the rest
    // (#980). A mocked issue that states its own flag is left alone.
    if (snapshot && Array.isArray(snapshot.issues)) {
      for (const issue of snapshot.issues)
        if (issue.housekeeping === undefined)
          issue.housekeeping = issue.title.trim() === 'Dependency Dashboard';
      if (snapshot.openIssueCount === undefined)
        snapshot.openIssueCount = snapshot.issues.filter(
          (i) => !i.housekeeping,
        ).length;
    }
    return data;
  }

  // Mocked responses to the dashboard fetch and the refresh POST.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await realFetch(input, init);
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!/\/api\/dashboard(\/refresh)?(\?|$)/.test(url) || !res.ok) return res;
    if (!(res.headers.get('content-type') ?? '').includes('json')) return res;
    const data = enrich(await res.clone().json());
    return new Response(JSON.stringify(data), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };

  // Snapshots a spec pushes by calling the stream's handler directly.
  Object.defineProperty(EventSource.prototype, 'onmessage', {
    configurable: true,
    get(this: { __om?: (e: MessageEvent) => void }) {
      return this.__om ?? null;
    },
    set(
      this: EventSource & { __om?: ((e: MessageEvent) => void) | null },
      handler: ((e: MessageEvent) => void) | null,
    ) {
      if (this.__om) this.removeEventListener('message', this.__om);
      if (!handler) {
        this.__om = null;
        return;
      }
      const wrapped = (e: MessageEvent) => {
        let data = e.data;
        try {
          data = JSON.stringify(enrich(JSON.parse(e.data)));
        } catch {
          /* not a snapshot */
        }
        return handler.call(this, new MessageEvent(e.type, { data }));
      };
      this.__om = wrapped;
      this.addEventListener('message', wrapped);
    },
  });
}
