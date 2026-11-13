<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, userEvent, waitFor } from "storybook/test";
  import { mockFetch } from "../../.storybook/mock-fetch";
  import type {
    DetailsTarget,
    ItemTarget,
  } from "./PullRequestDetailsDialog.svelte";
  import PullRequestDetailsDialog from "./PullRequestDetailsDialog.svelte";

  const { Story } = defineMeta({
    title: "PullRequestDetailsDialog",
    component: PullRequestDetailsDialog,
    parameters: { layout: "fullscreen" },
  });

  const hoursAgo = (n: number) =>
    new Date(Date.now() - n * 3_600_000).toISOString();
  const none = { count: 0, logins: [] };
  const reactions = { thumbsUp: none, thumbsDown: none };
  const body = (text: string, over: Record<string, unknown> = {}) => ({
    text,
    truncated: false,
    edited: false,
    reactions,
    ...over,
  });
  const comment = (
    id: string,
    login: string,
    text: string,
    over: Record<string, unknown> = {},
  ) => ({
    ...body(text, over),
    id,
    author: { login, avatarUrl: "", url: `https://github.com/${login}` },
    createdAt: hoursAgo(5),
    updatedAt: null,
  });

  const DETAILS = {
    description: body(
      "Adds a Storybook catalog so every component can be screenshotted in each state.\n\n- Installs `@storybook/sveltekit`\n- One story per state that matters\n\nCloses #3239",
      {
        reactions: {
          thumbsUp: { count: 2, logins: ["alrayyes", "renovate"] },
          thumbsDown: none,
        },
      },
    ),
    comments: [
      comment(
        "c1",
        "alrayyes",
        "Looks good. Can the dialogs open from a story?",
      ),
      comment(
        "c2",
        "claude",
        "Yes. Each dialog story has a small opener button, and its `play` function clicks it.",
        { edited: true },
      ),
    ],
    commentCount: 2,
    commentsTruncated: false,
  };

  const PULL_REQUEST: ItemTarget = {
    forge: "github",
    repo: "alrayyes/forge-dashboard",
    title: "feat(web): add a Storybook component catalog",
    url: "https://github.com/alrayyes/forge-dashboard/pull/3240",
    subject: "pull-request",
    number: 3240,
    kind: "regular",
  };

  const ROUTE = /\/api\/v1\/(pull-requests|issues|releases)\/details/;

  const opened = async (canvasElement: HTMLElement) => {
    await userEvent.click(
      canvasElement.querySelector("#open-details") as HTMLElement,
    );
    await waitFor(() =>
      expect(document.querySelector("dialog[open]")).not.toBeNull(),
    );
  };

  const loaded = async (canvasElement: HTMLElement) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".details-section")).not.toBeNull(),
    );
  };
</script>

<script lang="ts">
  let dialog = $state<PullRequestDetailsDialog>();
</script>

{#snippet opener(target: DetailsTarget)}
  <!-- The row's title link; focus returns to it when the dialog closes. -->
  <button
    type="button"
    id="open-details"
    onclick={() => dialog?.open(target, "open-details")}>Open details</button
  >
  <PullRequestDetailsDialog bind:this={dialog} />
{/snippet}

<!-- The dialog is closed: only the control that opens it is on the page. -->
<Story asChild name="Closed">{@render opener(PULL_REQUEST)}</Story>

<!-- The details are being fetched. -->
<Story
  asChild
  name="Loading"
  beforeEach={() => mockFetch([{ match: ROUTE, hang: true }])}
  play={async ({ canvasElement }) => opened(canvasElement)}
>
  {@render opener(PULL_REQUEST)}
</Story>

<!-- A pull request with a description and a conversation. -->
<Story
  asChild
  name="Pull request"
  beforeEach={() => mockFetch([{ match: ROUTE, body: DETAILS }])}
  play={async ({ canvasElement }) => {
    await loaded(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".details-comment")).not.toBeNull(),
    );
  }}
>
  {@render opener(PULL_REQUEST)}
</Story>

<!-- No description and no comments. -->
<Story
  asChild
  name="Empty"
  beforeEach={() =>
    mockFetch([
      {
        match: ROUTE,
        body: {
          description: body(""),
          comments: [],
          commentCount: 0,
          commentsTruncated: false,
        },
      },
    ])}
  play={async ({ canvasElement }) => loaded(canvasElement)}
>
  {@render opener(PULL_REQUEST)}
</Story>

<!-- A long description and conversation are cut, and the dialog says so. -->
<Story
  asChild
  name="Cut off"
  beforeEach={() =>
    mockFetch([
      {
        match: ROUTE,
        body: {
          ...DETAILS,
          description: { ...DETAILS.description, truncated: true },
          comments: [
            comment("c1", "alrayyes", "First of many.", { truncated: true }),
          ],
          commentCount: 120,
          commentsTruncated: true,
        },
      },
    ])}
  play={async ({ canvasElement }) => loaded(canvasElement)}
>
  {@render opener(PULL_REQUEST)}
</Story>

<!-- A bot's pull request keeps its description folded away. -->
<Story
  asChild
  name="Dependency bump"
  beforeEach={() =>
    mockFetch([
      {
        match: ROUTE,
        body: {
          description: body(
            "Bumps `golang` from `d9b6a1b` to `dc0963f`.\n\n<details><summary>Release notes</summary>Updated base image.</details>",
          ),
          comments: [],
          commentCount: 0,
          commentsTruncated: false,
        },
      },
    ])}
  play={async ({ canvasElement }) => loaded(canvasElement)}
>
  {@render opener({
    ...PULL_REQUEST,
    title: "fix(deps): bump golang from `d9b6a1b` to `dc0963f`",
    kind: "dependency",
    number: 3234,
  })}
</Story>

<!-- An issue: its filer is shown, and there are no release notes. -->
<Story
  asChild
  name="Issue"
  beforeEach={() =>
    mockFetch([
      {
        match: ROUTE,
        body: { ...DETAILS, state: "open" },
      },
    ])}
  play={async ({ canvasElement }) => loaded(canvasElement)}
>
  {@render opener({
    forge: "github",
    repo: "alrayyes/forge-dashboard",
    title: "Add a Storybook component catalog",
    url: "https://github.com/alrayyes/forge-dashboard/issues/3239",
    subject: "issue",
    number: 3239,
    author: "alrayyes",
    authorAvatarUrl: "",
    authorUrl: "https://github.com/alrayyes",
  })}
</Story>

<!-- A published release, found by its tag: notes only. -->
<Story
  asChild
  name="Release"
  beforeEach={() =>
    mockFetch([
      {
        match: ROUTE,
        body: {
          name: "v9.2.9",
          notes: body(
            "## Fixes\n\n- Refresh README screenshots\n- Bump base images",
          ),
        },
      },
    ])}
  play={async ({ canvasElement }) => loaded(canvasElement)}
>
  {@render opener({
    forge: "github",
    repo: "alrayyes/forge-dashboard",
    title: "v9.2.9",
    url: "https://github.com/alrayyes/forge-dashboard/releases/tag/v9.2.9",
    subject: "release",
    tag: "v9.2.9",
  })}
</Story>

<!-- A release with no notes. -->
<Story
  asChild
  name="Release without notes"
  beforeEach={() =>
    mockFetch([{ match: ROUTE, body: { name: "v9.2.8", notes: body("") } }])}
  play={async ({ canvasElement }) => loaded(canvasElement)}
>
  {@render opener({
    forge: "github",
    repo: "alrayyes/forge-dashboard",
    title: "v9.2.8",
    url: "https://github.com/alrayyes/forge-dashboard/releases/tag/v9.2.8",
    subject: "release",
    tag: "v9.2.8",
  })}
</Story>

<!-- The server gave a reason: it is shown with Try again. -->
<Story
  asChild
  name="Error"
  beforeEach={() =>
    mockFetch([
      { match: ROUTE, status: 502, body: { error: "GitHub did not answer." } },
    ])}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".details-error")).not.toBeNull(),
    );
  }}
>
  {@render opener(PULL_REQUEST)}
</Story>

<!-- Keyboard focus on Try again after a failed load. -->
<Story
  asChild
  name="Focus on Try again"
  beforeEach={() =>
    mockFetch([{ match: ROUTE, status: 500, body: { error: "boom" } }])}
  play={async ({ canvasElement }) => {
    await opened(canvasElement);
    await waitFor(() =>
      expect(document.querySelector(".details-retry")).not.toBeNull(),
    );
    (document.querySelector(".details-retry") as HTMLElement).focus();
  }}
>
  {@render opener(PULL_REQUEST)}
</Story>

<!-- An embedded image opened in the viewer (#3414). The proxy isn't served in
     the catalog, so the play function swaps in an inline image the way the
     renderer would draw one, then clicks it. -->
<Story
  asChild
  name="Image viewer"
  beforeEach={() => mockFetch([{ match: ROUTE, body: DETAILS }])}
  play={async ({ canvasElement }) => {
    await loaded(canvasElement);
    const svg =
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='800' height='400'><rect width='800' height='400' fill='%23cde'/></svg>";
    const host = document.querySelector(
      ".details-body .markdown",
    ) as HTMLElement;
    host.insertAdjacentHTML(
      "beforeend",
      `<a href="${svg}" target="_blank" rel="noopener noreferrer"><img class="md-image md-image-loaded" alt="Failing check summary screenshot" src="${svg}"></a>`,
    );
    await userEvent.click(
      host.querySelector("a:has(> img.md-image)") as HTMLElement,
    );
    await waitFor(() =>
      expect(
        document.querySelector("dialog.image-lightbox[open]"),
      ).not.toBeNull(),
    );
  }}
>
  {@render opener(PULL_REQUEST)}
</Story>
