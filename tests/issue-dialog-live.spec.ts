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

// Two frames on: the page has run every microtask, effect and focus move that
// the last change set going. For a check that nothing further happens, where
// no change of its own says the work is over.
const settled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );

// Lets a held lookup answer, and returns once the page has read the answer and
// had two frames to act on it.
async function releaseLookup(page: Page, release: () => void) {
  const answered = page.waitForResponse((r) =>
    r.url().includes('includeHidden=true'),
  );
  release();
  await (await answered).finished();
  await settled(page);
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

const outgoingRefs = [
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

test('a second poll with the same data leaves the outgoing pills where they were', async ({
  page,
}) => {
  const world = makeWorld();
  world.references[1] = outgoingRefs;
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  await expect(band(dialog, 'Refs').locator('.linked-pr')).toHaveCount(1);

  // The first poll adds an incoming pull request.
  world.issues[1] = {
    ...world.issues[1],
    referencedByPullRequests: [linked(40)],
  };
  await push(page, world);
  await expect(band(dialog, 'Referenced by').locator('.linked-pr')).toHaveCount(
    1,
  );

  // The reader is on the outgoing pill; the next poll has nothing new.
  const refs = band(dialog, 'Refs').locator('.linked-pr');
  await refs.evaluate(
    (a) => ((a as unknown as { __old: boolean }).__old = true),
  );
  await refs.focus();
  // Nothing is written to the dialog for a poll that brings nothing new.
  await dialog.evaluate((el) => {
    const w = window as unknown as { __writes: number };
    w.__writes = 0;
    new MutationObserver((records) => {
      w.__writes += records.length;
    }).observe(el, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  await push(page, world);
  await push(page, world);
  // Polls are handled in order, so a later poll's visible change on the board
  // says the identical ones before it have been handled, with no fixed wait.
  world.issues[2] = { ...world.issues[2], title: 'Issue 2 after the polls' };
  await push(page, world);
  await expect(
    page.locator('#issue-rows .row', { hasText: 'Issue 2 after the polls' }),
  ).toHaveCount(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { __writes: number }).__writes,
    ),
    'an identical poll wrote to the dialog',
  ).toBe(0);

  expect(
    await refs.evaluate((a) => (a as unknown as { __old?: boolean }).__old),
    'an identical poll replaced the outgoing pill',
  ).toBe(true);
  await expect(refs).toBeFocused();
});

test('a poll that undoes the last one takes the row it added away again', async ({
  page,
}) => {
  const world = makeWorld();
  // The snapshot always carries all three lists, empty or not.
  world.issues[1] = { ...world.issues[1], referencedByPullRequests: [] };
  world.references[1] = outgoingRefs;
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  await expect(band(dialog, 'Refs').locator('.linked-pr')).toHaveCount(1);
  const before = world.issues[1];
  world.issues[1] = { ...before, referencedByPullRequests: [linked(40)] };
  await push(page, world);
  await expect(band(dialog, 'Referenced by')).toHaveCount(1);

  // The pull request stops referring to the issue: the band is what it was
  // before the first poll, which is not what the dialog last drew.
  world.issues[1] = before;
  await push(page, world);
  await expect(band(dialog, 'Referenced by')).toHaveCount(0);
  await expect(band(dialog, 'Refs').locator('.linked-pr')).toHaveCount(1);
});

test('details read again with the same references leave the pills in place', async ({
  page,
}) => {
  const world = makeWorld();
  world.references[1] = outgoingRefs;
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  const refs = band(dialog, 'Refs').locator('.linked-pr');
  await expect(refs).toHaveCount(1);
  await refs.evaluate(
    (a) => ((a as unknown as { __old: boolean }).__old = true),
  );

  await dialog.evaluate((el) => {
    const w = window as unknown as { __writes: string[] };
    w.__writes = [];
    new MutationObserver((records) => {
      for (const r of records)
        w.__writes.push(`${r.type} ${(r.target as Element).className}`);
    }).observe(el.querySelector('.related-band') as Element, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  // The issue changed, so its details are read again; the references did not.
  world.issues[1] = { ...world.issues[1], updatedAt: ago(1) };
  world.issueText[1] = 'Issue one text, edited.';
  await push(page, world);
  await expect(dialog).toContainText('Issue one text, edited.');
  await settled(page);
  expect(
    await page.evaluate(
      () => (window as unknown as { __writes: string[] }).__writes,
    ),
    'the band was written to though its references did not change',
  ).toEqual([]);
  expect(
    await refs.evaluate((a) => (a as unknown as { __old?: boolean }).__old),
    'the references were drawn again though nothing in them changed',
  ).toBe(true);
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
  // On the Issues page a pull request opens read-only, and the dialog follows
  // pushes only for an issue (followIssueDialog) or for the Pull requests
  // page's own dialog (settlePRs). So this one is not read again, and its
  // text stays as it was. Count the reads to check that.
  let pullReads = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/pull-requests/details')) pullReads++;
  });

  // The pull request merges, and the issue it left changes again.
  world.pulls[10] = { ...world.pulls[10], ci: 'success', updatedAt: ago(1) };
  world.pullText[10] = 'Pull ten text, edited.';
  world.issues[1] = { ...world.issues[1], updatedAt: ago(0) };
  world.issueText[1] = 'Issue one text, edited twice.';
  world.issues[2] = { ...world.issues[2], title: 'Issue 2 after the push' };
  await push(page, world);
  // Polls are handled in order, so a change to the board that shows up says
  // the changes above have been handled, with no fixed wait.
  await expect(
    page.locator('#issue-rows .row', { hasText: 'Issue 2 after the push' }),
  ).toHaveCount(1);
  // The marker says the push was handled; two frames let a read it started
  // reach the page.
  await settled(page);
  expect(pullReads, 'a push read the read-only pull request again').toBe(0);
  await expect(pr).toContainText('Pull ten text.');
  await expect(pr).not.toContainText('Pull ten text, edited.');
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
  await releaseLookup(page, release);

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
  await releaseLookup(page, release);

  await expect(pullDialog(page)).toContainText('Pull request 30');
  await expect(pullDialog(page)).not.toContainText('Pull request 11');
});

test('a pull request looked up late does not open over a read-only pull request the reader chose since', async ({
  page,
}) => {
  const world = makeWorld();
  // Issue 1 is closed by two pull requests the board leaves out. The reader
  // asks for PR 10 from a row pill, and the answer is held. They then ask for
  // PR 11 the same way, which answers at once and opens read only. No other
  // dialog opened in between, so only the read-only open itself tells the
  // late answer it is stale.
  world.issues[1] = {
    ...world.issues[1],
    linkedPullRequests: [linked(10), linked(11)],
    mentionedByPullRequests: [],
  };
  world.pulls[11] = {
    ...world.pulls[10],
    number: 11,
    title: 'Pull request 11',
  };
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = 0;
  await start(page, world, [10, 11], () =>
    asked++ === 0 ? held : Promise.resolve(),
  );
  const pills = page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('.linked-pr');
  await expect(pills).toHaveCount(2);

  await pills.nth(0).click();
  await expect.poll(() => asked).toBe(1);
  await pills.nth(1).click();
  await expect(pullDialog(page)).toContainText('Pull request 11');

  await releaseLookup(page, release);
  await expect(pullDialog(page)).toContainText('Pull request 11');
  await expect(pullDialog(page)).not.toContainText('Pull request 10');
});

test('the label chips stay the elements they were when the references arrive', async ({
  page,
}) => {
  const world = makeWorld();
  world.issues[1] = { ...world.issues[1], mentionedByPullRequests: [] };
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  const chip = dialog.locator('.details-attributes .attr-chip.label');
  await expect(chip).toHaveText('enhancement');
  await tag(dialog);

  // The issue now refers to another issue: its details answer with a
  // reference, which adds a pill and leaves the labels as they were.
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
  world.issues[1] = { ...world.issues[1], updatedAt: ago(1) };
  await push(page, world);
  await expect(dialog.locator('.related-band .linked-pr')).toHaveCount(2);

  expect(await survivors(dialog), 'the label chip was replaced').toContain(
    'labels',
  );
});

test('focus stays on the pill the reader had when the same pull request is in two rows', async ({
  page,
}) => {
  const world = makeWorld();
  // PR 10 closes the issue and also mentions it: two rows, one address.
  world.issues[1] = {
    ...world.issues[1],
    mentionedByPullRequests: [linked(10)],
  };
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  const pills = dialog.locator('.related-band .linked-pr');
  await expect(pills).toHaveCount(2);
  await expect(pills.nth(0)).toHaveAttribute('href', /\/10$/);
  await expect(pills.nth(1)).toHaveAttribute('href', /\/10$/);

  await pills.nth(1).focus();
  await pills
    .nth(1)
    .evaluate((a) => ((a as unknown as { __old: boolean }).__old = true));
  world.issues[1] = {
    ...world.issues[1],
    linkedPullRequests: [
      linked(10, { ci: 'success', checks: { ...none, passed: 2 } }),
    ],
    mentionedByPullRequests: [
      linked(10, { ci: 'success', checks: { ...none, passed: 2 } }),
    ],
  };
  await push(page, world);
  await expect(pills.nth(1)).toHaveAccessibleName(/Passed/);
  await settled(page);
  // The pill is the element it was: the band was patched, so focus never left
  // and nothing was put back.
  expect(
    await pills
      .nth(1)
      .evaluate((a) => (a as unknown as { __old?: boolean }).__old),
    'the band was replaced instead of patched',
  ).toBe(true);

  const focused = () =>
    dialog.evaluate((el) =>
      [...el.querySelectorAll('.related-band .linked-pr')].indexOf(
        document.activeElement as Element,
      ),
    );
  expect(await focused(), 'focus moved to another pill').toBe(1);
});

test('focus goes back to the same one of two pills for a pull request when the band is replaced', async ({
  page,
}) => {
  const world = makeWorld();
  world.issues[1] = {
    ...world.issues[1],
    mentionedByPullRequests: [linked(10)],
  };
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  const pills = dialog.locator('.related-band .linked-pr');
  await expect(pills).toHaveCount(2);

  await pills.nth(1).focus();
  await pills
    .nth(1)
    .evaluate((a) => ((a as unknown as { __old: boolean }).__old = true));
  // Another pull request now mentions the issue: the band lists other pills,
  // so it is drawn again and the pill the reader was on is a new element.
  world.issues[1] = {
    ...world.issues[1],
    mentionedByPullRequests: [linked(10), linked(40, { ci: 'none' })],
  };
  await push(page, world);
  await expect(pills).toHaveCount(3);
  expect(
    await dialog.evaluate((el) =>
      [...el.querySelectorAll('.related-band .linked-pr')].some(
        (a) => (a as unknown as { __old?: boolean }).__old,
      ),
    ),
    'the pill the reader was on was kept, so nothing was put back',
  ).toBe(false);

  // Focus comes back a tick after the band is drawn again, so it is polled for.
  await expect
    .poll(
      () =>
        dialog.evaluate((el) =>
          [...el.querySelectorAll('.related-band .linked-pr')].indexOf(
            document.activeElement as Element,
          ),
        ),
      { message: 'focus moved to another pill' },
    )
    .toBe(1);
});

const threePills = async (page: Page) => {
  const world = makeWorld();
  // One pull request closes the issue, mentions it and references it: three
  // pills, one address.
  world.issues[1] = {
    ...world.issues[1],
    mentionedByPullRequests: [linked(10)],
    referencedByPullRequests: [linked(10)],
  };
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  const pills = dialog.locator('.related-band .linked-pr');
  await expect(pills).toHaveCount(3);
  for (const i of [0, 1, 2])
    await expect(pills.nth(i)).toHaveAttribute('href', /\/10$/);
  const focused = () =>
    dialog.evaluate((el) =>
      [...el.querySelectorAll('.related-band .linked-pr')].indexOf(
        document.activeElement as Element,
      ),
    );
  return { world, dialog, pills, focused };
};

test('focus goes back to the middle one of three pills for a pull request when the band is replaced', async ({
  page,
}) => {
  const { world, pills, focused } = await threePills(page);

  await pills.nth(1).focus();
  // Another pull request now mentions the issue: the band is drawn again.
  world.issues[1] = {
    ...world.issues[1],
    mentionedByPullRequests: [linked(10), linked(40, { ci: 'none' })],
  };
  await push(page, world);
  await expect(pills).toHaveCount(4);

  // Focus comes back a tick after the band is drawn again, so it is polled for.
  await expect
    .poll(focused, { message: 'focus moved to another pill' })
    .toBe(1);
});

test('focus goes to the last pill for a pull request when the reader was on one that is gone', async ({
  page,
}) => {
  const { world, pills, focused } = await threePills(page);

  await pills.nth(2).focus();
  // The issue is no longer referenced: one pill fewer, so the band is drawn
  // again and the third pill the reader was on has no place to come back to.
  world.issues[1] = { ...world.issues[1], referencedByPullRequests: [] };
  await push(page, world);
  await expect(pills).toHaveCount(2);

  // Focus comes back a tick after the band is drawn again, so it is polled for.
  await expect
    .poll(focused, { message: 'focus was not kept on the pull request' })
    .toBe(1);
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

const mergedRef = (number: number, relation: string) => ({
  forge: 'github',
  repo: REPO,
  number,
  title: `Item ${number}`,
  url: `https://example.com/${REPO}/pull/${number}`,
  pageUrl: `/pull-requests.html?pr=github/${REPO}/${number}`,
  kind: 'pullRequest',
  state: 'merged',
  direction: 'incoming',
  relation,
});

test('a merged pull request from the details stays in the band of a listed issue across polls (#4462)', async ({
  page,
}) => {
  const world = makeWorld();
  world.issues[1] = { ...world.issues[1], mentionedByPullRequests: [] };
  world.references[1] = [
    mergedRef(90, 'refs'),
    mergedRef(91, 'mentions'),
    mergedRef(92, 'closes'),
  ];
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  const merged = (label: string) =>
    band(dialog, label).locator('.linked-pr', { hasText: 'Merged' });
  await expect(merged('Referenced by')).toHaveText(['PR #90 · Merged']);
  await expect(merged('Mentioned by')).toHaveText(['PR #91 · Merged']);
  await expect(merged('Closed by')).toHaveText(['PR #92 · Merged']);

  // A poll changes the board's pills: the open ones follow it, and the merged
  // ones read from the details are still there, once each.
  world.issues[1] = {
    ...world.issues[1],
    linkedPullRequests: [linked(11)],
    referencedByPullRequests: [linked(40)],
  };
  await push(page, world);
  await expect(band(dialog, 'Referenced by').locator('.linked-pr')).toHaveText([
    /PR #40/,
    'PR #90 · Merged',
  ]);
  await expect(band(dialog, 'Closed by').locator('.linked-pr')).toHaveText([
    /PR #11/,
    'PR #92 · Merged',
  ]);
  await expect(merged('Mentioned by')).toHaveText(['PR #91 · Merged']);
  await expect(dialog.locator('.related-count')).toHaveText('5');
});

test('a merged pull request the board no longer draws stays, from the details that listed it under a board pill (#4462)', async ({
  page,
}) => {
  const world = makeWorld();
  // Every row is present, so a read that adds nothing changes nothing shown.
  world.issues[1] = {
    ...world.issues[1],
    referencedByPullRequests: [],
    mentionedByPullRequests: [],
  };
  // 10 is on the board and in the details, so the board's pill is the one drawn.
  world.references[1] = [mergedRef(10, 'closes')];
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  await expect(closedBy(dialog)).toHaveText([/PR #10 · /]);
  await expect(closedBy(dialog)).not.toContainText('Merged');

  // The board drops its pill: the details still list 10, as merged.
  world.issues[1] = { ...world.issues[1], linkedPullRequests: [] };
  await push(page, world);
  await expect(closedBy(dialog)).toHaveText(['PR #10 · Merged']);
});

test('a merged pull request goes from the band when a new read of the details stops listing it (#4462)', async ({
  page,
}) => {
  const world = makeWorld();
  world.issues[1] = { ...world.issues[1], mentionedByPullRequests: [] };
  world.references[1] = [mergedRef(90, 'refs')];
  await start(page, world);
  await page
    .locator('#issue-rows .row', { hasText: 'Issue 1' })
    .locator('button.title')
    .click();
  const dialog = issueDialog(page);
  await expect(dialog).toContainText('Issue one text.');
  await expect(band(dialog, 'Referenced by').locator('.linked-pr')).toHaveCount(
    1,
  );

  // The issue changed, so the details are read again, and 90 is not in them.
  world.references[1] = [];
  world.issues[1] = { ...world.issues[1], updatedAt: ago(1) };
  await push(page, world);
  await expect(band(dialog, 'Referenced by')).toHaveCount(0);
});
