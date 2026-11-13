import type { Locator, Page } from '@playwright/test';

// The pull request filter bar holds four labelled pill groups that combine
// (#3734), each with its own All. A pill is found by its text, which is unique
// across the groups. All is not, so ask for it by group.
export type PillGroup = 'forge' | 'ci' | 'merge' | 'review';

const GROUP_OF: Record<string, PillGroup> = {
  GitHub: 'forge',
  Forgejo: 'forge',
  Failing: 'ci',
  Running: 'ci',
  Passing: 'ci',
  'No checks': 'ci',
  Conflicting: 'merge',
  'Out of date': 'merge',
  Ready: 'review',
  'Needs review': 'review',
  'Review requested': 'review',
};

export function groupBar(page: Page, group?: PillGroup): Locator {
  return page.locator(
    group
      ? `.filter-bar .quick-pills[data-group="${group}"]`
      : '.filter-bar .quick-pills',
  );
}

export function quickPill(
  page: Page,
  name: string,
  group: PillGroup | undefined = GROUP_OF[name],
): Locator {
  return groupBar(page, group).getByRole('button', { name, exact: true });
}
