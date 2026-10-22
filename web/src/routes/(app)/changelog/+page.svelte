<script lang="ts">
  import { onMount } from "svelte";
  import {
    createNoteRenderer,
    createPlainNotes,
  } from "#lib/changelog-notes.js";
  import { renderMarkdown } from "#lib/markdown.js";

  // One entry per release in CHANGELOG.md, written to /changelog.json at
  // build time by scripts/changelog-json.ts (#813). This page makes no
  // request to GitHub or anyone else.
  type Release = {
    version: string;
    date: string;
    url: string;
    notes: string;
  };

  let status = $state("Loading…");
  let statusKind = $state<"" | "error">("");
  let releases = $state<Release[]>([]);
  let loaded = $state(false);

  // The newest releases show first and older ones on request: all of them in
  // one list was 3,490 elements and failed Lighthouse's DOM size audit
  // (#1135). Nothing is dropped, only revealed a page at a time.
  const PAGE_SIZE = 20;
  // How long the first cards wait for their notes to render before they show
  // as plain text instead.
  const RENDER_WAIT_MS = 1500;
  let visibleCount = $state(PAGE_SIZE);
  const visible = (list: Release[]) => list.slice(0, visibleCount);
  const shown = $derived(visible(releases));
  const hiddenCount = $derived(Math.max(0, releases.length - visibleCount));

  // The notes are release-please's Markdown (a bold scope, links, lists),
  // rendered by the same safe renderer as the pull request dialog: raw HTML
  // stays text, only http(s) and mailto links are links, images are off. A
  // link labelled with a pull request number or a commit hash gets the mono
  // class. Each release is rendered once. The first page of cards waits for its
  // notes to render, up to RENDER_WAIT_MS, so the usual load shows rendered
  // cards from the first paint and nothing moves. If the renderer's chunk is
  // slow or never loads, the cards show the notes as plain text and swap later.
  let rendered = $state<Record<string, string>>({});
  const requestNotes = createNoteRenderer(
    (text) => renderMarkdown(text, { monoReferences: true }),
    (version, html) => {
      if (html !== null) rendered[version] = html;
    },
  );

  $effect(() => {
    void requestNotes(shown);
  });
  // A render that failed is asked for again a few seconds later, for as long
  // as the page is open.
  $effect(() => () => requestNotes.stop());

  // The plain-text fallback, stripped once per release.
  const plainNotes = createPlainNotes();

  // The changelog's dates are calendar days with no time, read as UTC so a
  // reader west of Greenwich doesn't see the day before.
  function formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  // Holds the first cards back until their notes have rendered, for at most
  // RENDER_WAIT_MS. A failed render ends the wait at once: waiting longer
  // would not help, and the cards show as plain text.
  async function waitForNotes(list: Release[]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        requestNotes(visible(list)),
        new Promise((resolve) => {
          timer = setTimeout(resolve, RENDER_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  onMount(() => {
    let mounted = true;
    (async () => {
      let list: Release[];
      try {
        const res = await fetch("/changelog.json", {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`changelog answered ${res.status}`);
        list = ((await res.json()) as { releases?: Release[] }).releases ?? [];
      } catch {
        if (!mounted) return;
        status = "Could not load the changelog.";
        statusKind = "error";
        loaded = true;
        return;
      }
      // The JSON loaded. If the wait fails, the cards still show.
      await waitForNotes(list).catch(() => {});
      if (!mounted) return;
      status = "";
      releases = list;
      loaded = true;
    })();
    return () => {
      mounted = false;
    };
  });
</script>

<svelte:head>
  <title>Release history — Forge Board</title>
  <meta
    name="description"
    content="Every Forge Board release, newest first, with what changed in each."
  />
  <style>
    .changelog-wrap {
      max-width: 720px;
      margin: 0 auto;
      padding: 28px 0 64px;
    }
    .changelog-header {
      margin-bottom: 22px;
    }
    .changelog-header h1 {
      font-size: 19px;
      margin: 0;
    }
    .status {
      font-size: 12.5px;
      min-height: 1.4em;
      margin: 0 0 16px;
    }
    .status.error {
      color: var(--critical);
    }
    .release-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .release {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 18px 22px 20px;
      margin-bottom: 14px;
    }
    .release-head {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 8px 14px;
      margin-bottom: 10px;
    }
    .release-head h2 {
      font-size: 15px;
      margin: 0;
    }
    .release-head h2 a {
      color: var(--ink);
      text-decoration: none;
    }
    .release-head h2 a:hover {
      color: var(--accent);
    }
    .release-date {
      font-size: 12px;
      color: var(--ink-3);
    }
    .release-notes {
      font-size: 13.5px;
      color: var(--ink-2);
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .release-notes h3 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--ink-3);
      margin: 14px 0 6px;
    }
    .release-notes h3:first-child {
      margin-top: 0;
    }
    .release-notes p {
      margin: 0 0 6px;
    }
    .release-notes .plain-notes {
      white-space: pre-wrap;
    }
    .release-notes code {
      font-size: 12px;
    }
    .release-notes ul,
    .release-notes ol {
      margin: 0 0 4px;
      padding-left: 20px;
    }
    .release-notes pre {
      margin: 0 0 8px;
      padding: 8px 10px;
      overflow-x: auto;
      background: var(--surface-sunken);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .release-notes pre:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .release-notes pre code {
      font-size: 12px;
    }
    .release-notes blockquote {
      margin: 0 0 8px;
      padding: 0 0 0 12px;
      border-left: 3px solid var(--border-strong);
      color: var(--ink-3);
    }
    .release-notes li {
      margin-bottom: 3px;
    }
    .release-notes a {
      color: var(--accent);
    }
    .release-notes .mono {
      font-size: 12px;
    }
    .more-releases {
      display: block;
      margin: 18px auto 0;
      min-height: 44px;
      padding: 0 16px;
      font-family: inherit;
      font-size: 13px;
      color: var(--ink);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      cursor: pointer;
    }
    .more-releases:hover {
      background: var(--surface-2, var(--surface));
    }
    .more-releases:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .empty-state {
      font-size: 13px;
      color: var(--ink-3);
      padding: 8px 0;
    }
  </style>
</svelte:head>

<div class="changelog-wrap">
  <div class="changelog-header">
    <h1>Release history</h1>
  </div>

  <p
    class={`status${statusKind ? ` ${statusKind}` : ""}`}
    id="status"
    role="status"
    aria-live="polite"
  >
    {status}
  </p>

  <ul class="release-list" id="release-list">
    {#each shown as r (r.version)}
      <li class="release">
        <div class="release-head">
          <h2>
            {#if r.url}<a
                class="mono"
                href={r.url}
                target="_blank"
                rel="noopener noreferrer">v{r.version}</a
              >{:else}<span class="mono">v{r.version}</span>{/if}
          </h2>
          <time class="release-date" datetime={r.date}
            >{formatDate(r.date)}</time
          >
        </div>
        <div class="release-notes">
          {#if r.version in rendered}
            <!-- nosemgrep: svelte-at-html -- renderMarkdown() output only: markdown-it with html:false, the image rule off and non-http(s)/mailto links turned to text -->
            {@html rendered[r.version]}
          {:else}
            <p class="plain-notes">{plainNotes(r)}</p>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
  {#if hiddenCount > 0}
    <button
      type="button"
      class="more-releases"
      id="more-releases"
      onclick={() => (visibleCount += PAGE_SIZE)}
    >
      Show {Math.min(PAGE_SIZE, hiddenCount)} older releases ({hiddenCount} more)
    </button>
  {/if}
  <p
    class="empty-state"
    id="release-empty"
    hidden={!loaded || releases.length > 0}
  >
    No releases published yet.
  </p>
</div>
