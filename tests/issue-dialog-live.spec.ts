import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { forgeHealth } from './forge-health-helper';
import { test } from './server-fixture';

// The issue dialog opened from the Issues overview while the forge's state
// changes (#4328). The reader opens an issue, clicks a related pull request,
// then a related issue, and the open item's state changes on the server at
// each step. What changed is patched where it stands: the dialog's nodes,
// scroll, focus and open folds stay, and a Related pill whose item changed is
// the same element, not a replacement. A change to something the dialog
// doesn't show touches nothing. Mocks /api/v1/dashboard, its stream and the
// details endpoints only and writes no saved state.

const REPO = 'alrayyes/forge-dashboard';
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const none = { passed: 0, running: 0, waiting: 0, failed: 0 };
const linked = (number: number, over: Record<string, unknown> = {}) => ({
  forge: 'github',
  repo: REPO,
  number,
  draft: false,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  ci: 'pending',
  checks: { ...none, running: 1 },
  awaitingWorkflowApproval: false,
  ...over,
});

const ticket = (number: number) => ({
  repo: REPO,
  number,
  url: `https://example.com/${REPO}/issues/${number}`,
  pageUrl: `/issues.html?issue=github/${REPO}/${number}`,
  tracked: true,
});

type World = {
  issues: Record<number, Record<string, unknown>>;
  pulls: Record<number, Record<string, unknown>>;
  // What the details endpoints answer, by item.
  issueText: Record<number, string>;
  pullText: Record<number, string>;
  // What an issue's details list as its references, by issue.
  references: Record<number, unknown[]>;
};

const mention = [20, 21, 22, 23, 24, 25, 26, 27];

const makeWorld = (): World => ({
  issues: {
    1: {
      forge: 'github',
      repo: REPO,
      number: 1,
      title: 'Issue 1',
      url: 'https://example.com/issues/1',
      author: 'ryankes',
      labels: [{ name: 'enhancement', color: 'aaaaaa' }],
      createdAt: ago(60),
      updatedAt: ago(30),
      linkedPullRequests: [linked(10)],
      mentionedByPullRequests: mention.map((n) => linked(n, { ci: 'none' })),
    },
    2: {
      forge: 'github',
      repo: REPO,
      number: 2,
      title: 'Issue 2',
      url: 'https://example.com/issues/2',
      author: 'ryankes',
      labels: [],
      createdAt: ago(60),
      updatedAt: ago(30),
      linkedPullRequests: [linked(10)],
    },
  },
  pulls: {
    10: {
      forge: 'github',
      repo: REPO,
      number: 10,
      title: 'Pull request 10',
      url: 'https://example.com/pull/10',
      author: 'ryankes',
      draft: false,
      ci: 'pending',
      labels: [],
      createdAt: ago(60),
      updatedAt: ago(30),
      mergeStatus: 'mergeable',
      behind: false,
      kind: 'regular',
      closesIssues: [ticket(2)],
    },
    30: {
      forge: 'github',
      repo: REPO,
      number: 30,
      title: 'Pull request 30',
      url: 'https://example.com/pull/30',
      author: 'ryankes',
      draft: false,
      ci: 'success',
      labels: [],
      createdAt: ago(60),
      updatedAt: ago(30),
      mergeStatus: 'mergeable',
      behind: false,
      kind: 'regular',
      closesIssues: [],
    },
  },
  issueText: { 1: 'Issue one text.', 2: 'Issue two text.' },
  pullText: { 10: 'Pull ten text.' },
  references: {},
});

const reactions = {
  thumbsUp: { count: 0, logins: [] },
  thumbsDown: { count: 0, logins: [] },
};
const detailsOf = (text: string) => ({
  description: {
    text,
    format: 'markdown',
    truncated: false,
    edited: false,
    reactions,
  },
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  releaseNotes: null,
  state: 'open',
});

const snapshot = (world: World) => ({
  generatedAt: new Date().toISOString(),
  forges: [forgeHealth('github')],
  pullRequests: Object.values(world.pulls),
  issues: Object.values(world.issues),
  repos: [],
  hiddenDrafts: 0,
});

async function start(
  page: Page,
  world: World,
  // Pull requests the board leaves out; a click on their pill looks them up.
  hidden: number[] = [],
  lookUp: () => Promise<void> = async () => {},
  path = '/issues.html',
) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __streams: EventSource[];
      EventSource: typeof EventSource;
    };
    w.__streams = [];
    const Real = w.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        w.__streams.push(this);
      }
    };
  });
  await page.route('**/api/v1/dashboard/stream*', (route) => route.abort());
  await page.route('**/api/v1/dashboard*', async (route: Route) => {
    const all = route.request().url().includes('includeHidden=true');
    if (all) await lookUp();
    const board = snapshot(world);
    if (!all)
      board.pullRequests = board.pullRequests.filter(
        (p) => !hidden.includes(p.number as number),
      );
    return route.fulfill({ json: board });
  });
  await page.route('**/api/v1/issues/details*', (route: Route) => {
    const n = Number(new URL(route.request().url()).searchParams.get('number'));
    return route.fulfill({
      json: {
        ...detailsOf(world.issueText[n] ?? ''),
        references: world.references[n] ?? [],
      },
    });
  });
  await page.route('**/api/v1/pull-requests/details*', (route: Route) => {
    const n = Number(new URL(route.request().url()).searchParams.get('number'));
    return route.fulfill({ json: detailsOf(world.pullText[n] ?? '') });
  });
  await page.goto(path);
  if (path === '/issues.html')
    await expect(page.locator('#issue-rows > .row')).toHaveCount(2);
}

// One snapshot pushed down the live stream: the forge's state changing.
async function push(page: Page, world: World) {
  await page.evaluate(
    (data) => {
      const w = window as unknown as { __streams: EventSource[] };
      for (const stream of w.__streams)
        stream.onmessage?.(new MessageEvent('message', { data }));
    },
    JSON.stringify(snapshot(world)),
  );
}

const issueDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Issue details/ });
const pullDialog = (page: Page) =>
  page.getByRole('dialog', { name: /^Pull request details/ });

// Marks the nodes a redraw would replace, so a later read says which survived.
const tag = (dialog: Locator) =>
  dialog.evaluate((el) => {
    const mark = (name: string, node: Element | null) => {
      if (node) (node as unknown as Record<string, string>).__tag = name;
    };
    mark('dialog', el);
    mark('header', el.querySelector('.details-header'));
    mark('band', el.querySelector('.related-band'));
    mark('body', el.querySelector('.details-body'));
    mark('labels', el.querySelector('.details-attributes .attr-chip.label'));
    for (const a of el.querySelectorAll('.related-band .linked-pr'))
      mark(`pill:${a.getAttribute('href')}`, a);
  });

const survivors = (dialog: Locator) =>
  dialog.evaluate((el) => {
    const found: string[] = [];
    const seen = (node: Element | null) => {
      const t = (node as unknown as { __tag?: string } | null)?.__tag;
      if (t) found.push(t);
    };
    seen(el);
    seen(el.querySelector('.details-header'));
    seen(el.querySelector('.related-band'));
    seen(el.querySelector('.details-body'));
    seen(el.querySelector('.details-attributes .attr-chip.label'));
    return found.sort();
  });

// The Related pills that are still the elements they were when tagged.
const keptPills = (dialog: Locator) =>
  dialog.evaluate((el) =>
    [...el.querySelectorAll('.related-band .linked-pr')]
      .map((a) => (a as unknown as { __tag?: string }).__tag)
      .filter((t): t is string => Boolean(t))
      .sort(),
  );

const band = (dialog: Locator, label: string) =>
  dialog.getByRole('group', { name: label });
const closedBy = (dialog: Locator) =>
  band(dialog, 'Closed by').locator('.linked-pr');

test('an issue opened from the overview patches in place while the forge changes under it', async ({
  page,
}) => {
  const world = makeWorld();
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  await expect(closedBy(dialog)).toHaveAccessibleName(
    /^Closed by: PR #10 · Open Running/,
  );

  // An open fold and a pill holding focus: both must outlive the updates.
  const toggle = dialog.locator('.related-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await closedBy(dialog).focus();
  await tag(dialog);
  const before = await survivors(dialog);
  const pillsBefore = await keptPills(dialog);
  expect(pillsBefore).toHaveLength(9);

  // Step 1: the issue itself changes (a label, its text).
  world.issues[1] = {
    ...world.issues[1],
    labels: [
      { name: 'enhancement', color: 'aaaaaa' },
      { name: 'bug', color: 'bbbbbb' },
    ],
    updatedAt: ago(1),
  };
  world.issueText[1] = 'Issue one text, edited.';
  await push(page, world);
  await expect(dialog).toContainText('Issue one text, edited.');
  await expect(dialog.locator('.attr-chip.label')).toHaveText([
    'enhancement',
    'bug',
  ]);
  // A label was added, so the label chips are drawn again; the rest stays.
  expect(await survivors(dialog), 'issue change replaced dialog nodes').toEqual(
    before.filter((name) => name !== 'labels'),
  );
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await keptPills(dialog), 'issue change replaced the pills').toEqual(
    pillsBefore,
  );

  // Each step is judged on its own: tag whatever is on screen now.
  await tag(dialog);

  // Step 2: the linked pull request's checks finish.
  world.issues[1] = {
    ...world.issues[1],
    linkedPullRequests: [
      linked(10, { ci: 'success', checks: { ...none, passed: 2 } }),
    ],
  };
  world.pulls[10] = { ...world.pulls[10], ci: 'success' };
  await push(page, world);
  await expect(closedBy(dialog)).toHaveAccessibleName(
    /^Closed by: PR #10 · Open Passed/,
  );
  expect(
    await survivors(dialog),
    'a linked pull request change replaced dialog nodes',
  ).toEqual(before);
  expect(
    await keptPills(dialog),
    'a linked pull request change replaced its pill',
  ).toEqual(pillsBefore);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(closedBy(dialog)).toBeFocused();

  await tag(dialog);

  // A pull request the issue does not link to changes nothing in it.
  world.pulls[30] = { ...world.pulls[30], ci: 'failure', updatedAt: ago(1) };
  await push(page, world);
  expect(await survivors(dialog), 'an unrelated pull request redrew').toEqual(
    before,
  );
  expect(await keptPills(dialog), 'an unrelated pull request redrew').toEqual(
    pillsBefore,
  );

  const axe = await new AxeBuilder({ page }).include('dialog[open]').analyze();
  expect(axe.violations).toEqual([]);
});

test('a Refs pill keeps its description and its element when its pull request changes', async ({
  page,
}) => {
  const world = makeWorld();
  // Eight pull requests that reference the issue: six show, two sit behind the
  // fold. Each Refs pill is wrapped with a tip that its description points at.
  const refs = [40, 41, 42, 43, 44, 45, 46, 47];
  world.issues[1] = {
    ...world.issues[1],
    mentionedByPullRequests: [],
    referencedByPullRequests: refs.map((n) => linked(n, { ci: 'none' })),
  };
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  const referenced = band(dialog, 'Referenced by').locator('.linked-pr');
  await expect(referenced).toHaveCount(6);
  await tag(dialog);
  const kept = await keptPills(dialog);

  // The idref of every shown Refs pill must name an element in the page.
  const dangling = () =>
    dialog.evaluate((el) =>
      [...el.querySelectorAll('.related-band .linked-pr')]
        .filter((a) => {
          const id = a.getAttribute('aria-describedby');
          return id && !document.getElementById(id);
        })
        .map((a) => a.getAttribute('href')),
    );
  expect(await dangling()).toEqual([]);

  // A shown pill's checks finish.
  world.issues[1] = {
    ...world.issues[1],
    referencedByPullRequests: refs.map((n) =>
      n === 40
        ? linked(n, { ci: 'success', checks: { ...none, passed: 2 } })
        : linked(n, { ci: 'none' }),
    ),
  };
  await push(page, world);
  await expect(referenced.first()).toHaveAccessibleName(/Passed/);
  expect(await keptPills(dialog), 'a Refs pill was replaced').toEqual(kept);
  expect(await dangling(), 'a Refs pill lost its tip').toEqual([]);
  await expect(referenced.first()).toHaveAccessibleDescription(
    /References this issue/,
  );

  // A pill behind the fold changes: the row is still patched, not replaced.
  world.issues[1] = {
    ...world.issues[1],
    referencedByPullRequests: refs.map((n) =>
      n === 40 || n === 47
        ? linked(n, { ci: 'success', checks: { ...none, passed: 2 } })
        : linked(n, { ci: 'none' }),
    ),
  };
  await push(page, world);
  expect(
    await keptPills(dialog),
    'a change behind the fold replaced the row',
  ).toEqual(kept);
  await band(dialog, 'Referenced by').locator('.related-toggle').click();
  await expect(referenced).toHaveCount(8);
  await expect(referenced.last()).toHaveAccessibleName(/Passed/);
  await expect(referenced.last()).toHaveAccessibleDescription(
    /References this issue/,
  );
  expect(await dangling()).toEqual([]);

  const axe = await new AxeBuilder({ page }).include('dialog[open]').analyze();
  expect(axe.violations).toEqual([]);
});

test('what an issue refers to and what refers to it are both patched in place', async ({
  page,
}) => {
  const world = makeWorld();
  world.issues[1] = {
    ...world.issues[1],
    mentionedByPullRequests: [],
    referencedByPullRequests: [linked(40, { ci: 'none' })],
  };
  // The issue itself refers to another issue: an outgoing Refs pill.
  world.references[1] = [
    {
      forge: 'github',
      repo: REPO,
      number: 60,
      title: 'Item 60',
      url: `https://example.com/${REPO}/issues/60`,
      pageUrl: `/issues.html?issue=github/${REPO}/60`,
      kind: 'issue',
      state: 'open',
      direction: 'outgoing',
      relation: 'refs',
    },
  ];
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  const pills = dialog.locator('.related-band .linked-pr');
  await expect(pills).toHaveCount(3);
  await tag(dialog);
  const kept = await keptPills(dialog);

  world.issues[1] = {
    ...world.issues[1],
    linkedPullRequests: [
      linked(10, { ci: 'success', checks: { ...none, passed: 2 } }),
    ],
    referencedByPullRequests: [
      linked(40, { ci: 'success', checks: { ...none, passed: 2 } }),
    ],
  };
  await push(page, world);
  await expect(
    band(dialog, 'Referenced by').locator('.linked-pr'),
  ).toHaveAccessibleName(/Passed/);
  expect(await keptPills(dialog), 'a pill was replaced').toEqual(kept);
  const dangling = await dialog.evaluate((el) =>
    [...el.querySelectorAll('.related-band .linked-pr')]
      .map((a) => a.getAttribute('aria-describedby'))
      .filter((id) => id && !document.getElementById(id)),
  );
  expect(dangling).toEqual([]);
  const axe = await new AxeBuilder({ page }).include('dialog[open]').analyze();
  expect(axe.violations).toEqual([]);
});

test('clicking a related pull request, then its related issue, while the open item changes', async ({
  page,
}) => {
  const world = makeWorld();
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  await expect(issueDialog(page)).toContainText('Issue one text.');

  // The issue changes just before the click.
  world.issues[1] = { ...world.issues[1], updatedAt: ago(1) };
  world.issueText[1] = 'Issue one text, edited.';
  await push(page, world);
  await closedBy(issueDialog(page)).click();

  // Step 3: the pull request opens, and it is the one that stays.
  const pr = pullDialog(page);
  await expect(pr).toContainText('Pull request 10');
  await expect(pr).toContainText('Pull ten text.');
  await expect(issueDialog(page)).toHaveCount(0);
  await tag(pr);
  const before = await survivors(pr);

  // The pull request merges, and the issue it left changes again.
  world.pulls[10] = { ...world.pulls[10], ci: 'success', updatedAt: ago(1) };
  world.pullText[10] = 'Pull ten text, edited.';
  world.issues[1] = { ...world.issues[1], updatedAt: ago(0) };
  world.issueText[1] = 'Issue one text, edited twice.';
  await push(page, world);
  await page.waitForTimeout(300);
  await expect(pr).not.toContainText('Issue one text');
  expect(await survivors(pr), 'a push replaced the pull request nodes').toEqual(
    before,
  );

  // Step 4: its related issue opens, and the issue then changes.
  await band(pr, 'Closes').locator('.linked-pr').click();
  const issue = issueDialog(page);
  await expect(issue).toContainText('Issue two text.');
  await expect(pullDialog(page)).toHaveCount(0);
  await tag(issue);
  const issueBefore = await survivors(issue);
  world.issues[2] = { ...world.issues[2], updatedAt: ago(0) };
  world.issueText[2] = 'Issue two text, edited.';
  world.pulls[10] = { ...world.pulls[10], updatedAt: ago(0) };
  await push(page, world);
  await expect(issue).toContainText('Issue two text, edited.');
  expect(await survivors(issue), 'a push replaced the issue nodes').toEqual(
    issueBefore,
  );
  const axe = await new AxeBuilder({ page }).include('dialog[open]').analyze();
  expect(axe.violations).toEqual([]);
});

test('a pull request looked up late does not open over what the reader chose since', async ({
  page,
}) => {
  const world = makeWorld();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await start(page, world, [10], () => held);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  await expect(issueDialog(page)).toContainText('Issue one text.');

  // The click closes the issue's dialog and asks for the pull request.
  await closedBy(issueDialog(page)).click();
  await expect(issueDialog(page)).toHaveCount(0);

  // The reader opens another issue before the answer comes.
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 2' })
    .locator('button.title')
    .click();
  await expect(issueDialog(page)).toContainText('Issue two text.');
  release();
  await page.waitForTimeout(500);

  await expect(pullDialog(page)).toHaveCount(0);
  await expect(issueDialog(page)).toContainText('Issue two text.');
});

test('a pull request looked up late does not open over a pull request the reader chose since', async ({
  page,
}) => {
  const world = makeWorld();
  // Issue 2 is closed by PR 11, which the board leaves out, and PR 30 closes
  // it, so the reader can reach issue 2 from a pull request on the board.
  world.issues[2] = { ...world.issues[2], linkedPullRequests: [linked(11)] };
  world.pulls[11] = {
    ...world.pulls[10],
    number: 11,
    title: 'Pull request 11',
  };
  world.pulls[30] = { ...world.pulls[30], closesIssues: [ticket(2)] };
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await start(page, world, [11], () => held, '/pull-requests.html');
  const row = page.getByRole('button', { name: /^#30 / });
  await row.click();
  await band(pullDialog(page), 'Closes').locator('.linked-pr').click();
  await expect(issueDialog(page)).toContainText('Issue two text.');

  // The click closes the issue's dialog and asks for PR 11, which is held.
  await closedBy(issueDialog(page)).click();
  await expect(issueDialog(page)).toHaveCount(0);

  // The reader opens a pull request from the board before the answer comes.
  await row.click();
  await expect(pullDialog(page)).toContainText('Pull request 30');
  release();
  await page.waitForTimeout(500);

  await expect(pullDialog(page)).toContainText('Pull request 30');
  await expect(pullDialog(page)).not.toContainText('Pull request 11');
});

test('the overview rows follow a linked pull request without a reload', async ({
  page,
}) => {
  const world = makeWorld();
  await start(page, world);
  const pill = page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('.linked-pr')
    .first();
  await expect(pill).toContainText('Running');

  world.issues[1] = {
    ...world.issues[1],
    linkedPullRequests: [
      linked(10, { ci: 'success', checks: { ...none, passed: 2 } }),
    ],
  };
  await push(page, world);

  await expect(pill).toContainText('Passed');
});
