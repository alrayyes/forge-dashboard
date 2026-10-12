<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { syncThemeFromServer } from "#lib/theme.js";
  import { loadTimezone } from "#lib/time.svelte.js";
  import Footer from "#lib/Footer.svelte";
  import { navCounts, setNavCounts } from "#lib/nav-counts.svelte.js";
  import type { ServerNavCounts } from "#lib/nav-counts.svelte.js";
  import { headerLabel, tabLabel } from "#lib/nav-labels.js";
  import NavPills from "#lib/NavPills.svelte";

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

  // The numbers each item shows (#1315). The pills are aria-hidden, so each
  // link's own name carries them: "Branches, 12 total, 3 failing" on the
  // header icon, "12 Branches, 3 failing" on the tab, which shows its numbers
  // before its word.
  const branches = $derived(navCounts.value?.branches ?? null);
  const pulls = $derived(navCounts.value?.pullRequests ?? null);
  const issues = $derived(navCounts.value?.issues ?? null);
  const releases = $derived(navCounts.value?.releases ?? null);
  const bots = $derived(navCounts.value?.bots ?? null);

  const branchesLabel = $derived(headerLabel("Branches", branches));
  const branchesTabLabel = $derived(tabLabel("Branches", branches));
  const pullsLabel = $derived(headerLabel("Pull requests", pulls));
  const pullsTabLabel = $derived(tabLabel("PRs", pulls));
  const issuesLabel = $derived(headerLabel("Issues", issues));
  const issuesTabLabel = $derived(tabLabel("Issues", issues));
  const releasesLabel = $derived(headerLabel("Releases", releases));
  const releasesTabLabel = $derived(tabLabel("Releases", releases));
  const botsLabel = $derived(headerLabel("Bots", bots));
  const botsTabLabel = $derived(tabLabel("Bots", bots));

  // A page with nothing to show leaves the navigation (#1228). A count that
  // isn't known yet (null) is not zero, so a link doesn't blink in as the first
  // snapshot arrives, and the page you are on keeps its own link until you
  // leave it. Branches and Pull requests always show.
  const showIssues = $derived(
    issues === null || issues.total !== 0 || isCurrentRoute("/issues"),
  );
  const showReleases = $derived(
    releases === null || releases.total !== 0 || isCurrentRoute("/releases"),
  );
  const showBots = $derived(
    bots === null || bots.total !== 0 || isCurrentRoute("/bots"),
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

    // The dashboard views set the counts from their own snapshots. Every
    // other page asks once, so the badges are there too. Asked only once a
    // session exists: the changelog, disclaimer and privacy pages are open to
    // visitors, who have none (#1261).
    function loadNavCounts() {
      if (
        !isCurrentRoute("/pull-requests") &&
        !isCurrentRoute("/issues") &&
        !isCurrentRoute("/releases") &&
        !isCurrentRoute("/bots")
      ) {
        fetch("/api/dashboard", { headers: { Accept: "application/json" } })
          .then((res) => (res.ok ? res.json() : null))
          .then((data: { navCounts?: ServerNavCounts } | null) => {
            if (data) setNavCounts(data.navCounts);
          })
          .catch(() => {
            /* no badge is better than a wrong one */
          });
      }
    }

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
        loadNavCounts();
      })
      .catch(() => {
        /* a transient failure here isn't worth blocking the page over */
      });
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
          aria-label={branchesLabel}
          title="Branches"
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
            ><rect width="8" height="8" x="3" y="3" rx="2" /><path
              d="M7 11v4a2 2 0 0 0 2 2h4"
            /><rect width="8" height="8" x="13" y="13" rx="2" /></svg
          >
          <NavPills count={branches} />
        </a>
        <a
          class="theme-toggle"
          href="/pull-requests.html"
          aria-label={pullsLabel}
          title="Pull requests"
          aria-current={isCurrentRoute("/pull-requests") ? "page" : undefined}
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
            ><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path
              d="M13 6h3a2 2 0 0 1 2 2v7"
            /><line x1="6" x2="6" y1="9" y2="21" /></svg
          ><NavPills count={pulls} />
        </a>
        {#if showReleases}
          <a
            class="theme-toggle"
            href="/releases.html"
            aria-label={releasesLabel}
            title="Releases"
            aria-current={isCurrentRoute("/releases") ? "page" : undefined}
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
                d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"
              /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" /></svg
            ><NavPills count={releases} />
          </a>
        {/if}
        {#if showBots}
          <a
            class="theme-toggle"
            href="/bots.html"
            aria-label={botsLabel}
            title="Bots"
            aria-current={isCurrentRoute("/bots") ? "page" : undefined}
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
              ><path d="M12 8V4H8" /><rect
                width="16"
                height="12"
                x="4"
                y="8"
                rx="2"
              /><path d="M2 14h2" /><path d="M20 14h2" /><path
                d="M15 13v2"
              /><path d="M9 13v2" /></svg
            ><NavPills count={bots} />
          </a>
        {/if}
        {#if showIssues}
          <a
            class="theme-toggle"
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
            ><NavPills count={issues} />
          </a>
        {/if}
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
    aria-label={branchesTabLabel}
    aria-current={isCurrentRoute("/") ? "page" : undefined}
  >
    <NavPills count={branches} stacked />
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      ><rect width="8" height="8" x="3" y="3" rx="2" /><rect
        width="8"
        height="8"
        x="13"
        y="13"
        rx="2"
      /><path d="M7 11v4a2 2 0 0 0 2 2h4" /></svg
    >
    <span class="bottom-nav-label">Branches</span>
  </a>
  <a
    class="bottom-nav-link"
    href="/pull-requests.html"
    aria-label={pullsTabLabel}
    aria-current={isCurrentRoute("/pull-requests") ? "page" : undefined}
  >
    <NavPills count={pulls} stacked />
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      ><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path
        d="M13 6h3a2 2 0 0 1 2 2v7"
      /><line x1="6" x2="6" y1="9" y2="21" /></svg
    >
    <span class="bottom-nav-label">PRs</span>
  </a>
  {#if showReleases}
    <a
      class="bottom-nav-link"
      href="/releases.html"
      aria-label={releasesTabLabel}
      aria-current={isCurrentRoute("/releases") ? "page" : undefined}
    >
      <NavPills count={releases} stacked />
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
          d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"
        /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" /></svg
      >
      <span class="bottom-nav-label">Releases</span>
    </a>
  {/if}
  {#if showBots}
    <a
      class="bottom-nav-link"
      href="/bots.html"
      aria-label={botsTabLabel}
      aria-current={isCurrentRoute("/bots") ? "page" : undefined}
    >
      <NavPills count={bots} stacked />
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><path d="M12 8V4H8" /><rect
          width="16"
          height="12"
          x="4"
          y="8"
          rx="2"
        /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path
          d="M9 13v2"
        /></svg
      >
      <span class="bottom-nav-label">Bots</span>
    </a>
  {/if}
  {#if showIssues}
    <a
      class="bottom-nav-link"
      href="/issues.html"
      aria-label={issuesTabLabel}
      aria-current={isCurrentRoute("/issues") ? "page" : undefined}
    >
      <NavPills count={issues} stacked />
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
      >
      <span class="bottom-nav-label">Issues</span>
    </a>
  {/if}
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
