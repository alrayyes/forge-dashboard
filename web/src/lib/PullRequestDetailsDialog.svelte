<script module lang="ts">
  // The part of a row this dialog needs.
  export type DetailsTarget = {
    forge: string;
    repo: string;
    number: number;
    title: string;
    url: string;
    kind?: "release" | "dependency" | "regular";
  };
</script>

<script lang="ts">
  // A read-only dialog for one pull request (#943): its description, the
  // conversation and the thumbs reactions on both, and, for a release pull
  // request, the release notes. The data comes from
  // GET /api/pull-requests/details, fetched when the dialog opens and never
  // as part of the snapshot. Dashboard.svelte calls open() from a row's
  // trigger and holds nothing else of this dialog's state.
  import { FORGE_CLASSES, FORGE_LABELS } from "#lib/forges.js";
  import { renderMarkdown } from "#lib/markdown.js";

  // Matches components.schemas.PullRequestDetails in api/openapi.yaml.
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
    author: { login: string; avatarUrl: string } | null;
    createdAt: string;
    updatedAt: string | null;
  };
  type Details = {
    description: Body;
    comments: Comment[];
    commentCount: number;
    commentsTruncated: boolean;
    releaseNotes: Body | null;
  };

  let dialogEl = $state<HTMLDialogElement>();
  let target = $state<DetailsTarget | null>(null);
  let returnFocusId = "";
  let phase = $state<"loading" | "error" | "ready">("loading");
  let errorMessage = $state("");
  let details = $state<Details | null>(null);
  // Markdown rendered to safe HTML, by "description", "notes" or comment id.
  let html = $state<Record<string, string>>({});
  // Avatars that failed to load, by comment id: they fall back to an initial.
  let brokenAvatars = $state<Record<string, boolean>>({});

  // Bumped on every open and every close: a slow answer for a closed dialog,
  // or for another pull request, never lands.
  let token = 0;

  const forgeLabel = $derived(
    target ? (FORGE_LABELS[target.forge] ?? target.forge) : "",
  );
  const releaseNotes = $derived(details?.releaseNotes ?? null);
  const isBot = $derived(target?.kind === "dependency");

  export function open(item: DetailsTarget, triggerId: string) {
    target = item;
    returnFocusId = triggerId;
    brokenAvatars = {};
    load();
    dialogEl?.showModal();
  }

  async function load() {
    const current = target;
    if (!current) return;
    const mine = ++token;
    phase = "loading";
    details = null;
    html = {};
    try {
      const res = await fetch(
        `/api/pull-requests/details?forge=${encodeURIComponent(current.forge)}&fullName=${encodeURIComponent(current.repo)}&number=${current.number}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || `backend answered ${res.status}`);
      }
      const loaded = data as Details;
      const rendered: Record<string, string> = {};
      const jobs: Promise<void>[] = [];
      const add = (key: string, text: string) =>
        jobs.push(
          renderMarkdown(text).then((out) => {
            rendered[key] = out;
          }),
        );
      add("description", loaded.description.text);
      if (loaded.releaseNotes) add("notes", loaded.releaseNotes.text);
      for (const c of loaded.comments) add(c.id, c.text);
      await Promise.all(jobs);
      if (mine !== token) return;
      html = rendered;
      details = loaded;
      phase = "ready";
    } catch (err) {
      if (mine !== token) return;
      errorMessage = `Couldn't load details for ${current.repo}#${current.number}: ${
        err instanceof Error ? err.message : "unknown error"
      }`;
      phase = "error";
    }
  }

  function onClose() {
    token++;
    const id = returnFocusId;
    returnFocusId = "";
    if (id) document.getElementById(id)?.focus();
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

{#snippet reactionPills(reactions: Reactions)}
  {#if reactions.thumbsUp.count > 0 || reactions.thumbsDown.count > 0}
    <div class="reactions">
      {#each [{ r: reactions.thumbsUp, label: "thumbs up", icon: "👍" }, { r: reactions.thumbsDown, label: "thumbs down", icon: "👎" }] as pill (pill.label)}
        {#if pill.r.count > 0}
          <span class="reaction">
            <button
              type="button"
              class="reaction-pill"
              aria-label={pillName(pill.r, pill.label)}
            >
              <span aria-hidden="true">{pill.icon}</span>
              <span aria-hidden="true">{pill.r.count}</span>
            </button>
            <span class="reaction-people" aria-hidden="true">
              {who(pill.r)
                ? `${pill.label}: ${who(pill.r).replace(/^from /, "")}`
                : pill.label}
            </span>
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
    ? `Pull request details: ${target.repo} #${target.number}`
    : "Pull request details"}
  onclose={onClose}
  onclick={onBackdrop}
>
  {#if target}
    <div class="details-header">
      <div class="details-heading">
        <p class="details-ref">
          <span class="forge-badge {FORGE_CLASSES[target.forge] ?? ''}"
            ><span class="dot"></span>{forgeLabel}</span
          >
          <span class="mono">{target.repo} #{target.number}</span>
        </p>
        <h2 class="details-title">{target.title}</h2>
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
          <button type="button" class="details-retry" onclick={load}
            >Try again</button
          >
        </div>
      {:else if details}
        {#if releaseNotes}
          <section class="details-section">
            <h3>Release notes</h3>
            <div class="markdown">{@html html.notes}</div>
            {#if releaseNotes.truncated}
              <p class="details-note">
                Cut at 20,000 characters. The rest is on {forgeLabel}.
              </p>
            {/if}
            {@render reactionPills(releaseNotes.reactions)}
          </section>
        {:else}
          <section class="details-section">
            <h3>Description</h3>
            {#if details.description.text.trim() === ""}
              <p class="details-note">No description.</p>
            {:else if isBot}
              <details class="details-collapsed">
                <summary>Show the generated description</summary>
                <div class="markdown">{@html html.description}</div>
              </details>
            {:else}
              <div class="markdown">{@html html.description}</div>
            {/if}
            {#if details.description.truncated}
              <p class="details-note">
                Cut at 20,000 characters. The rest is on {forgeLabel}.
              </p>
            {/if}
            {@render reactionPills(details.description.reactions)}
          </section>
        {/if}

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
                    {#if c.author && c.author.avatarUrl && !brokenAvatars[c.id]}
                      <img
                        class="avatar"
                        src={c.author.avatarUrl}
                        alt=""
                        width="32"
                        height="32"
                        loading="lazy"
                        referrerpolicy="no-referrer"
                        onerror={() => (brokenAvatars[c.id] = true)}
                      />
                    {:else}
                      <span class="avatar" aria-hidden="true"
                        >{c.author ? login.charAt(0).toUpperCase() : "?"}</span
                      >
                    {/if}
                    <span class="comment-login">{login}</span>
                    <span class="comment-time">{relativeTime(c.createdAt)}</span
                    >
                    {#if c.edited}<span class="comment-edited">edited</span
                      >{/if}
                  </div>
                  <div class="markdown">{@html html[c.id]}</div>
                  {#if c.truncated}
                    <p class="details-note">Cut at 20,000 characters.</p>
                  {/if}
                  {@render reactionPills(c.reactions)}
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
    </div>

    <div class="details-footer">
      <a
        class="details-open-link"
        href={target.url}
        target="_blank"
        rel="noopener noreferrer"
        >Open on {forgeLabel}<span class="visually-hidden">
          (opens in a new tab)</span
        ></a
      >
    </div>
  {/if}
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
  .markdown :global(a) {
    color: var(--accent);
    overflow-wrap: anywhere;
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
    justify-content: flex-end;
    padding: 12px 18px;
    border-top: 1px solid var(--border);
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
    display: none;
    position: absolute;
    top: calc(100% + 4px);
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
  .reaction:hover .reaction-people,
  .reaction:focus-within .reaction-people {
    display: block;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 480px) {
    .details-dialog {
      width: 100vw;
      height: 100dvh;
      max-height: 100dvh;
      border-radius: 0;
      border: none;
    }
    .details-close {
      width: 44px;
      height: 44px;
    }
    .details-retry,
    .details-open-link {
      min-height: 44px;
      min-width: 44px;
    }
    .reaction-pill {
      min-height: 44px;
      min-width: 44px;
    }
    .details-collapsed summary {
      min-height: 44px;
      display: flex;
      align-items: center;
    }
  }
</style>
