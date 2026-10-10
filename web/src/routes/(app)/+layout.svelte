<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { syncThemeFromServer } from "#lib/theme.js";
  import { loadTimezone } from "#lib/time.svelte.js";
  import Footer from "#lib/Footer.svelte";
  import { issueCount } from "#lib/issue-count.svelte.js";

  let { children } = $props();

  // Matches GET /api/auth/session's JSON body — see nav.js's own comment
  // (now retired for every page under this layout) for the shape this
  // was always fetching.
  type Session = { displayName: string; isAdmin: boolean };

  let displayName = $state("");
  let isAdmin = $state(false);

  // SvelteKit's own reactive current-URL, replacing nav.js's
  // `a.pathname === window.location.pathname` DOM query (design.md -
  // Decisions: "Current-page detection uses SvelteKit's own
  // $page.url.pathname").
  const currentPath = $derived(page.url.pathname);

  // route is the SvelteKit route this layout's own links mean to point
  // at ("/insights", not "/insights.html" — see web/src/routes/(app)/
  // for the real per-page route paths). The header's own <a href>s below
  // still carry the pre-Svelte ".html" filenames, because
  // internal/api/server.go only registers GET handlers for those, not
  // yet for the bare route path — a hard page load today lands on
  // "/insights.html", not "/insights". Matching both forms here is what
  // keeps aria-current correct under today's real navigation (out of
  // this change's scope to also update the Go backend's routing) as well
  // as a future client-side navigation to the bare route.
  function isCurrentRoute(route: string): boolean {
    return (
      currentPath === route ||
      (route !== "/" && currentPath === `${route}.html`)
    );
  }

  // Release history, disclaimer and privacy are inside this (app) route
  // group by file location, but are meant to stay reachable without a
  // session (nav.js's old behavior read a document.body.dataset.
  // pageRequiresAuth = "false" flag these three pages set, and skipped
  // its redirect-to-login on a 401 — see the fetch below). Rather than
  // that DOM flag (a mount-order race between this layout's onMount and
  // each page's own, and nothing sets it once nav.js is retired here),
  // this reuses isCurrentRoute's own tolerant path matching against
  // currentPath directly: no child-to-parent signaling needed.
  const PUBLIC_ROUTES = ["/changelog", "/disclaimer", "/privacy"];

  function isPublicRoute(): boolean {
    return PUBLIC_ROUTES.some((route) => isCurrentRoute(route));
  }

  // "Issues, 12 open" for assistive tech; the visible badge is aria-hidden so
  // the number isn't read twice.
  const issuesLabel = $derived(
    issueCount.value === null ? "Issues" : `Issues, ${issueCount.value} open`,
  );
  // The bottom tab shows the count before the word ("12 Issues"), and a label
  // has to contain the words on screen (WCAG 2.5.3, #1135), so it reads the
  // same way round.
  const issuesTabLabel = $derived(
    issueCount.value === null ? "Issues" : `${issueCount.value} Issues open`,
  );

  function signOut() {
    fetch("/api/auth/logout", { method: "POST" }).finally(() => {
      window.location.href = "/login.html";
    });
  }

  // nav.js used to be a plain DOM-query IIFE — its own logic is ported
  // above/below as real Svelte state now. footer.js's own injection is
  // gone too: Footer.svelte (imported above) is rendered directly at the
  // end of this layout's template instead (alrayyes/forge-dashboard's
  // shared-footer-component change).
  onMount(() => {
    // The header no longer has its own toggle (#352 — theme is a
    // Settings-only control now); this is the "did another device
    // change it" half, reconciling the fast local cookie theme the inline script
    // already applied against whatever's actually saved.
    syncThemeFromServer();
    // Times on every page below read this; a failure leaves the browser's zone.
    loadTimezone();

    // ---- who's signed in ----
    // Ported from nav.js verbatim in behavior: same endpoint, same 401
    // redirect target — except release history, disclaimer and privacy
    // (see isPublicRoute above), which stay put on a 401 instead of
    // redirecting, same as nav.js's own pageRequiresAuth === "false" skip
    // used to for those three pages.
    fetch("/api/auth/session", { headers: { Accept: "application/json" } })
      .then((res) => {
        if (res.status === 401) {
          if (!isPublicRoute()) {
            window.location.href = "/login.html";
          }
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((session: Session | null) => {
        if (!session) return;
        displayName = session.displayName;
        isAdmin = session.isAdmin;
      })
      .catch(() => {
        /* a transient failure here isn't worth blocking the page over */
      });

    // The dashboard views set the issue count from their own snapshots.
    // Every other signed-in page asks once, so the badge is there too.
    if (
      !isPublicRoute() &&
      !isCurrentRoute("/") &&
      !isCurrentRoute("/issues")
    ) {
      fetch("/api/dashboard", { headers: { Accept: "application/json" } })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { openIssueCount?: number } | null) => {
          if (data && typeof data.openIssueCount === "number")
            issueCount.value = data.openIssueCount;
        })
        .catch(() => {
          /* no badge is better than a wrong one */
        });
    }
  });
</script>

<!--
  The header/nav/footer chrome every page shares — ported from the vanilla
  pages' duplicated HTML (internal/api/static/*.html) rather than redesigned,
  so footer.js keeps working unmodified: it's a plain DOM-query script with
  no framework coupling, matching the same ids/classes this markup still
  carries. nav.js itself is no longer loaded here — its session fetch,
  current-page highlight, admin-link visibility and sign-out are all real
  Svelte state now (see the script block above and the mobile bottom tab
  bar below); nav.js stays in the tree only for the three unauthenticated
  pages that still load it directly.
-->
<div class="wrap">
  <header>
    <a class="brand" href="/" aria-label="Forge Board home">
      <div class="brand-mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="6" cy="6" r="2.4" stroke="#eef1f6" stroke-width="1.6" />
          <circle cx="6" cy="18" r="2.4" stroke="#eef1f6" stroke-width="1.6" />
          <circle cx="18" cy="12" r="2.4" stroke="#eef1f6" stroke-width="1.6" />
          <path d="M6 8.4V15.6" stroke="#eef1f6" stroke-width="1.6" />
          <path d="M8.2 7.2 15.8 10.8" stroke="#eef1f6" stroke-width="1.6" />
          <path d="M8.2 16.8 15.8 13.2" stroke="#eef1f6" stroke-width="1.6" />
        </svg>
      </div>
      <div>
        <h1>Forge Board</h1>
      </div>
    </a>
    <div class="header-status">
      <span class="mono" id="whoami" style="font-size:12px;color:var(--ink-3);"
        >{displayName}</span
      >
      <nav class="app-nav" aria-label="Main">
        <a
          class="theme-toggle"
          href="/"
          aria-label="Home"
          title="Home"
          aria-current={isCurrentRoute("/") ? "page" : undefined}
          style="text-decoration:none;"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><path
              d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"
            /></svg
          >
        </a>
        <a
          class="theme-toggle nav-with-badge"
          href="/issues.html"
          aria-label={issuesLabel}
          title="Issues"
          aria-current={isCurrentRoute("/issues") ? "page" : undefined}
          style="text-decoration:none;"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><circle cx="12" cy="12" r="10" /><circle
              cx="12"
              cy="12"
              r="1"
            /></svg
          >{#if issueCount.value !== null}<span
              class="nav-badge"
              aria-hidden="true">{issueCount.value}</span
            >{/if}
        </a>
        <a
          class="theme-toggle"
          href="/insights.html"
          aria-label="Insights"
          title="Insights"
          aria-current={isCurrentRoute("/insights") ? "page" : undefined}
          style="text-decoration:none;"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><path d="M3 3v18h18" /><path
              d="M18.7 8 13 13.7l-3-3L4 16.7"
            /></svg
          >
        </a>
        <a
          class="theme-toggle"
          href="/webhooks.html"
          aria-label="Webhooks"
          title="Webhooks"
          aria-current={isCurrentRoute("/webhooks") ? "page" : undefined}
          style="text-decoration:none;"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg
          >
        </a>
        <a
          class="theme-toggle"
          href="/settings.html"
          aria-label="Settings"
          title="Settings"
          aria-current={isCurrentRoute("/settings") ? "page" : undefined}
          style="text-decoration:none;"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><circle cx="12" cy="12" r="3" /><path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
            /></svg
          >
        </a>
        {#if isAdmin}
          <a
            class="theme-toggle"
            href="/admin.html"
            id="admin-link"
            aria-label="Admin"
            title="Admin"
            aria-current={isCurrentRoute("/admin") ? "page" : undefined}
            style="text-decoration:none;"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle
                cx="9"
                cy="7"
                r="4"
              /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path
                d="M16 3.13a4 4 0 0 1 0 7.75"
              /></svg
            >
          </a>
        {/if}
      </nav>
      <button
        class="theme-toggle"
        id="logout-button"
        type="button"
        aria-label="Sign out"
        title="Sign out"
        onclick={signOut}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          ><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path
            d="M16 17l5-5-5-5"
          /><path d="M21 12H9" /></svg
        >
      </button>
    </div>
  </header>
</div>

<!--
  The mobile bottom tab bar (design.md - Decisions): a second, distinct
  <nav> landmark — not a copy of .app-nav's DOM, and given its own
  aria-label ("Mobile navigation" vs. the header's "Main") so a Playwright
  locator scoped to `a[aria-label="..."]` can tell the two surfaces apart
  once both exist in the DOM. Reuses the header's own icon SVGs and link
  labels for a consistent accessible name per destination; Admin is
  deliberately not one of these four tabs (design.md settled that as
  header/desktop-only). Shown/hidden purely by CSS (style.css's own
  breakpoint comment names which one) rather than an {#if isMobile} block,
  so there's no flash-of-missing-nav on first paint and no matchMedia
  listener needed.
-->
<nav class="bottom-nav" aria-label="Mobile navigation">
  <a
    class="bottom-nav-link"
    href="/"
    aria-label="Home"
    aria-current={isCurrentRoute("/") ? "page" : undefined}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      ><path
        d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"
      /></svg
    >
    <span class="bottom-nav-label">Home</span>
  </a>
  <a
    class="bottom-nav-link nav-with-badge"
    href="/issues.html"
    aria-label={issuesTabLabel}
    aria-current={isCurrentRoute("/issues") ? "page" : undefined}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      ><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="1" /></svg
    >{#if issueCount.value !== null}<span class="nav-badge" aria-hidden="true"
        >{issueCount.value}</span
      >{/if}
    <span class="bottom-nav-label">Issues</span>
  </a>
  <a
    class="bottom-nav-link"
    href="/insights.html"
    aria-label="Insights"
    aria-current={isCurrentRoute("/insights") ? "page" : undefined}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      ><path d="M3 3v18h18" /><path d="M18.7 8 13 13.7l-3-3L4 16.7" /></svg
    >
    <span class="bottom-nav-label">Insights</span>
  </a>
  <a
    class="bottom-nav-link"
    href="/webhooks.html"
    aria-label="Webhooks"
    aria-current={isCurrentRoute("/webhooks") ? "page" : undefined}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg
    >
    <span class="bottom-nav-label">Webhooks</span>
  </a>
  <a
    class="bottom-nav-link"
    href="/settings.html"
    aria-label="Settings"
    aria-current={isCurrentRoute("/settings") ? "page" : undefined}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      ><circle cx="12" cy="12" r="3" /><path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
      /></svg
    >
    <span class="bottom-nav-label">Settings</span>
  </a>
</nav>

{@render children()}

<Footer />
