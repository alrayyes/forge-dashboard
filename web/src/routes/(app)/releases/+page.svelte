<script lang="ts">
  import { onMount } from "svelte";

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

  function escapeHTML(s: string): string {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  function inline(text: string): string {
    return escapeHTML(text).replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, label, url) =>
        `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    );
  }

  // release-please/goreleaser output, not general Markdown: a leading
  // "## [version](compare-link) (date)" line (dropped — redundant with
  // the version/date this page already shows above it), then
  // "### Features"/"### Bug Fixes" sections of "* text ([#N](url))
  // ([hash](url))" bullets. Narrow to exactly that shape, safe by
  // construction since every piece of text is HTML-escaped before any
  // tag goes around it.
  function renderReleaseNotes(body: string | null): string {
    const lines = (body || "").split("\n");
    let html = "";
    let inList = false;

    function closeList() {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.indexOf("## ") === 0) continue;
      if (line.indexOf("### ") === 0) {
        closeList();
        html += `<h3>${inline(line.slice(4))}</h3>`;
        continue;
      }
      if (line.indexOf("* ") === 0) {
        if (!inList) {
          html += "<ul>";
          inList = true;
        }
        html += `<li>${inline(line.slice(2))}</li>`;
        continue;
      }
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
    closeList();
    return html;
  }

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

  onMount(() => {
    fetch("/changelog.json", { headers: { Accept: "application/json" } })
      .then((res) => {
        if (!res.ok) throw new Error(`changelog answered ${res.status}`);
        return res.json();
      })
      .then((data: { releases?: Release[] }) => {
        status = "";
        releases = data.releases ?? [];
        loaded = true;
      })
      .catch(() => {
        status = "Could not load the changelog.";
        statusKind = "error";
        loaded = true;
      });
  });
</script>

<svelte:head>
  <title>Release history — Forge Board</title>
  <style>
    .releases-wrap {
      max-width: 720px;
      margin: 0 auto;
      padding: 28px 0 64px;
    }
    .releases-header {
      margin-bottom: 22px;
    }
    .releases-header h1 {
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
    .release-notes ul {
      margin: 0 0 4px;
      padding-left: 20px;
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
    .empty-state {
      font-size: 13px;
      color: var(--ink-3);
      padding: 8px 0;
    }
  </style>
</svelte:head>

<div class="releases-wrap">
  <div class="releases-header">
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
    {#each releases as r (r.version)}
      <li class="release">
        <div class="release-head">
          <h2>
            {#if r.url}<a href={r.url} target="_blank" rel="noopener noreferrer"
                >v{r.version}</a
              >{:else}v{r.version}{/if}
          </h2>
          <time class="release-date" datetime={r.date}
            >{formatDate(r.date)}</time
          >
        </div>
        <div class="release-notes">
          {@html renderReleaseNotes(r.notes)}
        </div>
      </li>
    {/each}
  </ul>
  <p
    class="empty-state"
    id="release-empty"
    hidden={!loaded || releases.length > 0}
  >
    No releases published yet.
  </p>
</div>
