<script module lang="ts">
  // The header's status, drawn by the row's own builders in Dashboard.svelte
  // so the two cannot drift (#1563): the CI slot and merge state, and the
  // attribute chips.
  export type DetailsStatus = {
    state: HTMLElement;
    attributes: HTMLElement;
  };

  // The part of a row this dialog needs. An issue row opens the same dialog
  // with subject "issue": its own endpoint and wording, no release notes and
  // no footer actions. A published release (from the Main branches page) is
  // subject "release": found by its tag, with its notes and nothing else.
  export type DetailsTarget = {
    subject?: "pull-request" | "issue" | "release";
    // The release's tag; only a release has one.
    tag?: string;
    forge: string;
    repo: string;
    number: number;
    title: string;
    url: string;
    kind?: "release" | "dependency" | "regular";
    // Who filed an issue and the forge's avatar for them, from its row. Only
    // the issue dialog shows them.
    author?: string;
    authorAvatarUrl?: string;
    // The filer's page on the forge, built by the server; empty when none.
    authorUrl?: string;
    // Drawn from the row the dialog was opened from, as it was then. Nothing
    // here is fetched.
    status?: DetailsStatus;
  };

  // What the footer area shows, built by the row's own builders in
  // Dashboard.svelte (the same buttons, the same state) and handed over whole:
  // the status block under the header, the failure lines above the footer,
  // and the actions in order, the primary one first and Close last.
  export type DetailsChrome = {
    status: HTMLElement | null;
    feedback: HTMLElement | null;
    // The per-pull-request switch for automatic branch updates, above the
    // footer; null where there is none to show.
    option: HTMLElement | null;
    actions: HTMLElement[];
  };
</script>

<script lang="ts">
  // A read-only dialog for one pull request (#943) or one issue: its
  // description, the conversation and the thumbs reactions on both, and, for a
  // release pull request, the release notes. The data comes from
  // GET /api/pull-requests/details or GET /api/issues/details, fetched when
  // the dialog opens and never as part of the snapshot. Dashboard.svelte calls
  // open() from a row's trigger and holds nothing else of this dialog's state.
  import { avatarSrc } from "#lib/avatar.js";
  import { profileHref } from "#lib/profile-link.js";
  import { FORGE_CLASSES, FORGE_LABELS } from "#lib/forges.js";
  import { renderMarkdown } from "#lib/markdown.js";
  import { repoUrlOf } from "#lib/repo-url.js";

  // Puts a node the row's builders made into the header.
  const adopt = (content: HTMLElement) => (node: HTMLElement) => {
    node.replaceChildren(content);
  };

  // An error the server explained, as opposed to a network or chunk failure.
  class ServerReason extends Error {}

  // Matches components.schemas.PullRequestDetails and IssueDetails in
  // api/openapi.yaml (an issue has no releaseNotes).
  type Reaction = { count: number; logins: string[] };
  type Reactions = { thumbsUp: Reaction; thumbsDown: Reaction };
  type Body = {
    text: string;
    truncated: boolean;
    edited: boolean;
    reactions: Reactions;
  };
  type Comment = Body & {
    id: string;
    author: { login: string; avatarUrl: string; url: string } | null;
    createdAt: string;
    updatedAt: string | null;
  };
  type Details = {
    description: Body;
    comments: Comment[];
    commentCount: number;
    commentsTruncated: boolean;
    releaseNotes?: Body | null;
  };

  // Dashboard.svelte's hooks: Escape first backs out of an armed confirm, and
  // it hears when the dialog has closed.
  let {
    onEscape,
    onClosed,
  }: { onEscape?: () => boolean; onClosed?: () => void } = $props();

  let dialogEl = $state<HTMLDialogElement>();
  // These three hosts exist from the start so the page can fill them in the
  // same tick it opens the dialog, and move focus into them at once.
  let statusHost = $state<HTMLElement>();
  let feedbackHost = $state<HTMLElement>();
  let optionHost = $state<HTMLElement>();
  let actionsHost = $state<HTMLElement>();
  let target = $state<DetailsTarget | null>(null);
  let returnFocusId = "";
  let returnFocusFallbackId = "";
  let phase = $state<"loading" | "error" | "ready">("loading");
  let errorMessage = $state("");
  let details = $state<Details | null>(null);
  // Markdown rendered to safe HTML, by "description", "notes" or comment id.
  let html = $state<Record<string, string>>({});
  // Avatars that failed to load, by comment id: they fall back to an initial.
  let brokenAvatars = $state<Record<string, boolean>>({});
  // The same for the avatar of whoever filed the issue, in the header.
  let brokenFilerAvatar = $state(false);

  // Bumped on every open and every close: a slow answer for a closed dialog,
  // or for another pull request, never lands.
  let token = 0;

  const forgeLabel = $derived(
    target ? (FORGE_LABELS[target.forge] ?? target.forge) : "",
  );
  const releaseNotes = $derived(details?.releaseNotes ?? null);
  const isBot = $derived(target?.kind === "dependency");
  const subjectName = $derived(
    target?.subject === "issue"
      ? "Issue"
      : target?.subject === "release"
        ? "Release"
        : "Pull request",
  );
  const isRelease = $derived(target?.subject === "release");

  // The dialog's own polite live region. The page's one (outside the
  // <dialog>) is ignored by assistive tech while a modal is open, so the
  // dialog speaks through this one.
  let liveHost = $state<HTMLElement>();
  export function liveElement(): HTMLElement | undefined {
    return liveHost;
  }

  export function close() {
    dialogEl?.close();
  }

  export function isOpen(): boolean {
    return dialogEl?.open === true;
  }

  // The option's host, so the page can tell where focus is before it redraws.
  export function optionElement(): HTMLElement | undefined {
    return optionHost;
  }

  // The footer area's host, so the page can tell where focus is before it
  // redraws.
  export function actionsElement(): HTMLElement | undefined {
    return actionsHost;
  }

  // Swaps the state drawn in the header (the CI slot and merge state) for
  // another the page built, e.g. Closed after a close and the row's own again
  // after a reopen. The attributes below the title stay as they were.
  export function setHeaderState(state: HTMLElement) {
    if (target?.status)
      target = { ...target, status: { ...target.status, state } };
  }

  // The close button in the header: where focus goes when the control it was
  // on has gone and nothing else in the footer is left.
  export function focusClose() {
    dialogEl?.querySelector<HTMLElement>(".details-close")?.focus();
  }

  // Replaces what the page built for the footer area. Synchronous: the page
  // finds its new buttons by id straight after.
  export function setChrome(chrome: DetailsChrome) {
    statusHost?.replaceChildren(...(chrome.status ? [chrome.status] : []));
    if (statusHost) statusHost.hidden = chrome.status === null;
    feedbackHost?.replaceChildren(
      ...(chrome.feedback ? [chrome.feedback] : []),
    );
    if (feedbackHost) feedbackHost.hidden = chrome.feedback === null;
    optionHost?.replaceChildren(...(chrome.option ? [chrome.option] : []));
    if (optionHost) optionHost.hidden = chrome.option === null;
    actionsHost?.replaceChildren(...chrome.actions);
  }

  // `fallbackFocusId` is where focus goes on close when the trigger is no
  // longer on the page (its row is filtered out). It is looked up on close,
  // not here, since the row can come and go while the dialog is open.
  export function open(
    item: DetailsTarget,
    triggerId: string,
    fallbackFocusId = "",
  ) {
    target = item;
    returnFocusId = triggerId;
    returnFocusFallbackId = fallbackFocusId;
    brokenAvatars = {};
    brokenFilerAvatar = false;
    load();
    dialogEl?.showModal();
  }

  // Fetches the details again for the pull request on show. Once they are on
  // screen the swap is quiet and a failure leaves them as they were; while the
  // first load is still going, or after it failed, it is that load again, so
  // the skeleton or the error never outlives the answer. Resolves to whether
  // the details are now current.
  export function reload(): Promise<boolean> {
    if (!target) return Promise.resolve(true);

    return load(phase === "ready");
  }

  async function load(quiet = false): Promise<boolean> {
    const current = target;
    if (!current) return true;
    const mine = ++token;
    if (!quiet) {
      phase = "loading";
      details = null;
      html = {};
    }
    try {
      const where = `forge=${encodeURIComponent(current.forge)}&fullName=${encodeURIComponent(current.repo)}`;
      const res = await fetch(
        current.subject === "release"
          ? `/api/releases/details?${where}&tag=${encodeURIComponent(current.tag ?? "")}`
          : `/api/${current.subject === "issue" ? "issues" : "pull-requests"}/details?${where}&number=${current.number}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status === 401) {
        window.location.href = "/login.html";
        return true;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new ServerReason(
          data?.error || `the server answered ${res.status}`,
        );
      }
      // A release answers with its title and notes: shown through the
      // release-notes section, with no description and no conversation.
      let loaded: Details;
      if (current.subject === "release") {
        const release = data as { name: string; notes: Body };
        loaded = {
          description: release.notes,
          comments: [],
          commentCount: 0,
          commentsTruncated: false,
          releaseNotes: release.notes,
        };
        if (release.name && target === current)
          target = { ...current, title: release.name };
      } else {
        loaded = data as Details;
      }
      const rendered: Record<string, string> = {};
      const jobs: Promise<void>[] = [];
      const add = (key: string, text: string) =>
        jobs.push(
          renderMarkdown(text, { repoUrl: repoUrlOf(current.url) }).then(
            (out) => {
              rendered[key] = out;
            },
          ),
        );
      if (current.subject !== "release")
        add("description", loaded.description.text);
      if (loaded.releaseNotes) add("notes", loaded.releaseNotes.text);
      for (const c of loaded.comments) add(c.id, c.text);
      await Promise.all(jobs);
      if (mine !== token) return true;
      html = rendered;
      details = loaded;
      phase = "ready";
      // A quiet swap leaves a list the reader has open alone; a full load
      // replaces everything, so the old content's state goes with it.
      if (!quiet) {
        shownReaction = null;
        brokenAvatars = {};
      }

      return true;
    } catch (err) {
      if (mine !== token) return true;
      if (quiet) return false;
      // The server's own reason is plain words. A network or chunk failure
      // carries a URL and a browser message, which stay out of the UI.
      errorMessage =
        err instanceof ServerReason
          ? `Could not load the details: ${err.message}`
          : "Could not load the details. Check your connection and try again.";
      phase = "error";

      return false;
    }
  }

  // The one reaction list on show, if any (WCAG 1.4.13): hover or focus
  // shows it, leaving hides it, and Escape dismisses it without moving focus.
  let shownReaction = $state<string | null>(null);

  function onCancel(event: Event) {
    // An armed confirm in the footer ends first, keeping the dialog open.
    if (onEscape?.()) {
      event.preventDefault();
      return;
    }
    if (shownReaction === null) return;
    // The first Escape only dismisses the list; the next one closes the dialog.
    event.preventDefault();
    shownReaction = null;
  }

  function onClose() {
    shownReaction = null;
    // Nothing said inside the dialog is still true once it is gone.
    if (liveHost) liveHost.textContent = "";
    token++;
    const id = returnFocusId;
    const fallbackId = returnFocusFallbackId;
    returnFocusId = "";
    returnFocusFallbackId = "";
    onClosed?.();
    const back =
      (id ? document.getElementById(id) : null) ??
      (fallbackId ? document.getElementById(fallbackId) : null);
    back?.focus();
  }

  // A click that lands on the <dialog> itself, not on something inside it,
  // is a click on the backdrop.
  function onBackdrop(event: MouseEvent) {
    if (event.target === dialogEl) dialogEl?.close();
  }

  function relativeTime(iso: string): string {
    const mins = Math.max(
      0,
      Math.floor((Date.now() - Date.parse(iso)) / 60000),
    );
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  // "3 thumbs up, from alice, bob and carol": every name and the "and N more"
  // for the people past the first ten.
  function who(r: Reaction): string {
    const names = r.logins;
    const more = r.count - names.length;
    if (names.length === 0) return "";
    if (more > 0) return `from ${names.join(", ")} and ${more} more`;
    if (names.length === 1) return `from ${names[0]}`;
    return `from ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }

  function pillName(r: Reaction, label: string): string {
    const from = who(r);
    return from ? `${r.count} ${label}, ${from}` : `${r.count} ${label}`;
  }
</script>

{#snippet reactionPills(reactions: Reactions, scope: string)}
  {#if reactions.thumbsUp.count > 0 || reactions.thumbsDown.count > 0}
    <div class="reactions">
      {#each [{ r: reactions.thumbsUp, label: "thumbs up", icon: "👍" }, { r: reactions.thumbsDown, label: "thumbs down", icon: "👎" }] as pill (pill.label)}
        {#if pill.r.count > 0}
          {@const key = `${scope}:${pill.label}`}
          <!-- Display only, so not a button: a focusable group whose name
               carries the count and the people, with a list that shows on
               hover or focus. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <span
            class="reaction"
            role="group"
            tabindex="0"
            aria-label={pillName(pill.r, pill.label)}
            onmouseenter={() => (shownReaction = key)}
            onmouseleave={() => {
              if (shownReaction === key) shownReaction = null;
            }}
            onfocusin={() => (shownReaction = key)}
            onfocusout={() => {
              if (shownReaction === key) shownReaction = null;
            }}
          >
            <span class="reaction-pill" aria-hidden="true">
              <span>{pill.icon}</span>
              <span>{pill.r.count}</span>
            </span>
            {#if shownReaction === key}
              <span class="reaction-people" aria-hidden="true">
                {who(pill.r)
                  ? `${pill.label}: ${who(pill.r).replace(/^from /, "")}`
                  : pill.label}
              </span>
            {/if}
          </span>
        {/if}
      {/each}
    </div>
  {/if}
{/snippet}

<dialog
  bind:this={dialogEl}
  class="details-dialog"
  aria-label={target
    ? `${subjectName} details: ${target.repo} ${isRelease ? target.tag : `#${target.number}`}`
    : "Pull request details"}
  onclose={onClose}
  oncancel={onCancel}
  onclick={onBackdrop}
>
  {#if target}
    <div class="details-header">
      <div class="details-heading">
        {#if target.status}
          <div
            class="details-status"
            {@attach adopt(target.status.state)}
          ></div>
        {/if}
        <p class="details-ref">
          <span class="forge-badge {FORGE_CLASSES[target.forge] ?? ''}"
            ><span class="dot"></span>{forgeLabel}</span
          >
          <!-- The repository and the number are two links, each named by its
            own text, to the repository and to the item on the forge. Without
            a repository address (an item address of an unknown shape) they
            stay plain text. -->
          <span class="mono">
            {#if repoUrlOf(target.url)}
              <a
                class="ref-link"
                href={repoUrlOf(target.url) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                >{target.repo}<span class="visually-hidden">
                  (opens in a new tab)</span
                ></a
              >
              <a
                class="ref-link"
                href={target.url}
                target="_blank"
                rel="noopener noreferrer"
                >{target.subject === "release"
                  ? target.tag
                  : `#${target.number}`}<span class="visually-hidden">
                  (opens in a new tab)</span
                ></a
              >
            {:else}
              {target.repo}
              {target.subject === "release" ? target.tag : `#${target.number}`}
            {/if}
          </span>
        </p>
        <h2 class="details-title">{target.title}</h2>
        {#if target.subject === "issue" && target.author}
          {#snippet filer()}
            {#if avatarSrc(target?.authorAvatarUrl) && !brokenFilerAvatar}
              <img
                class="filer-avatar"
                src={avatarSrc(target?.authorAvatarUrl) ?? undefined}
                alt=""
                width="20"
                height="20"
                loading="lazy"
                referrerpolicy="no-referrer"
                onerror={() => (brokenFilerAvatar = true)}
              />
            {/if}
            <span class="filer-name">{target?.author}</span>
          {/snippet}
          <p class="details-author">
            <span>Filed by</span>
            <!-- The avatar and the name are one link to the filer's page on
              the forge, as on the row. Without an address, or for a deleted
              account, they are plain text. -->
            {#if profileHref(target.authorUrl)}
              <a
                class="filer-link"
                href={profileHref(target.authorUrl) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                {@render filer()}
              </a>
            {:else}
              {@render filer()}
            {/if}
          </p>
        {/if}
        {#if target.status?.attributes.hasChildNodes()}
          <div
            class="details-attributes"
            {@attach adopt(target.status.attributes)}
          ></div>
        {/if}
      </div>
      <button
        type="button"
        class="details-close"
        aria-label="Close details"
        onclick={() => dialogEl?.close()}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="M18 6 6 18" /><path d="M6 6l12 12" /></svg
        >
      </button>
    </div>
  {/if}

  <!-- Present from the first paint and written only when something is said. -->
  <div
    class="visually-hidden"
    role="status"
    aria-live="polite"
    aria-atomic="true"
    bind:this={liveHost}
  ></div>

  <!-- What the pull request is waiting on or blocked by, in words. -->
  <div class="details-status-block" bind:this={statusHost} hidden></div>

  {#if target}
    <div class="details-body">
      {#if phase === "loading"}
        <div class="details-skeleton" role="status">
          <span class="visually-hidden">Loading details</span>
          <span class="skeleton-line"></span>
          <span class="skeleton-line short"></span>
          <span class="skeleton-line"></span>
        </div>
      {:else if phase === "error"}
        <div class="details-error" role="alert">
          <p>{errorMessage}</p>
          <button type="button" class="details-retry" onclick={() => load()}
            >Try again</button
          >
        </div>
      {:else if details}
        {#if releaseNotes}
          <section class="details-section">
            <h3>Release notes</h3>
            {#if releaseNotes.text.trim() === ""}
              <p class="details-note">No release notes.</p>
            {:else}
              <!-- nosemgrep: svelte-at-html -- html holds only renderMarkdown() output: markdown-it with html:false, the image rule off and non-http(s)/mailto links turned to text, never raw forge text -->
              <div class="markdown">{@html html.notes}</div>
            {/if}
            {#if releaseNotes.truncated}
              <p class="details-note">
                Cut at 20,000 characters. The rest is on {forgeLabel}.
              </p>
            {/if}
            {@render reactionPills(releaseNotes.reactions, "notes")}
          </section>
        {:else}
          <section class="details-section">
            <h3>Description</h3>
            {#if details.description.text.trim() === ""}
              <p class="details-note">No description.</p>
            {:else if isBot}
              <details class="details-collapsed">
                <summary>Show the generated description</summary>
                <!-- nosemgrep: svelte-at-html -- html holds only renderMarkdown() output: markdown-it with html:false, the image rule off and non-http(s)/mailto links turned to text, never raw forge text -->
                <div class="markdown">{@html html.description}</div>
              </details>
            {:else}
              <!-- nosemgrep: svelte-at-html -- html holds only renderMarkdown() output: markdown-it with html:false, the image rule off and non-http(s)/mailto links turned to text, never raw forge text -->
              <div class="markdown">{@html html.description}</div>
            {/if}
            {#if details.description.truncated}
              <p class="details-note">
                Cut at 20,000 characters. The rest is on {forgeLabel}.
              </p>
            {/if}
            {@render reactionPills(
              details.description.reactions,
              "description",
            )}
          </section>
        {/if}

        {#if !isRelease}
          <section class="details-section">
            <h3>Comments ({details.commentCount})</h3>
            {#if details.comments.length === 0}
              <p class="details-note">No comments.</p>
            {:else}
              <ol class="details-comments">
                {#each details.comments as c (c.id)}
                  {@const login = c.author?.login ?? "ghost"}
                  <li class="details-comment">
                    <div class="comment-head">
                      {#snippet person()}
                        {#if avatarSrc(c.author?.avatarUrl) && !brokenAvatars[c.id]}
                          <img
                            class="avatar"
                            src={avatarSrc(c.author?.avatarUrl) ?? undefined}
                            alt=""
                            width="32"
                            height="32"
                            loading="lazy"
                            referrerpolicy="no-referrer"
                            onerror={() => (brokenAvatars[c.id] = true)}
                          />
                        {:else}
                          <span class="avatar" aria-hidden="true"
                            >{c.author
                              ? login.charAt(0).toUpperCase()
                              : "?"}</span
                          >
                        {/if}
                        <span class="comment-login">{login}</span>
                      {/snippet}
                      <!-- The avatar and the name are one link to the person's
                      page on the forge: two links to one place would read as
                      the same link twice. A deleted account, or a forge the
                      board has no address for yet, stays plain text. -->
                      {#if profileHref(c.author?.url)}
                        <a
                          class="comment-person"
                          href={profileHref(c.author?.url) ?? undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {@render person()}
                        </a>
                      {:else}
                        {@render person()}
                      {/if}
                      <span class="comment-time"
                        >{relativeTime(c.createdAt)}</span
                      >
                      {#if c.edited}<span class="comment-edited">edited</span
                        >{/if}
                    </div>
                    <!-- nosemgrep: svelte-at-html -- html holds only renderMarkdown() output: markdown-it with html:false, the image rule off and non-http(s)/mailto links turned to text, never raw forge text -->
                    <div class="markdown">{@html html[c.id]}</div>
                    {#if c.truncated}
                      <p class="details-note">Cut at 20,000 characters.</p>
                    {/if}
                    {@render reactionPills(c.reactions, c.id)}
                  </li>
                {/each}
              </ol>
              {#if details.commentsTruncated}
                <p class="details-note">
                  Showing the first {details.comments.length} of {details.commentCount}
                  comments.
                  <a href={target.url} target="_blank" rel="noopener noreferrer"
                    >Read the rest on {forgeLabel}<span class="visually-hidden">
                      (opens in a new tab)</span
                    ></a
                  >
                </p>
              {/if}
            {/if}
          </section>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Failure lines, above the footer so there is always room for them. -->
  <div class="details-feedback" bind:this={feedbackHost} hidden></div>

  <div class="details-option" bind:this={optionHost} hidden></div>

  <div class="details-footer">
    {#if target}
      <a
        class="details-open-link"
        href={target.url}
        target="_blank"
        rel="noopener noreferrer"
        >Open on {forgeLabel}<span class="visually-hidden">
          (opens in a new tab)</span
        ></a
      >
    {/if}
    <div class="details-actions" bind:this={actionsHost}></div>
  </div>
</dialog>

<style>
  .details-dialog {
    width: min(720px, calc(100vw - 32px));
    max-width: 100vw;
    max-height: min(90vh, 900px);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--ink);
    box-shadow: var(--shadow);
  }
  .details-dialog[open] {
    display: flex;
    flex-direction: column;
  }
  .details-dialog::backdrop {
    background: var(--backdrop);
  }
  .details-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 18px 14px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .details-heading {
    min-width: 0;
  }
  .details-ref {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0 0 6px;
    font-size: 12.5px;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .details-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .details-author {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--ink-2);
  }
  .filer-name {
    font-weight: 600;
    color: var(--ink);
  }
  /* One link on the avatar and the name; 24px tall at least (WCAG 2.5.8). */
  .filer-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    color: inherit;
    text-decoration: none;
  }
  .filer-link:hover .filer-name {
    text-decoration: underline;
  }
  .filer-link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .filer-avatar {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    object-fit: cover;
  }
  .details-close {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-sunken);
    color: var(--ink-2);
    cursor: pointer;
  }
  .details-close:hover {
    color: var(--ink);
  }
  .details-close:focus-visible,
  .details-retry:focus-visible,
  .details-open-link:focus-visible,
  .reaction-pill:focus-visible,
  .details-collapsed summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .details-body {
    padding: 16px 18px 20px;
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1 1 auto;
    min-width: 0;
  }
  .details-section + .details-section {
    margin-top: 22px;
  }
  .details-section h3 {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-2);
  }
  .details-note {
    margin: 8px 0 0;
    font-size: 12.5px;
    color: var(--ink-2);
  }
  .details-note a,
  .ref-link,
  .markdown :global(a) {
    color: var(--accent);
    overflow-wrap: anywhere;
  }
  /* The header links are small text where colour alone would be the cue. */
  .ref-link {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    min-width: 24px;
    max-width: 100%;
    text-decoration: underline;
  }
  .details-skeleton {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .skeleton-line {
    display: block;
    height: 12px;
    border-radius: 6px;
    background: var(--neutral-bg);
  }
  .skeleton-line.short {
    width: 55%;
  }
  .details-error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    color: var(--critical);
    font-size: 13px;
  }
  .details-error p {
    margin: 0;
  }
  .details-retry,
  .details-open-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 32px;
    padding: 0 14px;
    border-radius: 8px;
    border: 1px solid var(--border-strong);
    background: var(--surface-sunken);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    text-decoration: none;
    cursor: pointer;
  }
  .details-footer {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px 16px;
    padding: 12px 18px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
  /* The status block sits under the header, outside the scrolling body. */
  .details-status-block {
    flex: none;
    padding: 10px 18px 0;
  }
  .details-status-block[hidden],
  .details-option[hidden],
  .details-feedback[hidden] {
    display: none;
  }
  /* Failure lines: room for several, scrolling past a few rather than
     pushing the footer off a short screen. */
  .details-feedback {
    flex: none;
    max-height: 30vh;
    overflow-y: auto;
    padding: 8px 18px 0;
    border-top: 1px solid var(--border);
  }
  .details-option {
    flex: none;
    padding: 10px 18px 0;
  }
  .markdown {
    font-size: 13.5px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .markdown :global(> :first-child) {
    margin-top: 0;
  }
  .markdown :global(> :last-child) {
    margin-bottom: 0;
  }
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4) {
    font-size: 14px;
    margin: 14px 0 6px;
  }
  .markdown :global(pre) {
    overflow-x: auto;
    padding: 10px;
    border-radius: 8px;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
  }
  .markdown :global(code) {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 12.5px;
  }
  .markdown :global(table) {
    display: block;
    overflow-x: auto;
    border-collapse: collapse;
  }
  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid var(--border);
    padding: 4px 8px;
  }
  .markdown :global(li.task-list-item) {
    list-style: none;
    margin-left: -1.25em;
  }
  .markdown :global(label.task) {
    /* Block, not flex: inline children (code, em, a) must flow as text. The
       box hangs in the left padding so wrapped lines align with the text. */
    display: block;
    padding-left: 20px;
    text-indent: -20px;
    color: inherit;
  }
  .markdown :global(label.task input) {
    display: inline-block;
    box-sizing: border-box;
    margin: 0 6px 0 0;
    vertical-align: -2px;
    text-indent: 0;
    /* A disabled native box is pale in both colour schemes: draw our own. */
    appearance: none;
    width: 14px;
    height: 14px;
    border: 1.5px solid var(--ink-2);
    border-radius: 3px;
    background: transparent;
  }
  .markdown :global(label.task input:checked) {
    background:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.5l2.5 2.5 4.5-5.5' fill='none' stroke='%23fff' stroke-width='1.8'/%3E%3C/svg%3E")
        center / 100% no-repeat,
      var(--accent);
    border-color: var(--accent);
  }
  /* The accent is light in the dark scheme, so the tick is dark there. */
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme="light"]))
      .markdown
      :global(label.task input:checked) {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.5l2.5 2.5 4.5-5.5' fill='none' stroke='%2306181a' stroke-width='1.8'/%3E%3C/svg%3E");
    }
  }
  :global(:root[data-theme="dark"])
    .markdown
    :global(label.task input:checked) {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.5l2.5 2.5 4.5-5.5' fill='none' stroke='%2306181a' stroke-width='1.8'/%3E%3C/svg%3E");
  }
  /* Forced colours drop our fills and the fixed-colour tick, so a checked box
     would look empty: hand the control back to the browser. */
  @media (forced-colors: active) {
    .markdown :global(label.task input),
    .markdown :global(label.task input:checked) {
      appearance: auto;
      background: none;
      border: 0;
    }
  }
  .markdown :global(blockquote) {
    margin: 8px 0;
    padding-left: 12px;
    border-left: 3px solid var(--border-strong);
    color: var(--ink-2);
  }
  .details-collapsed summary {
    cursor: pointer;
    font-size: 13px;
    color: var(--ink-2);
    margin-bottom: 8px;
  }
  .details-comments {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .details-comment {
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    min-width: 0;
  }
  .comment-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 12.5px;
  }
  .avatar {
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--neutral-bg);
    color: var(--ink-2);
    font-weight: 600;
    font-size: 14px;
  }
  .comment-login {
    font-weight: 600;
  }
  /* The avatar and the name are one link to the person's page on the forge;
     24px tall at least (WCAG 2.5.8), 44px on a phone. */
  .comment-person {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
    color: inherit;
    text-decoration: none;
  }
  .comment-person:hover .comment-login {
    text-decoration: underline;
  }
  .comment-person:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
  @media (max-width: 480px) {
    .comment-person {
      min-height: 44px;
    }
  }
  .comment-time,
  .comment-edited {
    color: var(--ink-2);
  }
  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
  .reaction {
    position: relative;
    border-radius: 999px;
  }
  .reaction:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* The header follows the row's tiers (#1563): the CI slot and merge state
     above the title, the attribute chips below it. The nodes come from
     Dashboard.svelte's builders, so the row's global classes style them. */
  .details-status {
    margin: 0 0 8px;
  }
  .details-status :global(.details-state) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .details-attributes {
    margin-top: 8px;
  }
  .reaction-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid var(--border-strong);
    background: var(--surface-sunken);
    color: var(--ink);
    font: inherit;
    font-size: 12.5px;
    cursor: default;
  }
  .reaction-people {
    display: block;
    position: absolute;
    top: 100%;
    margin-top: 2px;
    left: 0;
    z-index: 2;
    width: max-content;
    max-width: min(260px, 70vw);
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--border-strong);
    background: var(--surface);
    box-shadow: var(--shadow);
    font-size: 12px;
    color: var(--ink);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* The 44px target applies under 761px, the same cut as style.css, so the
     centred dialog at 700px gets it too, not just the full-height sheet. */
  @media (max-width: 760px) {
    .details-close {
      width: 44px;
      height: 44px;
    }
    .details-retry,
    .details-open-link {
      min-height: 44px;
      min-width: 44px;
    }
    .ref-link {
      min-height: 44px;
      min-width: 44px;
    }
    .reaction {
      display: inline-flex;
    }
    .reaction-pill {
      min-height: 44px;
      min-width: 44px;
      justify-content: center;
    }
    .details-collapsed summary {
      min-height: 44px;
      display: flex;
      align-items: center;
    }
  }

  @media (max-width: 480px) {
    .details-dialog {
      width: 100vw;
      height: 100dvh;
      max-height: 100dvh;
      border-radius: 0;
      border: none;
    }
    /* The CI slot at the top right of the header, the attributes wrapping
       on their own line below the title. */
    .details-status :global(.details-state) {
      justify-content: flex-end;
    }
    /* A sticky footer: the link to the forge, then the actions at the bottom
       where a thumb reaches. */
    .details-footer {
      flex-direction: column;
      align-items: stretch;
      padding-bottom: max(12px, env(safe-area-inset-bottom));
    }
  }
</style>
