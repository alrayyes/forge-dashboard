<script lang="ts">
  import { onMount } from "svelte";
  import { syncThemeFromServer } from "$lib/theme";

  // The dashboard is the one page with header content no other page
  // needs (forge health, the owner-switcher, the refresh button) — see
  // (app)/+layout.svelte's own comment on why that shared layout exists
  // at all: convenience for pages that don't need anything extra. This
  // page predates it and still doesn't fit it, so it keeps its own full
  // header (and stays outside the (app) route group) rather than
  // stretching that layout to carry markup every other page would just
  // render empty and unused.

  type PullRequestItem = FilterableItem & {
    number: number;
    url: string;
    draft: boolean;
    ci: string;
    mergeStatus: string;
    autoMergeEnabled: boolean | null;
    behind: boolean;
  };
  type IssueItem = FilterableItem & {
    number: number;
    url: string;
  };
  // Matches components.schemas.Check in api/openapi.yaml — one job/check
  // run against a pull request's head commit, as returned by
  // GET /api/pull-requests/checks.
  type Check = { name: string; state: string; url: string };
  type RateLimit = { limit: number; remaining: number; resetsAt: string };
  type Forge = {
    forge: string;
    reachable: boolean;
    repoCount: number;
    errorKind?: string;
    error?: string;
    // Two independent GitHub budgets (#361) — see api/openapi.yaml's own
    // ForgeHealth.rateLimitGraphQL/rateLimitREST doc comment for which
    // is which and when each is reported.
    rateLimitGraphQL?: RateLimit;
    rateLimitREST?: RateLimit;
  };
  type DashboardSnapshot = {
    generatedAt: string;
    forges: Forge[];
    pullRequests: PullRequestItem[];
    issues: IssueItem[];
  };
  type ActionPhase =
    "idle" | "confirming" | "merging" | "updating" | "requesting" | "locked";
  type ActionState = { phase: ActionPhase; reason?: string };

  onMount(() => {
    for (const src of ["/footer.js", "/nav.js"]) {
      const script = document.createElement("script");
      script.src = src;
      document.body.appendChild(script);
    }
    syncThemeFromServer();

    const filtersScript = document.createElement("script");
    filtersScript.src = "/filters.js";
    filtersScript.addEventListener("load", initDashboard);
    document.body.appendChild(filtersScript);
  });

  // Everything below only ever runs once filters.js (the global Filters,
  // shared with Insights) has loaded — a straight TypeScript port of
  // app.js, kept in its original imperative, DOM-query-driven shape
  // rather than rewritten as reactive Svelte state: this page's own
  // state (per-row merge/update-branch/Dependabot/Renovate action locks,
  // in-flight phases, pagination, the poll + SSE loop) is exactly the
  // kind of thing Svelte's own guidance says to keep as a mutex-owned
  // plain object outside the framework rather than fight a second state
  // system over — see rules/go.md's "one owner per piece of mutable
  // state" for the same principle applied to a goroutine instead of a
  // browser tab.
  function initDashboard() {
    const REFRESH_INTERVAL_MS = 30000;
    const CI_LABELS: Record<string, string> = {
      success: "Passing",
      failure: "Failing",
      pending: "Running",
      none: "No checks",
    };
    const FORGE_LABELS = window.Filters.FORGE_LABELS;
    const FORGE_CLASSES: Record<string, string> = {
      github: "gh",
      forgejo: "fj",
    };

    let lastGeneratedAt: string | null = null;

    // ---- formatting ----
    function relativeTime(iso: string): string {
      const mins = window.Filters.minutesAgo(iso);
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.round(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.round(hours / 24);
      return `${days}d ago`;
    }

    // No optional (`?`) parameters here on purpose: Svelte's own
    // Rolldown-based build parser (distinct from svelte-check's full TS
    // language service, which accepts either form) rejects a plain
    // function's optional parameters inside a `<script>` block — plain
    // defaults instead, every call site already only ever omits a
    // trailing argument rather than passing an explicit empty string.
    function el(
      tag: string,
      className: string = "",
      text: string = "",
    ): HTMLElement {
      const e = document.createElement(tag);
      if (className) e.className = className;
      if (text) e.textContent = text;
      return e;
    }

    // A generic `el<K extends keyof HTMLElementTagNameMap>` overload reads
    // better than this cast at every button call site, but trips the
    // Svelte compiler's own script parser (distinct from svelte-check's
    // full TS language service, which accepts it fine) on `<script>`
    // blocks that aren't already a generic component's own
    // `<script generics="...">` — a real, narrower gap than TypeScript's
    // own generic function syntax itself.
    function buttonEl(
      className: string = "",
      text: string = "",
    ): HTMLButtonElement {
      return el("button", className, text) as HTMLButtonElement;
    }

    // Used by each board's own small count next to its heading — the
    // full phrase reads fine at that size. The top stat tile below gets
    // its own, more compact treatment: shownCountText would wrap a 26px
    // bold number onto two lines.
    function shownCountText(shown: number, total: number): string {
      return shown === total ? `${total} open` : `${shown} of ${total} shown`;
    }

    // idPrefix ('pr'/'issue') -> the top stat tile for that entity type.
    const STAT_TILE_IDS: Record<string, string> = {
      pr: "stat-prs",
      issue: "stat-issues",
    };

    // The stat tile's headline number is the filtered count — what's
    // actually visible in the board below it right now — with a small
    // muted "/ total" only when a filter is actually narrowing it, so an
    // unfiltered tile looks exactly as it always has.
    function renderStatTile(tileId: string, shown: number, total: number) {
      const tile = document.getElementById(tileId);
      if (!tile) return;
      tile.innerHTML = "";
      tile.appendChild(document.createTextNode(String(shown)));
      if (shown !== total) {
        tile.appendChild(el("span", "n-total", ` / ${total}`));
      }
    }

    // ---- row rendering ----
    function repoCell(item: FilterableItem): HTMLElement {
      const wrap = el("div", "repo");
      const badge = el("span", `forge-badge ${FORGE_CLASSES[item.forge]}`);
      badge.appendChild(el("span", "dot"));
      badge.appendChild(
        document.createTextNode(FORGE_LABELS[item.forge] || item.forge),
      );
      wrap.appendChild(badge);
      const repoName = el("span", "repo-name", item.repo);
      // .repo-name truncates via CSS text-overflow: ellipsis — title
      // is what lets a mouse user actually read the full name on
      // hover; the truncation is purely visual, so a screen reader
      // already reads the untruncated text content regardless.
      repoName.title = item.repo;
      wrap.appendChild(repoName);
      return wrap;
    }

    // WCAG relative-luminance/contrast math (same formula this codebase's
    // own design tokens were hand-verified against) — picks whichever of
    // near-black/near-white ink actually reads against a label's real
    // background color, since that color is arbitrary and forge-supplied,
    // not one of our own palette's pre-checked pairs.
    function relativeLuminance(hex: string): number {
      function channel(c: number): number {
        c = c / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }
      const r = channel(Number.parseInt(hex.substr(0, 2), 16));
      const g = channel(Number.parseInt(hex.substr(2, 2), 16));
      const b = channel(Number.parseInt(hex.substr(4, 2), 16));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function contrastRatio(l1: number, l2: number): number {
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    function labelTextColor(bgHex: string): string {
      // True black/white, not this app's own --ink/--ink-3 tokens — a
      // themed near-black measurably under-performs pure black against
      // an arbitrary background (caught live: GitHub's own default "bug"
      // red, #d73a4a, cleared 4.5:1 against pure black at 4.59:1 but
      // only hit 4.2:1 against this app's #0b0f14 — the decision math
      // and the applied color have to agree on which black they mean, or
      // a label can fail axe-core's contrast check despite this function
      // "picking the higher-contrast option").
      const bg = relativeLuminance(bgHex);
      const blackContrast = contrastRatio(bg, 0);
      const whiteContrast = contrastRatio(bg, 1);
      return blackContrast >= whiteContrast ? "#000000" : "#ffffff";
    }

    // A real button — see the comment above ciPill on why the row isn't
    // an <a> around everything.
    function labelChip(
      label: { name: string; color?: string },
      onLabelClick: (name: string) => void,
      activeLabel: string,
    ): HTMLButtonElement {
      const chip = document.createElement("button");
      chip.type = "button";
      // activeLabel (the shared label filter) is always lowercase — set
      // that way by both a chip click and the shared Label <select>'s
      // generic .col-filter wiring, which lowercases every filter value
      // uniformly — so the comparison here has to lowercase label.name
      // to match.
      const isActive = label.name.toLowerCase() === activeLabel;
      chip.className = `label-chip${isActive ? " active" : ""}`;
      chip.textContent = label.name;
      if (label.color && !isActive) {
        // The active state has its own fixed accent styling (see
        // .label-chip.active in style.css) — a per-label background
        // would fight with "this is the one currently filtering" as a
        // signal.
        chip.style.backgroundColor = `#${label.color}`;
        chip.style.borderColor = `#${label.color}`;
        chip.style.color = labelTextColor(label.color);
      }
      chip.setAttribute("aria-label", `Filter by label: ${label.name}`);
      chip.setAttribute("aria-pressed", String(isActive));
      chip.addEventListener("click", () => {
        onLabelClick(label.name);
      });
      return chip;
    }

    function titleCell(
      item: FilterableItem & { number: number; url: string; draft?: boolean },
      onLabelClick: (name: string) => void,
      activeLabel: string,
    ): HTMLElement {
      const wrap = el("div", "title-cell");
      // The real, keyboard-focusable link — a "stretched link" (see
      // .title-cell .title::after in style.css) makes the whole row
      // clickable, without the row itself being an <a> that would make
      // the CI pill and label chips invalid/inaccessible nested
      // interactive elements.
      // https://css-tricks.com/block-links-the-search-for-a-perfect-solution/
      const title = document.createElement("a");
      title.className = "title";
      title.href = item.url;
      title.target = "_blank";
      title.rel = "noopener noreferrer";
      // The ellipsis truncation lives on this inner span, not .title
      // itself — overflow:hidden on .title would clip its own ::after
      // stretched overlay down to .title's box instead of letting it
      // cover the whole row (see the comment on .title in style.css).
      const text = el("span", "title-text");
      text.appendChild(el("span", "num", `#${item.number}`));
      text.appendChild(document.createTextNode(item.title));
      title.appendChild(text);
      wrap.appendChild(title);
      if (item.draft) wrap.appendChild(el("span", "draft-badge", "Draft"));
      (item.labels || []).slice(0, 3).forEach((label) => {
        wrap.appendChild(labelChip(label, onLabelClick, activeLabel));
      });
      return wrap;
    }

    // status is a real button — see titleCell's comment on why the row
    // isn't an <a> around everything. onStatusClick is only ever passed
    // for the pull requests board (isPR).
    function ciPill(
      status: string,
      onStatusClick: ((status: string) => void) | undefined,
    ): HTMLButtonElement {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = `ci-pill ${status}`;
      pill.appendChild(el("span", "dot"));
      pill.appendChild(document.createTextNode(CI_LABELS[status] || status));
      pill.setAttribute(
        "aria-label",
        `Filter pull requests by CI status: ${CI_LABELS[status] || status}`,
      );
      pill.addEventListener("click", () => {
        onStatusClick?.(status);
      });
      return pill;
    }

    const MERGE_STATUS_LABELS: Record<string, string> = {
      conflicting: "Conflicting",
      blocked: "Blocked",
    };

    // Silent for "mergeable" and "unknown" — flagging every clean row
    // would just be noise (the same restraint .forge-health-error
    // already uses: shown only when there's actually a problem). Not a
    // button, unlike ciPill: there's no filter dimension for this, just
    // a fact about the row.
    //
    // #418: "blocked" specifically is also silent while ci is still
    // "pending" — GitHub's own mergeStateStatus reports BLOCKED whenever
    // required checks haven't *completed*, not only once one has
    // actually failed, the same root cause #385 already fixed for the
    // Merge button's own clickability. "conflicting" gets no such
    // exception: a real merge conflict is true regardless of CI state,
    // not a completion gate the way an incomplete "blocked" is.
    function mergeStatusPill(status: string, ci: string): HTMLElement | null {
      if (status === "blocked" && ci === "pending") return null;
      const label = MERGE_STATUS_LABELS[status];
      if (!label) return null;
      const pill = el("span", `merge-pill ${status}`);
      pill.appendChild(el("span", "dot"));
      pill.appendChild(document.createTextNode(label));
      return pill;
    }

    // Silent unless auto-merge is genuinely enabled — autoMergeEnabled
    // is `null` for a forge that can't report this at all (Forgejo,
    // today), which must never render as "not enabled": strict ===
    // true, not a truthy check.
    function autoMergePill(
      autoMergeEnabled: boolean | null,
    ): HTMLElement | null {
      if (autoMergeEnabled !== true) return null;
      const pill = el("span", "merge-pill auto-merge");
      pill.appendChild(el("span", "dot"));
      pill.appendChild(document.createTextNode("Auto-merge"));
      return pill;
    }

    function buildRow(
      item: PullRequestItem | IssueItem,
      isPR: boolean,
      onStatusClick: ((status: string) => void) | undefined,
      onLabelClick: (name: string) => void,
      activeLabel: string,
    ): HTMLElement {
      const row = el("div", "row");

      row.appendChild(repoCell(item));
      row.appendChild(titleCell(item, onLabelClick, activeLabel));

      const meta = el("div", "row-meta");
      meta.appendChild(el("div", "author", item.author));
      meta.appendChild(el("div", "created", relativeTime(item.createdAt)));
      meta.appendChild(el("div", "updated", relativeTime(item.updatedAt)));
      if (isPR) {
        const pr = item as PullRequestItem;
        // One cell, possibly several pills — keeps .row's fixed
        // grid-template-columns unchanged regardless of how many of
        // them this particular row has anything to say.
        const statusCell = el("div", "status-cell");
        statusCell.appendChild(ciPill(pr.ci, onStatusClick));
        const conflictPill = mergeStatusPill(pr.mergeStatus, pr.ci);
        if (conflictPill) statusCell.appendChild(conflictPill);
        const mergePill = autoMergePill(pr.autoMergeEnabled);
        if (mergePill) statusCell.appendChild(mergePill);
        const updateBranchAction = updateBranchActionCell(pr);
        if (updateBranchAction) statusCell.appendChild(updateBranchAction);
        const mergeAction = mergeActionCell(pr);
        if (mergeAction) statusCell.appendChild(mergeAction);
        const dependabotAction = dependabotActionCell(pr);
        if (dependabotAction) statusCell.appendChild(dependabotAction);
        const renovateRebaseAction = renovateRebaseActionCell(pr);
        if (renovateRebaseAction) statusCell.appendChild(renovateRebaseAction);
        const pipelineAction = pipelineActionCell(pr);
        if (pipelineAction) statusCell.appendChild(pipelineAction);
        meta.appendChild(statusCell);
      } else {
        meta.appendChild(el("div", "empty-cell"));
      }
      row.appendChild(meta);
      row.appendChild(el("div", "go", "→"));
      return row;
    }

    // ---- pull request merge action ----
    // mergeState persists per-PR merge-button UI state across renders —
    // the dashboard polls and pushes fresh snapshots (applySnapshot)
    // that rebuild every row from scratch, unlike the webhooks page's
    // one-shot render, so a lock earned from a real
    // permission/rate-limit/conflict failure has to live outside the DOM
    // node itself, or the next poll would silently hand back a
    // re-clickable button and undo the whole point of locking it (see
    // webhooks.js's own reactiveLockReason/lockedButton, the same
    // pattern this mirrors).
    const mergeState: Record<string, ActionState> = {};

    function prKey(item: {
      forge: string;
      repo: string;
      number: number;
    }): string {
      return `${item.forge}:${item.repo}#${item.number}`;
    }

    // A stable, DOM-safe id derived from a PR's own key — used to find a
    // just-re-rendered action button again after prBoard.render()
    // rebuilds every row from scratch, so a click handler can move
    // focus to it.
    function domSafeId(key: string): string {
      return key.replace(/[^a-zA-Z0-9_-]/g, "-");
    }

    // ---- bot-managed PR detection ----
    // release-please, Dependabot, and Renovate all keep their own pull
    // requests current on their own schedule — a manual Update branch
    // click is redundant at best and, for release-please specifically
    // (which regenerates the branch and changelog together on every
    // push to the base branch), a genuine risk of fighting its own next
    // run.

    // release-please labels every PR it manages with
    // "autorelease: pending" or "autorelease: tagged" — the author is a
    // human in this account's setup, not release-please itself, so the
    // label is the only signal.
    function isReleasePleasePr(item: PullRequestItem): boolean {
      return (item.labels || []).some((l) => l.name.startsWith("autorelease:"));
    }

    // Dependabot's author login is its GitHub App identity,
    // "app/dependabot" — not "dependabot[bot]", which is the older, now-
    // secondary identity.
    function isDependabotPr(item: PullRequestItem): boolean {
      return item.author === "app/dependabot";
    }

    // Renovate's author login varies by how it's installed (a GitHub App
    // vs. a classic bot account) — checking both forms this account has
    // seen documented, rather than picking one and risking silent
    // non-detection.
    function isRenovatePr(item: PullRequestItem): boolean {
      return item.author === "renovate[bot]" || item.author === "app/renovate";
    }

    function isBotManagedPr(item: PullRequestItem): boolean {
      return (
        isReleasePleasePr(item) || isDependabotPr(item) || isRenovatePr(item)
      );
    }

    // Strips the "github: <method> <path>: " / "forgejo: <method>
    // <path>: " diagnostic prefix restError/forgejoError wrap every
    // message in — useful in the full error banner, just noise in a
    // locked-row reason read right next to the button it's locking.
    function forgeMessageOnly(message: string): string {
      const match = /^(?:github|forgejo): \S+ \S+: (.+)$/.exec(message || "");
      return match ? match[1] : message;
    }

    // Mirrors webhooks.js's reactiveLockReason, plus 409 — GitHub's
    // merge endpoint uses that one status for two different causes: a PR
    // that's genuinely no longer mergeable, and a merge method the repo
    // doesn't allow (#349, collapsed into the same status by
    // forgeErrorKindFromStatus). The forge's own message, already
    // reaching the client, is what decides which reason to show, rather
    // than a second, independently-authored guess keyed only on the
    // status code.
    function reactiveMergeLockReason(
      status: number | undefined,
      message: string,
    ): string | null {
      if (status === 403)
        return "Missing permission — check your token in Settings.";
      if (status === 429)
        return "Rate limit exceeded — try again once it resets.";
      if (status === 409) {
        const real = forgeMessageOnly(message);
        if (!real || /not mergeable/i.test(real)) {
          return "No longer mergeable — refresh to see the current state.";
        }
        return real;
      }
      return null;
    }

    let actionLockReasonCounter = 0;

    // Same aria-disabled + visible, wired-up reason shape webhooks.js's
    // own lockedButton uses, not a native disabled attribute or a
    // title-only tooltip — native disabled would drop it from the tab
    // order and hide the reason from keyboard and screen-reader users.
    //
    // onRetry, when given, makes this a real clickable "Retry" instead
    // of a dead end. Left undefined for the actions that don't pass it
    // (Dependabot/Renovate), which keep today's plain disabled-button
    // behavior.
    function lockedActionButton(
      label: string,
      reasonText: string,
      onRetry: (() => void) | undefined = undefined,
    ): HTMLElement {
      const wrap = el("span", "row-action-locked");
      const button = buttonEl("row-action", onRetry ? "Retry" : label);
      button.type = "button";
      const reasonId = `action-locked-reason-${actionLockReasonCounter++}`;
      button.setAttribute("aria-describedby", reasonId);
      if (onRetry) {
        button.addEventListener("click", onRetry);
      } else {
        button.setAttribute("aria-disabled", "true");
      }
      wrap.appendChild(button);
      const reason = el("span", "row-action-reason", reasonText);
      reason.id = reasonId;
      wrap.appendChild(reason);
      return wrap;
    }

    // Clears every "locked for good" entry in a merge/update-branch
    // state map — called on every fresh snapshot (applySnapshot), so a
    // lock only ever reflects the most recent data instead of latching
    // until a full page reload. Leaves in-flight phases
    // ('confirming', 'merging', 'updating') alone; those track a request
    // actually in progress, not a stale conclusion from a previous one.
    function clearStaleLocks(stateMap: Record<string, ActionState>) {
      for (const key of Object.keys(stateMap)) {
        if (stateMap[key].phase === "locked") delete stateMap[key];
      }
    }

    // A branch update GitHub answers 202 to is its own background job,
    // not yet finished by the time the very next snapshot lands — so an
    // "updating" phase can't just be cleared the moment the POST
    // resolves (doUpdateBranch used to do exactly that, and the
    // in-flight button flickered back to a plain re-clickable one while
    // GitHub was still working, then vanished for good once a later
    // snapshot finally caught up). Left in place here until a snapshot
    // actually reports the PR no longer behind, the same real signal
    // updateBranchActionCell itself already gates the button's very
    // existence on. Called from applySnapshot — whichever snapshot is
    // the one that finally shows the PR caught up (doUpdateBranch's own
    // follow-up refresh, the next poll, an SSE push, or a manual
    // force-refresh click), not just the refresh doUpdateBranch itself
    // triggered — so the returned list is what the caller reports as
    // just-finished, regardless of which of those it was.
    function clearResolvedUpdateBranches(
      stateMap: Record<string, ActionState>,
      prs: PullRequestItem[],
    ): PullRequestItem[] {
      const stillBehind = new Set(
        prs.filter((p) => p.behind).map((p) => prKey(p)),
      );
      const resolved: PullRequestItem[] = [];
      for (const item of prs) {
        const key = prKey(item);
        if (stateMap[key]?.phase === "updating" && !stillBehind.has(key)) {
          delete stateMap[key];
          resolved.push(item);
        }
      }
      return resolved;
    }

    // The "Retry" click every locked merge/update-branch button now has
    // — re-fetches the dashboard for real (not from a cache) so the
    // lock re-derives from current data immediately instead of waiting
    // out the rest of the poll interval.
    function retryLockedAction(item: PullRequestItem) {
      showStatus(`Checking ${item.repo}#${item.number}…`);
      refreshDashboardNow()
        .then(() => {
          clearStatus();
        })
        .catch((err: Error) => {
          showError(`Could not refresh: ${err.message}`);
        });
    }

    // Set once any merge/update-branch call against a forge comes back
    // 403 — a token's write permission is an account-wide property, not
    // a per-PR one, so a permission failure on one PR means every other
    // PR on that same forge is doomed the same way, not just the one
    // that happened to be tried first. Persists for the session, the
    // same lifetime mergeState/updateBranchState's own per-PR locks
    // have — cleared only by a full page reload.
    const forgePermissionDenied: Record<string, boolean> = {};

    // Known-doomed before ever calling the API, the same pre-click check
    // addWebhookButton (webhooks.js) already does from ForgeHealth — a
    // forge that's currently unreachable or already out of rate-limit
    // budget will fail the exact same way after a real, wasted request
    // as it would before one.
    function proactiveActionLockReason(forgeName: string): string | null {
      const health = lastForges.find((f) => f.forge === forgeName);
      if (health && health.reachable === false) {
        // The specific reason (unreachable, rate-limited, ...) is
        // already stated once in the forge-health panel above, via
        // forgeErrorHeadline — repeating the same system-wide fact
        // under every affected row read as noise, not information
        // (#360).
        return "See the forge status above.";
      }
      // #361: every action this locks (Merge, Update branch, Dependabot,
      // Renovate) is a REST call — checking rateLimitGraphQL here would
      // have kept a REST-exhausted row looking clickable right up until
      // the click itself failed, since GraphQL's own budget is a
      // completely separate allowance that says nothing about REST's.
      if (health?.rateLimitREST && health.rateLimitREST.remaining === 0) {
        const resetTime = new Date(
          health.rateLimitREST.resetsAt,
        ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return `Rate limit exhausted · resets ${resetTime}`;
      }
      if (forgePermissionDenied[forgeName]) {
        return "Missing permission — check your token in Settings.";
      }
      return null;
    }

    // Actually calls the merge endpoint, once the confirm click lands —
    // mergeActionCell's own click handler only ever flips into
    // "confirming", so a single accidental click can never merge
    // anything.
    function doMerge(item: PullRequestItem, confirmButton: HTMLButtonElement) {
      const key = prKey(item);
      mergeState[key] = { phase: "merging" };
      confirmButton.disabled = true;
      confirmButton.textContent = "Merging…";
      showStatus(`Merging ${item.repo}#${item.number}…`);

      fetch("/api/pull-requests/merge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          forge: item.forge,
          fullName: item.repo,
          number: item.number,
        }),
      })
        .then((res) => {
          if (res.status === 401) {
            window.location.href = "/login.html";
            throw new Error("session expired");
          }
          if (res.status === 204) return null;
          return res.json().then((body) => {
            const err: Error & { status?: number } = new Error(
              body?.error || `backend answered ${res.status}`,
            );
            err.status = res.status;
            throw err;
          });
        })
        .then(() => {
          delete mergeState[key];
          showStatus(`Merged ${item.repo}#${item.number}.`);
          // Pulls a fresh snapshot right away rather than waiting out
          // the rest of the background poll's own interval — the same
          // call the "Refresh now" button makes — so the just-merged PR
          // drops off the board as soon as the forge itself reflects
          // the merge.
          return fetch("/api/dashboard/refresh", {
            method: "POST",
            headers: { Accept: "application/json" },
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (data) applySnapshot(data);
            });
        })
        .catch((err: Error & { status?: number }) => {
          const lockReason = reactiveMergeLockReason(err.status, err.message);
          mergeState[key] = lockReason
            ? { phase: "locked", reason: lockReason }
            : { phase: "idle" };
          if (err.status === 403) forgePermissionDenied[item.forge] = true;
          clearStatus();
          showError(
            `Couldn't merge ${item.repo}#${item.number}: ${err.message}`,
          );
          prBoard.render();
        });
    }

    // Only rendered at all when mergeStatus is "mergeable" — the same
    // restraint mergeStatusPill/autoMergePill already use for a row
    // that has nothing to say. First click only arms a confirm step
    // (doMerge is never reachable from it directly); merging is a real,
    // hard-to-reverse write to the real repo, not a filter toggle like
    // the CI pill next to it.
    function mergeActionCell(item: PullRequestItem): HTMLElement | null {
      // #385: GitHub's own mergeStateStatus reports CLEAN (mapped to
      // "mergeable" here) whenever branch protection doesn't mark a
      // given check as required, even while that check is still
      // running — so a PR whose CI hasn't finished could otherwise show
      // a fully clickable Merge button. CI failure is deliberately left
      // unchanged: a required check already blocks mergeStatus itself,
      // and GitHub lets a one-click merge over a non-required failure
      // anyway, so there's nothing extra to enforce here for that case.
      if (item.mergeStatus !== "mergeable" || item.ci === "pending")
        return null;

      const key = prKey(item);
      const entry = mergeState[key] || { phase: "idle" };

      if (entry.phase === "locked")
        return lockedActionButton("Merge", entry.reason ?? "", () =>
          retryLockedAction(item),
        );

      // Only checked from idle — once a confirm/merge is already in
      // flight, let it finish and report its own real outcome rather
      // than yanking the button out from under a click that's already
      // landed.
      if (entry.phase === "idle") {
        const proactiveReason = proactiveActionLockReason(item.forge);
        if (proactiveReason)
          return lockedActionButton("Merge", proactiveReason, () =>
            retryLockedAction(item),
          );
      }

      const wrap = el("span", "row-action-group");

      const confirming = entry.phase === "confirming";
      if (confirming || entry.phase === "merging") {
        const confirmButton = buttonEl(
          "row-action confirm",
          confirming ? "Confirm merge?" : "Merging…",
        );
        confirmButton.id = `merge-confirm-${domSafeId(key)}`;
        confirmButton.disabled = !confirming;
        confirmButton.addEventListener("click", () => {
          doMerge(item, confirmButton);
        });
        wrap.appendChild(confirmButton);

        if (confirming) {
          const cancelButton = buttonEl("row-action cancel", "Cancel");
          cancelButton.type = "button";
          cancelButton.addEventListener("click", () => {
            delete mergeState[key];
            prBoard.render();
          });
          wrap.appendChild(cancelButton);
        }
        return wrap;
      }

      const mergeButton = buttonEl("row-action", "Merge");
      mergeButton.type = "button";
      mergeButton.addEventListener("click", () => {
        mergeState[key] = { phase: "confirming" };
        prBoard.render();
        // Moves focus to the confirm button that render() just built —
        // the browser's own scroll-into-view + focus ring is what
        // actually makes this state change noticeable, not just
        // relying on someone watching the exact pixels the button
        // occupies.
        const justConfirmed = document.getElementById(
          `merge-confirm-${domSafeId(key)}`,
        );
        justConfirmed?.focus();
      });
      wrap.appendChild(mergeButton);
      return wrap;
    }

    // ---- pull request update-branch action ----
    // Its own state map, parallel to mergeState — a Forgejo pull request
    // can be mergeable and behind at once, so both actions can
    // legitimately show on the same row at the same time and need
    // independent lock/in-flight state rather than sharing one.
    const updateBranchState: Record<string, ActionState> = {};

    // Mirrors reactiveMergeLockReason's 403/429 handling exactly; 409
    // reads differently here since the forge is reporting the two
    // branches can't be merged cleanly, not that the pull request
    // itself stopped being mergeable.
    function reactiveUpdateBranchLockReason(
      status: number | undefined,
    ): string | null {
      if (status === 403)
        return "Missing permission — check your token in Settings.";
      if (status === 429)
        return "Rate limit exceeded — try again once it resets.";
      if (status === 409)
        return "Can't update cleanly — resolve the conflict on the forge.";
      return null;
    }

    // No confirm step, unlike doMerge — bringing a branch up to date is
    // routine and reversible in a way completing the pull request isn't.
    function doUpdateBranch(item: PullRequestItem, button: HTMLButtonElement) {
      const key = prKey(item);
      updateBranchState[key] = { phase: "updating" };
      button.disabled = true;
      button.textContent = "Updating…";
      showStatus(`Updating the branch for ${item.repo}#${item.number}…`);

      fetch("/api/pull-requests/update-branch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          forge: item.forge,
          fullName: item.repo,
          number: item.number,
        }),
      })
        .then((res) => {
          if (res.status === 401) {
            window.location.href = "/login.html";
            throw new Error("session expired");
          }
          // 202: the forge scheduled the update as a background job
          // rather than finishing it inline (GitHub) — not a failure,
          // same as 204.
          if (res.status === 204 || res.status === 202) return null;
          return res.json().then((body) => {
            const err: Error & { status?: number } = new Error(
              body?.error || `backend answered ${res.status}`,
            );
            err.status = res.status;
            throw err;
          });
        })
        .then(() => {
          // Left in the "updating" phase rather than cleared here — a
          // 202 is GitHub's own background job, not necessarily done by
          // the time this refresh lands, so the button only actually
          // clears once clearResolvedUpdateBranches (called from
          // applySnapshot, which also reports the "Updated" status once
          // it happens) sees a snapshot that no longer reports this PR
          // as behind. Until then it keeps reading "Updating…" instead
          // of flickering back to a plain re-clickable button.
          return fetch("/api/dashboard/refresh", {
            method: "POST",
            headers: { Accept: "application/json" },
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (data) applySnapshot(data);
            });
        })
        .catch((err: Error & { status?: number }) => {
          const lockReason = reactiveUpdateBranchLockReason(err.status);
          updateBranchState[key] = lockReason
            ? { phase: "locked", reason: lockReason }
            : { phase: "idle" };
          if (err.status === 403) forgePermissionDenied[item.forge] = true;
          clearStatus();
          showError(
            `Couldn't update the branch for ${item.repo}#${item.number}: ${err.message}`,
          );
          prBoard.render();
        });
    }

    // Only rendered when the forge reports this pull request as behind
    // its base — independent of mergeStatus, so it can show alongside
    // the merge button rather than instead of it.
    function updateBranchActionCell(item: PullRequestItem): HTMLElement | null {
      if (!item.behind) return null;
      if (isBotManagedPr(item) && !allowBotPrUpdates) return null;

      const key = prKey(item);
      const entry = updateBranchState[key] || { phase: "idle" };

      if (entry.phase === "locked")
        return lockedActionButton("Update branch", entry.reason ?? "", () =>
          retryLockedAction(item),
        );

      if (entry.phase === "idle") {
        const proactiveReason = proactiveActionLockReason(item.forge);
        if (proactiveReason)
          return lockedActionButton("Update branch", proactiveReason, () =>
            retryLockedAction(item),
          );
      }

      const updating = entry.phase === "updating";
      const button = buttonEl(
        "row-action",
        updating ? "Updating…" : "Update branch",
      );
      button.type = "button";
      button.disabled = updating;
      button.addEventListener("click", () => {
        doUpdateBranch(item, button);
      });
      return button;
    }

    // ---- Dependabot rebase/recreate actions ----
    // Keyed by `${prKey}:${action}`, not just prKey — Rebase and
    // Recreate are independent actions on the same PR, each with its
    // own in-flight/locked state, so one locking can't hide the other
    // still being clickable.
    const dependabotActionState: Record<string, ActionState> = {};

    // Mirrors reactiveUpdateBranchLockReason's 403/429 handling; 409
    // reads as Dependabot's own comment command not applying right now
    // rather than a merge conflict.
    function reactiveDependabotActionLockReason(
      status: number | undefined,
    ): string | null {
      if (status === 403)
        return "Missing permission — check your token in Settings.";
      if (status === 429)
        return "Rate limit exceeded — try again once it resets.";
      if (status === 409)
        return "Dependabot can't act on this pull request right now.";
      return null;
    }

    const DEPENDABOT_ACTION_LABELS: Record<string, string> = {
      rebase: "Dependabot: Rebase",
      recreate: "Dependabot: Recreate",
    };
    const DEPENDABOT_ACTION_PROGRESS_LABELS: Record<string, string> = {
      rebase: "Requesting rebase…",
      recreate: "Requesting recreate…",
    };

    // No confirm step — same reasoning as doUpdateBranch: this only
    // asks Dependabot to redo its own routine, reversible work, not a
    // merge.
    function doDependabotAction(
      item: PullRequestItem,
      action: "rebase" | "recreate",
      button: HTMLButtonElement,
    ) {
      const key = `${prKey(item)}:${action}`;
      dependabotActionState[key] = { phase: "requesting" };
      button.disabled = true;
      button.textContent = DEPENDABOT_ACTION_PROGRESS_LABELS[action];
      showStatus(`Asking Dependabot to ${action} ${item.repo}#${item.number}…`);

      fetch("/api/pull-requests/dependabot-action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          forge: item.forge,
          fullName: item.repo,
          number: item.number,
          action,
        }),
      })
        .then((res) => {
          if (res.status === 401) {
            window.location.href = "/login.html";
            throw new Error("session expired");
          }
          if (res.status === 204) return null;
          return res.json().then((body) => {
            const err: Error & { status?: number } = new Error(
              body?.error || `backend answered ${res.status}`,
            );
            err.status = res.status;
            throw err;
          });
        })
        .then(() => {
          delete dependabotActionState[key];
          showStatus(
            `Asked Dependabot to ${action} ${item.repo}#${item.number}.`,
          );
          // No immediate /api/dashboard/refresh, unlike doMerge/
          // doUpdateBranch: posting the comment doesn't change anything
          // about this pull request itself — Dependabot's own rebase/
          // recreate run is what would, on its own schedule.
          prBoard.render();
        })
        .catch((err: Error & { status?: number }) => {
          const lockReason = reactiveDependabotActionLockReason(err.status);
          dependabotActionState[key] = lockReason
            ? { phase: "locked", reason: lockReason }
            : { phase: "idle" };
          if (err.status === 403) forgePermissionDenied[item.forge] = true;
          clearStatus();
          showError(
            `Couldn't ask Dependabot to ${action} ${item.repo}#${item.number}: ${err.message}`,
          );
          prBoard.render();
        });
    }

    function dependabotActionButton(
      item: PullRequestItem,
      action: "rebase" | "recreate",
    ): HTMLElement {
      const key = `${prKey(item)}:${action}`;
      const entry = dependabotActionState[key] || { phase: "idle" };

      if (entry.phase === "locked")
        return lockedActionButton(
          DEPENDABOT_ACTION_LABELS[action],
          entry.reason ?? "",
        );

      if (entry.phase === "idle") {
        const proactiveReason = proactiveActionLockReason(item.forge);
        if (proactiveReason)
          return lockedActionButton(
            DEPENDABOT_ACTION_LABELS[action],
            proactiveReason,
          );
      }

      const requesting = entry.phase === "requesting";
      const button = buttonEl(
        "row-action",
        requesting
          ? DEPENDABOT_ACTION_PROGRESS_LABELS[action]
          : DEPENDABOT_ACTION_LABELS[action],
      );
      button.disabled = requesting;
      button.addEventListener("click", () => {
        doDependabotAction(item, action, button);
      });
      return button;
    }

    // GitHub only — Dependabot doesn't run on Forgejo, so there's no
    // equivalent comment command to send there.
    function dependabotActionCell(item: PullRequestItem): HTMLElement | null {
      if (item.forge !== "github" || !isDependabotPr(item)) return null;

      const wrap = el("span", "row-action-group");
      wrap.appendChild(dependabotActionButton(item, "rebase"));
      wrap.appendChild(dependabotActionButton(item, "recreate"));
      return wrap;
    }

    // ---- Renovate rebase action ----
    // Unlike Dependabot, Renovate runs on both forges and has only the
    // one trigger (no separate "recreate") — the server resolves which
    // label to add from the signed-in user's own saved setting, so the
    // request here carries no action field the way the Dependabot one
    // does.
    const renovateRebaseState: Record<string, ActionState> = {};

    // Same 403/429 handling as reactiveDependabotActionLockReason; 404
    // reads as the configured label not existing on this repo (Forgejo
    // requires the label to already exist) rather than the pull request
    // itself being missing.
    function reactiveRenovateRebaseLockReason(
      status: number | undefined,
    ): string | null {
      if (status === 403)
        return "Missing permission — check your token in Settings.";
      if (status === 429)
        return "Rate limit exceeded — try again once it resets.";
      if (status === 404) return "Rebase label doesn't exist on this repo.";
      return null;
    }

    function doRenovateRebase(
      item: PullRequestItem,
      button: HTMLButtonElement,
    ) {
      const key = prKey(item);
      renovateRebaseState[key] = { phase: "requesting" };
      button.disabled = true;
      button.textContent = "Requesting rebase…";
      showStatus(`Asking Renovate to rebase ${item.repo}#${item.number}…`);

      fetch("/api/pull-requests/renovate-rebase", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          forge: item.forge,
          fullName: item.repo,
          number: item.number,
        }),
      })
        .then((res) => {
          if (res.status === 401) {
            window.location.href = "/login.html";
            throw new Error("session expired");
          }
          if (res.status === 204) return null;
          return res.json().then((body) => {
            const err: Error & { status?: number } = new Error(
              body?.error || `backend answered ${res.status}`,
            );
            err.status = res.status;
            throw err;
          });
        })
        .then(() => {
          delete renovateRebaseState[key];
          showStatus(`Asked Renovate to rebase ${item.repo}#${item.number}.`);
          prBoard.render();
        })
        .catch((err: Error & { status?: number }) => {
          const lockReason = reactiveRenovateRebaseLockReason(err.status);
          renovateRebaseState[key] = lockReason
            ? { phase: "locked", reason: lockReason }
            : { phase: "idle" };
          if (err.status === 403) forgePermissionDenied[item.forge] = true;
          clearStatus();
          showError(
            `Couldn't ask Renovate to rebase ${item.repo}#${item.number}: ${err.message}`,
          );
          prBoard.render();
        });
    }

    function renovateRebaseActionCell(
      item: PullRequestItem,
    ): HTMLElement | null {
      if (!isRenovatePr(item)) return null;

      const key = prKey(item);
      const entry = renovateRebaseState[key] || { phase: "idle" };

      if (entry.phase === "locked")
        return lockedActionButton("Renovate: Rebase", entry.reason ?? "");

      if (entry.phase === "idle") {
        const proactiveReason = proactiveActionLockReason(item.forge);
        if (proactiveReason)
          return lockedActionButton("Renovate: Rebase", proactiveReason);
      }

      const requesting = entry.phase === "requesting";
      const button = buttonEl(
        "row-action",
        requesting ? "Requesting rebase…" : "Renovate: Rebase",
      );
      button.disabled = requesting;
      button.addEventListener("click", () => {
        doRenovateRebase(item, button);
      });
      return button;
    }

    // ---- pipeline checks panel ----
    // Per-check status vocabulary for GET /api/pull-requests/checks's own
    // CheckState enum — distinct from CI_LABELS above, which only ever
    // describes the combined, row-level CIStatus, never one individual
    // job.
    const CHECK_STATE_LABELS: Record<string, string> = {
      queued: "Queued",
      running: "Running",
      success: "Passed",
      failure: "Failed",
      cancelled: "Cancelled",
      skipped: "Skipped",
      timed_out: "Timed out",
    };

    const pipelineDialog = document.getElementById(
      "pipeline-dialog",
    ) as HTMLDialogElement | null;
    const pipelineDialogSubtitle = document.getElementById(
      "pipeline-dialog-subtitle",
    );
    const pipelineDialogBody = document.getElementById("pipeline-dialog-body");
    const pipelineDialogCloseButton = document.getElementById(
      "pipeline-dialog-close",
    ) as HTMLButtonElement | null;

    // The button that opened the dialog most recently — closing it (via
    // Escape, a backdrop click, or the close button itself) moves focus
    // back here, the same "return focus to what opened it" contract every
    // other transient UI in this file already honors (see
    // retryLockedAction moving focus back to a just-re-rendered locked
    // button).
    let pipelineDialogTrigger: HTMLButtonElement | null = null;

    // Bumped on every open — a slow fetch from an already-closed (or
    // reopened against a different pull request) dialog is never allowed
    // to land and overwrite whatever the dialog is showing now.
    let pipelineRequestToken = 0;

    function renderPipelineLoading() {
      if (!pipelineDialogBody) return;
      pipelineDialogBody.innerHTML = "";
      pipelineDialogBody.appendChild(
        el("p", "pipeline-status", "Loading checks…"),
      );
    }

    function renderPipelineChecks(checks: Check[]) {
      if (!pipelineDialogBody) return;
      pipelineDialogBody.innerHTML = "";
      if (checks.length === 0) {
        pipelineDialogBody.appendChild(
          el("p", "pipeline-status", "No CI configured for this pull request."),
        );
        return;
      }
      const list = el("ul", "pipeline-check-list");
      checks.forEach((check) => {
        const row = el("li", "pipeline-check");
        const status = el("span", `pipeline-check-status ${check.state}`);
        status.appendChild(el("span", "dot"));
        status.appendChild(
          document.createTextNode(
            CHECK_STATE_LABELS[check.state] || check.state,
          ),
        );
        row.appendChild(status);
        row.appendChild(el("span", "pipeline-check-name", check.name));
        const link = document.createElement("a");
        link.className = "pipeline-check-link";
        link.href = check.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "View run";
        link.setAttribute("aria-label", `View run: ${check.name}`);
        row.appendChild(link);
        list.appendChild(row);
      });
      pipelineDialogBody.appendChild(list);
    }

    function renderPipelineError(message: string, onRetry: () => void) {
      if (!pipelineDialogBody) return;
      pipelineDialogBody.innerHTML = "";
      const wrap = el("div", "pipeline-error");
      wrap.setAttribute("role", "alert");
      wrap.appendChild(el("p", "", message));
      const retryButton = buttonEl("row-action", "Retry");
      retryButton.addEventListener("click", onRetry);
      wrap.appendChild(retryButton);
      pipelineDialogBody.appendChild(wrap);
    }

    // Always fetched fresh — never cached, never part of applySnapshot's
    // own eager pull, per the checks endpoint's own doc comment: this is
    // detail a row doesn't show until the panel is actually opened for
    // it.
    function loadPipelineChecks(item: PullRequestItem) {
      const token = ++pipelineRequestToken;
      renderPipelineLoading();
      showStatus(`Loading pipeline checks for ${item.repo}#${item.number}…`);

      fetch(
        `/api/pull-requests/checks?forge=${encodeURIComponent(item.forge)}&fullName=${encodeURIComponent(item.repo)}&number=${item.number}`,
        { headers: { Accept: "application/json" } },
      )
        .then((res) => {
          if (res.status === 401) {
            window.location.href = "/login.html";
            throw new Error("session expired");
          }
          return res.json().then((body) => {
            if (!res.ok) {
              const err: Error & { status?: number } = new Error(
                body?.error || `backend answered ${res.status}`,
              );
              err.status = res.status;
              throw err;
            }
            return body as { checks: Check[] };
          });
        })
        .then((data) => {
          if (token !== pipelineRequestToken) return;
          clearStatus();
          renderPipelineChecks(data.checks || []);
        })
        .catch((err: Error & { status?: number }) => {
          if (token !== pipelineRequestToken) return;
          clearStatus();
          const message = `Couldn't load pipeline checks for ${item.repo}#${item.number}: ${err.message}`;
          showError(message);
          renderPipelineError(message, () => loadPipelineChecks(item));
        });
    }

    function openPipelineDialog(
      item: PullRequestItem,
      trigger: HTMLButtonElement,
    ) {
      if (!pipelineDialog) return;
      pipelineDialogTrigger = trigger;
      if (pipelineDialogSubtitle) {
        pipelineDialogSubtitle.textContent = `${item.repo}#${item.number}`;
      }
      loadPipelineChecks(item);
      pipelineDialog.showModal();
    }

    pipelineDialogCloseButton?.addEventListener("click", () => {
      pipelineDialog?.close();
    });

    // Fires for every close path — Escape, the close button, and the
    // backdrop-click handler just below — so focus returns to the row's
    // own button no matter which one the pull request's own row-action
    // group used to get here.
    pipelineDialog?.addEventListener("close", () => {
      pipelineDialogTrigger?.focus();
      pipelineDialogTrigger = null;
    });

    // <dialog>'s own ::backdrop is a separate, non-clickable pseudo-
    // element that never receives this event — a click landing on the
    // <dialog> element itself (rather than something inside it) is what
    // "clicked outside the panel" actually looks like from here.
    pipelineDialog?.addEventListener("click", (event) => {
      if (event.target === pipelineDialog) {
        pipelineDialog.close();
      }
    });

    // Visible whenever the row has any CI at all — "none" already has
    // nothing to show a panel about, the same signal ciPill's own
    // CI_LABELS.none already reads.
    function pipelineActionCell(item: PullRequestItem): HTMLElement | null {
      if (item.ci === "none") return null;
      const button = buttonEl("row-action", "View pipeline");
      button.addEventListener("click", () => {
        openPipelineDialog(item, button);
      });
      return button;
    }

    // ---- shared filter state ----
    // One object for forge/repo/label/author/title/created/updated/
    // groupBy, applied to both boards at once, plus the two fields with
    // no equivalent on the other entity type (status,
    // hideDependencyDashboard). allPRs/allIssues is the pool the shared
    // bar's dynamic controls (repo/author/label/title) are populated
    // from — both entity types combined, forge-scoped, not just one
    // board's own items, since picking "author: alice" should narrow
    // both boards.
    const sharedState = window.Filters.loadState();
    let allPRs: PullRequestItem[] = [];
    let allIssues: IssueItem[] = [];
    // The latest snapshot's own forges array — mergeActionCell/
    // updateBranchActionCell read this to pre-emptively lock a row's
    // action button when its forge is unreachable or its rate-limit
    // budget is already exhausted.
    let lastForges: Forge[] = [];
    let sharedControlsRestored = false;
    // Fetched once at startup below — updateBranchActionCell reads this
    // to decide whether a bot-managed PR's row gets the button at all.
    let allowBotPrUpdates = false;

    // #353: the cookie above is a fast local cache for this page's very
    // first paint, not the source of truth across devices — this fetch
    // is what makes a second browser see filters set on the first one.
    // Runs in parallel with everything else below, and reconciles into
    // sharedState whichever of "the first dashboard snapshot" or "this
    // resolving" happens second, via sharedControlsRestored below — a
    // real server value always wins, but this page never sits idle
    // waiting for it first.
    window.Filters.loadStateFromServer().then((got) => {
      if (got) window.Filters.applyServerState(sharedState, got);
      if (sharedControlsRestored) {
        updateSharedFilterOptions();
        syncSharedControlsToState();
        renderBoth();
      }
    });

    function forgeScopedItems(): FilterableItem[] {
      const items: FilterableItem[] = [...allPRs, ...allIssues];
      if (!sharedState.shared.forge) return items;
      return items.filter((item) => item.forge === sharedState.shared.forge);
    }

    // "Group by forge" is a no-op once the Forge filter already narrows
    // every visible row to one forge — grouping by it would produce
    // exactly one cluster, telling the user nothing a flat list didn't
    // already. Hidden in that case; resets to no grouping if it was the
    // active mode when a forge got picked (#112).
    function updateGroupByOptions() {
      const groupSelect = document.getElementById(
        "shared-group-select",
      ) as HTMLSelectElement | null;
      const forgeOption = groupSelect?.querySelector<HTMLOptionElement>(
        'option[value="forge"]',
      );
      if (!forgeOption) return;
      const forgeFilterActive = Boolean(sharedState.shared.forge);
      forgeOption.hidden = forgeFilterActive;
      if (forgeFilterActive && sharedState.shared.groupBy === "forge") {
        sharedState.shared.groupBy = "";
        if (groupSelect) groupSelect.value = "";
      }
    }

    // Repopulates the shared bar's dynamic controls (repo/author/label/
    // title suggestions) from the combined, forge-scoped item pool. A
    // filter left pointing at a value that no longer exists gets
    // cleared here too — otherwise it keeps silently filtering out
    // everything on a value nothing can match, with no visible cause
    // (#112).
    function updateSharedFilterOptions() {
      const scoped = forgeScopedItems();
      const staleRepo = window.Filters.populateRepoSelect(
        document.getElementById(
          "shared-repo-select",
        ) as HTMLSelectElement | null,
        scoped,
      );
      const staleAuthor = window.Filters.populateSelect(
        document.getElementById(
          "shared-author-select",
        ) as HTMLSelectElement | null,
        window.Filters.distinctValues((item) => item.author, scoped),
        sharedState.shared.author,
      );
      window.Filters.populateDatalist(
        document.getElementById(
          "shared-title-options",
        ) as HTMLDataListElement | null,
        window.Filters.distinctValues((item) => item.title, scoped),
      );
      const staleLabel = window.Filters.populateSelect(
        document.getElementById(
          "shared-label-select",
        ) as HTMLSelectElement | null,
        window.Filters.distinctValues(
          (item) => (item.labels || []).map((l) => l.name),
          scoped,
        ),
        sharedState.shared.label,
      );
      updateGroupByOptions();
      if (staleRepo) sharedState.shared.repo = "";
      if (staleAuthor) sharedState.shared.author = "";
      if (staleLabel) sharedState.shared.label = "";
      if (staleRepo || staleAuthor || staleLabel)
        window.Filters.saveState(sharedState);
    }

    // Restores the shared bar's controls to match the filters just
    // loaded from the cookie. Only meaningful once real items exist:
    // repo/author/label are dynamic <select>s populated from what's on
    // screen. Runs once, right after the first combined item set — a
    // later refresh must never repeat it, or it would stomp the title
    // filter back to its lowercase canonical form over whatever case
    // the user is mid-typing.
    function syncSharedControlsToState() {
      const bar = document.querySelector(".filter-bar");
      if (!bar) return;
      bar
        .querySelectorAll<HTMLInputElement | HTMLSelectElement>(".col-filter")
        .forEach((c) => {
          const value =
            sharedState.shared[(c as HTMLElement).dataset.col ?? ""];
          if (c instanceof HTMLInputElement && c.type === "radio") {
            c.checked = c.value === (value || "");
            return;
          }
          if (!value) return;
          if (c instanceof HTMLSelectElement) {
            const option = Array.from(c.options).find(
              (o) => o.value.toLowerCase() === value,
            );
            if (option) c.value = option.value;
          } else {
            c.value = value;
          }
        });
      const groupSelect = document.getElementById(
        "shared-group-select",
      ) as HTMLSelectElement | null;
      if (groupSelect) groupSelect.value = sharedState.shared.groupBy || "";
    }

    function renderBoth() {
      prBoard.render();
      issueBoard.render();
    }

    // Toggles the one shared label filter and re-renders both boards —
    // a chip click on either board's rows affects the other board too,
    // the same as the Label <select> in the shared bar does.
    function handleLabelClick(label: string) {
      // The shared label filter is always lowercase — but a real
      // <option>'s value keeps its real case, so select.value can't
      // just be assigned next directly; the browser only accepts an
      // exact (case-sensitive) option value, silently clearing the
      // selection on any case mismatch otherwise.
      const lower = label.toLowerCase();
      const next = sharedState.shared.label === lower ? "" : lower;
      sharedState.shared.label = next;
      prBoard.resetPage();
      issueBoard.resetPage();
      window.Filters.saveState(sharedState);
      const select = document.getElementById(
        "shared-label-select",
      ) as HTMLSelectElement | null;
      if (select) {
        const option = Array.from(select.options).find(
          (o) => o.value.toLowerCase() === next,
        );
        select.value = option ? option.value : "";
      }
      renderBoth();
    }

    // Clicking a CI pill or the "CI failing" stat tile jumps to the
    // pull requests board filtered to that status. Status has no
    // equivalent on the issues board, so this only ever re-renders the
    // Pull Requests board.
    function handleStatusClick(status: string) {
      const next = prBoard.toggleStatus?.(status);
      const select = document.querySelector<HTMLSelectElement>(
        'section[aria-label="Open pull requests"] .col-filter[data-col="status"]',
      );
      if (select && next !== undefined) select.value = next;
      const section = document.querySelector(
        'section[aria-label="Open pull requests"]',
      );
      section?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // ---- board state + render ----
    // Each board (pull requests, issues) owns its own items, pagination,
    // and — for the one field with no equivalent on the other entity
    // type — its own extraState (status for pull requests,
    // hideDependencyDashboard for issues). Everything else it filters
    // and groups by comes from the shared state above.
    type Board = {
      setItems: (items: (PullRequestItem | IssueItem)[]) => void;
      render: () => void;
      resetPage: () => void;
      toggleStatus?: (value: string) => string;
    };

    function createBoard(
      containerId: string,
      emptyId: string,
      noResultsId: string,
      isPR: boolean,
      onStatusClick: ((status: string) => void) | undefined,
      idPrefix: string,
      extraState: Record<string, string>,
    ): Board {
      const section = document
        .getElementById(containerId)
        ?.closest("section.board");
      const state: {
        items: (PullRequestItem | IssueItem)[];
        page: number;
        pageSize: number;
      } = { items: [], page: 1, pageSize: 25 };

      // Grouped by repo or by forge, alphabetically (forge by its
      // display label, not the raw "github"/"forgejo" value, since
      // that's what a screen reader announces), under a real heading
      // (not a styled div) so it's announced as structure, not
      // decoration. Off by default — this is a chosen mode, not a
      // permanent change to how the flat list already reads.
      function renderGrouped(
        container: HTMLElement,
        items: (PullRequestItem | IssueItem)[],
        groupBy: string,
      ) {
        const keyOf =
          groupBy === "forge"
            ? (item: FilterableItem) => FORGE_LABELS[item.forge] || item.forge
            : (item: FilterableItem) => item.repo;

        const groups: Record<string, (PullRequestItem | IssueItem)[]> = {};
        const order: string[] = [];
        for (const item of items) {
          const key = keyOf(item);
          if (!groups[key]) {
            groups[key] = [];
            order.push(key);
          }
          groups[key].push(item);
        }
        order.sort();

        for (const key of order) {
          const heading = document.createElement("h3");
          heading.className = "group-heading";
          heading.appendChild(document.createTextNode(key));
          heading.appendChild(
            el("span", "group-count", String(groups[key].length)),
          );
          container.appendChild(heading);
          for (const item of groups[key]) {
            container.appendChild(
              buildRow(
                item,
                isPR,
                onStatusClick,
                handleLabelClick,
                sharedState.shared.label,
              ),
            );
          }
        }
      }

      function setPage(page: number) {
        state.page = page;
        render();
      }

      function renderPagination(totalPages: number) {
        const wrap = document.getElementById(`${idPrefix}-pagination`);
        if (!wrap) return;

        const needed = totalPages > 1;
        wrap.hidden = !needed;
        if (!needed) return;

        const pages = document.getElementById(`${idPrefix}-pagination-pages`);
        if (!pages) return;
        pages.innerHTML = "";

        const prev = buttonEl("pagination-nav", "Previous");
        prev.type = "button";
        prev.disabled = state.page <= 1;
        prev.addEventListener("click", () => {
          setPage(state.page - 1);
        });
        pages.appendChild(prev);

        for (let p = 1; p <= totalPages; p++) {
          const button = buttonEl("pagination-page", String(p));
          button.type = "button";
          if (p === state.page) {
            button.classList.add("active");
            button.setAttribute("aria-current", "page");
          }
          button.addEventListener("click", () => {
            setPage(p);
          });
          pages.appendChild(button);
        }

        const next = buttonEl("pagination-nav", "Next");
        next.type = "button";
        next.disabled = state.page >= totalPages;
        next.addEventListener("click", () => {
          setPage(state.page + 1);
        });
        pages.appendChild(next);
      }

      function render() {
        const container = document.getElementById(containerId);
        if (!container) return;
        const visible = state.items.filter((item) =>
          window.Filters.matchesFilters(
            item,
            isPR,
            sharedState.shared,
            extraState,
          ),
        );

        container.innerHTML = "";

        const groupBy = sharedState.shared.groupBy;
        if (groupBy) {
          // Grouping and pagination stay mutually exclusive —
          // paginating grouped clusters coherently is a bigger problem
          // than either feature's own acceptance criteria asked for, so
          // grouped mode just renders the whole filtered set and the
          // pager hides.
          renderGrouped(container, visible, groupBy);
          const groupedPagination = document.getElementById(
            `${idPrefix}-pagination`,
          );
          if (groupedPagination) groupedPagination.hidden = true;
        } else {
          const totalPages = Math.max(
            1,
            Math.ceil(visible.length / state.pageSize),
          );
          if (state.page > totalPages) state.page = totalPages;
          const start = (state.page - 1) * state.pageSize;
          const pageItems = visible.slice(start, start + state.pageSize);
          for (const item of pageItems) {
            container.appendChild(
              buildRow(
                item,
                isPR,
                onStatusClick,
                handleLabelClick,
                sharedState.shared.label,
              ),
            );
          }
          renderPagination(totalPages);
        }

        const emptyEl = document.getElementById(emptyId);
        if (emptyEl) emptyEl.hidden = state.items.length !== 0;
        const noResults = document.getElementById(noResultsId);
        if (noResults)
          noResults.hidden = visible.length !== 0 || state.items.length === 0;

        const count = document.getElementById(`${idPrefix}-count`);
        if (count)
          count.textContent = shownCountText(
            visible.length,
            state.items.length,
          );
        renderStatTile(
          STAT_TILE_IDS[idPrefix],
          visible.length,
          state.items.length,
        );
        // Every state change this app makes ends in a render() on one
        // or both boards (directly, or via renderBoth()) —
        // updateClearFiltersButton is declared later in this same
        // closure but hoists, so this stays the one place the button's
        // disabled state can go stale.
        updateClearFiltersButton();
      }

      const pageSizeSelect = document.getElementById(
        `${idPrefix}-page-size`,
      ) as HTMLSelectElement | null;
      pageSizeSelect?.addEventListener("change", () => {
        state.pageSize = Number(pageSizeSelect.value) || 25;
        state.page = 1;
        render();
      });

      // CI status has no equivalent on the issues board, so it's wired
      // locally here rather than through the shared bar — a change only
      // ever re-renders this one board.
      if (isPR) {
        const statusSelect = section?.querySelector<HTMLSelectElement>(
          '.col-filter[data-col="status"]',
        );
        if (statusSelect) {
          statusSelect.value = extraState.status || "";
          statusSelect.addEventListener("change", () => {
            extraState.status = statusSelect.value.trim().toLowerCase();
            state.page = 1;
            window.Filters.saveState(sharedState);
            render();
          });
        }
      }

      // Not a generic .col-filter: it's a checkbox (driven by .checked,
      // not .value) and its default is "on" rather than "no filter
      // applied" — both break the generic wiring the shared bar's own
      // controls share. Only the issues board's markup has this element
      // at all.
      const hideDependencyDashboardCheckbox = document.getElementById(
        `${idPrefix}-hide-dependency-dashboard`,
      ) as HTMLInputElement | null;
      if (hideDependencyDashboardCheckbox) {
        hideDependencyDashboardCheckbox.checked =
          extraState.hideDependencyDashboard === "1";
        hideDependencyDashboardCheckbox.addEventListener("change", () => {
          extraState.hideDependencyDashboard =
            hideDependencyDashboardCheckbox.checked ? "1" : "";
          state.page = 1;
          window.Filters.saveState(sharedState);
          render();
        });
      }

      return {
        setItems: (items) => {
          state.items = items;
          state.page = 1;
          render();
        },
        render,
        resetPage: () => {
          state.page = 1;
        },
        toggleStatus: isPR
          ? (value: string) => {
              const next = extraState.status === value ? "" : value;
              extraState.status = next;
              state.page = 1;
              window.Filters.saveState(sharedState);
              render();
              return next;
            }
          : undefined,
      };
    }

    const prBoard = createBoard(
      "pr-rows",
      "pr-empty",
      "pr-no-results",
      true,
      handleStatusClick,
      "pr",
      sharedState.pr,
    );
    const issueBoard = createBoard(
      "issue-rows",
      "issue-empty",
      "issue-no-results",
      false,
      undefined,
      "issue",
      sharedState.issue,
    );

    const statFailingTile = document.getElementById("stat-failing-tile");
    statFailingTile?.addEventListener("click", () => {
      handleStatusClick("failure");
    });

    // The shared bar's own controls (forge, group-by, repo, title,
    // author, label, created, updated) apply to both boards at once — a
    // single wiring loop, not one per board.
    document
      .querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        ".filter-bar .col-filter",
      )
      .forEach((c) => {
        const apply = () => {
          const col = (c as HTMLElement).dataset.col ?? "";
          const value =
            c instanceof HTMLInputElement && c.type === "radio"
              ? c.value
              : c.value.trim().toLowerCase();
          sharedState.shared[col] = value;
          prBoard.resetPage();
          issueBoard.resetPage();
          // Repo/Author/Label options (and "Group by forge") are scoped
          // to the active forge, so a forge change has to re-narrow
          // them right away rather than waiting for the next poll's
          // setItems (#112).
          if (col === "forge") updateSharedFilterOptions();
          // debouncedCol: only Title fires on 'input' per keystroke;
          // every other control here only ever fires on 'change' (a
          // discrete, already-complete pick), so passing col
          // unconditionally is safe — saveState itself only debounces
          // when it's 'title'.
          window.Filters.saveState(sharedState, col);
          renderBoth();
        };
        c.addEventListener("input", apply);
        c.addEventListener("change", apply);
      });

    const sharedGroupSelect = document.getElementById(
      "shared-group-select",
    ) as HTMLSelectElement | null;
    sharedGroupSelect?.addEventListener("change", () => {
      sharedState.shared.groupBy = sharedGroupSelect.value || "";
      prBoard.resetPage();
      issueBoard.resetPage();
      window.Filters.saveState(sharedState);
      renderBoth();
    });

    // #354: true once nothing in sharedState differs from Filters' own
    // defaultState() — shared is empty, no CI status, and
    // hideDependencyDashboard is back at its default-checked '1'.
    function filtersAreDefault(): boolean {
      return (
        Object.keys(sharedState.shared).every((k) => !sharedState.shared[k]) &&
        !sharedState.pr.status &&
        sharedState.issue.hideDependencyDashboard === "1"
      );
    }

    // Called from each board's own render() (itself called on every
    // state change, shared or board-local) rather than threaded through
    // every individual change handler separately — one place this can
    // go stale.
    function updateClearFiltersButton() {
      const button = document.getElementById(
        "clear-filters-button",
      ) as HTMLButtonElement | null;
      if (button) button.disabled = filtersAreDefault();
    }

    const clearFiltersButton = document.getElementById("clear-filters-button");
    clearFiltersButton?.addEventListener("click", () => {
      // Mutated in place, not reassigned: createBoard's own extraState
      // closures (sharedState.pr, sharedState.issue) captured these
      // exact objects at setup time, and a reassignment here would
      // leave them pointing at the old, still-filtered one.
      for (const k of Object.keys(sharedState.shared))
        delete sharedState.shared[k];
      for (const k of Object.keys(sharedState.pr)) delete sharedState.pr[k];
      for (const k of Object.keys(sharedState.issue))
        delete sharedState.issue[k];
      sharedState.issue.hideDependencyDashboard = "1";

      document
        .querySelectorAll<HTMLInputElement | HTMLSelectElement>(
          ".filter-bar .col-filter",
        )
        .forEach((c) => {
          if (c instanceof HTMLInputElement && c.type === "radio") {
            c.checked = c.value === "";
          } else {
            c.value = "";
          }
        });
      if (sharedGroupSelect) sharedGroupSelect.value = "";
      const statusSelect = document.querySelector<HTMLSelectElement>(
        '.col-filter[data-col="status"]',
      );
      if (statusSelect) statusSelect.value = "";
      const hideDependencyDashboardCheckbox = document.getElementById(
        "issue-hide-dependency-dashboard",
      ) as HTMLInputElement | null;
      if (hideDependencyDashboardCheckbox)
        hideDependencyDashboardCheckbox.checked = true;

      updateSharedFilterOptions();
      prBoard.resetPage();
      issueBoard.resetPage();
      window.Filters.saveState(sharedState);
      renderBoth();
    });

    // ---- forge health ----
    // One friendly, actionable line per ForgeErrorKind, taking
    // precedence over the raw error string as the primary visible text.
    // "unreachable" names the refresh button as the way to retry now,
    // not just "wait."
    const ERROR_HEADLINES: Record<string, string> = {
      unreachable:
        "Temporarily unreachable — try the refresh button above, or it’ll retry automatically.",
      unauthorized: "Check the token in Settings.",
      not_found: "Check the instance URL in Settings.",
      rate_limited: "Rate limit exceeded.",
    };

    function forgeErrorHeadline(f: Forge): string {
      return (
        (f.errorKind && ERROR_HEADLINES[f.errorKind]) ||
        `Something went wrong talking to ${FORGE_LABELS[f.forge] || f.forge}.`
      );
    }

    function renderForgeHealth(forges: Forge[]) {
      const container = document.getElementById("forge-health");
      if (!container) return;
      container.innerHTML = "";
      for (const f of forges) {
        const item = el("div", "forge-health-item");
        const chip = el(
          "span",
          `forge-health${f.reachable ? "" : " unreachable"}`,
        );
        chip.appendChild(el("span", "pulse-dot"));
        const label =
          (FORGE_LABELS[f.forge] || f.forge) +
          (f.reachable ? " reachable" : " unreachable");
        chip.appendChild(document.createTextNode(label));
        item.appendChild(chip);
        // The reason has to be real text, not just chip.title — a hover
        // tooltip never reaches a touch device and isn't reliably
        // announced by a screen reader either. The raw technical string
        // stays available in a native, keyboard-accessible <details>
        // disclosure instead.
        //
        // Except rate_limited: the rate-limit banner (#361) already
        // covers that case at the top of the page, per-budget and with a
        // countdown — repeating "Rate limit exceeded." and a raw-error
        // disclosure here is noise, not a second source of detail.
        if (!f.reachable && f.error && f.errorKind !== "rate_limited") {
          item.appendChild(
            el("span", "forge-health-error", forgeErrorHeadline(f)),
          );
          const details = document.createElement("details");
          details.className = "forge-health-detail";
          const summary = document.createElement("summary");
          summary.textContent = "Show details";
          details.appendChild(summary);
          details.appendChild(document.createTextNode(f.error));
          item.appendChild(details);
        }
        container.appendChild(item);
      }
      const forgeNames = document.getElementById("forge-names");
      if (forgeNames) {
        forgeNames.innerHTML = forges
          .map(
            (f) =>
              `<span class="mono">${FORGE_LABELS[f.forge] || f.forge}</span>`,
          )
          .join(" + ");
      }
    }

    // ---- ticking "refreshed Xs ago" clock, independent of the poll interval ----
    function tickRefreshedAt() {
      const target = document.getElementById("refreshed-at");
      if (!lastGeneratedAt || !target) return;
      target.textContent = relativeTime(lastGeneratedAt);
    }

    // ---- rate-limit-exceeded banner (#361) ----
    // An exhausted REST or GraphQL budget silently locks every proactive
    // action it drives (merge, update branch, Dependabot/Renovate
    // triggers) until the forge's own reset window passes — that's
    // already surfaced per-row via proactiveActionLockReason, but easy to
    // miss buried in a board below the fold. This mirrors it at the top
    // of the page, with the same critical prominence as the "CI failing"
    // stat tile, so it's visible at a glance.
    // Same 5% "critical" cutoff Insights' own rate-limit gauge already
    // uses for its color tier (rateLimitStatusClass) — kept as a literal
    // copy rather than a shared import, same reasoning as
    // countdownLabel's own comment below.
    const LOW_BUDGET_THRESHOLD = 0.05;

    type RateLimitAlert = {
      label: string;
      severity: "exceeded" | "low";
      resetsAt: string;
      remaining: number;
      limit: number;
    };
    let rateLimitAlerts: RateLimitAlert[] = [];

    function computeRateLimitAlerts(forges: Forge[]): RateLimitAlert[] {
      const out: RateLimitAlert[] = [];
      for (const f of forges) {
        const name = FORGE_LABELS[f.forge] || f.forge;
        for (const [kind, rl] of [
          ["GraphQL", f.rateLimitGraphQL],
          ["REST", f.rateLimitREST],
        ] as const) {
          if (!rl) continue;
          if (rl.remaining === 0) {
            out.push({
              label: `${name} ${kind}`,
              severity: "exceeded",
              resetsAt: rl.resetsAt,
              remaining: rl.remaining,
              limit: rl.limit,
            });
          } else if (
            rl.limit > 0 &&
            rl.remaining / rl.limit < LOW_BUDGET_THRESHOLD
          ) {
            out.push({
              label: `${name} ${kind}`,
              severity: "low",
              resetsAt: rl.resetsAt,
              remaining: rl.remaining,
              limit: rl.limit,
            });
          }
        }
      }
      return out;
    }

    // Same rounding/format as Insights' own countdown (#361) — kept as a
    // separate copy rather than a shared import, since this page's own
    // architecture is a near-literal imperative-TS translation of the
    // pre-migration dashboard, not reactive Svelte state like Insights.
    function countdownLabel(resetsAt: string): string {
      const msLeft = new Date(resetsAt).getTime() - Date.now();
      if (msLeft <= 0) return "resets any moment";
      const totalSeconds = Math.floor(msLeft / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return minutes > 0
        ? `resets in ${minutes}m ${seconds}s`
        : `resets in ${seconds}s`;
    }

    function renderRateLimitBanner() {
      document.getElementById("rate-limit-banner")?.remove();
      if (rateLimitAlerts.length === 0) return;
      const banner = el("div", "rate-limit-banner");
      banner.id = "rate-limit-banner";
      banner.setAttribute("role", "alert");
      for (const alert of rateLimitAlerts) {
        const exceeded = alert.severity === "exceeded";
        const row = el("div", `rate-limit-banner-row${exceeded ? "" : " low"}`);
        row.appendChild(
          el(
            "span",
            "rate-limit-banner-label",
            exceeded
              ? `Rate limit exceeded — ${alert.label}`
              : `Rate limit running low — ${alert.label}`,
          ),
        );
        row.appendChild(
          el(
            "span",
            "rate-limit-banner-timer",
            exceeded
              ? countdownLabel(alert.resetsAt)
              : `${alert.remaining.toLocaleString()} of ${alert.limit.toLocaleString()} requests left`,
          ),
        );
        banner.appendChild(row);
      }
      document
        .querySelector(".wrap")
        ?.insertBefore(banner, document.querySelector(".stats"));
    }

    setInterval(() => {
      tickRefreshedAt();
      // Cheap to call unconditionally — it removes and, only if there's
      // still something exhausted, redraws a handful of rows.
      renderRateLimitBanner();
    }, 1000);

    function showError(message: string) {
      document.getElementById("error-banner")?.remove();
      const banner = el("div", "error-banner", message);
      banner.id = "error-banner";
      // role="alert" carries an implicit aria-live="assertive" — this
      // was never actually wired up to announce to a screen reader
      // before, despite being the one place a failed write to a forge
      // surfaces.
      banner.setAttribute("role", "alert");
      document
        .querySelector(".wrap")
        ?.insertBefore(banner, document.querySelector(".stats"));
    }

    function clearError() {
      document.getElementById("error-banner")?.remove();
    }

    // showStatus/clearStatus: the same shape as showError/clearError,
    // for a row action's own in-progress/success text rather than a
    // failure — a real click otherwise had nothing to show for it
    // beyond the row silently vanishing on the next refresh.
    // aria-live="polite" rather than showError's role="alert": routine
    // progress/success isn't urgent enough to interrupt a screen reader
    // the way a failure is.
    function showStatus(message: string) {
      document.getElementById("status-banner")?.remove();
      const banner = el("div", "status-banner", message);
      banner.id = "status-banner";
      banner.setAttribute("aria-live", "polite");
      document
        .querySelector(".wrap")
        ?.insertBefore(banner, document.querySelector(".stats"));
      // Auto-dismisses — unlike the error banner, which stays until the
      // next successful action clears it, a routine "Merged x#42." isn't
      // meant to linger.
      setTimeout(() => {
        if (banner.parentNode) banner.remove();
      }, 4000);
    }

    function clearStatus() {
      document.getElementById("status-banner")?.remove();
    }

    // Session/admin-link/logout are nav.js's job now — shared by every
    // page's header, not just the dashboard's own.

    // ---- force-refresh: retry right now instead of waiting out the
    // rest of the background poll's own interval ----
    const FORCE_REFRESH_COOLDOWN_MS = 5000;
    const forceRefreshButton = document.getElementById(
      "force-refresh-button",
    ) as HTMLButtonElement | null;

    // Shared by this button and every locked merge/update-branch row's
    // own "Retry" — a locked reason can only be known to have cleared by
    // asking the forge again right now, not by staring at data already
    // on screen. POSTs, not the plain GET refresh() polls with — this
    // forces a real re-fetch from the forge instead of possibly
    // answering from a cache.
    function refreshDashboardNow(): Promise<void> {
      return fetch("/api/dashboard/refresh", {
        method: "POST",
        headers: { Accept: "application/json" },
      })
        .then((res) => {
          if (res.status === 401) {
            window.location.href = "/login.html";
            throw new Error("session expired");
          }
          if (!res.ok) throw new Error(`backend answered ${res.status}`);
          return res.json();
        })
        .then(applySnapshot);
    }

    forceRefreshButton?.addEventListener("click", () => {
      forceRefreshButton.disabled = true;
      forceRefreshButton.classList.add("is-refreshing");
      refreshDashboardNow()
        .catch((err: Error) => {
          showError(`Could not refresh: ${err.message}`);
        })
        .finally(() => {
          forceRefreshButton.classList.remove("is-refreshing");
          // Cooldown starts once the response is already in hand, not
          // from the click — a user mashing the button gets one real
          // refresh and a short pause, not a queue of them landing back
          // to back.
          setTimeout(() => {
            forceRefreshButton.disabled = false;
          }, FORCE_REFRESH_COOLDOWN_MS);
        });
    });

    // ---- bot-managed PR update setting, fetched once at startup ----
    // /api/settings/bot-pr-updates, not /api/settings itself — that GET
    // also provisions webhook credentials on first call, which the
    // dashboard silently triggering on behalf of a user who's never
    // opened Settings would be a real, surprising side effect.
    //
    // The first refresh() call below waits on this
    // (settingsLoaded.then(refresh)) rather than firing independently
    // and re-rendering a second time on its own resolve — both requests
    // still go out concurrently, so this doesn't add a real sequential
    // round trip.
    const settingsLoaded = fetch("/api/settings/bot-pr-updates", {
      headers: { Accept: "application/json" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) allowBotPrUpdates = !!data.allowBotPrUpdates;
      })
      .catch(() => {
        // A transient failure here just leaves bot-managed PRs
        // suppressed (the safer default) rather than blocking the page
        // over it.
      });

    // ---- switching to a dashboard someone else shared with you ----
    let currentOwner = "";
    const ownerSelect = document.getElementById(
      "dashboard-owner-select",
    ) as HTMLSelectElement | null;

    fetch("/api/sharing", { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            sharedWithMe?: { username: string; displayName: string }[];
          } | null,
        ) => {
          if (
            !data?.sharedWithMe ||
            data.sharedWithMe.length === 0 ||
            !ownerSelect
          )
            return;
          for (const u of data.sharedWithMe) {
            const option = document.createElement("option");
            option.value = u.username;
            option.textContent = `${u.displayName}’s dashboard`;
            ownerSelect.appendChild(option);
          }
          ownerSelect.hidden = false;
        },
      )
      .catch(() => {
        /* a transient failure here isn't worth blocking the page over */
      });

    ownerSelect?.addEventListener("change", () => {
      currentOwner = ownerSelect.value;
      // Force-refresh only ever hits the signed-in user's own dashboard
      // (POST /api/dashboard/refresh has no ?owner= support, same as
      // the SSE stream) — hidden rather than left clickable-but-wrong
      // while viewing someone else's shared one.
      if (forceRefreshButton) forceRefreshButton.hidden = Boolean(currentOwner);
      refresh();
    });

    // ---- main fetch/render loop ----
    function applySnapshot(data: DashboardSnapshot) {
      clearError();
      lastGeneratedAt = data.generatedAt;
      tickRefreshedAt();

      renderForgeHealth(data.forges || []);
      lastForges = data.forges || [];
      rateLimitAlerts = computeRateLimitAlerts(lastForges);
      renderRateLimitBanner();

      // A locked merge/update-branch reason only reflects what the
      // forge said at the moment of the last attempt — re-derived here
      // from this fresh snapshot instead of latching indefinitely. A
      // lock whose root cause is still real reappears right away on the
      // next render — proactiveActionLockReason already re-checks
      // lastForges/forgePermissionDenied fresh every time from the
      // values just updated above — while one that's resolved simply
      // doesn't.
      clearStaleLocks(mergeState);
      clearStaleLocks(updateBranchState);

      const prs = data.pullRequests || [];
      for (const item of clearResolvedUpdateBranches(updateBranchState, prs)) {
        showStatus(`Updated the branch for ${item.repo}#${item.number}.`);
      }
      const issues = data.issues || [];
      allPRs = prs;
      allIssues = issues;
      updateSharedFilterOptions();
      if (!sharedControlsRestored) {
        sharedControlsRestored = true;
        syncSharedControlsToState();
      }
      // Each board's own render() sets its stat tile's text too (the
      // same filtered-vs-total wording its own count already uses), so
      // the tile never disagrees with the board sitting right below it.
      prBoard.setItems(prs);
      issueBoard.setItems(issues);

      const failingCount = prs.filter((p) => p.ci === "failure").length;
      const statFailing = document.getElementById("stat-failing");
      if (statFailing) statFailing.textContent = String(failingCount);
      // Red only once there's actually something failing — zero is
      // good news, not a tile that reads as an alarm nobody needs to
      // act on — and green, not just neutral, since zero failing is
      // itself the positive signal a CI status tile exists to show.
      statFailingTile?.classList.toggle("critical", failingCount > 0);
      statFailingTile?.classList.toggle("ok", failingCount === 0);
      const statRepos = document.getElementById("stat-repos");
      if (statRepos) {
        statRepos.textContent = String(
          (data.forges || []).reduce((sum, f) => sum + (f.repoCount || 0), 0),
        );
      }
    }

    function refresh() {
      const url =
        "/api/dashboard" +
        (currentOwner ? `?owner=${encodeURIComponent(currentOwner)}` : "");
      fetch(url, { headers: { Accept: "application/json" } })
        .then((res) => {
          if (res.status === 401) {
            window.location.href = "/login.html";
            throw new Error("session expired");
          }
          if (!res.ok) throw new Error(`backend answered ${res.status}`);
          return res.json();
        })
        .then(applySnapshot)
        .catch((err: Error) => {
          showError(`Could not reach the backend: ${err.message}`);
        });
    }

    settingsLoaded.then(refresh);
    setInterval(refresh, REFRESH_INTERVAL_MS);

    // ---- live updates over Server-Sent Events, on top of the poll above ----
    // The poll keeps running unconditionally — this only ever makes the
    // dashboard update sooner than the next one, never a replacement
    // for it. A browser or proxy that can't hold this connection open
    // just never benefits from it: EventSource retries on its own, and
    // if it never connects at all the poll still keeps the data fresh.
    if (window.EventSource) {
      const eventSource = new EventSource("/api/dashboard/stream");
      eventSource.onmessage = (event) => {
        // Only when looking at your own dashboard — a push here is
        // always this session's own aggregator, never the owner
        // currently selected in the sharing dropdown.
        if (currentOwner) return;
        try {
          applySnapshot(JSON.parse(event.data));
        } catch {
          /* a malformed event here isn't worth surfacing over the working poll */
        }
      };
    }
  }
</script>

<svelte:head>
  <title>Forge Board</title>
</svelte:head>

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
        <p id="forge-names"><span class="mono">&hellip;</span></p>
      </div>
    </a>
    <div class="header-status">
      <label for="dashboard-owner-select" class="sr-only"
        >Viewing dashboard</label
      >
      <select
        id="dashboard-owner-select"
        class="mono"
        style="font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--border-strong);background:var(--surface-sunken);color:var(--ink);"
        hidden
      >
        <option value="">My dashboard</option>
      </select>
      <div id="forge-health" aria-live="polite"></div>
      <span class="refreshed"
        >Refreshed <span class="mono" id="refreshed-at">&mdash;</span></span
      >
      <button
        class="theme-toggle"
        id="force-refresh-button"
        type="button"
        aria-label="Refresh now"
        title="Refresh now"
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
          ><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg
        >
      </button>
      <span class="mono" id="whoami" style="font-size:12px;color:var(--ink-3);"
      ></span>
      <nav class="app-nav" aria-label="Main">
        <a
          class="theme-toggle"
          href="/"
          aria-label="Home"
          title="Home"
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
          class="theme-toggle"
          href="/insights.html"
          aria-label="Insights"
          title="Insights"
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
        <a
          class="theme-toggle"
          href="/admin.html"
          id="admin-link"
          aria-label="Admin"
          title="Admin"
          style="text-decoration:none;"
          hidden
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
      </nav>
      <button
        class="theme-toggle"
        id="logout-button"
        type="button"
        aria-label="Sign out"
        title="Sign out"
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

  <div class="stats">
    <div class="stat">
      <div class="n" id="stat-prs">&ndash;</div>
      <div class="label">Open pull requests</div>
    </div>
    <div class="stat">
      <div class="n" id="stat-issues">&ndash;</div>
      <div class="label">Open issues</div>
    </div>
    <button
      type="button"
      class="stat"
      id="stat-failing-tile"
      aria-label="Filter pull requests by CI status: Failing"
    >
      <div class="n" id="stat-failing">&ndash;</div>
      <div class="label">CI failing</div>
    </button>
    <div class="stat">
      <div class="n" id="stat-repos">&ndash;</div>
      <div class="label">Repos tracked</div>
    </div>
  </div>

  <div
    class="filter-bar"
    role="search"
    aria-label="Filter pull requests and issues"
  >
    <fieldset class="forge-segmented">
      <legend class="sr-only">Filter by forge</legend>
      <label>
        <input
          type="radio"
          name="forge"
          class="col-filter"
          data-col="forge"
          value=""
          checked
        />
        <span>All</span>
      </label>
      <label>
        <input
          type="radio"
          name="forge"
          class="col-filter"
          data-col="forge"
          value="github"
        />
        <span>GitHub</span>
      </label>
      <label>
        <input
          type="radio"
          name="forge"
          class="col-filter"
          data-col="forge"
          value="forgejo"
        />
        <span>Forgejo</span>
      </label>
    </fieldset>
    <select
      class="group-select"
      id="shared-group-select"
      aria-label="Group rows by"
    >
      <option value="">No grouping</option>
      <option value="repo">Group by repo</option>
      <option value="forge">Group by forge</option>
    </select>
    <select
      class="col-filter"
      data-col="repo"
      id="shared-repo-select"
      aria-label="Filter by repo"
    >
      <option value="">All repos</option>
    </select>
    <input
      class="col-filter"
      data-col="title"
      type="text"
      placeholder="Title"
      aria-label="Filter by title"
      list="shared-title-options"
      autocomplete="off"
    />
    <datalist id="shared-title-options"></datalist>
    <select
      class="col-filter"
      data-col="author"
      id="shared-author-select"
      aria-label="Filter by author"
    >
      <option value="">All authors</option>
    </select>
    <select
      class="col-filter"
      data-col="label"
      id="shared-label-select"
      aria-label="Filter by label"
    >
      <option value="">All labels</option>
    </select>
    <select
      class="col-filter"
      data-col="created"
      aria-label="Filter by created"
    >
      <option value="">Created</option>
      <option value="60">&lt; 1 hour</option>
      <option value="1440">&lt; 24 hours</option>
      <option value="10080">&lt; 7 days</option>
      <option value="43200">&lt; 30 days</option>
    </select>
    <select
      class="col-filter"
      data-col="updated"
      aria-label="Filter by updated"
    >
      <option value="">Updated</option>
      <option value="60">&lt; 1 hour</option>
      <option value="1440">&lt; 24 hours</option>
      <option value="10080">&lt; 7 days</option>
      <option value="43200">&lt; 30 days</option>
    </select>
    <button
      type="button"
      class="clear-filters"
      id="clear-filters-button"
      disabled>Clear filters</button
    >
  </div>

  <section class="board" aria-label="Open pull requests">
    <div class="board-head">
      <h2>Pull requests</h2>
      <div class="board-head-controls">
        <select
          class="col-filter"
          data-col="status"
          aria-label="Filter by CI status"
        >
          <option value="">CI status</option>
          <option value="success">Passing</option>
          <option value="failure">Failing</option>
          <option value="pending">Running</option>
          <option value="none">No checks</option>
        </select>
        <span class="count" id="pr-count">&ndash;</span>
      </div>
    </div>

    <div id="pr-rows"></div>
    <p class="empty-state" id="pr-empty" hidden>No open pull requests.</p>
    <p class="no-results" id="pr-no-results" hidden>
      No pull requests match these filters.
    </p>
    <div class="pagination" id="pr-pagination" hidden>
      <div class="pagination-pages" id="pr-pagination-pages"></div>
      <label class="pagination-size">
        Per page
        <select id="pr-page-size" aria-label="Results per page">
          <option value="10">10</option>
          <option value="25" selected>25</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
      </label>
    </div>
  </section>

  <section class="board" aria-label="Open issues">
    <div class="board-head">
      <h2>Issues</h2>
      <div class="board-head-controls">
        <label class="checkbox-filter">
          <input type="checkbox" id="issue-hide-dependency-dashboard" checked />
          Hide Dependency Dashboard
        </label>
        <span class="count" id="issue-count">&ndash;</span>
      </div>
    </div>

    <div id="issue-rows"></div>
    <p class="empty-state" id="issue-empty" hidden>No open issues.</p>
    <p class="no-results" id="issue-no-results" hidden>
      No issues match these filters.
    </p>
    <div class="pagination" id="issue-pagination" hidden>
      <div class="pagination-pages" id="issue-pagination-pages"></div>
      <label class="pagination-size">
        Per page
        <select id="issue-page-size" aria-label="Results per page">
          <option value="10">10</option>
          <option value="25" selected>25</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
      </label>
    </div>
  </section>

  <footer>
    Read-only mirror of both forges &middot; credentials never leave <span
      class="mono">forge-dashboard</span
    >'s backend &middot;
    <a
      href="https://github.com/alrayyes/forge-dashboard"
      target="_blank"
      rel="noopener noreferrer">Source</a
    >
    <span id="footer-version"></span>
  </footer>
</div>

<dialog
  id="pipeline-dialog"
  class="pipeline-dialog"
  aria-label="Pipeline checks"
>
  <div class="pipeline-dialog-header">
    <div>
      <h2 class="pipeline-dialog-title">Pipeline checks</h2>
      <p class="pipeline-dialog-subtitle" id="pipeline-dialog-subtitle"></p>
    </div>
    <button
      type="button"
      class="pipeline-dialog-close"
      id="pipeline-dialog-close"
      aria-label="Close pipeline checks"
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
        ><path d="M18 6 6 18" /><path d="M6 6l12 12" /></svg
      >
    </button>
  </div>
  <div class="pipeline-dialog-body" id="pipeline-dialog-body"></div>
</dialog>
