// The layout's /api/v1/dashboard read, for the pages that need more from it than
// the navigation counts: Insights, Settings and Webhooks. They used to make a
// one-shot read of their own at the same moment as the layout's, and two
// same-URL requests collide in the browser's HTTP cache lock (#1801). The
// layout is now the one reader.
//
// The store follows the layout's answers until one settles the page:
//  - While the first refresh runs the server answers with an empty snapshot
//    that says `firstRefreshDone: false`. Each such answer is shown and the
//    next replaces it, so the pages agree with the nav pills throughout.
//  - The first answer that is done (or carries no flag) latches. Later polls
//    are ignored from then on, so they cannot replace rows a person changed.
//  - A 4xx latches as a failure (the session is gone or the request is wrong,
//    and a retry would say the same). An aborted read, a network error or a
//    5xx settles nothing: the page keeps what it has and the next answer
//    decides.
// `state` is "pending" until the first answer or latched failure. `status` is
// the HTTP status of a latched failure. `lastError` is the message for the
// latest read that failed (a 5xx, a network error, or a 4xx other than 401,
// which sends the page to sign-in), cleared by the next answer. It does not
// settle anything: it only lets a page say the data did not load (#3212).

import { type ForgeCapabilities, registerForgeCapabilities } from './forges';

export type DashboardReadData = {
  repos?: unknown[];
  forges?: { forge: string; capabilities?: Partial<ForgeCapabilities> }[];
  pullRequests?: unknown[];
  issues?: unknown[];
  settingsHiddenIssueCount?: number;
  hideDependencyDashboard?: boolean;
  firstRefreshDone?: boolean;
};

export const dashboardRead = $state<{
  state: 'pending' | 'answered' | 'failed';
  data: DashboardReadData | null;
  status: number;
  latched: boolean;
  lastError: string | null;
}>({
  state: 'pending',
  data: null,
  status: 0,
  latched: false,
  lastError: null,
});

// The layout owns the read; it registers how to run it again so a page's Retry
// button can ask for one.
let rereader: (() => void) | null = null;

export function setDashboardRereader(fn: (() => void) | null) {
  rereader = fn;
}

export function retryDashboardRead() {
  // A latched failure ignores every later answer, so let this one decide.
  if (dashboardRead.state === 'failed') {
    dashboardRead.state = 'pending';
    dashboardRead.latched = false;
  }
  rereader?.();
}

export function resetDashboardRead() {
  dashboardRead.state = 'pending';
  dashboardRead.data = null;
  dashboardRead.status = 0;
  dashboardRead.latched = false;
  dashboardRead.lastError = null;
}

export function settleDashboardRead(
  data: DashboardReadData | null,
  status = 0,
  error: string | null = null,
) {
  if (dashboardRead.latched) return;
  if (data) {
    registerForgeCapabilities(data.forges);
    dashboardRead.data = data;
    dashboardRead.status = 200;
    dashboardRead.state = 'answered';
    dashboardRead.lastError = null;
    dashboardRead.latched = data.firstRefreshDone !== false;
    return;
  }
  if (status !== 401) dashboardRead.lastError = error;
  if (status < 400 || status >= 500) return;
  dashboardRead.data = null;
  dashboardRead.status = status;
  dashboardRead.state = 'failed';
  dashboardRead.latched = true;
}
