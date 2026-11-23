/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writesForgeEntryByHand } from './forge-entries-by-hand';

// Every mocked `forges` entry comes from forgeHealth() (#4030), so `capabilities`
// is filled in one place. A file that still writes an entry by hand is listed
// here. The list only shrinks: converting a file means deleting its line, and a
// new hand-written entry in any other file fails this test.
const stillByHand = [
  'startup-banner.spec.ts',
  'startup-state.spec.ts',
  'stream-after-first-poll.spec.ts',
  'unreachable-age-tick.spec.ts',
  'unreachable-once.spec.ts',
  'actions-dialog-helper.spec.ts',
  'armed-behind-status.spec.ts',
  'branch-rerun-checks.spec.ts',
  'cancel-run.spec.ts',
  'dashboard.spec.ts',
  'forge-health-budgets.spec.ts',
  'forge-health-live-region.spec.ts',
  'forgejo-auto-merge.spec.ts',
  'hide-pull-request.spec.ts',
  'hit-areas.spec.ts',
  'inline-feedback.spec.ts',
  'in-place-dialogs.spec.ts',
  'insights.spec.ts',
  'landscape-first-row.spec.ts',
  'linked-pull-requests.spec.ts',
  'list-date-columns-root-font-size.spec.ts',
  'live-control.spec.ts',
  'main-branches-page.spec.ts',
  'main-branches-refetch-on-flag.spec.ts',
  'main-branches-server-copy.spec.ts',
  'main-branches-stream.spec.ts',
  'mentioned-tickets.spec.ts',
  'mobile-filters.spec.ts',
  'mono-figures.spec.ts',
  'nav-counts-helper.ts',
  'nav.spec.ts',
  'out-of-date-chip-fit.spec.ts',
  'out-of-date-filter.spec.ts',
  'pager-stepper.spec.ts',
  'page-tops.spec.ts',
  'pagination-focus.spec.ts',
  'pick-row-click.spec.ts',
  'pick-row-mouse.spec.ts',
  'pill-counts-add-up.spec.ts',
  'pill-groups-combine.spec.ts',
  'pills-axe.spec.ts',
  'placeholder-contrast.spec.ts',
  'profile-links.spec.ts',
  'pull-request-checks.spec.ts',
  'pull-request-dependabot-action.spec.ts',
  'pull-request-merge-refusal.spec.ts',
  'pull-request-merge.spec.ts',
  'pull-request-merge-states.spec.ts',
  'pull-request-number-filter.spec.ts',
  'pull-request-update-branch.spec.ts',
  'queued-action-feedback.spec.ts',
  'queued-for-reset.spec.ts',
  'rate-limit-actions.spec.ts',
  'rate-limit-readonly.spec.ts',
  'rate-limit-severity.spec.ts',
  'rebase-requested-behind.spec.ts',
  'reference-links-open-dialog.spec.ts',
  'reference-to-pull-request.spec.ts',
  'refresh-interval.spec.ts',
  'refresh-queue-focus.spec.ts',
  'refs-issues-filter.spec.ts',
  'refs-pills.spec.ts',
  'release-pr-behind.spec.ts',
  'releases-page.spec.ts',
  'repo-author-multi-select.spec.ts',
  'repo-logo.spec.ts',
  'repo-name-hover.spec.ts',
  'rerun-all.spec.ts',
  'review-comments-pill.spec.ts',
  'review-requested-pill.spec.ts',
  'root-font-size.spec.ts',
  'row-failure-lines.spec.ts',
  'row-opens-dialog.spec.ts',
  'row-status-grammar.spec.ts',
  'running-pill-counts.spec.ts',
  'segment-single-choice.spec.ts',
  'settings.spec.ts',
  'show-drafts-by-page.spec.ts',
  'show-drafts.spec.ts',
  'show-row-clears-filters.spec.ts',
  'skipped-pill-counts.spec.ts',
  'stable-rows.spec.ts',
  'stacked-prs.spec.ts',
  'stale-dashboard-instance.spec.ts',
  'timezone.spec.ts',
  'transient-failure-clears.spec.ts',
  'unknown-check-pill.spec.ts',
  'unreachable-banner-height.spec.ts',
  'unreachable-forge.spec.ts',
  'unreachable-incident.spec.ts',
  'update-all.spec.ts',
  'update-branch-on-row.spec.ts',
  'update-branch-request.spec.ts',
  'upstream-error-banner.spec.ts',
  'wait-chip.spec.ts',
  'webhooks-filter-choices.spec.ts',
  'webhooks-page.spec.ts',
  'webhooks-rebase-bots.spec.ts',
  'webmcp.spec.ts',
];

const dir = join(import.meta.dir, '..', 'tests');

const writtenByHand = readdirSync(dir)
  .filter((name) => name.endsWith('.ts') && name !== 'forge-health-helper.ts')
  .filter((name) =>
    writesForgeEntryByHand(readFileSync(join(dir, name), 'utf8')),
  )
  .sort();

test('no spec writes a forge entry by hand unless it is on the list (#4030)', () => {
  const added = writtenByHand.filter((name) => !stillByHand.includes(name));
  // Build the entry with forgeHealth() from tests/forge-health-helper.ts, which
  // fills `capabilities`. Do not add the file to the list above.
  expect(
    added,
    'build each forge entry with forgeHealth() from tests/forge-health-helper.ts instead of adding the file to stillByHand',
  ).toEqual([]);
});

test.each([
  ['plain', "{ forge: 'github', reachable: true, repoCount: 1 }"],
  ['reachable first', "{ reachable: true, forge: 'github' }"],
  ['leading spread', "{ ...base, forge: 'github', reachable: true }"],
  ['key between', "{ forge: 'github', repoCount: 1, reachable: true }"],
  ['quoted keys', "{ 'forge': 'github', \"reachable\": true }"],
  ['space before colon', "{ forge : 'github', reachable : true }"],
  ['shorthand', '{ forge, reachable: true, repoCount: 1 }'],
  ['multi-line', "{\n  forge: 'github',\n  reachable: true,\n}"],
  ['inside a list', 'forges: [{ forge: pr.forge, reachable: true }]'],
  [
    'after a regex literal holding a quote (#4443)',
    "const r = /'/; x = { forge: 'a', reachable: true }",
  ],
  [
    'inside a template substitution (#4443)',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test
    'const s = `a ${{ forge: 1, reachable: true }} b`;',
  ],
])('the detector catches a hand-written entry: %s (#4030)', (_name, source) => {
  expect(writesForgeEntryByHand(source)).toBe(true);
});

test.each([
  ['forgeHealth call', "forgeHealth('github', { reachable: false })"],
  ['forge only', "{ forge: 'github', repoCount: 1 }"],
  ['keys on different objects', "{ a: { forge: 'x' }, reachable: true }"],
  ['text, not keys', "const forgeName = 'reachable';"],
  [
    'words in a string inside a block',
    "async () => { const title = 'the forge is reachable now'; await go(); }",
  ],
  [
    'words in multi-line template text (#4443)',
    'const t = `\n  { forge: 1, reachable: 2 }\n`; const o = { a: 1 };',
  ],
  [
    'words in a line comment with an apostrophe (#4443)',
    "// it's { forge: 1, reachable: 2 }\nconst x = 'y';",
  ],
  [
    'words in a block comment (#4443)',
    '/* { forge: 1, reachable: true } */ const x = { a: 1 };',
  ],
  [
    'words in a regex literal (#4443)',
    'const o = { a: / forge, reachable, / };',
  ],
  [
    'a division is not a regex (#4443)',
    'const q = a / b; const o = { forge: 1 }; const z = c / d;',
  ],
])('the detector leaves alone: %s (#4030)', (_name, source) => {
  expect(writesForgeEntryByHand(source)).toBe(false);
});

test('a spec on the list still writes one, so the list shrinks as they convert (#4030)', () => {
  expect(stillByHand.filter((name) => !writtenByHand.includes(name))).toEqual(
    [],
  );
});
