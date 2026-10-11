<script lang="ts">
  import Footer from "#lib/Footer.svelte";

  // The dashboard's own error page (#1175, rules/error-pages.md): what
  // happened in plain words, one sentence that doesn't blame the visitor, a
  // way back, and a short list of the main sections. It shows nothing about
  // the server: no stack trace, path, host or version. Used by +error.svelte
  // for errors the router meets, and prerendered at /404 and /500 so the Go
  // server has finished pages to serve with the real status.
  let { status }: { status: number } = $props();

  const notFound = $derived(status === 404);
  const headline = $derived(
    notFound ? "Page not found" : "Something went wrong on our side",
  );
  const sentence = $derived(
    notFound
      ? "We couldn't find that page. The address may have changed or been mistyped."
      : "The dashboard hit an unexpected problem. Trying again often works. If it keeps happening, it's ours to fix.",
  );
</script>

<svelte:head>
  <title
    >{notFound ? "Page not found" : "Something went wrong"} — Forge Board</title
  >
  <style>
    .error-wrap {
      max-width: 720px;
      margin: 0 auto;
      padding: 28px 0 64px;
    }
    .error-brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      color: inherit;
      text-decoration: none;
      font-weight: 600;
      font-size: 19px;
      border-radius: 8px;
      margin-bottom: 28px;
    }
    .error-brand:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .error-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 28px 24px;
    }
    .error-status {
      display: inline-block;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--ink-2);
      background: var(--neutral-bg);
      border-radius: 4px;
      padding: 2px 8px;
      margin: 0 0 14px;
    }
    .error-card h1 {
      font-size: 24px;
      margin: 0 0 10px;
      letter-spacing: -0.01em;
    }
    .error-card .error-sentence {
      margin: 0 0 22px;
      font-size: 14.5px;
      color: var(--ink-2);
      line-height: 1.5;
    }
    .error-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 26px;
    }
    .error-primary,
    .error-secondary {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      padding: 0 16px;
      border-radius: 8px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
    }
    .error-primary {
      background: var(--accent);
      color: var(--accent-ink);
      border: 1px solid transparent;
    }
    .error-primary:hover {
      filter: brightness(1.05);
    }
    .error-secondary {
      background: var(--surface);
      color: var(--ink);
      border: 1px solid var(--border-strong);
    }
    .error-primary:focus-visible,
    .error-secondary:focus-visible,
    .error-links a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .error-links h2 {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--ink-2);
      margin: 0 0 8px;
    }
    .error-links ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 8px 18px;
    }
    .error-links a {
      display: inline-block;
      padding: 6px 0;
      min-height: 24px;
      color: var(--accent);
      font-size: 14px;
    }
  </style>
</svelte:head>

<div class="error-wrap">
  <a class="error-brand" href="/" aria-label="Forge Board home">
    <span class="brand-mark" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <circle cx="6" cy="6" r="2.4" stroke="#eef1f6" stroke-width="1.6" />
        <circle cx="6" cy="18" r="2.4" stroke="#eef1f6" stroke-width="1.6" />
        <circle cx="18" cy="12" r="2.4" stroke="#eef1f6" stroke-width="1.6" />
        <path d="M6 8.4V15.6" stroke="#eef1f6" stroke-width="1.6" />
        <path d="M8.2 7.2 15.8 10.8" stroke="#eef1f6" stroke-width="1.6" />
        <path d="M8.2 16.8 15.8 13.2" stroke="#eef1f6" stroke-width="1.6" />
      </svg>
    </span>
    Forge Board
  </a>

  <main class="error-card">
    <p class="error-status">Error {status}</p>
    <h1>{headline}</h1>
    <p class="error-sentence">{sentence}</p>
    <div class="error-actions">
      <a class="error-primary" href="/">Back to pull requests</a>
      {#if !notFound}
        <button
          type="button"
          class="error-secondary"
          onclick={() => window.location.reload()}>Try again</button
        >
      {/if}
    </div>
    <nav class="error-links" aria-label="Where to go next">
      <h2>Where to go next</h2>
      <ul>
        <li><a href="/issues.html">Issues</a></li>
        <li><a href="/releases.html">Releases</a></li>
        <li><a href="/insights.html">Insights</a></li>
        <li><a href="/settings.html">Settings</a></li>
      </ul>
    </nav>
  </main>
</div>

<Footer />
