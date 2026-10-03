// A stand-in for the server's `allowedActions` on mocked snapshots (#805).
//
// The real server works out which actions each pull request offers
// (internal/dashboard/allowed_actions.go) and puts them on every pull
// request. Most specs here mock /api/dashboard with hand-written pull
// requests that carry only raw fields, so this fills in `allowedActions` on
// any mocked pull request that doesn't state its own. It is a test double,
// not the page's logic: the page holds no copy of these rules, and a mock
// that sets `allowedActions` itself (tests/allowed-actions.spec.ts) is left
// alone, which is how a spec says exactly what the server answered.
//
// This is a port of the Go rules and has to follow them. When
// allowed_actions.go changes, change this too.
//
// allowedActionsFor is pure and refers to nothing outside itself, so the
// same source runs in the browser (fixtures.ts passes it to the installer)
// and in a spec's own Node-side snapshot builder.

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
};

export type StandInEntry = {
  action: string;
  blocked?: { code: string; message: string; next?: string };
};

export function allowedActionsFor(pr: StandInPR): StandInEntry[] {
  const isDependabot =
    pr.author === 'dependabot' || pr.author === 'dependabot[bot]';
  const isRenovate = pr.author === 'renovate' || pr.author === 'renovate[bot]';
  const isReleasePlease = (pr.labels ?? []).some((l) =>
    l.name.startsWith('autorelease:'),
  );

  const blockedMerge = (
    code: string,
    message: string,
    next?: string,
  ): StandInEntry => ({
    action: 'merge',
    blocked: next ? { code, message, next } : { code, message },
  });

  function merge(): StandInEntry {
    if (pr.empty)
      return blockedMerge(
        'already_up_to_date',
        'Already up to date with the target branch — merging would be empty.',
      );
    if (pr.mergeStatus === 'conflicting')
      return blockedMerge(
        'conflict',
        'Merge conflict',
        'Resolve it on the forge to unlock Merge',
      );
    if (pr.draft && pr.mergeStatus !== 'mergeable')
      return blockedMerge(
        'not_mergeable',
        'Draft pull request',
        'Mark it ready for review to unlock Merge',
      );
    if (pr.ci === 'pending')
      return blockedMerge(
        'checks_pending',
        'Waiting for CI to finish',
        'Merge unlocks automatically',
      );
    if (pr.behind && pr.mergeStatus !== 'mergeable')
      return blockedMerge(
        'behind',
        'Behind the base branch',
        'Bring it up to date to unlock Merge',
      );
    if (pr.mergeStatus === 'blocked' && pr.ci === 'failure')
      return blockedMerge(
        'checks_failing',
        'Blocked, CI is failing',
        'Fix the failing check to unlock Merge',
      );
    if (pr.mergeStatus === 'blocked')
      return blockedMerge(
        'blocked_by_protection',
        'Blocked by the forge',
        'A required check or review is missing',
      );
    if (pr.mergeStatus !== 'mergeable')
      return blockedMerge(
        'not_mergeable',
        'Merge status not known yet',
        'Merge unlocks once the forge reports it',
      );
    return { action: 'merge' };
  }

  function updateBranch(): StandInEntry | null {
    if (!pr.behind || pr.empty) return null;
    if ((isDependabot || isRenovate) && !isReleasePlease) return null;
    if (pr.mergeStatus === 'conflicting')
      return {
        action: 'update_branch',
        blocked: {
          code: 'conflict',
          message: 'Conflicts need fixing by hand — resolve them on the forge.',
        },
      };
    return { action: 'update_branch' };
  }

  function autoMergeOffered(): boolean {
    if (pr.forge !== 'github') return false;
    if (pr.autoMergeEnabled === true) return false;
    if (pr.autoMergeAllowed === false) return false;
    if (pr.empty || pr.mergeStatus === 'conflicting') return false;
    if (pr.mergeStatus === 'mergeable' && pr.ci === 'success' && !pr.behind)
      return false;
    return true;
  }

  const out: StandInEntry[] = [merge(), { action: 'close' }];
  const ub = updateBranch();
  if (ub) out.push(ub);
  if (autoMergeOffered()) out.push({ action: 'auto_merge' });
  if (pr.forge === 'github' && isDependabot)
    out.push(
      { action: 'dependabot_rebase' },
      { action: 'dependabot_recreate' },
    );
  if (isRenovate) out.push({ action: 'renovate_rebase' });
  return out;
}

// Runs in the browser. Self-contained apart from the rule function it is
// handed, because it's sent over as source text.
export function installAllowedActionsStandIn(
  allowedFor: (pr: StandInPR) => StandInEntry[],
) {
  function enrich<T>(data: T): T {
    const snapshot = data as unknown as { pullRequests?: StandInPR[] };
    if (snapshot && Array.isArray(snapshot.pullRequests))
      for (const pr of snapshot.pullRequests)
        if (pr.allowedActions === undefined) pr.allowedActions = allowedFor(pr);
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
