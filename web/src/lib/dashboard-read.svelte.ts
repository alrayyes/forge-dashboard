// The first answer to the layout's /api/dashboard read, for the pages that need
// more from it than the navigation counts: Insights, Settings and Webhooks.
// They used to make a one-shot read of their own at the same moment as the
// layout's, and two same-URL requests collide in the browser's HTTP cache lock
// (#1801). The layout is now the one reader.
//
// Only the first outcome is kept, answer or failure, because that is what the
// one-shot read gave these pages: a later poll must not replace the rows a
// person is editing, and a failure stays a failure for the page's lifetime.
// `state` is "pending" until the layout's first read ends. `status` is the HTTP
// status of an answer that was not usable (0 when no answer came at all).

export type DashboardReadData = {
  repos?: unknown[];
  forges?: unknown[];
  pullRequests?: unknown[];
  issues?: unknown[];
  settingsHiddenIssueCount?: number;
  hideDependencyDashboard?: boolean;
};

export const dashboardRead = $state<{
  state: 'pending' | 'answered' | 'failed';
  data: DashboardReadData | null;
  status: number;
}>({ state: 'pending', data: null, status: 0 });

export function resetDashboardRead() {
  dashboardRead.state = 'pending';
  dashboardRead.data = null;
  dashboardRead.status = 0;
}

export function settleDashboardRead(
  data: DashboardReadData | null,
  status = 0,
) {
  if (dashboardRead.state !== 'pending') return;
  dashboardRead.data = data;
  dashboardRead.status = data ? 200 : status;
  dashboardRead.state = data ? 'answered' : 'failed';
}
