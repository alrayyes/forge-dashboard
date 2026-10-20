<script lang="ts">
  // The dashboard is four pages sharing one script: pull requests at "/pull-requests",
  // issues at "/issues" (#827), release pull requests at "/releases" (#1107)
  // and Dependabot and Renovate's at "/bots" (#1192). Each view renders only
  // its own board and controls; every id the script looks up that the other
  // view lacks is already null-guarded. The releases and bots views are the
  // pull request board over one kind of pull request.
  let { view }: { view: "pulls" | "issues" | "releases" | "bots" } = $props();
  // The kind of pull request a view lists, or null for the pull request page,
  // which lists the rest.
  const viewKind = $derived(
    view === "releases" ? "release" : view === "bots" ? "dependency" : null,
  );
  const pullsView = $derived(view !== "issues");

  import { onMount } from "svelte";
  import PullRequestDetailsDialog, {
    type DetailsChrome,
    type DetailsStatus,
  } from "#lib/PullRequestDetailsDialog.svelte";
  import {
    type AutoUpdate,
    autoUpdateBadge,
    autoUpdateControl,
  } from "#lib/auto-update.js";
  import { CHECK_GLYPHS } from "#lib/check-glyphs.js";
  import {
    CHECK_KIND_GLYPH,
    type CheckCounts,
    checkSegments,
    pillName,
  } from "#lib/check-counts.js";
  import {
    CHECK_STATE_LABELS,
    formatCheckDuration,
    type Check,
  } from "#lib/pipeline-checks.js";
  import * as Filters from "#lib/filters.js";
  import { FORGE_CLASSES, FORGE_LABELS } from "#lib/forges.js";
  import { setNavCounts } from "#lib/nav-counts.svelte.js";
  import {
    firstRefreshLoading,
    firstRefreshPending,
    hasTimestamp,
  } from "#lib/first-refresh.js";
  import { adviseReadIntervalMs } from "#lib/read-interval.js";
  import {
    firstRefresh,
    setFirstRefresh,
    settleFirstRefresh,
  } from "#lib/first-refresh.svelte.js";
  import FirstRefreshStatus from "#lib/FirstRefreshStatus.svelte";
  import ListSkeleton from "#lib/ListSkeleton.svelte";
  import type { ServerNavCounts } from "#lib/nav-counts.svelte.js";
  import {
    type ActionName,
    type AllowedAction,
    findAction,
    primaryAction,
  } from "#lib/allowed-actions.js";
  import { avatarSrc } from "#lib/avatar.js";
  import { profileHref } from "#lib/profile-link.js";
  import * as Stacks from "#lib/stacks.js";
  import { createTitleHover } from "#lib/title-hover.js";
  import type { FilterableItem, SharedFilterState } from "#lib/filters.js";
  import {
    type ActionCode,
    type ActionRequestError,
    interpretActionFailure,
    failureDetails,
    NETWORK_FAILURE,
    readActionFailure,
    type SettledState,
    settledBadge,
    showSettled,
  } from "#lib/action-error.js";
  import {
    CONFIRM_TIMEOUT_MS,
    createConfirmArm,
    type DisarmReason,
  } from "#lib/confirm-arm.js";
  import {
    type ActionRef,
    type FailureDetails,
    type BotRequest,
    createFeedbackStore,
  } from "#lib/feedback.js";
  import { copyButton } from "#lib/copy-details.js";
  import { mountFeedbackUI } from "#lib/feedback-ui.js";
  import {
    comesBack,
    hideFailedMessage,
    hidMessage,
    nameOf,
    restoredMessage,
    restoreFailedMessage,
  } from "#lib/hidden-pull-requests.js";
  import {
    autoMergeChip,
    buildWaitChip,
    queuedChip,
    requestedAnnouncement,
    type WaitKind,
  } from "#lib/wait-chip.js";
  import type { RevealOutcome } from "#lib/feedback-ui.js";
  import {
    budgetText,
    isRateLimited,
    msUntilReset,
    PERMISSION_REASON,
    type RateLimit,
    rateLimitReasonText,
  } from "#lib/rate-limit.js";
  import { remainingBand } from "#lib/rate-limit-band.js";
  import {
    formatClock,
    formatTime,
    onTimezoneChange,
    effectiveZone,
  } from "#lib/time.svelte.js";
  import { createWebMCPTools } from "#lib/webmcp-tools.js";

  // This page now lives under (app) and inherits (app)/+layout.svelte's
  // header (brand link, .app-nav, admin-link, logout-button, whoami) —
  // its own duplicate copies of that chrome, and the nav.js injection
  // that used to drive them, were removed when it moved here
  // (alrayyes/forge-dashboard#645). Its own genuinely page-specific
  // content (the forge-names subtitle, forge health, the owner-switcher,
  // the refresh button) used to be injected into the layout's <header>
  // via a Svelte context the layout exposed — that approach didn't work:
  // SvelteKit's SSR renders a layout's own template (everything before
  // {@render children()}) in one synchronous top-down pass, before this
  // page's own script ever runs, so content this page set could never
  // appear in that earlier part of the layout's output (confirmed
  // against internal/api/static/index.html post-build). It's plain,
  // non-landmark markup in this page's own template now instead — see
  // the .dashboard-toolbar div below, right where the old duplicate
  // <header> used to sit.

  // components.schemas.QueuedAction: a safe action queued to run when a
  // rate-limited forge resets (#756). The server owns the queue.
  type QueuedActionItem = {
    id: string;
    action: "update_branch" | "dependabot_rebase" | "renovate_rebase";
    forge: string;
    fullName: string;
    number: number;
    status: "queued" | "done" | "skipped" | "failed";
    runAt: string;
    createdAt: string;
    finishedAt?: string;
    code?: string;
    message?: string;
  };
  type PullRequestItem = FilterableItem & {
    number: number;
    url: string;
    // The forge's own avatar URL for the author; empty when it has none.
    authorAvatarUrl?: string;
    // The author's profile page on the forge, built by the server; empty when
    // there is none to link to.
    authorUrl?: string;
    draft: boolean;
    ci: string;
    // How many checks passed, are running, are waiting and failed (#2004). The
    // server tallies them; absent from an older server, which leaves the pill
    // as it was.
    checks?: CheckCounts;
    mergeStatus: string;
    // GitHub holds this pull request's workflow runs until someone approves
    // them (#1280). The server decides; the page only says so.
    awaitingWorkflowApproval?: boolean;
    autoMergeEnabled: boolean | null;
    // Who holds an enabled auto-merge. Omitted means the server doesn't
    // know, and the page doesn't guess (#1596).
    autoMergeHeldBy?: "dashboard" | "forge";
    behind: boolean;
    empty: boolean;
    // Why this pull request is waiting or can't be merged, in one place
    // (#1375): null when nothing holds it back. The server sends it on every
    // pull request; the page only shows it.
    status?: {
      code: string;
      message: string;
      next?: string;
      action?: string;
    } | null;
    // Review comments on the pull request, and how many review threads are
    // still open, or null where the forge can't say (#1335). Optional so a
    // server that predates them draws nothing.
    reviewComments?: number;
    conversationComments?: number;
    unresolvedThreads?: number | null;
    // What the server offers on this pull request (#805).
    allowedActions?: AllowedAction[];
    // The action queued on this pull request that is still waiting for its
    // forge's rate limit to reset, or null (#756).
    queued?: QueuedActionItem | null;
    // Where it sits in a stack of pull requests (#861).
    stack?: { position: number; size: number } | null;
    stackedOn?: { number: number; url: string } | null;
    stackChildren?: number[];
    // A Dependabot or Renovate rebase asked for through this app and not
    // settled yet (#808). The server owns it.
    botRequest?: ServerBotRequest;
    // An Update branch the forge accepted that no snapshot has shown
    // landing yet (#982). The server owns it too.
    updateRequest?: ServerUpdateRequest;
    // Where this app's own auto-merge stands, present only on a Forgejo
    // pull request the signed-in user armed it on.
    autoMerge?: ServerAutoMergeStatus;
    // Set on a pull request the user hid, in an answer that asked for the
    // hidden ones (#841); hiddenUntil is when a timed hide ends.
    hidden?: boolean;
    hiddenUntil?: string;
    // Whether the dashboard brings this branch up to date by itself, and
    // where that comes from. The server decides; absent from an older server.
    autoUpdate?: AutoUpdate;
  };
  // Matches components.schemas.AutoMergeStatus in api/openapi.yaml.
  type ServerAutoMergeStatus = {
    state: "waiting" | "stopped";
    code?: string;
    message: string;
  };
  // Matches components.schemas.AutoMergedPullRequest in api/openapi.yaml.
  type ServerAutoMerged = {
    forge: string;
    fullName: string;
    number: number;
    mergedAt: string;
    message: string;
  };
  // Matches components.schemas.BotRequest in api/openapi.yaml.
  type ServerBotRequest = {
    bot: "dependabot" | "renovate";
    action: "rebase" | "recreate";
    phase: "queued" | "rebasing" | "expired";
    requestedAt: string;
    expiresAt: string;
    // Dependabot's thumbs-up on the command comment was seen (#1082).
    acknowledgedAt?: string;
    commentUrl?: string;
  };
  // Matches components.schemas.UpdateRequest in api/openapi.yaml.
  type ServerUpdateRequest = {
    phase: "queued" | "expired";
    requestedAt: string;
    expiresAt: string;
  };
  type IssueItem = FilterableItem & {
    number: number;
    url: string;
    // The forge's own avatar URL for whoever filed it; empty when it has none.
    authorAvatarUrl?: string;
    // The author's profile page on the forge, built by the server.
    authorUrl?: string;
  };
  type Forge = {
    forge: string;
    reachable: boolean;
    repoCount: number;
    errorKind?: string;
    error?: string;
    // Set with reachable: false when the rows shown are the last good ones
    // (#933): when that data was fetched.
    staleSince?: string;
    // Two independent GitHub budgets (#361) — see api/openapi.yaml's own
    // ForgeHealth.rateLimitGraphQL/rateLimitREST doc comment for which
    // is which and when each is reported.
    rateLimitGraphQL?: RateLimit;
    rateLimitREST?: RateLimit;
    // #666: why Dependabot would refuse a command sent through this
    // forge's credential (a GitHub App) — the Dependabot buttons lock
    // with this exact text. Absent when commands work.
    dependabotCommandsBlocked?: string;
  };
  type DashboardSnapshot = {
    generatedAt: string;
    // How often, in seconds, to re-read the snapshot (the server's advice).
    readIntervalSeconds?: number;
    forges: Forge[];
    pullRequests: PullRequestItem[];
    issues: IssueItem[];
    // How many issues are real work, from the server (#980).
    openIssueCount?: number;
    // What each nav item shows: its page's total and failed count (#1315).
    navCounts?: ServerNavCounts;
    // False from process start until this viewer's first refresh has finished
    // (succeeded or failed), true after (#1672, spec #1674, server #1673).
    // Optional in the spec until the server emits it; missing counts as loaded.
    firstRefreshDone?: boolean;
    // The viewer's issue settings (#1630): whether the Dependency Dashboard is
    // hidden, whether the ignored-titles list has an entry, and how many
    // issues they left out of `issues`.
    hideDependencyDashboard?: boolean;
    ignoredTitlesSet?: boolean;
    settingsHiddenIssueCount?: number;
    repos?: Filters.RepoRef[];
    // Drafts the API left out (#791). 0 when the request asked for them.
    hiddenDrafts?: number;
    // Pull requests the user hid that are still open (#841).
    hiddenPullRequests?: number;
    // What this app auto-merged in the last ten minutes (Forgejo).
    autoMerged?: ServerAutoMerged[];
    // The user's queued actions: waiting, and finished in the last 24 hours
    // (#756).
    queuedActions?: QueuedActionItem[];
  };
  type ActionPhase =
    | "idle"
    | "confirming"
    | "merging"
    | "closing"
    | "queued"
    // A bot rebase the bot has picked up, until CI restarts (#707).
    | "rebasing"
    | "requesting"
    | "enabling"
    | "locked"
    // Found already merged or closed on the forge (the row lagged it).
    | SettledState;
  type ActionState = {
    phase: ActionPhase;
    reason?: string;
    // The code of the refusal that locked it (#806): what decides whether
    // Retry is offered, not the words in the reason.
    code?: string;
    // The feedback entry that explains a permission lock (#918): the lock
    // lasts as long as that failure line does.
    fkey?: string;
    // Only on a queued or rebasing request the server tracks (#706, #808,
    // #982): which pull request it is on, and what lets a snapshot without
    // a botRequest or updateRequest end the wait. A snapshot only counts once the server has the request
    // (`posted`) and the fetch started after that (`seq`, #691).
    // `restored` marks one this page only learned of from a snapshot: no
    // click of this page's own is mid-way, so it doesn't hold the board.
    queued?: {
      prKey: string;
      posted: boolean;
      seq: number;
      restored?: boolean;
    };
  };

  // The read-only details dialog (#943); a pull request's title button opens it.
  let detailsDialog = $state<PullRequestDetailsDialog>();
  // The pull request the open dialog shows, by key (#943). Null while it is
  // closed; the footer follows this pull request's row.
  let dialogKey: string | null = null;
  // The newest snapshot no longer has that pull request (merged, closed,
  // hidden). The list behind the dialog holds still; the dialog says so.
  let dialogGone = false;
  // The dialog's hooks into the board, set once the board exists below.
  let escapeDetails: () => boolean = () => false;
  let detailsClosed: () => void = () => {};

  // The Issues settings (#1630). The server applies them to what it sends, so
  // this page only stops drawing the two fields they replace and says how many
  // issues they hid. The fields stay hidden until the first snapshot says, so a
  // field that is about to go never flashes in.
  // True until the server says this viewer's first refresh has finished
  // (#1672): the lists draw a skeleton instead of themselves or an empty state.
  // False while the snapshot's time is the zero time, so no "Refreshed ... ago"
  // is drawn for a moment that never was.
  let refreshedKnown = $state(false);
  const loadingFirst = $derived(firstRefreshLoading(firstRefresh));
  let issueSettingsKnown = $state(false);
  let settingsHideDependencyDashboard = $state(false);
  let settingsIgnoreTitles = $state(false);
  let settingsHiddenIssues = $state(0);

  // The issue rules the page filters by: its own saved values, except for a
  // field the settings replace. That one is ignored, not cleared, so it comes
  // back when the setting is turned off.
  function withSettings(extra: Record<string, string>): Record<string, string> {
    if (!settingsHideDependencyDashboard && !settingsIgnoreTitles) return extra;
    return {
      ...extra,
      ...(settingsHideDependencyDashboard
        ? { hideDependencyDashboard: "1" }
        : {}),
      ...(settingsIgnoreTitles ? { hideTitleRegex: "" } : {}),
    };
  }

  onMount(initDashboard);

  // Everything below only ever runs once the page has mounted — a straight TypeScript port of
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
    // Set once the page is torn down. A client-side move from Releases to Home
    // destroys this component, but the code below finds its elements by id, so
    // anything still running would draw this view's pull requests onto the
    // next page (#1259).
    let destroyed = false;
    // How long to wait between reads of the snapshot. The server says so in
    // every snapshot (readIntervalSeconds, #809), so the page keeps no
    // interval of its own; this is only the wait before the first answer
    // has arrived, e.g. when that first read failed.
    let readIntervalMs = 10_000;
    // Counts the snapshot fetches started so far, so a queued bot rebase
    // can tell a fetch begun before its click from one begun after (#691).
    let requestSeq = 0;
    // When the background poll next fires — what the queued-action
    // banner's countdown reads, so it tracks the real cadence instead of
    // a number hard-coded beside the interval. Re-armed by schedulePoll.
    let nextPollAt = Date.now() + readIntervalMs;

    // Per-pull-request action feedback (#714): inline row lines, toasts
    // and the Activity panel. State lives here, outside the DOM, so it
    // outlasts every row rebuild and snapshot.
    // Finished entries survive a reload in this tab (#724); a blocked
    // sessionStorage just means an empty list.
    const feedback = createFeedbackStore(
      Date.now,
      (() => {
        try {
          return window.sessionStorage;
        } catch {
          return undefined;
        }
      })(),
    );
    const feedbackUI = mountFeedbackUI(feedback, {
      liveTarget: () =>
        dialogKey !== null ? (detailsDialog?.liveElement() ?? null) : null,
      countdownText: () => queuedCountdownText(),
      revealRow: (key) => revealRow(key),
      // The write may have landed before the connection dropped, so the row
      // is read again from the server before the action is offered anew.
      onTransientFailureCleared: () => {
        refreshDashboardNow().catch(() => {});
      },
      // A wait that has run two minutes: read the row again (#1229).
      onCheckAgain: () => {
        refreshDashboardNow().catch((err: Error) => {
          showError(`Could not refresh: ${err.message}`);
        });
      },
    });
    function actionRef(item: PullRequestItem): ActionRef {
      return { key: prKey(item), repo: item.repo, number: item.number };
    }
    // A failed action: the row gets a Failed line (with Retry unless the
    // failure locked the button), and an error toast that stays.
    // The action's context for a Copy payload. The action is the first part
    // of its feedback key ("merge", "renovate", "cancel-auto-merge", …).
    // A caller whose key doesn't say which command it was (Dependabot's
    // Rebase and Recreate share one) names it.
    function detailsContext(
      item: PullRequestItem,
      fkey: string,
      actionName?: string,
    ) {
      return {
        action: actionName ?? fkey.split(":")[0],
        forge: item.forge,
        repo: item.repo,
        number: item.number,
      };
    }

    function failAction(
      actionKey: string,
      what: string,
      reason: string,
      canRetry: boolean,
      transient = false,
      details?: FailureDetails,
    ) {
      const message = `Couldn't ${what}: ${reason}`;
      feedback.update(actionKey, {
        phase: "failed",
        inline: reason,
        message,
        toast: true,
        announce: message,
        canRetry,
        // A failure that passes by itself clears its row line after a few
        // seconds (#1206).
        transient,
        // What Copy holds: the server's whole answer (#1323).
        details,
      });
    }
    const CI_LABELS: Record<string, string> = {
      success: "Passed",
      failure: "Failed",
      pending: "Running",
      none: "No checks",
    };
    const FORGE_SHORT_LABELS: Record<string, string> = {
      github: "GH",
      forgejo: "FJ",
    };

    let lastGeneratedAt: string | null = null;

    // ---- formatting ----
    // A caption over the value: the row is a two-line card, so a header row
    // would sit far from the cells it names (#1109).
    function timeCell(cls: string, label: string, iso: string): HTMLElement {
      const cell = el("div", cls);
      cell.appendChild(el("span", "time-label", label));
      cell.appendChild(el("span", "time-value", relativeTime(iso)));
      return cell;
    }

    function relativeTime(iso: string): string {
      const mins = Filters.minutesAgo(iso);
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

    // A pending action's button stays focusable: a native `disabled`
    // drops focus, so a keyboard or screen reader user loses their place
    // (#690). aria-disabled keeps it, and clicks are ignored in the
    // handler instead.
    function markPending(button: HTMLButtonElement, pending: boolean) {
      if (pending) button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
    }

    function isPending(button: HTMLButtonElement): boolean {
      return button.getAttribute("aria-disabled") === "true";
    }

    // The one line that says how many rows show: the total when nothing is
    // filtered, "Showing 1 of 2" when a filter narrows it (#1325). The nav
    // icons carry the totals, so the page has no tiles repeating them.
    function shownCountText(shown: number, total: number): string {
      return shown === total ? `${total} open` : `Showing ${shown} of ${total}`;
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
      // The repository's own logo, only when the forge has one; a repository
      // without one draws nothing, so the row doesn't shift. Decorative: the
      // name beside it already says which repository. A failed load drops
      // the image and leaves the name alone.
      const logo = avatarSrc(
        reposByKey.get(Filters.repoKey(item.forge, item.repo))?.logoUrl,
      );
      if (logo) {
        const img = el("img", "repo-logo") as HTMLImageElement;
        img.src = logo;
        img.alt = "";
        img.width = 16;
        img.height = 16;
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.addEventListener("error", () => img.remove());
        wrap.appendChild(img);
      }
      const repoName = el("span", "repo-name", item.repo);
      // .repo-name truncates via CSS text-overflow: ellipsis — a title
      // is what lets a mouse user actually read the full name on hover.
      // It is set only while the name is cut, as for a pull request title
      // (#1961); the truncation is purely visual, so a screen reader
      // already reads the untruncated text content regardless.
      titleHover.track(repoName, item.repo);
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

    const titleHover = createTitleHover();

    function titleCell(
      item: FilterableItem & { number: number; url: string; draft?: boolean },
      onLabelClick: (name: string) => void,
      activeLabel: string,
      onOpen?: (triggerId: string) => void,
    ): HTMLElement {
      const wrap = el("div", "title-cell");
      // The real, keyboard-focusable link — a "stretched link" (see
      // .title-cell .title::after in style.css) makes the whole row
      // clickable, without the row itself being an <a> that would make
      // the CI pill and label chips invalid/inaccessible nested
      // interactive elements.
      // https://css-tricks.com/block-links-the-search-for-a-perfect-solution/
      //
      // A row's title is a button that opens its dialog (the dialog links on
      // to the forge); a row with nothing to open still links to the forge.
      const title = document.createElement(onOpen ? "button" : "a");
      title.className = "title";
      if (title instanceof HTMLAnchorElement) {
        title.href = item.url;
        title.target = "_blank";
        title.rel = "noopener noreferrer";
      } else if (onOpen) {
        const button = title as HTMLButtonElement;
        button.type = "button";
        button.setAttribute("aria-label", `#${item.number} ${item.title}`);
        // Stable, so the dialog can hand focus back after a re-render.
        button.id = `details-trigger-${domSafeId(prKey(item as PullRequestItem))}`;
        // A drag that starts and ends on the overlay is a text-selection
        // gesture, not a click (a link never opens on one either).
        let down: { x: number; y: number } | null = null;
        button.addEventListener("pointerdown", (event) => {
          down = { x: event.clientX, y: event.clientY };
        });
        button.addEventListener("click", (event) => {
          const start = down;
          down = null;
          // detail 0 is a keyboard click: no pointer path to judge.
          if (
            event.detail > 0 &&
            start &&
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5
          )
            return;
          onOpen(button.id);
        });
      }
      // The ellipsis truncation lives on this inner span, not .title
      // itself — overflow:hidden on .title would clip its own ::after
      // stretched overlay down to .title's box instead of letting it
      // cover the whole row (see the comment on .title in style.css).
      const text = el("span", "title-text");
      text.appendChild(el("span", "num", `#${item.number}`));
      // A real space, so the visible text reads like the accessible name.
      text.appendChild(document.createTextNode(` ${item.title}`));
      // The whole title as hover text, while it is cut (on the visible text,
      // not the button: a second description would be announced twice).
      titleHover.track(text, item.title);
      title.appendChild(text);
      wrap.appendChild(title);
      (item.labels || []).slice(0, 3).forEach((label) => {
        wrap.appendChild(labelChip(label, onLabelClick, activeLabel));
      });
      return wrap;
    }

    // status is a real button — see titleCell's comment on why the row
    // isn't an <a> around everything. It opens the pipeline panel
    // (#1139); filtering by CI status lives in the column filter.
    //
    // The CI slot (#1563) holds a state (running) and the outcomes it leads to
    // (failed, passed): one pill in one fixed-size slot, a glyph and a word,
    // so a run turns into its result without the row moving. The glyphs are
    // the pipeline panel's own (#1473). A run held for approval is not
    // running, so it gets the pause glyph the pipeline panel uses for it.
    const SEGMENTED_CI = new Set(["pending", "failure", "success"]);
    const CI_SLOT_GLYPHS: Record<string, string> = {
      pending: "running",
      failure: "failure",
      success: "success",
    };
    // The details header draws the same pill as a plain badge: it was a
    // snapshot at open, so it opens nothing (interactive = false).
    function ciPill(item: PullRequestItem, interactive = true): HTMLElement {
      const status = item.ci;
      const awaiting = item.awaitingWorkflowApproval === true;
      const label = awaiting
        ? "Waiting for workflow approval"
        : CI_LABELS[status] || status;
      const glyphs = pipelineCheckGlyphs(
        awaiting ? "awaiting_approval" : (CI_SLOT_GLYPHS[status] ?? ""),
      );
      // A pipeline that ran says how far it got (#2004, #2074), running, passed
      // or failed alike: the word, then one count per state that has any, each
      // with its glyph. The server tallies the counts; nothing is drawn without
      // them, which leaves the plain pill.
      const segments =
        SEGMENTED_CI.has(status) && !awaiting ? checkSegments(item.checks) : [];
      const segmented = segments.length > 0;
      const addMark = (pill: HTMLElement) => {
        if (glyphs.length > 0) glyphs.forEach((g) => pill.appendChild(g));
        else pill.appendChild(el("span", "dot"));
      };
      const fill = (pill: HTMLElement) => {
        if (!segmented) {
          addMark(pill);
          pill.appendChild(document.createTextNode(label));
          return;
        }
        pill.appendChild(el("span", "ci-seg ci-seg-label", label));
        for (const { kind, n } of segments) {
          const seg = el("span", `ci-seg ci-seg-${kind}`);
          // The counts are said in words by the name (or, on a badge, by the
          // hidden text after them), so a screen reader skips these.
          seg.setAttribute("aria-hidden", "true");
          pipelineCheckGlyphs(CHECK_KIND_GLYPH[kind]).forEach((g) =>
            seg.appendChild(g),
          );
          seg.appendChild(document.createTextNode(String(n)));
          // A space before each count, so the pill's text reads "Running 5 2 3"
          // and the name below contains it whole.
          pill.appendChild(document.createTextNode(" "));
          pill.appendChild(seg);
        }
      };
      const classes = `ci-pill ${status}${awaiting ? " awaiting" : ""}${segmented ? " segmented" : ""}`;
      // No CI, no pipeline to open: a plain badge (#1139).
      if (status === "none" || !interactive) {
        const badge = el("span", classes);
        fill(badge);
        if (segmented) {
          // A badge has no name of its own to carry the words, so a hidden
          // line says them whole, and the sighted word is hidden too or a
          // screen reader would hear Running twice.
          badge
            .querySelector(".ci-seg-label")
            ?.setAttribute("aria-hidden", "true");
          badge.appendChild(el("span", "sr-only", pillName(label, segments)));
        }
        return badge;
      }
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = classes;
      // Given a stable id: openPipelineDialog's "close" handler refocuses
      // it by this id once a later render has rebuilt the row.
      pill.id = `pipeline-trigger-${domSafeId(prKey(item))}`;
      fill(pill);
      // The visible word leads the name (WCAG 2.5.3), the counts in words
      // after it.
      pill.setAttribute(
        "aria-label",
        `${segmented ? pillName(label, segments) : label}. Open pipeline`,
      );
      pill.addEventListener("click", () => {
        openPipelineDialog(item);
      });
      return pill;
    }

    // A link out to the checks page, where GitHub's own button approves the
    // held runs (#1280). Nothing here approves anything.
    function approveOnGithubLink(item: PullRequestItem): HTMLElement | null {
      if (item.awaitingWorkflowApproval !== true) return null;
      const link = el(
        "a",
        "approve-link",
        "Approve on GitHub",
      ) as HTMLAnchorElement;
      link.href = `${item.url.replace(/\/+$/, "")}/checks`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute(
        "aria-label",
        "Approve on GitHub (opens the checks page in a new tab)",
      );
      return link;
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
    // #1561: "blocked" is also silent while ci is "failure", the failing CI
    // pill already says why (Filters.showBlockedChip).
    function mergeStatusPill(status: string, ci: string): HTMLElement | null {
      if (status === "blocked" && !Filters.showBlockedChip(status, ci))
        return null;
      const label = MERGE_STATUS_LABELS[status];
      if (!label) return null;
      const pill = el("span", `merge-pill ${status}`);
      pill.appendChild(el("span", "dot"));
      pill.appendChild(document.createTextNode(label));
      return pill;
    }

    // Dependabot and Renovate pull requests never get
    // updateBranchActionCell's own inline button — that function returns
    // null for them on purpose (see its own doc comment: their own Rebase
    // actions do that job). release-please does get the button (#728),
    // so it's left out here the same way a plain pull request is. Without this
    // pill a bot-managed row that's actually behind had no visible sign
    // of it at all — confirmed live against a real Dependabot PR
    // (hush-hush-python#153) that GitHub itself flagged "out-of-date
    // with the base branch" while this dashboard showed nothing, with
    // the one relevant action (Dependabot: Rebase) nowhere on the row.
    // Silent for every non-bot pull request:
    // those already get the Update-branch button as their one clear
    // signal (#359), and a second pill saying the same thing would be
    // exactly the duplication #359 fixed.
    function behindPill(item: PullRequestItem): HTMLElement | null {
      // Behind, with something to merge, on a pull request a bot rebases:
      // the server lists that rebase for exactly those (#805).
      if (
        !item.behind ||
        item.empty ||
        !(
          findAction(item, "dependabot_rebase") ||
          findAction(item, "renovate_rebase")
        )
      )
        return null;
      return attrChip("behind", "Out of date");
    }

    // The review activity pill (#1335): how many review comments there are
    // and, where the forge can say, how many threads are still open. Nothing
    // at zero. The words are in the accessible name, the numbers on screen,
    // and the open state is a dot and "open" as well as amber. It links to
    // the files-and-review view on the forge.
    function reviewPill(item: PullRequestItem): HTMLElement | null {
      const review = item.reviewComments ?? 0;
      const conversation = item.conversationComments ?? 0;
      const comments = review + conversation;
      if (comments <= 0) return null;
      // Conversation comments join the count (#1953); the word is "review
      // comment" only while every one of them is.
      const word = conversation > 0 ? "comment" : "review comment";
      const open = item.unresolvedThreads ?? 0;
      const plural = (n: number, word: string) =>
        `${n} ${word}${n === 1 ? "" : "s"}`;
      const pill = el(
        "a",
        open > 0 ? "review-pill open" : "review-pill",
      ) as HTMLAnchorElement;
      pill.href = review > 0 ? `${item.url}/files` : item.url;
      pill.target = "_blank";
      pill.rel = "noopener noreferrer";
      pill.appendChild(reviewIcon());
      if (open > 0) pill.appendChild(el("span", "dot"));
      const shown = el(
        "span",
        "review-pill-text",
        open > 0 ? `${comments} · ${open} open` : `${comments}`,
      );
      shown.setAttribute("aria-hidden", "true");
      pill.appendChild(shown);
      pill.appendChild(
        el(
          "span",
          "sr-only",
          open > 0
            ? `${plural(comments, word)}, ${plural(open, "unresolved thread")}`
            : plural(comments, word),
        ),
      );
      return pill;
    }

    function reviewIcon(): SVGElement {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "12");
      svg.setAttribute("height", "12");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute(
        "d",
        "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
      );
      svg.appendChild(path);
      return svg;
    }

    // Who holds a Forgejo auto-merge, in the chip's note. An unnamed holder
    // gets no note at all (#1596).
    const HOLDER_NOTE: Record<string, string> = {
      dashboard: "Managed by Forge Dashboard",
      forge: "Scheduled on Forgejo",
    };

    // Silent unless auto-merge is genuinely enabled — autoMergeEnabled
    // is `null` for a forge that can't report this at all (Forgejo,
    // today), which must never render as "not enabled": strict ===
    // true, not a truthy check.
    function autoMergePill(pr: PullRequestItem): HTMLElement | null {
      if (pr.autoMergeEnabled !== true) return null;
      // On Forgejo this app does the merging, not the forge, and the chip
      // says so in words (it has no GitHub-style setting to point at).
      if (pr.forge === "forgejo") {
        const chip = attrChip("auto-merge", "Auto-merge on");
        const note = HOLDER_NOTE[pr.autoMergeHeldBy ?? ""];
        if (note) chip.appendChild(el("span", "pill-note", note));
        return chip;
      }
      return attrChip("auto-merge", "Auto-merge");
    }

    // The attribute tier (#1563): something set on the pull request that
    // holds until someone changes it. A quiet outlined chip with a small
    // icon and its word, no fill, no motion and no state colour, so it never
    // reads as a CI state. Not a button: there is nothing to press.
    const ATTR_ICONS: Record<string, string> = {
      "auto-merge":
        '<circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/>' +
        '<circle cx="12" cy="8" r="1.5"/><path d="M4 5v6M4 8h6.5"/>',
      draft: '<path d="M3 13l.7-3L11 2.7 13.3 5 6 12.3z"/>',
      bot:
        '<rect x="2.5" y="5" width="11" height="8" rx="2"/>' +
        '<path d="M8 2.5V5M5.8 8.5v1M10.2 8.5v1"/>',
      behind: '<path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3.5 13.5h9"/>',
      "auto-update": '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/>',
    };
    function attrChip(name: string, label: string): HTMLElement {
      const chip = el("span", `attr-chip ${name}`);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("class", "attr-icon");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      svg.innerHTML = ATTR_ICONS[name] ?? "";
      chip.appendChild(svg);
      chip.appendChild(document.createTextNode(label));
      return chip;
    }

    // Marks a pull request whose automatic update is its own choice, not the
    // repo's. Words as well as a glyph, so it reads without colour.
    function autoUpdateChip(pr: PullRequestItem): HTMLElement | null {
      const label = autoUpdateBadge(pr.autoUpdate);
      return label ? attrChip("auto-update", label) : null;
    }

    // The chips of a row's attribute cluster, in one order: auto-merge, draft,
    // bot, out of date, auto-update. Draft and bot come from the fields the row
    // already has (a bot's pull request is the server's `kind: dependency`).
    // The Bots page is a bots-only overview, so its rows leave the bot chip
    // out: it would say the same on every row. The dialog keeps it.
    function attributeCluster(
      pr: PullRequestItem,
      showBot = true,
    ): HTMLElement {
      const cluster = el("div", "attr-cluster");
      const chips = [
        autoMergePill(pr),
        pr.draft ? attrChip("draft", "Draft") : null,
        showBot && pr.kind === "dependency" ? attrChip("bot", "Bot") : null,
        behindPill(pr),
        autoUpdateChip(pr),
      ];
      for (const chip of chips) if (chip) cluster.appendChild(chip);
      return cluster;
    }

    // An armed pull request that has stopped needs a person, so it reads as a
    // line led by the state, never by colour alone. One that is only waiting
    // is the row's waiting chip instead (#1229). Both forges send the status
    // (GitHub since #1293).
    function autoMergeStatusLine(pr: PullRequestItem): HTMLElement | null {
      if (pr.autoMerge?.state !== "stopped") return null;
      const line = el("span", `auto-merge-status ${pr.autoMerge.state}`);
      line.appendChild(el("strong", "", "Stopped: "));
      line.appendChild(document.createTextNode(pr.autoMerge.message));
      return line;
    }

    // The chip for an armed auto-merge that is waiting, with the button that
    // turns it off inside it. null when there is nothing to wait for, or the
    // row is settled.
    function autoMergeWaitChip(pr: PullRequestItem): HTMLElement | null {
      if (!pr.autoMerge) return null;
      const chip = autoMergeChip({
        state: pr.autoMerge.state,
        code: pr.autoMerge.code,
        message: pr.autoMerge.message,
        draft: pr.draft,
        forge: pr.forge,
        heldBy: pr.autoMergeHeldBy,
      });
      if (!chip) return null;
      const disarm = isSettled(pr) ? null : cancelAutoMergeCell(pr, true);
      return buildWaitChip(chip, {
        source: "auto-merge",
        subject: `${pr.repo}#${pr.number}`,
        button: disarm ?? undefined,
      });
    }

    // ---- stacked pull requests (#861) ----
    // The chip says where the pull request sits and what it waits for, in
    // words and an icon, never colour alone. Tapping it lists the stack. A
    // child also says it targets its parent's branch, which is why
    // auto-merge isn't offered; Merge's own reason comes from the server.
    function stackIcon(): SVGElement {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "12");
      svg.setAttribute("height", "12");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute(
        "d",
        "m12 2 10 5-10 5L2 7zM2 12l10 5 10-5M2 17l10 5 10-5",
      );
      svg.appendChild(path);
      return svg;
    }

    function stackInfo(item: PullRequestItem): HTMLElement {
      const stack = item.stack;
      const info = el("div", "stack-info");
      if (!stack) return info;
      const listId = `stack-members-${domSafeId(prKey(item))}`;

      const chip = el("button", "stack-chip");
      chip.setAttribute("type", "button");
      chip.setAttribute("aria-expanded", "false");
      chip.setAttribute("aria-controls", listId);
      chip.appendChild(stackIcon());
      chip.appendChild(
        el("span", "stack-pos", `Stack ${stack.position} of ${stack.size}`),
      );
      info.appendChild(chip);

      const waits = item.stackedOn
        ? `waits for #${item.stackedOn.number}`
        : (item.stackChildren?.length ?? 0) > 0
          ? "merges first"
          : "";
      if (waits) {
        const sep = el("span", "stack-sep", "·");
        sep.setAttribute("aria-hidden", "true");
        info.appendChild(sep);
        info.appendChild(el("span", "stack-wait", waits));
      }

      if (item.stackedOn) {
        const n = item.stackedOn.number;
        info.appendChild(
          el(
            "div",
            "stack-note",
            `Depends on #${n}. Targets #${n}'s branch, not main. Auto-merge is unavailable until it is retargeted to main.`,
          ),
        );
      }

      const list = el("ul", "stack-members");
      list.id = listId;
      list.hidden = true;
      for (const member of Stacks.stackMembers(item, allPRs)) {
        const li = el("li", member.number === item.number ? "this" : "");
        li.appendChild(el("span", "num", `#${member.number}`));
        li.appendChild(document.createTextNode(` ${member.title}`));
        if (member.number === item.number)
          li.appendChild(el("span", "stack-this", " (this one)"));
        list.appendChild(li);
      }
      info.appendChild(list);
      chip.addEventListener("click", () => {
        const open = list.hidden;
        list.hidden = !open;
        chip.setAttribute("aria-expanded", String(open));
      });
      return info;
    }

    // "chore(main): release 0.74.2" -> "0.74.2". Display only: whether a pull
    // request is a release is the server's `kind`, not this.
    function releaseVersion(title: string): string {
      return /\brelease\s+v?(\d+\.\d+\.\d+\S*)/i.exec(title)?.[1] ?? "";
    }

    // The details header (#1563) follows the row's three tiers, built by the
    // row's own builders so the two cannot drift: the CI slot and the merge
    // state first, the attributes (the row's cluster, then labels and the
    // release version) below the title. Fields the row has, nothing else, as
    // they were when the dialog opened.
    function detailsStatus(item: PullRequestItem): DetailsStatus {
      const state = el("div", "details-state");
      state.setAttribute("role", "group");
      state.setAttribute("aria-label", "Status when opened");
      const slot = el("div", "ci-slot");
      slot.appendChild(ciPill(item, false));
      state.appendChild(slot);
      // Mergeable draws nothing, as on the row.
      const merge = mergeStatusPill(item.mergeStatus, item.ci);
      if (merge) state.appendChild(merge);
      const attributes = attributeCluster(item);
      attributes.setAttribute("role", "group");
      attributes.setAttribute("aria-label", "Attributes when opened");
      // The row only flags a bot's pull request as out of date (it has an
      // Update branch button otherwise); the dialog keeps saying it for any.
      if (item.behind && !attributes.querySelector(".behind"))
        attributes.appendChild(attrChip("behind", "Out of date"));
      if (item.kind === "release") {
        const version = releaseVersion(item.title);
        if (version)
          attributes.appendChild(el("span", "attr-chip mono", `v${version}`));
      }
      for (const label of item.labels ?? [])
        attributes.appendChild(el("span", "attr-chip label", label.name));
      return { state, attributes };
    }

    // ---- the details dialog's footer (#943) ----
    // Every action the row offers, drawn by the row's own builders so there
    // is one implementation of each: the primary one first, the others, then
    // Close last. The status block under the header, the failure lines above
    // the footer and the buttons are rebuilt whenever the board renders or an
    // action's feedback changes, so the open dialog shows its own pull
    // request as it is now.

    // "Rerun failed checks" has no button on the row (it lives in the
    // pipeline dialog, next to the checks), so its in-flight state is kept
    // here, outside the footer's DOM like every other action's.
    type RerunState =
      | { phase: "requesting" }
      | {
          phase: "queued";
          // When the forge accepted it, and the pull request's updatedAt
          // then: a hold can't outlive ten minutes or the pull request
          // changing under it (a new commit, a rerun that failed again).
          queuedAt: number;
          updatedAt: string;
        }
      | {
          phase: "failed";
          message: string;
          details: FailureDetails;
        };
    const rerunState: Record<string, RerunState> = {};
    const RERUN_HOLD_MS = 10 * 60 * 1000;

    // The pull request as the last snapshot shows it. A dialog that opened
    // earlier holds an older copy, so staleness is judged from this one.
    function livePullRequest(item: {
      forge: string;
      repo: string;
      number: number;
    }): PullRequestItem | undefined {
      const key = prKey(item);
      return allPRs.find((p) => prKey(p) === key);
    }

    // A rerun the forge accepted is held until CI moves on (the pull request
    // stops reading failed or changes) or the hold runs out. The row, the
    // details dialog and the pipeline panel all read this one answer (#1941).
    // A pure read: evictRerunState does the deleting.
    function rerunQueued(item: PullRequestItem): boolean {
      const state = rerunState[prKey(item)];
      if (state?.phase !== "queued") return false;
      const live = livePullRequest(item);
      return (
        live !== undefined &&
        live.ci === "failure" &&
        live.updatedAt === state.updatedAt &&
        Date.now() - state.queuedAt <= RERUN_HOLD_MS
      );
    }

    // Forgets rerun state for pull requests no longer listed, and holds that
    // have been released. Run on each snapshot.
    function evictRerunState() {
      for (const key of Object.keys(rerunState)) {
        const state = rerunState[key];
        const live = allPRs.find((p) => prKey(p) === key);
        if (!live) delete rerunState[key];
        else if (state.phase === "queued" && !rerunQueued(live))
          delete rerunState[key];
      }
    }
    // A Hide that failed while the dialog was open: the page's own status
    // line is behind the modal, so the dialog shows and speaks it itself.
    const hideFailure: Record<string, string> = {};
    // A change to a pull request's automatic update that the server refused.
    const autoUpdateFailure: Record<string, string> = {};

    // The one rerun flow: the details dialog's button and the pipeline
    // panel's both call it. `onChange` lets the panel redraw its own control
    // in place after each state change.
    function doRerunChecks(item: PullRequestItem, onChange?: () => void) {
      const key = prKey(item);
      rerunState[key] = { phase: "requesting" };
      onChange?.();
      renderPRBoard();
      postRerunChecks(item)
        .then(() => {
          rerunState[key] = {
            phase: "queued",
            queuedAt: Date.now(),
            updatedAt: livePullRequest(item)?.updatedAt ?? item.updatedAt,
          };
          feedback.announce(
            "Rerun queued. The new results show after the next refresh.",
          );
        })
        .catch((err: ActionRequestError) => {
          feedback.announce(`Couldn't rerun the checks: ${err.message}`);
          rerunState[key] = {
            phase: "failed",
            message: err.message,
            details: failureDetails(err, {
              action: "rerun-checks",
              forge: item.forge,
              repo: item.repo,
              number: item.number,
            }),
          };
        })
        .finally(() => {
          onChange?.();
          renderPRBoard();
        });
    }

    // Offered where the server lists rerun_checks and something failed.
    function rerunChecksActionCell(item: PullRequestItem): HTMLElement | null {
      if (!findAction(item, "rerun_checks") || item.ci !== "failure")
        return null;
      const proactiveReason = proactiveActionLockReason(item.forge);
      if (readOnlyBecauseRateLimited(proactiveReason)) return null;
      if (proactiveReason)
        return lockedActionButton("Rerun failed checks", proactiveReason);
      const phase = rerunQueued(item)
        ? "queued"
        : rerunState[prKey(item)]?.phase;
      const button = buttonEl(
        "row-action",
        phase === "requesting"
          ? "Queuing the rerun…"
          : phase === "queued"
            ? "Rerun queued"
            : "Rerun failed checks",
      );
      button.type = "button";
      markPending(button, phase === "requesting" || phase === "queued");
      button.addEventListener("click", () => {
        if (isPending(button)) return;
        doRerunChecks(item);
      });
      return button;
    }

    // A failure the feedback store doesn't hold (a rerun, a Hide), in the
    // same line as any other action's failure. Visible text only: it was
    // announced once when it happened.
    function plainFailureLine(
      item: PullRequestItem,
      text: string,
      details: FailureDetails | undefined,
      onDismiss: () => void,
    ): HTMLElement {
      const line = el("div", "row-feedback-line");
      line.dataset.phase = "failed";
      line.appendChild(el("span", "row-feedback-text", text));
      if (details)
        line.appendChild(copyButton(details, "row-action row-feedback-copy"));
      const dismiss = buttonEl("row-action row-feedback-dismiss", "Dismiss");
      dismiss.type = "button";
      dismiss.setAttribute(
        "aria-label",
        `Dismiss failure for ${item.repo}#${item.number}`,
      );
      dismiss.addEventListener("click", () => {
        onDismiss();
        renderPRBoard();
      });
      line.appendChild(dismiss);
      return line;
    }

    function ownFailureLines(item: PullRequestItem): HTMLElement[] {
      const key = prKey(item);
      const lines: HTMLElement[] = [];
      const rerun = rerunState[key];
      if (rerun?.phase === "failed")
        lines.push(
          plainFailureLine(
            item,
            `Failed: couldn't rerun the checks: ${rerun.message}`,
            rerun.details,
            () => delete rerunState[key],
          ),
        );
      if (autoUpdateFailure[key])
        lines.push(
          plainFailureLine(item, autoUpdateFailure[key], undefined, () => {
            delete autoUpdateFailure[key];
          }),
        );
      if (hideFailure[key])
        lines.push(
          plainFailureLine(item, hideFailure[key], undefined, () => {
            delete hideFailure[key];
          }),
        );
      return lines;
    }

    // The footer's buttons in order. A pull request found merged or closed
    // has nothing left to do, as on the row.
    function footerActionCells(item: PullRequestItem): HTMLElement[] {
      if (isSettled(item)) {
        const badge = mergeActionCell(item);
        return badge ? [badge] : [];
      }
      const named: [ActionName, () => HTMLElement | null][] = [
        ["merge", () => mergeActionCell(item)],
        ["update_branch", () => updateBranchActionCell(item)],
        ["dependabot_rebase", () => dependabotRebaseCell(item)],
        [
          "dependabot_recreate",
          () =>
            findAction(item, "dependabot_recreate")
              ? dependabotActionButton(item, "recreate")
              : null,
        ],
        ["renovate_rebase", () => renovateRebaseActionCell(item)],
        ["auto_merge", () => autoMergeActionCell(item)],
        ["cancel_auto_merge", () => cancelAutoMergeCell(item)],
        ["rerun_checks", () => rerunChecksActionCell(item)],
      ];
      const primary = primaryAction(item)?.action;
      const first: HTMLElement[] = [];
      const rest: HTMLElement[] = [];
      for (const [action, build] of named) {
        const cell = build();
        if (!cell) continue;
        if (action === primary) {
          cell.classList.add("details-action-primary");
          first.push(cell);
        } else rest.push(cell);
      }
      const queueCell = queueActionCell(item);
      if (queueCell) rest.push(queueCell);
      rest.push(...hideActionCells(item));
      const close = closeActionCell(item);
      if (close) {
        close.classList.add("details-action-close");
        if (primary === "close") close.classList.add("details-action-primary");
      }
      const cells = [...first, ...rest, ...(close ? [close] : [])];
      const holder = el("div");
      for (const cell of cells) holder.appendChild(cell);
      dedupeRetryButtons(holder);
      return Array.from(holder.children) as HTMLElement[];
    }

    function dialogChrome(item: PullRequestItem | undefined): DetailsChrome {
      if (!item) {
        const gone = el(
          "p",
          "status-area details-gone",
          "This pull request is no longer on the board. It may have been merged, closed or hidden.",
        );
        return { status: gone, feedback: null, option: null, actions: [] };
      }
      const key = prKey(item);
      const lines = feedbackUI.inlineLines(key);
      const own = ownFailureLines(item);
      let feedbackNode = lines;
      if (own.length > 0) {
        feedbackNode = lines ?? el("div", "row-feedback");
        for (const line of own) feedbackNode.appendChild(line);
      }
      return {
        status: isSettled(item) ? null : statusArea(item, false),
        feedback: feedbackNode,
        option: autoUpdateOption(item),
        actions: footerActionCells(item),
      };
    }

    // A merged pull request has nothing left to act on or read about, so a
    // dialog open on it closes (#1927).
    function closeDialogOf(key: string) {
      if (dialogKey === key) detailsDialog?.close();
    }

    // The pull request's updatedAt when the dialog last fetched its details:
    // a later one means a comment, an edit or a reaction landed.
    let dialogUpdatedAt = "";

    let lastChromeSig = "";
    let lastChromeItem: PullRequestItem | undefined;

    // Draws the open dialog's footer area from the board's current copy of
    // its pull request. Skipped when nothing in it changed, so a poll that
    // changes another row neither redraws nor moves focus.
    function refreshDialogChrome() {
      if (dialogKey === null || !detailsDialog) return;
      const item = dialogGone
        ? undefined
        : (prBoard.find(dialogKey) as PullRequestItem | undefined);
      idScope = DIALOG_ID_SCOPE;
      let chrome: DetailsChrome;
      try {
        chrome = dialogChrome(item);
      } finally {
        idScope = "";
      }
      const sig = [
        chrome.status?.outerHTML,
        chrome.feedback?.outerHTML,
        chrome.option?.outerHTML,
        ...chrome.actions.map((a) => a.outerHTML),
      ].join("\n");
      if (sig === lastChromeSig && item === lastChromeItem) return;
      lastChromeSig = sig;
      lastChromeItem = item;

      // Where focus is in the footer, to put it back on the same control
      // once the buttons are new nodes (a click that changes a button's own
      // label, a refused action, the confirm step arriving or leaving).
      const host = detailsDialog.actionsElement();
      const active = document.activeElement;
      const here =
        host && active instanceof HTMLElement && host.contains(active)
          ? {
              id: active.id,
              className: active.className,
              text: active.textContent,
              index: Array.from(host.querySelectorAll("button")).indexOf(
                active as HTMLButtonElement,
              ),
            }
          : null;
      // The same for the update option, whose controls are not buttons in
      // the actions: put focus back on the one it was on, by id.
      const optionHost = detailsDialog.optionElement();
      const optionFocusId =
        optionHost &&
        document.activeElement instanceof HTMLElement &&
        optionHost.contains(document.activeElement)
          ? document.activeElement.id
          : "";
      detailsDialog.setChrome(chrome);
      if (optionFocusId) {
        const back = optionHost?.querySelector<HTMLElement>(
          `[id="${optionFocusId}"]`,
        );
        (back ?? optionHost?.querySelector<HTMLElement>("input"))?.focus();
        return;
      }
      if (!here || !host) return;
      const buttons = Array.from(host.querySelectorAll("button"));
      const back =
        (here.id ? buttons.find((b) => b.id === here.id) : undefined) ??
        buttons.find(
          (b) => b.className === here.className && b.textContent === here.text,
        ) ??
        buttons[Math.min(Math.max(here.index, 0), buttons.length - 1)];
      if (back) back.focus();
      else detailsDialog.focusClose();
    }

    function openDetailsDialog(item: PullRequestItem, triggerId: string) {
      dialogKey = prKey(item);
      dialogGone = false;
      lastChromeSig = "";
      lastChromeItem = undefined;
      dialogUpdatedAt = item.updatedAt;
      detailsDialog?.open({ ...item, status: detailsStatus(item) }, triggerId);
      refreshDialogChrome();
    }

    // An issue opens the same dialog as a pull request, with nothing in the
    // footer but the link to the forge: there is no action on an issue. The
    // board's dialog state (dialogKey) stays null, so a poll neither redraws
    // its footer nor reloads it.
    function openIssueDialog(item: IssueItem, triggerId: string) {
      dialogKey = null;
      dialogGone = false;
      lastChromeSig = "";
      lastChromeItem = undefined;
      detailsDialog?.setChrome({
        status: null,
        feedback: null,
        option: null,
        actions: [],
      });
      detailsDialog?.open(
        { ...item, subject: "issue", status: issueStatus(item) },
        triggerId,
      );
    }

    // The issue header: it is open (the board lists open issues only), and
    // its labels as the pull request header shows them.
    function issueStatus(item: IssueItem): DetailsStatus {
      const state = el("div", "details-state");
      state.setAttribute("role", "group");
      state.setAttribute("aria-label", "Status when opened");
      state.appendChild(el("span", "attr-chip", "Open"));
      const attributes = el("div", "attr-cluster");
      attributes.setAttribute("role", "group");
      attributes.setAttribute("aria-label", "Labels when opened");
      for (const label of item.labels ?? [])
        attributes.appendChild(el("span", "attr-chip label", label.name));
      return { state, attributes };
    }

    // An armed confirm in the footer ends on the first Escape, and goes
    // with the dialog when it closes.
    escapeDetails = () => confirmArm.disarm("escape");
    detailsClosed = () => {
      if (dialogKey !== null) {
        // A queued or in-flight rerun outlives the dialog; only a failure line goes.
        if (!["queued", "requesting"].includes(rerunState[dialogKey]?.phase))
          delete rerunState[dialogKey];
        delete hideFailure[dialogKey];
        delete autoUpdateFailure[dialogKey];
      }
      dialogKey = null;
      if (confirmArm.disarm("dropped")) renderPRBoard();
      // The dialog hands focus back to its row. When that row left the board
      // while it was open, focus would fall to the page: put it on the first
      // row, or the list itself, instead.
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        const first = document.querySelector<HTMLElement>(
          "#pr-rows button.title",
        );
        const list = document.getElementById("pr-rows");
        if (first) first.focus();
        else if (list) {
          list.tabIndex = -1;
          list.focus();
        }
      }, 0);
    };

    function buildRow(
      item: PullRequestItem | IssueItem,
      isPR: boolean,
      onLabelClick: (name: string) => void,
      activeLabel: string,
    ): HTMLElement {
      const row = el("div", "row");

      row.appendChild(repoCell(item));
      const titleCellEl = titleCell(
        item,
        onLabelClick,
        activeLabel,
        isPR
          ? (triggerId) => openDetailsDialog(item as PullRequestItem, triggerId)
          : (triggerId) => openIssueDialog(item as IssueItem, triggerId),
      );
      row.appendChild(titleCellEl);
      if (!isPR) row.dataset.issueKey = prKey(item);
      if (isPR && (item as PullRequestItem).stack)
        titleCellEl.appendChild(stackInfo(item as PullRequestItem));
      // The Releases page shows the version being released, and says why a
      // behind release needs Update branch from a person (#1107).
      if (isPR && view === "releases") {
        const version = releaseVersion(item.title);
        if (version)
          titleCellEl.appendChild(
            el("span", "release-version mono", `v${version}`),
          );
        if ((item as PullRequestItem).behind)
          titleCellEl.appendChild(
            el(
              "p",
              "release-behind-note",
              "Behind the base branch. release-please won't update this pull request until a releasable change lands, so Update branch brings it up to date.",
            ),
          );
      }
      if (isPR) {
        row.dataset.prKey = prKey(item);
        if (updatedMarkers.has(prKey(item)))
          titleCellEl.appendChild(
            el("span", "updated-just-now", "Updated just now"),
          );
      }

      const meta = el("div", "row-meta");
      const authorCell = el("div", "author", item.author);
      const avatar = avatarSrc(
        (item as PullRequestItem | IssueItem).authorAvatarUrl,
      );
      if (avatar) {
        // Decorative: the name beside it already says who. A failed load
        // drops the image and leaves the name alone.
        const img = el("img", "author-avatar") as HTMLImageElement;
        img.src = avatar;
        img.alt = "";
        img.width = 20;
        img.height = 20;
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.addEventListener("error", () => {
          img.remove();
          authorCell.classList.remove("has-avatar");
        });
        authorCell.classList.add("has-avatar");
        authorCell.replaceChildren(img, el("span", "author-name", item.author));
      }
      // The avatar and the name are one link to the person's page on the
      // forge, not two links to the same place. It sits above the row's
      // stretched title link, so clicking it never opens the row's dialog.
      const profile = profileHref(
        (item as PullRequestItem | IssueItem).authorUrl,
      );
      if (profile) {
        const link = el("a", "author-link") as HTMLAnchorElement;
        link.href = profile;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        // No aria-label: the link's name is the visible name, as WCAG 2.5.3
        // (label in name) and the person's own name ask.
        link.append(...Array.from(authorCell.childNodes));
        authorCell.replaceChildren(link);
      }
      meta.appendChild(authorCell);
      meta.appendChild(timeCell("created", "Created", item.createdAt));
      meta.appendChild(timeCell("updated", "Updated", item.updatedAt));
      if (isPR) {
        const pr = item as PullRequestItem;
        // One cell, possibly several pills — keeps .row's fixed
        // grid-template-columns unchanged regardless of how many of
        // them this particular row has anything to say.
        const statusCell = el("div", "status-cell");
        // The action area's reserved slot: the waiting chip lives here, so
        // it comes and goes without moving the row (#1229).
        const waitSlot = el("div", "wait-slot");
        const autoMergeWait = autoMergeWaitChip(pr);
        if (autoMergeWait) waitSlot.appendChild(autoMergeWait);
        else {
          const queuedWait = queuedWaitChip(pr);
          if (queuedWait) waitSlot.appendChild(queuedWait);
        }
        statusCell.appendChild(waitSlot);
        const mergeAction = mergeActionCell(pr);
        // The CI slot (state and outcome, fixed size) and the attribute
        // cluster, side by side (#1563).
        const stateGroup = el("div", "state-group");
        const ciSlot = el("div", "ci-slot");
        ciSlot.appendChild(ciPill(pr));
        stateGroup.appendChild(ciSlot);
        stateGroup.appendChild(attributeCluster(pr, view !== "bots"));
        statusCell.appendChild(stateGroup);
        const approveLink = approveOnGithubLink(pr);
        if (approveLink) statusCell.appendChild(approveLink);
        const conflictPill = mergeStatusPill(pr.mergeStatus, pr.ci);
        if (conflictPill) statusCell.appendChild(conflictPill);
        const reviewActivity = reviewPill(pr);
        if (reviewActivity) statusCell.appendChild(reviewActivity);
        const mergeStatusLine = autoMergeStatusLine(pr);
        if (mergeStatusLine) statusCell.appendChild(mergeStatusLine);

        // Found already merged or closed: the badge replaces Merge, and
        // nothing else on the row has anything left to do.
        const settledRow = isSettled(pr);
        // What it is waiting on, in its own place above the actions (#1375).
        const statusAreaEl = settledRow ? null : statusArea(pr);
        if (statusAreaEl) statusCell.appendChild(statusAreaEl);
        // The row draws one control: the action the server marked primary,
        // or, while Merge is locked, the greyed Merge with its reason. Every
        // other action is in the details pop-up's footer, built by the same
        // functions (#943).
        const rowAction = rowActionCell(pr, settledRow, mergeAction);
        // In a bar of its own: on a phone it is the card's last tier, after a
        // divider; on a wider screen the bar adds no box of its own.
        if (rowAction) {
          const bar = el("div", "row-action-bar");
          bar.appendChild(rowAction);
          statusCell.appendChild(bar);
        }
        // A refused Close locks a button that lives in the pop-up, so the row
        // says so in words, or nobody would find it without opening it.
        const closeCue = settledRow ? null : closeLockCue(pr);
        if (closeCue) statusCell.appendChild(closeCue);
        const queueCell = queueActionCell(pr);
        if (queueCell) statusCell.appendChild(queueCell);
        dedupeRetryButtons(statusCell);
        meta.appendChild(statusCell);
      } else {
        meta.appendChild(el("div", "empty-cell"));
      }
      row.appendChild(meta);
      row.appendChild(el("div", "go", "→"));
      if (isPR) feedbackUI.decorateRow(row, prKey(item as PullRequestItem));
      return row;
    }

    // The lasting state of a Close the forge refused (a missing permission, a
    // rate limit). The locked button is in the pop-up's footer, so a row whose
    // pop-up was closed would show nothing. This is the same note a locked
    // Merge prints on the row: words, never colour alone, the reason beside
    // the label so it is read without opening anything. It leaves when the
    // lock does (the line that explains it is dismissed, or the next snapshot
    // clears a stale lock), and is skipped while Close is the row's own
    // action, whose locked button already says why.
    function closeLockCue(item: PullRequestItem): HTMLElement | null {
      const entry = closeState[prKey(item)];
      if (!entry || entry.phase !== "locked") return null;
      if (primaryAction(item)?.action === "close") return null;
      const cue = el("span", "row-lock-cue row-action-note");
      cue.appendChild(el("span", "row-action-note-reason", "Close locked"));
      if (entry.reason)
        cue.appendChild(el("span", "row-action-note-next", entry.reason));
      return cue;
    }

    // The one control a row draws beside its status. A settled row keeps the
    // merged or closed badge. Otherwise it is the server's primary action
    // (the same one the footer lists first), or, with no primary and Merge
    // locked, the greyed Merge with its reason. A pull request with no
    // primary and no locked Merge has no action on the row; its other
    // actions are in the pop-up. The "Behind the base branch" cure is
    // drawn inside the status block, so the row never repeats it.
    function rowActionCell(
      pr: PullRequestItem,
      settledRow: boolean,
      mergeAction: HTMLElement | null,
    ): HTMLElement | null {
      if (settledRow) return mergeAction;
      const primary = primaryAction(pr)?.action;
      const fix = statusFixName(pr);
      switch (primary) {
        case "merge":
          return mergeAction;
        case "update_branch":
          return fix === "update_branch" ? null : updateBranchActionCell(pr);
        case "dependabot_rebase":
          return fix === "dependabot_rebase" || dependabotRebaseHidden(pr)
            ? null
            : dependabotActionButton(pr, "rebase");
        case "renovate_rebase":
          return fix === "renovate_rebase"
            ? null
            : renovateRebaseActionCell(pr);
        case "close":
          return closeActionCell(pr);
        case undefined:
          // A Renovate rebase that is already waiting keeps its locked
          // button: it says what the pull request is waiting on. Otherwise a
          // locked Merge reads as the row's only button.
          if (findAction(pr, "renovate_rebase")?.blocked)
            return fix === "renovate_rebase"
              ? null
              : renovateRebaseActionCell(pr);
          if (findAction(pr, "merge")?.blocked) return mergeAction;
          return null;
        default:
          return null;
      }
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

    // The details dialog's footer is built by the row's own builders, so the
    // same ids would be on the page twice. While the footer is being built
    // idScope is the dialog's prefix, and every id a builder makes or looks
    // up starts with it; the builders keep the value they were built with,
    // so a click finds the right one later (#943).
    const DIALOG_ID_SCOPE = "dlg-";
    let idScope = "";

    // The prefix to look a button up by when nothing is being built: the
    // dialog's while it is open (it is modal, so it is where the user is),
    // the row's otherwise.
    function activeScope(): string {
      return dialogKey !== null ? DIALOG_ID_SCOPE : "";
    }

    // Forgejo has no auto-merge this app can read, so Forge Dashboard does
    // the merging itself. Said once under each Forgejo group heading, with a
    // way to the full explanation.
    function groupAutoMergeCallout(forgeName: string): HTMLElement | null {
      if (forgeName !== "forgejo") return null;
      const note = el(
        "p",
        "group-callout",
        "Auto-merge on Forgejo is handled by Forge Dashboard, not Forgejo itself. Manage it in ",
      );
      const link = el("a", "", "Settings") as HTMLAnchorElement;
      link.href = "/settings.html#forgejo-auto-merge";
      note.appendChild(link);
      note.appendChild(document.createTextNode("."));
      return note;
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
    // Why an action is locked, and the code that says what kind of wait it is
    // when one is known: "rate_limited" and "permission" don't clear by
    // clicking; anything else may.
    type LockInfo = { reason: string; code?: string };

    function lockOf(entry: ActionState): LockInfo {
      return { reason: entry.reason ?? "", code: entry.code };
    }

    function lockedActionButton(
      label: string,
      lock: string | LockInfo,
      requestedRetry: (() => void) | undefined = undefined,
      visibleNote: string | undefined = undefined,
      // The element that already says why, on the row (#1375): the button is
      // described by it, and prints no note or tooltip of its own.
      describedBy: string | undefined = undefined,
    ): HTMLElement {
      const reasonText = typeof lock === "string" ? lock : lock.reason;
      const code = typeof lock === "string" ? undefined : lock.code;
      // In the dialog's footer the reason is printed, not left to a hover
      // bubble the footer's edge would clip.
      if (idScope !== "" && visibleNote === undefined && !describedBy)
        visibleNote = "";
      // Retry only for a reason waiting can fix (a 502, an unreachable
      // forge). A rate limit or a missing permission can't clear by
      // clicking, so it stays a greyed-out action with its own label
      // (#732). The refusal's code says which, not its wording (#806).
      const onRetry =
        code === "rate_limited" || code === "permission"
          ? undefined
          : requestedRetry;
      const wrap = el("span", "row-action-locked");
      const button = buttonEl("row-action", onRetry ? "Retry" : label);
      button.type = "button";
      const reasonId =
        describedBy ?? `action-locked-reason-${actionLockReasonCounter++}`;
      button.setAttribute("aria-describedby", reasonId);
      if (onRetry) {
        button.addEventListener("click", onRetry);
      } else {
        button.setAttribute("aria-disabled", "true");
      }
      wrap.appendChild(button);
      if (describedBy) return wrap;
      if (visibleNote !== undefined) {
        // The reason is the point of this button (Merge waiting on CI,
        // #705), so it's printed beside it instead of floating as a
        // hover/focus bubble. Still the aria-describedby target, so the
        // accessible description is unchanged. A second line, when given,
        // says what happens next.
        wrap.classList.add("row-action-locked-visible");
        const note = el("span", "row-action-note");
        note.id = reasonId;
        note.appendChild(el("span", "row-action-note-reason", reasonText));
        if (visibleNote)
          note.appendChild(el("span", "row-action-note-next", visibleNote));
        wrap.appendChild(note);
        return wrap;
      }
      // Purely decorative -- the real explanation is already reachable via
      // aria-describedby regardless of whether this renders, so it never
      // gets its own accessible name (aria-hidden) or duplicates the
      // reason for a screen reader. Its only job is signaling to a
      // sighted mouse/keyboard user that hovering or focusing this button
      // reveals more: nothing about a plain greyed-out button otherwise
      // suggests that, and the reason bubble itself stays invisible until
      // that happens (row-action-reason's own opacity:0 default).
      const hint = el("span", "row-action-locked-hint", "i");
      hint.setAttribute("aria-hidden", "true");
      wrap.appendChild(hint);
      const reason = el("span", "row-action-reason", reasonText);
      reason.id = reasonId;
      reason.setAttribute("role", "tooltip");
      wrap.appendChild(reason);
      return wrap;
    }

    // #516 regressed by #573: that PR dropped the per-row reason-text
    // dedup on the theory that hiding the reason behind hover/focus meant
    // "the same clutter can't happen" -- true for the text, but it missed
    // that Merge/Update-branch/Close all render the *button itself* as
    // the generic label "Retry" (lockedActionButton's onRetry branch)
    // whenever they're locked, so two of them sharing one forge-wide
    // reason are two pixel-identical, always-visible buttons regardless
    // of whether the reason text under them is deduped. Confirmed live,
    // screenshot against alrayyes/alrayyes.github.io#17.
    //
    // Scoped to buttons whose visible label is literally "Retry" --
    // Dependabot/Renovate's own locked actions keep their distinct labels
    // (Rebase/Recreate) and are never touched, since #517's original
    // design deliberately kept those visible even sharing a reason: they
    // aren't confusable with each other the way two "Retry"s are.
    function dedupeRetryButtons(statusCell: HTMLElement) {
      const seenReasons = new Set<string>();
      for (const locked of Array.from(
        statusCell.querySelectorAll<HTMLElement>(".row-action-locked"),
      )) {
        const button = locked.querySelector<HTMLButtonElement>(".row-action");
        if (button?.textContent !== "Retry") continue;
        const reasonText =
          locked.querySelector<HTMLElement>(".row-action-reason")
            ?.textContent ?? "";
        if (!reasonText) continue;
        if (seenReasons.has(reasonText)) {
          locked.remove();
        } else {
          seenReasons.add(reasonText);
        }
      }
    }

    // Clears every "locked for good" entry in a merge/update-branch
    // state map — called on every fresh snapshot (applySnapshot), so a
    // lock only ever reflects the most recent data instead of latching
    // until a full page reload. Leaves in-flight phases
    // ('confirming', 'merging', 'queued') alone; those track a request
    // actually in progress, not a stale conclusion from a previous one.
    function clearStaleLocks(stateMap: Record<string, ActionState>) {
      for (const key of Object.keys(stateMap)) {
        const entry = stateMap[key];
        if (entry.phase === "locked" && !holdsPermissionLock(entry))
          delete stateMap[key];
      }
    }

    // A permission refusal doesn't come from the snapshot, so a snapshot
    // can't re-derive it. It stands while the failure line that explains it
    // does, and Dismiss (or acting on the row again) frees the action (#918).
    function holdsPermissionLock(entry: ActionState): boolean {
      return (
        entry.phase === "locked" &&
        entry.code === "permission" &&
        feedback
          .entries()
          .some((e) => e.actionKey === entry.fkey && e.phase === "failed")
      );
    }

    // Dismissing the line frees its action at once, without waiting for the
    // next snapshot to redraw the row. (Subscribed below.)
    function releaseDismissedPermissionLocks(): boolean {
      let released = false;
      for (const stateMap of [
        mergeState,
        closeState,
        updateBranchState,
        autoMergeState,
        dependabotActionState,
        renovateRebaseState,
      ]) {
        for (const key of Object.keys(stateMap)) {
          const entry = stateMap[key];
          if (
            entry.phase === "locked" &&
            entry.code === "permission" &&
            !holdsPermissionLock(entry)
          ) {
            delete stateMap[key];
            released = true;
          }
        }
      }
      return released;
    }

    feedback.subscribe(() => {
      if (releaseDismissedPermissionLocks()) renderPRBoard();
      else refreshDialogChrome();
    });

    // The "Retry" click every locked merge/update-branch button now has
    // — re-fetches the dashboard for real (not from a cache) so the
    // lock re-derives from current data immediately instead of waiting
    // out the rest of the poll interval.
    function retryLockedAction(item: PullRequestItem) {
      refreshDashboardNow().catch((err: Error) => {
        showError(`Could not refresh: ${err.message}`);
      });
    }

    // Known-doomed before ever calling the API, the same pre-click check
    // addWebhookButton (webhooks.js) already does from ForgeHealth — a
    // forge that's currently unreachable or already out of rate-limit
    // budget will fail the exact same way after a real, wasted request
    // as it would before one.
    function proactiveActionLockReason(
      forgeName: string,
      budget: "rest" | "graphql" = "rest",
    ): LockInfo | null {
      const health = lastForges.find((f) => f.forge === forgeName);
      if (health && health.reachable === false) {
        // The forge can't be reached, so nothing here can work (#1199). The
        // controls are not drawn (see readOnlyBecauseRateLimited), and one
        // banner says why, once (#360, #755).
        return {
          reason: "This forge can't be reached right now.",
          code: "forge_unreachable",
        };
      }
      // #361: Merge, Update branch, Close and the bot commands are REST
      // calls, so REST's budget decides them; auto-merge is a GraphQL
      // mutation and asks for that budget instead. The two are separate
      // allowances, and one saying nothing about the other would leave a
      // row looking clickable until the click itself failed.
      const spent =
        health?.[budget === "rest" ? "rateLimitREST" : "rateLimitGraphQL"];
      if (isRateLimited(spent))
        return {
          reason: rateLimitedReason(forgeName, spent),
          code: "rate_limited",
        };
      return null;
    }

    // A forge whose budget is spent, or that can't be reached, is read-only
    // (#755, #1199): the controls that need it are not drawn at all, instead
    // of greyed out on every row. One banner says so once. A lock from a
    // failed click (a 429 the snapshot hadn't shown yet) still draws, with
    // its reason.
    function readOnlyBecauseRateLimited(reason: LockInfo | null): boolean {
      return (
        reason?.code === "rate_limited" || reason?.code === "forge_unreachable"
      );
    }

    // "GitHub API rate limit reached. Actions resume at 14:32 (in 12
    // min)." Built fresh from the latest snapshot, so a 429 from a click
    // reads the same as a budget the snapshot already showed spent (#732).
    function rateLimitedReason(forgeName: string, known?: RateLimit): string {
      const health = lastForges.find((f) => f.forge === forgeName);
      const limit =
        known ??
        [health?.rateLimitREST, health?.rateLimitGraphQL].find(
          (l) => l && Date.parse(l.resetsAt) > Date.now(),
        );
      return rateLimitReasonText(
        FORGE_LABELS[forgeName] || forgeName,
        limit?.resetsAt,
      );
    }

    function isSettled(item: PullRequestItem): boolean {
      const phase = mergeState[prKey(item)]?.phase;
      return phase === "merged" || phase === "closed";
    }

    // Renders the server's answer to a refused action (#751): the same for
    // Merge, Close, Update branch, auto-merge and the bot rebases. The
    // server re-read the pull request and said why (its code); this only
    // shows it. A pull request found merged or closed settles the whole
    // row, whichever button was clicked. setState stores the action's own
    // locked or idle state; retryable names codes that pass by themselves.
    function renderActionRefusal(
      item: PullRequestItem,
      err: ActionRequestError,
      fkey: string,
      what: string,
      setState: (next: ActionState) => void,
      retryable?: ReadonlySet<ActionCode>,
      actionName?: string,
    ) {
      // The raw answer for Copy, made once for whichever line this ends in.
      const details = failureDetails(
        err,
        detailsContext(item, fkey, actionName),
      );
      const outcome = interpretActionFailure(
        err,
        (resetsAt) =>
          resetsAt
            ? rateLimitReasonText(
                FORGE_LABELS[item.forge] || item.forge,
                resetsAt,
              )
            : rateLimitedReason(item.forge),
        retryable,
      );
      if (outcome.kind === "settled") {
        setState({ phase: "idle" });
        mergeState[prKey(item)] = { phase: outcome.state };
        if (outcome.state === "merged") closeDialogOf(prKey(item));
        showSettled(feedback, fkey, actionRef(item), outcome);
        // Same immediate refresh the success path makes, so the row
        // drops off the open list as soon as the forge shows it.
        refreshDashboardNow().catch(() => renderPRBoard());
        renderPRBoard();
        return;
      }
      if (outcome.kind === "locked") {
        // A refusal is about this action on this pull request, not every
        // action on the forge: a fine-grained token can lack one permission
        // (Workflows, say) and have the rest (#918). A permission lock is
        // kept, with the line that explains it, until that line is
        // dismissed; see clearStaleLocks.
        setState({
          phase: "locked",
          reason: outcome.reason,
          code: outcome.code,
          fkey,
        });
        failAction(fkey, what, outcome.reason, false, false, details);
      } else {
        setState({ phase: "idle" });
        failAction(
          fkey,
          what,
          outcome.reason,
          true,
          outcome.transient,
          details,
        );
      }
      renderPRBoard();
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
      const fkey = `merge:${key}`;
      feedback.start({
        actionKey: fkey,
        ref: actionRef(item),
        label: "Merge",
        kind: "merge",
        phase: "working",
        inline: "Merging…",
        message: "Merging…",
        announce: "Merging…",
        // A merge is never re-sent without the confirm step.
        retry: () => {
          feedback.drop(fkey);
          armConfirm("merge", item);
          renderPRBoard();
          document
            .getElementById(`${activeScope()}merge-confirm-${domSafeId(key)}`)
            ?.focus();
        },
      });

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
          return readActionFailure(res).then((err) => {
            throw err;
          });
        })
        .then(() => {
          delete mergeState[key];
          closeDialogOf(key);
          feedback.update(fkey, {
            phase: "done",
            message: "Merged.",
            toast: true,
            announce: "Merged.",
          });
          // Pulls a fresh snapshot right away rather than waiting out
          // the rest of the background poll's own interval — the same
          // call the "Refresh now" button makes — so the just-merged PR
          // drops off the board as soon as the forge itself reflects
          // the merge.
          return fetch(withDrafts("/api/dashboard/refresh"), {
            method: "POST",
            headers: { Accept: "application/json" },
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (data) applySnapshot(data, true);
            });
        })
        .catch((err: ActionRequestError) => {
          // A raw network failure (no HTTP status at all — the fetch
          // itself rejected, not just a non-204 response) is genuinely
          // ambiguous: the request might have reached the backend and
          // the merge might have gone through even though no response
          // ever made it back to this tab. Reported live: forge-
          // dashboard's own backend can restart mid-request (a redeploy
          // the merge itself can trigger) and the browser sees exactly
          // this. Verify against a fresh refresh before declaring
          // failure, rather than trusting an ambiguous error at face
          // value — the same resilience doUpdateBranch's own fix
          // (#447) already applies to its own ambiguous-outcome case.
          if (err.status === undefined) {
            fetch(withDrafts("/api/dashboard/refresh"), {
              method: "POST",
              headers: { Accept: "application/json" },
            })
              .then((res) => (res.ok ? res.json() : null))
              .then((data) => {
                const stillThere = (data?.pullRequests || []).some(
                  (p: PullRequestItem) => prKey(p) === key,
                );
                if (data && !stillThere) {
                  // Gone from the board — the merge almost certainly
                  // went through despite the network error, so this
                  // reports as the same success the happy path does
                  // rather than a false failure.
                  delete mergeState[key];
                  closeDialogOf(key);
                  applySnapshot(data, true);
                  feedback.update(fkey, {
                    phase: "done",
                    message: "Merged.",
                    toast: true,
                    announce: "Merged.",
                  });
                  return;
                }
                mergeState[key] = { phase: "idle" };
                if (data) {
                  applySnapshot(data, true);
                } else {
                  renderPRBoard();
                }
                failAction(
                  fkey,
                  "merge",
                  NETWORK_FAILURE,
                  true,
                  true,
                  failureDetails(err, detailsContext(item, fkey)),
                );
              })
              .catch(() => {
                mergeState[key] = { phase: "idle" };
                failAction(
                  fkey,
                  "merge",
                  NETWORK_FAILURE,
                  true,
                  true,
                  failureDetails(err, detailsContext(item, fkey)),
                );
                renderPRBoard();
              });
            return;
          }

          renderActionRefusal(item, err, fkey, "merge", (next) => {
            mergeState[key] = next;
          });
        });
    }

    // The one place on a row that says what the pull request is waiting on or
    // blocked by (#1375). Text and an icon, never colour alone. A locked Merge
    // is described by it, so it is read without hovering.
    function statusAreaId(item: PullRequestItem): string {
      return `${idScope}status-area-${domSafeId(prKey(item))}`;
    }

    // The pop-up passes withFix false: its footer already lists every action.
    function statusArea(
      item: PullRequestItem,
      withFix = true,
    ): HTMLElement | null {
      const status = item.status;
      if (!status) return null;
      const area = el("div", "status-area");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "14");
      svg.setAttribute("height", "14");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.setAttribute("aria-hidden", "true");
      const circle = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle",
      );
      circle.setAttribute("cx", "12");
      circle.setAttribute("cy", "12");
      circle.setAttribute("r", "10");
      const mark = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      mark.setAttribute("d", "M12 16v-4M12 8h.01");
      svg.appendChild(circle);
      svg.appendChild(mark);
      area.appendChild(svg);
      const text = el("span", "status-area-text");
      // Merge is described by the words alone, never by the button beside them.
      text.id = statusAreaId(item);
      text.appendChild(el("span", "status-area-message", status.message));
      if (status.next)
        text.appendChild(el("span", "status-area-next", status.next));
      // The action that clears the warning sits under its words (#1943). The
      // server names it; the row leaves its own copy out. The slot keeps the
      // button's height while the server names an action, so the block keeps
      // its size when the button goes (queued, hidden).
      if (withFix && item.status?.action) {
        const slot = el("span", "status-area-fix");
        const fix = statusFixCell(item);
        if (fix) slot.appendChild(fix);
        text.appendChild(slot);
      }
      area.appendChild(text);
      return area;
    }

    // The action the server says clears this pull request's status, or null.
    // A settled pull request has nothing left to fix.
    // Only a name the page can draw, and only while its button exists, so the
    // row and the footer never drop their copy for a button that isn't there.
    function statusFixName(item: PullRequestItem): ActionName | null {
      const action = item.status?.action;
      if (!action || isSettled(item)) return null;
      return fixCellFor(item, action) ? (action as ActionName) : null;
    }

    function statusFixCell(item: PullRequestItem): HTMLElement | null {
      const action = item.status?.action;
      return action && !isSettled(item) ? fixCellFor(item, action) : null;
    }

    function fixCellFor(
      item: PullRequestItem,
      action: string,
    ): HTMLElement | null {
      switch (action) {
        case "update_branch":
          return updateBranchActionCell(item);
        case "dependabot_rebase":
          return dependabotRebaseCell(item);
        case "renovate_rebase":
          return renovateRebaseActionCell(item);
        default:
          return null;
      }
    }

    function dependabotRebaseCell(item: PullRequestItem): HTMLElement | null {
      return findAction(item, "dependabot_rebase") &&
        !dependabotRebaseHidden(item)
        ? dependabotActionButton(item, "rebase")
        : null;
    }

    // Always rendered for an open pull request (#705): clickable when
    // mergeNotReady has nothing to say, locked with a visible reason
    // otherwise. First click only arms a confirm step
    // (doMerge is never reachable from it directly); merging is a real,
    // hard-to-reverse write to the real repo, not a filter toggle like
    // the CI pill next to it.
    function mergeActionCell(item: PullRequestItem): HTMLElement | null {
      // Found already merged or closed on the forge: say so, nothing to click.
      const settled = mergeState[prKey(item)]?.phase;
      if (settled === "merged" || settled === "closed")
        return settledBadge(settled);

      // The server decides whether Merge applies and, when it can't be
      // taken yet, why (#805): empty, conflicting, draft, waiting on CI,
      // behind, blocked by the forge. Merge stays on the row, locked with
      // the reason in plain sight; the next snapshot builds it again, so it
      // unlocks by itself (#705).
      const merge = findAction(item, "merge");
      if (!merge) return null;
      // Read-only while the forge's budget is spent (#755), blocked or not:
      // the banner says why, so a greyed Merge adds nothing.
      if (
        (mergeState[prKey(item)]?.phase ?? "idle") === "idle" &&
        readOnlyBecauseRateLimited(proactiveActionLockReason(item.forge))
      )
        return null;
      if (merge.blocked) {
        // The status block on the row already says why, and describes the
        // button; without one (it is always sent for a blocked Merge) the
        // reason is printed beside it as before.
        const described = item.status ? statusAreaId(item) : undefined;
        return lockedActionButton(
          "Merge",
          merge.blocked.message,
          undefined,
          described ? undefined : merge.blocked.next,
          described,
        );
      }

      const key = prKey(item);
      const scope = idScope;
      const entry = mergeState[key] || { phase: "idle" };

      if (entry.phase === "locked")
        return lockedActionButton("Merge", lockOf(entry), () =>
          retryLockedAction(item),
        );

      // Only checked from idle — once a confirm/merge is already in
      // flight, let it finish and report its own real outcome rather
      // than yanking the button out from under a click that's already
      // landed.
      if (entry.phase === "idle") {
        const proactiveReason = proactiveActionLockReason(item.forge);
        if (readOnlyBecauseRateLimited(proactiveReason)) return null;
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
        confirmButton.id = `${scope}merge-confirm-${domSafeId(key)}`;
        confirmButton.disabled = !confirming;
        if (confirming) {
          confirmGroup("merge", item, wrap, confirmButton, () =>
            doMerge(item, confirmButton),
          );
        } else {
          wrap.appendChild(confirmButton);
        }
        return wrap;
      }

      const mergeButton = buttonEl("row-action", "Merge");
      mergeButton.type = "button";
      mergeButton.id = `${scope}merge-arm-${domSafeId(key)}`;
      mergeButton.addEventListener("click", () => {
        armConfirm("merge", item);
        renderPRBoard();
        // Moves focus to the confirm button that render() just built —
        // the browser's own scroll-into-view + focus ring is what
        // actually makes this state change noticeable, not just
        // relying on someone watching the exact pixels the button
        // occupies.
        const justConfirmed = document.getElementById(
          `${scope}merge-confirm-${domSafeId(key)}`,
        );
        justConfirmed?.focus();
      });
      wrap.appendChild(mergeButton);
      return wrap;
    }

    // ---- enable auto-merge action ----
    // GitHub only, today (#526) — Forgejo has no separate "enable
    // auto-merge" endpoint of its own; `merge_when_checks_succeed` is a
    // flag on the same merge call PullRequestMerger already uses, which
    // commits to merging right now rather than arming a standing intent
    // the way this action means "enable auto-merge" — different enough
    // framing that it's left for a follow-up rather than folded in here.
    const autoMergeState: Record<string, ActionState> = {};

    // A refusal that passes by itself: GitHub rejects arming auto-merge
    // while a non-required check is still running (#621), and the point of
    // arming ahead of CI is to try again once it settles.
    const AUTO_MERGE_RETRYABLE: ReadonlySet<ActionCode> = new Set([
      "checks_pending",
    ]);

    // No confirm step — arming auto-merge doesn't merge anything by
    // itself, the same reasoning doUpdateBranch's own comment gives.
    function doEnableAutoMerge(
      item: PullRequestItem,
      button: HTMLButtonElement,
    ) {
      const key = prKey(item);
      autoMergeState[key] = { phase: "enabling" };
      button.disabled = true;
      button.textContent = "Enabling…";
      const fkey = `auto-merge:${key}`;
      feedback.start({
        actionKey: fkey,
        ref: actionRef(item),
        label: "Enable auto-merge",
        kind: "enable-auto-merge",
        phase: "working",
        inline: "Enabling auto-merge…",
        message: "Enabling auto-merge…",
        announce: "Enabling auto-merge…",
        retry: () => doEnableAutoMerge(item, buttonEl("row-action")),
      });

      fetch("/api/pull-requests/auto-merge", {
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
          return readActionFailure(res).then((err) => {
            throw err;
          });
        })
        .then(() => {
          delete autoMergeState[key];
          feedback.update(fkey, {
            phase: "done",
            message: "Auto-merge enabled.",
            toast: true,
            announce: "Auto-merge enabled.",
          });
          // Same immediate-refresh pattern doMerge/doUpdateBranch already
          // use, so the row's Auto-merge pill (autoMergePill) reflects
          // the new state without waiting out the rest of the background
          // poll's own interval.
          return fetch(withDrafts("/api/dashboard/refresh"), {
            method: "POST",
            headers: { Accept: "application/json" },
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (data) applySnapshot(data, true);
            });
        })
        .catch((err: ActionRequestError) => {
          renderActionRefusal(
            item,
            err,
            fkey,
            "enable auto-merge",
            (next) => {
              autoMergeState[key] = next;
            },
            AUTO_MERGE_RETRYABLE,
          );
        });
    }

    // GitHub only; already-enabled (autoMergePill already shows it) and a
    // genuine conflict both hide the action rather than lock it — unlike
    // Merge's own mergeStatus gate, "blocked" (most often pending or
    // not-yet-required checks) stays available here, since arming
    // auto-merge ahead of CI finishing is the entire point of the
    // feature, not a state to wait out first. item.empty is excluded the
    // same way mergeActionCell excludes it: nothing to merge, so nothing
    // to arm either.
    function autoMergeActionCell(item: PullRequestItem): HTMLElement | null {
      if (!findAction(item, "auto_merge")) return null;

      const key = prKey(item);
      const entry = autoMergeState[key] || { phase: "idle" };

      if (entry.phase === "locked")
        return lockedActionButton("Enable auto-merge", lockOf(entry));

      if (entry.phase === "idle") {
        const proactiveReason = proactiveActionLockReason(
          item.forge,
          "graphql",
        );
        if (readOnlyBecauseRateLimited(proactiveReason)) return null;
        if (proactiveReason)
          return lockedActionButton("Enable auto-merge", proactiveReason);
      }

      const enabling = entry.phase === "enabling";
      const button = buttonEl(
        "row-action",
        enabling ? "Enabling…" : "Enable auto-merge",
      );
      button.type = "button";
      button.disabled = enabling;
      button.addEventListener("click", () => {
        doEnableAutoMerge(item, button);
      });
      return button;
    }

    // ---- cancel an armed auto-merge ----
    // On Forgejo the intent is stored here, so cancelling sends nothing to the
    // forge; on GitHub the server turns off GitHub's own auto-merge. Either
    // way there is nothing to confirm: arming it again is one click.
    const cancelAutoMergeState: Record<string, ActionState> = {};

    // A Forgejo merge the server says the forge holds: Cancel removes that.
    function forgeHolds(item: PullRequestItem): boolean {
      return item.forge === "forgejo" && item.autoMergeHeldBy === "forge";
    }

    function doCancelAutoMerge(item: PullRequestItem) {
      const key = prKey(item);
      const onForge = forgeHolds(item);
      const cancelled = onForge
        ? "Merge scheduled on Forgejo cancelled."
        : "Auto-merge cancelled.";
      const cancelling = onForge
        ? "Cancelling the merge scheduled on Forgejo…"
        : "Cancelling auto-merge…";
      cancelAutoMergeState[key] = { phase: "requesting" };
      keepFocusAcross(renderPRBoard);
      const fkey = `cancel-auto-merge:${key}`;
      feedback.start({
        actionKey: fkey,
        ref: actionRef(item),
        label: "Cancel auto-merge",
        kind: "cancel-auto-merge",
        phase: "working",
        inline: cancelling,
        message: cancelling,
        announce: cancelling,
        retry: () => doCancelAutoMerge(item),
      });

      fetch("/api/pull-requests/auto-merge/cancel", {
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
          return readActionFailure(res).then((err) => {
            throw err;
          });
        })
        .then(() => {
          delete cancelAutoMergeState[key];
          feedback.update(fkey, {
            phase: "done",
            message: cancelled,
            toast: true,
            announce: cancelled,
          });
          return fetch(withDrafts("/api/dashboard/refresh"), {
            method: "POST",
            headers: { Accept: "application/json" },
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (data) applySnapshot(data, true);
            });
        })
        .catch((err: ActionRequestError) => {
          renderActionRefusal(item, err, fkey, "cancel auto-merge", (next) => {
            cancelAutoMergeState[key] = next;
          });
        });
    }

    function cancelAutoMergeCell(
      item: PullRequestItem,
      inChip = false,
    ): HTMLElement | null {
      if (!findAction(item, "cancel_auto_merge")) return null;

      const requesting =
        cancelAutoMergeState[prKey(item)]?.phase === "requesting";
      // In the waiting chip it says Disarm, the chip's own word for it.
      const button = buttonEl(
        inChip ? "row-action wait-chip-action" : "row-action",
        inChip
          ? requesting
            ? "Disarming…"
            : "Disarm"
          : requesting
            ? "Cancelling…"
            : "Cancel auto-merge",
      );
      if (inChip)
        button.setAttribute(
          "aria-label",
          requesting
            ? "Disarming auto-merge"
            : forgeHolds(item)
              ? "Disarm the merge scheduled on Forgejo"
              : "Disarm auto-merge",
        );
      if (forgeHolds(item))
        button.title = "Cancels the merge scheduled on Forgejo.";
      button.type = "button";
      button.disabled = requesting;
      button.addEventListener("click", () => {
        doCancelAutoMerge(item);
      });
      return button;
    }

    // ---- pull request close action ----
    // For a pull request that turns out not to need merging at all — a
    // duplicate, or one whose content already landed another way
    // (confirmed live) — Close is the action that actually applies, not
    // Merge. Own state map, parallel to
    // mergeState, the same shape updateBranchState uses for its own
    // independent action.
    const closeState: Record<string, ActionState> = {};

    // ---- the armed confirm step (#764) ----
    // Merge's and Close's second click. One is armed at a time; it ends on
    // Cancel, a click anywhere else, Escape, or 8 seconds alone. The state
    // lives in confirmArm and mergeState/closeState, not in the row's DOM,
    // so a rebuilt row comes back still armed.
    type ConfirmKind = "merge" | "close";
    const confirmStates: Record<ConfirmKind, Record<string, ActionState>> = {
      merge: mergeState,
      close: closeState,
    };
    const splitArmKey = (armKey: string): [ConfirmKind, string] => {
      const at = armKey.indexOf(":");

      return [armKey.slice(0, at) as ConfirmKind, armKey.slice(at + 1)];
    };

    function onConfirmDisarmed(armKey: string, reason: DisarmReason) {
      const [kind, key] = splitArmKey(armKey);
      if (
        reason !== "confirmed" &&
        confirmStates[kind][key]?.phase === "confirming"
      )
        delete confirmStates[kind][key];
      // The caller renders for these: it is mid-click, mid-menu-close or
      // mid-render itself.
      if (
        reason === "replaced" ||
        reason === "dropped" ||
        reason === "confirmed"
      )
        return;
      // Rendering also lets a snapshot the armed row was holding back land.
      renderPRBoard();
      if (reason === "cancel" || reason === "escape")
        document
          .getElementById(`${activeScope()}${kind}-arm-${domSafeId(key)}`)
          ?.focus();
    }

    const confirmArm = createConfirmArm({ onDisarm: onConfirmDisarmed });

    function armConfirm(kind: ConfirmKind, item: PullRequestItem) {
      const key = prKey(item);
      confirmStates[kind][key] = { phase: "confirming" };
      confirmArm.arm(`${kind}:${key}`);
      feedback.announce(
        `Confirm ${kind} of #${item.number}? Press Confirm or Cancel.`,
      );
    }

    // Cancel, Confirm and the countdown line, for either action.
    function confirmGroup(
      kind: ConfirmKind,
      item: PullRequestItem,
      wrap: HTMLElement,
      confirmButton: HTMLButtonElement,
      onConfirm: () => void,
    ) {
      const key = prKey(item);
      const armKey = `${kind}:${key}`;
      wrap.classList.add("confirm-group");
      wrap.dataset.armKey = armKey;
      wrap.setAttribute("role", "group");
      wrap.setAttribute("aria-label", `Confirm ${kind} of #${item.number}`);

      // The second click of a double-click on the original button lands on
      // whichever of the two now sits there, and a held or repeated Enter
      // lands on Confirm: neither is a decision, for either button.
      const tooSoon = (e: MouseEvent) =>
        confirmArm.guardActive(armKey) && e.detail !== 1;

      confirmButton.addEventListener("click", (e) => {
        if (tooSoon(e)) return;
        confirmArm.disarm("confirmed", armKey);
        onConfirm();
      });
      wrap.appendChild(confirmButton);

      const cancelButton = buttonEl("row-action cancel", "Cancel");
      cancelButton.type = "button";
      cancelButton.addEventListener("click", (e) => {
        if (tooSoon(e)) return;
        if (!confirmArm.disarm("cancel", armKey)) {
          delete confirmStates[kind][key];
          renderPRBoard();
        }
      });
      wrap.appendChild(cancelButton);

      // How to back out without finding Cancel (#767). Plain text, not
      // live: the arming announcement stays the only message spoken.
      wrap.appendChild(
        el("span", "confirm-hint", "Esc or click away to cancel"),
      );

      // Decoration for sighted users; the announcement carries the rest.
      // Started part-way through when the row was rebuilt mid-countdown.
      const line = el("span", "confirm-countdown");
      line.setAttribute("aria-hidden", "true");
      line.style.animationDuration = `${CONFIRM_TIMEOUT_MS}ms`;
      line.style.animationDelay = `-${confirmArm.elapsedMs()}ms`;
      wrap.appendChild(line);
    }

    // The armed step can be on the page twice, on the row and in the open
    // dialog's footer. The countdown follows the one the user can reach.
    function armedGroups(): Element[] {
      const armKey = confirmArm.armedKey();
      if (!armKey) return [];

      return Array.from(document.querySelectorAll(".confirm-group")).filter(
        (group) => (group as HTMLElement).dataset.armKey === armKey,
      );
    }
    function armedGroup(): Element | null {
      const groups = armedGroups();

      return groups.find((g) => g.closest("dialog[open]")) ?? groups[0] ?? null;
    }
    const inArmedGroup = (target: EventTarget | null) =>
      target instanceof Node && armedGroups().some((g) => g.contains(target));

    // The countdown waits while the pointer is over the group or keyboard
    // focus is in it. Focus from the arming mouse click doesn't count
    // (:focus-visible), or walking away from a clicked Merge would never
    // time out. The CSS line pauses on the same two conditions.
    let confirmHover = false;
    let confirmFocus = false;
    function applyConfirmPause() {
      if (confirmHover || confirmFocus) confirmArm.pause();
      else confirmArm.resume();
    }
    function readConfirmPause() {
      const group = armedGroup();
      confirmHover = Boolean(group?.matches(":hover"));
      confirmFocus = Boolean(group?.querySelector(":focus-visible"));
      applyConfirmPause();
    }
    document.addEventListener("pointerover", (e) => {
      if (!inArmedGroup(e.target)) return;
      confirmHover = true;
      applyConfirmPause();
    });
    document.addEventListener("pointerout", (e) => {
      if (inArmedGroup(e.relatedTarget)) return;
      confirmHover = false;
      applyConfirmPause();
    });
    document.addEventListener("focusin", (e) => {
      const target = e.target as Element;
      if (!inArmedGroup(target) || !target.matches(":focus-visible")) return;
      confirmFocus = true;
      applyConfirmPause();
    });
    document.addEventListener("focusout", (e) => {
      if (inArmedGroup(e.relatedTarget)) return;
      confirmFocus = false;
      applyConfirmPause();
    });

    // A click anywhere but the armed group disarms it. Watched in the
    // capture phase, so a handler that stops propagation can't hide it, and
    // acted on after the click has been dispatched: rebuilding the row
    // before the target's own handler ran would swallow that click.
    document.addEventListener(
      "click",
      (e) => {
        const armKey = confirmArm.armedKey();
        if (!armKey || inArmedGroup(e.target)) return;
        // The second click of a double-click on Merge or Close lands where
        // the row has just shifted to: the CI pill, say. It isn't a decision
        // to leave, so it neither disarms nor reaches what it landed on
        // (#1286).
        if (confirmArm.guardActive(armKey) && e.detail !== 1) {
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        setTimeout(() => confirmArm.disarm("outside", armKey), 0);
      },
      true,
    );

    // Escape on an armed Close ends the confirm.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || modalDialogOpen()) return;
      if (confirmArm.disarm("escape")) e.stopImmediatePropagation();
    });

    // Rows are rebuilt from scratch on every render, so the group is
    // checked against the DOM afterwards: a pull request that left the board
    // (a filter, a page change) takes its armed state with it.
    const prRowsEl = document.getElementById("pr-rows");
    if (prRowsEl)
      new MutationObserver(() => {
        const armKey = confirmArm.armedKey();
        if (!armKey) return;
        const [, key] = splitArmKey(armKey);
        const present = Array.from(
          prRowsEl.querySelectorAll<HTMLElement>(".row[data-pr-key]"),
        ).some((row) => row.dataset.prKey === key);
        if (!present) {
          confirmArm.disarm("dropped", armKey);
          renderPRBoard();
          return;
        }
        readConfirmPause();
      }).observe(prRowsEl, { childList: true, subtree: true });

    function doClose(item: PullRequestItem, confirmButton: HTMLButtonElement) {
      const key = prKey(item);
      closeState[key] = { phase: "closing" };
      confirmButton.disabled = true;
      confirmButton.textContent = "Closing…";
      const fkey = `close:${key}`;
      feedback.start({
        actionKey: fkey,
        ref: actionRef(item),
        label: "Close",
        kind: "close",
        phase: "working",
        inline: "Closing…",
        message: "Closing…",
        announce: "Closing…",
        // Like merge, a close is never re-sent without its confirm step.
        retry: () => {
          feedback.drop(fkey);
          armConfirm("close", item);
          renderPRBoard();
          document
            .getElementById(`${activeScope()}close-confirm-${domSafeId(key)}`)
            ?.focus();
        },
      });

      fetch("/api/pull-requests/close", {
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
          return readActionFailure(res).then((err) => {
            throw err;
          });
        })
        .then(() => {
          delete closeState[key];
          feedback.update(fkey, {
            phase: "done",
            message: "Closed.",
            toast: true,
            announce: "Closed.",
          });
          return fetch(withDrafts("/api/dashboard/refresh"), {
            method: "POST",
            headers: { Accept: "application/json" },
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (data) applySnapshot(data, true);
            });
        })
        .catch((err: ActionRequestError) => {
          renderActionRefusal(item, err, fkey, "close", (next) => {
            closeState[key] = next;
          });
        });
    }

    function markClose(locked: HTMLElement): HTMLElement {
      locked.classList.add("close-group");
      return locked;
    }

    // Offered for every open pull request, gated only on the forge itself
    // being reachable/within budget — unlike Merge, Close needs no
    // particular mergeability or CI state to make sense. It lives in the
    // details pop-up's footer, and on the row only when the server marks it
    // primary (an empty pull request). Its confirm button is focused by id.
    function closeActionCell(item: PullRequestItem): HTMLElement | null {
      if (!findAction(item, "close")) return null;
      const key = prKey(item);
      const scope = idScope;
      const entry = closeState[key] || { phase: "idle" };

      if (entry.phase === "locked") {
        return markClose(
          lockedActionButton("Close pull request", lockOf(entry), () =>
            retryLockedAction(item),
          ),
        );
      }

      if (entry.phase === "idle") {
        const proactiveReason = proactiveActionLockReason(item.forge);
        if (readOnlyBecauseRateLimited(proactiveReason)) return null;
        if (proactiveReason)
          return markClose(
            lockedActionButton("Close pull request", proactiveReason, () =>
              retryLockedAction(item),
            ),
          );
      }

      const wrap = el("span", "row-action-group close-group");

      const confirming = entry.phase === "confirming";
      if (confirming || entry.phase === "closing") {
        const confirmButton = buttonEl(
          "row-action confirm",
          confirming ? "Confirm close pull request?" : "Closing…",
        );
        confirmButton.id = `${scope}close-confirm-${domSafeId(key)}`;
        confirmButton.disabled = !confirming;
        if (confirming) {
          confirmGroup("close", item, wrap, confirmButton, () =>
            doClose(item, confirmButton),
          );
        } else {
          wrap.appendChild(confirmButton);
        }
        return wrap;
      }

      // A neutral button on every row (#1223): closing is reversible, so it
      // is not red, and green read as the affirmative, so an empty pull
      // request no longer gets it. Merge stays visible-and-locked there (a
      // past incident: a vanished Merge button with no explanation read as
      // broken), and Close is the only enabled action beside it. The name
      // says what it closes, so it can't be taken for a Cancel; only the
      // confirm step carries the warning tone.
      const closeButton = buttonEl("row-action close", "Close pull request");
      closeButton.type = "button";
      closeButton.id = `${scope}close-arm-${domSafeId(key)}`;
      closeButton.addEventListener("click", () => {
        armConfirm("close", item);
        renderPRBoard();
        const justConfirmed = document.getElementById(
          `${scope}close-confirm-${domSafeId(key)}`,
        );
        justConfirmed?.focus();
      });
      wrap.appendChild(closeButton);
      return wrap;
    }

    // ---- pull request update-branch action ----
    // Its own state map, parallel to mergeState — a Forgejo pull request
    // can be mergeable and behind at once, so both actions can
    // legitimately show on the same row at the same time and need
    // independent lock/in-flight state rather than sharing one.
    const updateBranchState: Record<string, ActionState> = {};

    // No confirm step, unlike doMerge — bringing a branch up to date is
    // routine and reversible in a way completing the pull request isn't.
    function doUpdateBranch(item: PullRequestItem, button: HTMLButtonElement) {
      const key = prKey(item);
      updateBranchState[key] = {
        phase: "queued",
        queued: queuedRequestInfo(item),
      };
      markPending(button, true);
      button.textContent = "Queued…";
      const fkey = `update-branch:${key}`;
      feedback.start({
        actionKey: fkey,
        ref: actionRef(item),
        label: "Update branch",
        kind: "update-branch",
        phase: "queued",
        inline: "Branch update requested",
        message: "Branch update requested.",
        retry: () => doUpdateBranch(item, buttonEl("row-action")),
      });

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
          return readActionFailure(res).then((err) => {
            throw err;
          });
        })
        .then(() => {
          // The server has the request now and puts it on the pull request
          // until a later fetch shows the branch caught up (#982). The row
          // stays "queued" until a snapshot says otherwise
          // (syncServerRequests), so it doesn't flicker back to a plain
          // re-clickable button while GitHub's background job runs.
          confirmRequest(updateBranchState, key);
          feedback.update(fkey, {
            toast: true,
            announce: requestedAnnouncement("update-branch"),
          });
          return fetch(withDrafts("/api/dashboard/refresh"), {
            method: "POST",
            headers: { Accept: "application/json" },
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (data) applySnapshot(data, true);
            });
        })
        .catch((err: ActionRequestError) => {
          renderActionRefusal(item, err, fkey, "update the branch", (next) => {
            updateBranchState[key] = next;
          });
        });
    }

    // Only rendered when the forge reports this pull request as behind
    // its base, so it can show alongside the merge button rather than
    // instead of it. A conflicting pull request gets it locked, with the
    // reason, rather than clickable.
    function updateBranchActionCell(item: PullRequestItem): HTMLElement | null {
      // Offered only when the server lists it (#805): behind with
      // something to merge, and not a Dependabot or Renovate pull request,
      // which have their own rebase. A conflicting one is listed blocked, so
      // it shows locked with the reason rather than clickable; derived from
      // each snapshot, so the real button comes back by itself (#701).
      const updateBranch = findAction(item, "update_branch");
      if (!updateBranch) return null;
      if (
        (updateBranchState[prKey(item)]?.phase ?? "idle") === "idle" &&
        readOnlyBecauseRateLimited(proactiveActionLockReason(item.forge))
      )
        return null;
      if (updateBranch.blocked)
        return lockedActionButton(
          "Update branch",
          updateBranch.blocked.message,
        );

      const key = prKey(item);
      const entry = updateBranchState[key] || { phase: "idle" };

      if (entry.phase === "locked")
        return lockedActionButton("Update branch", lockOf(entry), () =>
          retryLockedAction(item),
        );

      if (entry.phase === "idle") {
        const proactiveReason = proactiveActionLockReason(item.forge);
        if (readOnlyBecauseRateLimited(proactiveReason)) return null;
        if (proactiveReason)
          return lockedActionButton("Update branch", proactiveReason, () =>
            retryLockedAction(item),
          );
      }

      const queued = entry.phase === "queued";
      const button = buttonEl(
        "row-action",
        queued ? "Queued…" : "Update branch",
      );
      button.type = "button";
      markPending(button, queued);
      button.addEventListener("click", () => {
        if (isPending(button)) return;
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

    const DEPENDABOT_ACTION_LABELS: Record<string, string> = {
      rebase: "Dependabot: Rebase",
      recreate: "Dependabot: Recreate",
    };

    // What the row line needs to talk about the bot (#707).
    function botLineInfo(
      bot: "Dependabot" | "Renovate",
      acknowledged = false,
    ): BotRequest {
      return {
        bot,
        trigger: bot === "Renovate" ? "label" : "comment",
        ...(acknowledged ? { acknowledged } : {}),
      };
    }

    // No confirm step — same reasoning as doUpdateBranch: this only
    // asks Dependabot to redo its own routine, reversible work, not a
    // merge.
    function doDependabotAction(
      item: PullRequestItem,
      action: "rebase" | "recreate",
      button: HTMLButtonElement,
    ) {
      const key = `${prKey(item)}:${action}`;
      dependabotActionState[key] = {
        phase: "queued",
        queued: queuedRequestInfo(item),
      };
      markPending(button, true);
      button.textContent = queuedBotLabel(action === "rebase");
      // Recreate rebuilds the whole pull request, so a Rebase beside it has
      // no point from the moment it's queued, not once the response lands
      // and the board re-renders (#792, #834).
      if (action === "recreate")
        button
          .closest(".row")
          ?.querySelectorAll('[data-bot-action="rebase"]')
          .forEach((el) => el.remove());
      const fkey = `dependabot:${key}`;
      feedback.start({
        actionKey: fkey,
        ref: actionRef(item),
        label: DEPENDABOT_ACTION_LABELS[action],
        kind: action === "rebase" ? "bot-rebase" : "bot-recreate",
        phase: "queued",
        inline: `Dependabot ${action} requested`,
        message: `Dependabot ${action} requested.`,
        bot: action === "rebase" ? botLineInfo("Dependabot") : undefined,
        retry: () => doDependabotAction(item, action, buttonEl("row-action")),
      });

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
          return readActionFailure(res).then((err) => {
            throw err;
          });
        })
        .then(() => {
          // Stays "queued" — Dependabot acts on its own schedule, so the
          // button holds until the next snapshot lands (applySnapshot
          // clears it) rather than inviting a second comment.
          // No immediate /api/dashboard/refresh, unlike doMerge/
          // doUpdateBranch: posting the comment doesn't change anything
          // about this pull request itself — Dependabot's own rebase/
          // recreate run is what would, on its own schedule.
          confirmRequest(dependabotActionState, key);
          feedback.update(fkey, {
            toast: true,
            announce: requestedAnnouncement(
              action === "rebase" ? "bot-rebase" : "bot-recreate",
              "Dependabot",
            ),
          });
          renderPRBoard();
        })
        .catch((err: ActionRequestError) => {
          renderActionRefusal(
            item,
            err,
            fkey,
            `ask Dependabot to ${action}`,
            (next) => {
              dependabotActionState[key] = next;
            },
            undefined,
            `dependabot-${action}`,
          );
        });
    }

    function dependabotActionButton(
      item: PullRequestItem,
      action: "rebase" | "recreate",
    ): HTMLElement | null {
      const key = `${prKey(item)}:${action}`;
      const entry = dependabotActionState[key] || { phase: "idle" };

      const blockedReason = lastForges.find(
        (f) => f.forge === item.forge,
      )?.dependabotCommandsBlocked;
      if (blockedReason)
        return lockedActionButton(
          DEPENDABOT_ACTION_LABELS[action],
          blockedReason,
        );

      if (entry.phase === "locked")
        return lockedActionButton(
          DEPENDABOT_ACTION_LABELS[action],
          lockOf(entry),
        );

      if (entry.phase === "idle") {
        const proactiveReason = proactiveActionLockReason(item.forge);
        if (readOnlyBecauseRateLimited(proactiveReason)) return null;
        if (proactiveReason)
          return lockedActionButton(
            DEPENDABOT_ACTION_LABELS[action],
            proactiveReason,
          );
      }

      const queued = entry.phase === "queued" || entry.phase === "rebasing";
      const button = buttonEl(
        "row-action",
        queued
          ? queuedBotLabel(action === "rebase")
          : DEPENDABOT_ACTION_LABELS[action],
      );
      markPending(button, queued);
      button.dataset.botAction = action;
      button.addEventListener("click", () => {
        if (isPending(button)) return;
        doDependabotAction(item, action, button);
      });
      return button;
    }

    // ---- Renovate rebase action ----
    // Unlike Dependabot, Renovate runs on both forges and has only the
    // one trigger (no separate "recreate") — the server resolves which
    // label to add from the signed-in user's own saved setting, so the
    // request here carries no action field the way the Dependabot one
    // does.
    const renovateRebaseState: Record<string, ActionState> = {};

    // #212: a row armed for a second click (Merge's own "Confirm merge?"
    // step, or an update-branch/Dependabot/Renovate request already in
    // flight) must not have its position stolen by a live snapshot
    // landing mid-interaction — aggregator.go sorts pullRequests by
    // UpdatedAt descending, so any other tracked pull request updating
    // in that window reshuffles the whole board on the next poll or SSE
    // push, and the confirm click lands wherever that row used to be
    // instead of the button itself. "locked" is deliberately excluded:
    // that state already swaps the button for a single-click "Retry",
    // not a two-step interaction a moved target can break.
    function anyRowActionInFlight(): boolean {
      // "rebasing" is a bot already acting on its own: nothing the user
      // is mid-way through, so snapshots keep landing in place (#707).
      // A request restored from a snapshot (a reload) isn't a click of
      // this page's own either.
      const inFlight = (entry: ActionState) =>
        !entry.queued?.restored &&
        entry.phase !== "idle" &&
        entry.phase !== "locked" &&
        entry.phase !== "merged" &&
        entry.phase !== "closed" &&
        entry.phase !== "rebasing";

      return [
        mergeState,
        closeState,
        updateBranchState,
        dependabotActionState,
        renovateRebaseState,
      ].some((stateMap) => Object.values(stateMap).some(inFlight));
    }

    // Live updates land by themselves. shownPRs is what the board is
    // showing; latestPRs is the newest snapshot's list that hasn't been
    // applied yet. Each incoming snapshot is compared with what's shown:
    //   - a row whose own content changed (CI, merge status, behind,
    //     labels, title) is updated where it stands and marked briefly;
    //     it never reorders or jumps the list;
    //   - rows added, removed or reordered apply in one render, unless
    //     the pointer rests on the list, in which case they wait and land
    //     the moment it leaves;
    //   - nothing is applied while an action is in flight, a menu or
    //     another modal is open, or updates are paused. A refresh the user
    //     asked for applies in full unless one of those holds.
    // The open details dialog is not a hold: the board behind it keeps
    // updating, and the dialog follows its own pull request.
    let shownPRs: PullRequestItem[] = [];
    let latestPRs: PullRequestItem[] | null = null;
    // The newest snapshot in the server's own order, so a sort change can
    // go back to "Last activity" rather than re-sorting an already
    // re-sorted list.
    let rawPRs: PullRequestItem[] = [];
    let latestIsUserAsked = false;
    // How many rows the filters leave on the current view, for the Filters
    // sheet's "Show N results" button (#828).
    let visibleResultCount = 0;

    // The issues page's counterpart. A change that would add, remove or
    // move rows waits only while you're scrolled below the top, a control
    // in the list has focus, the pointer rests on the list, another modal
    // is open or updates are paused, then lands by itself. Otherwise it
    // applies at once. A row whose own
    // content changed is replaced where it stands, and a snapshot that
    // changes nothing renders nothing.
    let shownIssues: IssueItem[] = [];
    let latestIssues: IssueItem[] | null = null;
    let rawIssues: IssueItem[] = [];
    let latestIssuesAsked = false;

    // How long "Updated just now" stays on a row changed in place.
    const UPDATED_MARKER_MS = 2500;
    const updatedMarkers = new Set<string>();

    // Whether a re-render now would be felt: a row action is in flight (or
    // an armed confirm waits for its second click), or a modal other than
    // the details dialog is open. The details
    // dialog is deliberately not here: it follows its own pull request,
    // and nothing behind it can be clicked, so the board behind it may
    // move.
    function interactionFreezesBoard(): boolean {
      return anyRowActionInFlight() || otherModalOpen();
    }

    // A modal that isn't the details dialog.
    function otherModalOpen(): boolean {
      const open = document.querySelectorAll("dialog[open]").length;
      return open > (detailsDialog?.isOpen() ? 1 : 0);
    }

    // The mouse or pen rests on a list: rows must not move under it, or the
    // click lands on a different row. A modal being open means the pointer
    // is on its backdrop, not the list.
    let pointerInList = false;
    // A finger has no resting position, but a tap right after the list
    // shifted lands on another row, and a list under a scrolling finger
    // must not change. So rows wait for a moment after the last touch or
    // touch-driven scroll.
    const TOUCH_SETTLE_MS = 1000;
    let touchMode = false;
    let lastTouchAt = 0;
    let ownScrollY = -1;
    let touchTimer: ReturnType<typeof setTimeout> | undefined;
    function touchSettling(): boolean {
      return touchMode && Date.now() - lastTouchAt < TOUCH_SETTLE_MS;
    }
    function touched() {
      touchMode = true;
      lastTouchAt = Date.now();
      clearTimeout(touchTimer);
      touchTimer = setTimeout(reconcileCurrentView, TOUCH_SETTLE_MS + 20);
    }
    function pointerRestsOnList(): boolean {
      return (pointerInList && !modalDialogOpen()) || touchSettling();
    }
    // The pointer's claim ends when the page loses the user: an alt-tab
    // with the mouse still over the list must not hold the board for good.
    function releasePointer() {
      pointerInList = false;
      reconcileCurrentView();
    }
    // Everything added here is taken off again when the page goes.
    const stopListening: (() => void)[] = [];
    function listen(
      target: EventTarget | null,
      type: string,
      handler: (e: Event) => void,
      options?: AddEventListenerOptions,
    ) {
      target?.addEventListener(type, handler, options);
      stopListening.push(() =>
        target?.removeEventListener(type, handler, options),
      );
    }
    for (const id of ["pr-rows", "issue-rows"]) {
      const list = document.getElementById(id);
      const mark = (e: Event) => {
        if ((e as PointerEvent).pointerType !== "touch") {
          pointerInList = true;
          touchMode = false;
        }
      };
      listen(list, "pointerenter", mark);
      listen(list, "pointermove", mark);
      listen(list, "pointerleave", releasePointer);
    }
    for (const type of ["pointerdown", "pointerup", "pointercancel"]) {
      listen(
        document,
        type,
        (e) => {
          if ((e as PointerEvent).pointerType === "touch") touched();
        },
        { passive: true, capture: true },
      );
    }
    listen(
      window,
      "scroll",
      () => {
        // The page's own scroll correction is not the user's finger.
        if (touchMode && window.scrollY !== ownScrollY) touched();
      },
      { passive: true },
    );
    listen(window, "blur", releasePointer);
    listen(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") releasePointer();
    });
    // A modal closing ends the pointer's claim on the list until it moves
    // again, and lifts the hold the modal put on the board. "close" doesn't
    // bubble, hence the capture.
    listen(
      document,
      "close",
      (e) => {
        if (!(e.target instanceof HTMLDialogElement)) return;
        pointerInList = false;
        setTimeout(reconcileCurrentView, 0);
      },
      { capture: true },
    );
    function reconcileCurrentView() {
      if (view === "issues") reconcileIssues();
      else reconcilePRs();
    }

    // A polite status for sighted-less readers: rows were added, removed or
    // moved. One line per applied change, never per poll and never for a
    // row changed in place.
    const listUpdates = document.getElementById("list-updates-status");
    let listUpdatesTimer: ReturnType<typeof setTimeout> | undefined;
    function announceListUpdate(diff: {
      added: number;
      removed: number;
      moved: number;
    }) {
      if (!listUpdates) return;
      const parts: string[] = [];
      if (diff.added > 0) parts.push(`${diff.added} added`);
      if (diff.removed > 0) parts.push(`${diff.removed} removed`);
      if (parts.length === 0 && diff.moved > 0) parts.push("reordered");
      if (parts.length === 0) return;
      listUpdates.replaceChildren(
        document.createTextNode(`List updated: ${parts.join(", ")}`),
      );
      clearTimeout(listUpdatesTimer);
      listUpdatesTimer = setTimeout(
        () => listUpdates.replaceChildren(),
        10_000,
      );
    }

    const pauseUpdatesButton = document.getElementById(
      "pause-updates-button",
    ) as HTMLButtonElement | null;
    const pausedHint = document.getElementById("updates-paused-hint");

    function updatesPaused(): boolean {
      return sharedState.view.paused === "1";
    }

    // ---- show drafts (#791) ----
    // The API leaves drafts out unless asked and counts them, so this only
    // passes the choice on and shows the count. Kept in view state beside
    // "paused": how the list is shown, not something "Clear filters"
    // resets.
    function draftsOn(): boolean {
      return sharedState.view.drafts === "1";
    }

    function withDrafts(url: string): string {
      if (!draftsOn()) return url;
      return `${url}${url.includes("?") ? "&" : "?"}includeDrafts=true`;
    }

    const showDraftsButton = document.getElementById(
      "show-drafts-toggle",
    ) as HTMLButtonElement | null;
    const draftsHiddenCount = document.getElementById("drafts-hidden-count");
    let hiddenDrafts = 0;
    let syncDraftsPreference: () => void = () => {};

    function syncDraftsToggle() {
      showDraftsButton?.setAttribute("aria-pressed", String(draftsOn()));
      if (!draftsHiddenCount) return;
      const shown = !draftsOn() && hiddenDrafts > 0;
      draftsHiddenCount.hidden = !shown;
      draftsHiddenCount.textContent = shown ? `${hiddenDrafts} hidden` : "";
    }

    // ---- hide one pull request (#841) ----
    // The server hides it and counts what it hid; this page asks, says what
    // happened in a status message that stays until the next one, and lists
    // the hidden ones with a Restore. Hiding is reversible, so there is no
    // confirm step.
    const hideStatus = document.getElementById("hide-status");
    const hiddenToggle = document.getElementById(
      "hidden-prs-toggle",
    ) as HTMLButtonElement | null;
    const hiddenPanel = document.getElementById("hidden-prs-panel");
    const hiddenList = document.getElementById("hidden-prs-list");
    let hiddenPullRequests = 0;

    function syncHiddenToggle() {
      if (!hiddenToggle) return;
      hiddenToggle.hidden = hiddenPullRequests === 0;
      hiddenToggle.textContent = `Hidden (${hiddenPullRequests})`;
      if (hiddenPullRequests === 0) setHiddenPanel(false);
    }

    function setHiddenPanel(open: boolean) {
      if (!hiddenToggle || !hiddenPanel) return;
      hiddenToggle.setAttribute("aria-expanded", String(open));
      hiddenPanel.hidden = !open;
      if (open) void loadHiddenList();
    }

    hiddenToggle?.addEventListener("click", () => {
      setHiddenPanel(hiddenToggle.getAttribute("aria-expanded") !== "true");
    });

    type HideRef = { forge: string; fullName: string; number: number };

    function hideRefOf(item: PullRequestItem): HideRef {
      return { forge: item.forge, fullName: item.repo, number: item.number };
    }

    function postHide(
      path: "hide" | "unhide",
      body: HideRef & { days?: number },
    ): Promise<boolean> {
      return fetch(`/api/pull-requests/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      })
        .then((res) => {
          if (res.status === 401) {
            window.location.href = "/login.html";
            return false;
          }
          return res.status === 204;
        })
        .catch(() => false);
    }

    // The board asks the server again, so the row leaves or returns at once
    // instead of waiting for the pointer to leave the list.
    function refreshBoard(): Promise<void> {
      return fetch(withDrafts("/api/dashboard/refresh"), {
        method: "POST",
        headers: { Accept: "application/json" },
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data) applySnapshot(data, true);
        })
        .catch(() => {});
    }

    // One message at a time, as a status for assistive tech. An Undo button
    // rides along when there is something to undo; the Hidden list has the
    // same restore, so nothing depends on reaching this in time.
    function setHideStatus(text: string, undo?: () => void) {
      if (!hideStatus) return;
      hideStatus.replaceChildren(el("span", "hide-status-text", text));
      if (undo) {
        const button = buttonEl("hide-status-undo", "Undo");
        button.type = "button";
        button.addEventListener("click", undo);
        hideStatus.appendChild(button);
      }
      hideStatus.hidden = false;
    }

    async function doHidePullRequest(item: PullRequestItem, days?: number) {
      const ref = hideRefOf(item);
      const key = prKey(item);
      if (!(await postHide("hide", days ? { ...ref, days } : ref))) {
        if (dialogKey === key) {
          // Said inside the dialog, where it can be reached and heard.
          hideFailure[key] = hideFailedMessage(item);
          feedback.announce(hideFailure[key]);
        } else setHideStatus(hideFailedMessage(item));
        renderPRBoard();
        return;
      }
      // The Undo is on the page behind the modal, out of reach. So a
      // successful Hide closes the dialog first (the pull request is leaving
      // the board anyway), and the page's status line and its Undo are
      // spoken and focused where the user can reach them.
      if (dialogKey === key) detailsDialog?.close();
      setHideStatus(hidMessage(item), () => void doRestore(item));
      await refreshBoard();
      // The row this was reached from is gone, so focus moves to the one
      // thing left to act on, which is the Undo.
      hideStatus?.querySelector<HTMLElement>("button")?.focus();
      if (hiddenToggle?.getAttribute("aria-expanded") === "true")
        void loadHiddenList();
    }

    async function doRestore(item: PullRequestItem) {
      if (!(await postHide("unhide", hideRefOf(item)))) {
        setHideStatus(restoreFailedMessage(item));
        return;
      }
      setHideStatus(restoredMessage(item));
      await refreshBoard();
      if (hiddenToggle?.getAttribute("aria-expanded") === "true")
        void loadHiddenList();
    }

    // The writes to a pull request's automatic update that are not settled
    // yet, one per pull request. `latest` is what the last click asked for
    // (null: hand it back to the repo). A click while a write is in flight only
    // moves `latest`, and the loop below sends it once the first one lands, so
    // the last click wins and the server never ends on a stale answer. The box
    // shows `latest` until the board has been read again, so neither a poll nor
    // a slow answer puts the old value back under the user's hand.
    const autoUpdateWrites: Record<string, { latest: boolean | null }> = {};

    function postAutoUpdate(
      item: PullRequestItem,
      enabled: boolean | null,
    ): Promise<boolean> {
      return fetch("/api/pull-requests/auto-update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          forge: item.forge,
          fullName: item.repo,
          number: item.number,
          enabled,
        }),
      })
        .then((res) => {
          if (res.status === 401) {
            window.location.href = "/login.html";
            return false;
          }
          return res.status === 204;
        })
        .catch(() => false);
    }

    // Sends the checkbox's change, or null to hand the pull request back to its
    // repo's setting. A local write on the server: nothing goes to the forge.
    async function doSetAutoUpdate(
      item: PullRequestItem,
      enabled: boolean | null,
    ) {
      const key = prKey(item);
      const write = autoUpdateWrites[key];
      if (write) {
        write.latest = enabled;
        return;
      }
      delete autoUpdateFailure[key];
      const mine = { latest: enabled };
      autoUpdateWrites[key] = mine;
      refreshDialogChrome();
      let ok = true;
      let sent: boolean | null;
      do {
        sent = mine.latest;
        ok = await postAutoUpdate(item, sent);
      } while (ok && mine.latest !== sent);
      if (ok) await refreshBoard();
      else {
        autoUpdateFailure[key] =
          `Couldn't change automatic updates for ${item.repo}#${item.number}. Try again.`;
        feedback.announce(autoUpdateFailure[key]);
      }
      delete autoUpdateWrites[key];
      // The chrome's signature is built from markup, which does not carry a
      // box's checked state: force the redraw so a refused change always puts
      // the box back to what the server has.
      lastChromeSig = "";
      renderPRBoard();
      refreshDialogChrome();
    }

    // The dialog's checkbox for "Update this branch automatically". The label
    // never changes; the checked state is the state. Where it cannot apply it
    // is aria-disabled, not disabled, so it stays in the keyboard order and
    // its reason is read with it.
    function autoUpdateOption(item: PullRequestItem): HTMLElement | null {
      if (isSettled(item)) return null;
      const control = autoUpdateControl(item.autoUpdate);
      if (!control) return null;
      const id = `${idScope}auto-update-${domSafeId(prKey(item))}`;
      const saving = autoUpdateWrites[prKey(item)];
      const checked =
        saving && saving.latest !== null ? saving.latest : control.checked;
      const wrap = el("div", "auto-update-option");
      // Carried in the markup, which the footer's redraw check compares.
      wrap.dataset.checked = String(checked);
      if (saving) wrap.setAttribute("aria-busy", "true");
      const label = el("label", "auto-update-label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.id = id;
      box.className = "auto-update-box";
      box.checked = checked;
      box.setAttribute("aria-describedby", `${id}-note`);
      if (control.disabled) box.setAttribute("aria-disabled", "true");
      box.addEventListener("click", (event) => {
        if (control.disabled) event.preventDefault();
      });
      box.addEventListener("change", () => {
        void doSetAutoUpdate(item, box.checked);
      });
      label.appendChild(box);
      label.appendChild(
        el("span", "auto-update-text", "Update this branch automatically"),
      );
      wrap.appendChild(label);
      const note = el(
        "p",
        "auto-update-note",
        saving ? "Saving…" : control.note,
      );
      note.id = `${id}-note`;
      wrap.appendChild(note);
      if (control.canReset && !saving) {
        const reset = buttonEl(
          "row-action auto-update-reset",
          "Use the repo's setting",
        );
        reset.type = "button";
        reset.id = `${id}-reset`;
        reset.addEventListener("click", () => void doSetAutoUpdate(item, null));
        wrap.appendChild(reset);
      }
      return wrap;
    }

    // A rate-limited or unreachable forge draws no controls on its rows (one
    // banner says why), and hiding is no exception: the row stays as the
    // read-only list it is until the forge answers.
    function hideActionCells(item: PullRequestItem): HTMLElement[] {
      if (readOnlyBecauseRateLimited(proactiveActionLockReason(item.forge)))
        return [];
      const forever = buttonEl("row-action", "Hide this pull request");
      forever.type = "button";
      forever.addEventListener("click", () => void doHidePullRequest(item));
      const week = buttonEl("row-action", "Hide for 7 days");
      week.type = "button";
      week.addEventListener("click", () => void doHidePullRequest(item, 7));
      return [forever, week];
    }

    // The hidden ones come from the same endpoint, asked for with
    // includeHidden, so there is no second list to keep in step.
    async function loadHiddenList() {
      if (!hiddenList) return;
      const data: DashboardSnapshot | null = await fetch(
        "/api/dashboard?includeHidden=true",
        { headers: { Accept: "application/json" } },
      )
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
      if (!data) return;
      const hidden = (data.pullRequests || []).filter((p) => p.hidden);
      hiddenList.replaceChildren(
        ...hidden.map((pr) => {
          const item = el("li", "hidden-prs-item");
          item.appendChild(
            el(
              "span",
              "hidden-prs-name",
              `${pr.repo} #${pr.number} ${pr.title}`,
            ),
          );
          item.appendChild(
            el("span", "hidden-prs-when", comesBack(pr.hiddenUntil)),
          );
          const restore = buttonEl("hidden-prs-restore", "Restore");
          restore.type = "button";
          restore.setAttribute("aria-label", `Restore ${nameOf(pr)}`);
          restore.addEventListener("click", () => void doRestore(pr));
          item.appendChild(restore);
          return item;
        }),
      );
    }

    function syncPauseControl() {
      pauseUpdatesButton?.setAttribute("aria-pressed", String(updatesPaused()));
      if (pausedHint) pausedHint.hidden = !updatesPaused();
    }

    function markUpdated(keys: string[]) {
      for (const key of keys) {
        updatedMarkers.add(key);
        setTimeout(() => {
          updatedMarkers.delete(key);
          document
            .querySelectorAll<HTMLElement>("#pr-rows .row")
            .forEach((row) => {
              if (row.dataset.prKey === key)
                row.querySelector(".updated-just-now")?.remove();
            });
        }, UPDATED_MARKER_MS);
      }
    }

    // Applies whatever is pending (or just re-sorts what's shown) without
    // rendering; the caller renders once. Called before any user-driven
    // filter, sort or page change.
    // A failure line is attached to its row, so it goes when the row does:
    // when the board actually drops the pull request, not when one snapshot
    // happens to leave it out while the row is still on screen (#918).
    function retireFailuresOfRemoved(next: PullRequestItem[]) {
      const keep = new Set(next.map((p) => prKey(p)));
      for (const p of shownPRs)
        if (!keep.has(prKey(p))) feedback.dropFailedFor(prKey(p), "");
    }

    function applyPendingNow() {
      const sorted = Filters.sortItems(rawPRs, sharedState.view.sort);
      retireFailuresOfRemoved(sorted);
      shownPRs = sorted;
      prBoard.replaceItems(shownPRs);
      latestPRs = null;
      latestIsUserAsked = false;
    }

    function applyPendingIssuesNow() {
      shownIssues = Filters.sortItems(rawIssues, sharedState.view.sort);
      issueBoard.replaceItems(shownIssues);
      latestIssues = null;
      latestIssuesAsked = false;
    }

    // Below the top (a little slack for a resting scroll position) or a
    // control in the list has focus: rows must not move under the reader.
    function issuesHoldBoard(userAsked: boolean): boolean {
      if (userAsked) return false;
      const scrolled = window.scrollY > 8;
      const focusInList = Boolean(
        document.activeElement?.closest("#issue-rows"),
      );
      return (
        scrolled ||
        focusInList ||
        pointerRestsOnList() ||
        otherModalOpen() ||
        updatesPaused()
      );
    }

    // Replaces just these rows, keeping every other row's DOM node.
    function replaceIssueRows(items: IssueItem[]) {
      for (const item of items) {
        const key = prKey(item);
        const old = Array.from(
          document.querySelectorAll<HTMLElement>(
            "#issue-rows [data-issue-key]",
          ),
        ).find((row) => row.dataset.issueKey === key);
        if (!old) continue;
        old.replaceWith(
          buildRow(item, false, handleLabelClick, sharedState.shared.label),
        );
      }
    }

    // Whether the issues board has been drawn at least once. With no issues the
    // first snapshot has nothing to add, so without this the empty state would
    // never show (#1228).
    let issuesDrawn = false;

    // Returns true when it rendered the board.
    function reconcileIssues(): boolean {
      if (!latestIssues) {
        return false;
      }
      const userAsked = latestIssuesAsked || shownIssues.length === 0;
      // Only what the list would show counts: a change to an issue the
      // filters or the hidden-by-default housekeeping flag keep off screen
      // moves nothing, so it waits for nothing (#1198).
      const onList = (items: IssueItem[]) =>
        items.filter((item) =>
          Filters.matchesFilters(
            item,
            false,
            sharedState.shared,
            sharedState.issue,
          ),
        );
      const diff = Filters.diffItems(onList(shownIssues), onList(latestIssues));
      const structural = diff.added + diff.removed + diff.moved;

      if (structural === 0 && diff.changed.length === 0) {
        // Nothing on screen differs, but the rows off screen may. Keep them
        // current so a filter change later shows fresh data, without drawing.
        shownIssues = latestIssues;
        latestIssues = null;
        if (!issuesDrawn) {
          issuesDrawn = true;
          issueBoard.setItems(shownIssues, true);

          return true;
        }
        issueBoard.replaceItems(shownIssues);

        return false;
      }
      const held = issuesHoldBoard(userAsked);
      if (!held && (structural > 0 || userAsked)) {
        if (!userAsked) announceListUpdate(diff);
        shownIssues = latestIssues;
        latestIssues = null;
        latestIssuesAsked = false;
        issuesDrawn = true;
        keepFocusAcross(() => issueBoard.setItems(shownIssues, true));

        return true;
      }
      // Anything else lands only as content changes, each row where it
      // stands; structural changes (held here) land when the hold lifts.
      if (diff.changed.length > 0) {
        const fresh = new Map(latestIssues.map((i) => [prKey(i), i]));
        const changed = shownIssues
          .filter((i) => diff.changed.includes(prKey(i)))
          .map((i) => fresh.get(prKey(i)) ?? i);
        shownIssues = shownIssues.map((i) => fresh.get(prKey(i)) ?? i);
        replaceIssueRows(changed);
      }
      if (structural === 0) latestIssues = null;

      return diff.changed.length > 0;
    }

    function ingestIssues(issues: IssueItem[], userAsked: boolean) {
      rawIssues = issues;
      latestIssues = Filters.sortItems(issues, sharedState.view.sort);
      latestIssuesAsked = latestIssuesAsked || userAsked;
      reconcileIssues();
    }

    // Pull requests whose bot request a snapshot just moved on (#787). The
    // row already says so, so its data has to agree even while another
    // row's action holds the board.
    const botResolvedKeys = new Set<string>();

    // Redraws rows without dropping the button the user is on: a request's
    // record arriving changes the row's data (#982) but not what the
    // focused button says, so a keyboard user keeps their place.
    function keepFocusAcross(draw: () => void) {
      const anchor = captureScrollAnchor();
      const active = document.activeElement;
      // A row's open button has a stable id, so focus on it survives a row
      // being rebuilt, even when its title (and so its text) changed.
      const activeId =
        active instanceof HTMLElement && active.closest("#pr-rows, #issue-rows")
          ? active.id
          : "";
      const key =
        active instanceof HTMLButtonElement
          ? active.closest<HTMLElement>("#pr-rows .row")?.dataset.prKey
          : undefined;
      const label = active?.textContent;
      const className = active?.className;
      draw();
      restoreScrollAnchor(anchor);
      if (activeId) {
        const same = document.getElementById(activeId);
        if (same) {
          same.focus({ preventScroll: true });
          return;
        }
      }
      if (!key) return;
      const row = Array.from(
        document.querySelectorAll<HTMLElement>("#pr-rows .row"),
      ).find((r) => r.dataset.prKey === key);
      Array.from(row?.querySelectorAll("button") ?? [])
        .find((b) => b.className === className && b.textContent === label)
        ?.focus({ preventScroll: true });
    }

    // Every row is rebuilt on a render, so the browser's own scroll
    // anchoring has no node to hold on to and a row inserted above the
    // viewport would push the reader's place down. Remember the first row
    // on screen and where it was, and scroll by however far it moved. Keeping
    // each unchanged row's node instead would mean every row builder stays
    // free of hidden state, which this board does not promise.
    // Candidates in order of preference: the first row on screen, the rows
    // below it, then the rows above, so a snapshot that removes the anchor
    // itself still has a surviving row to hold on to.
    type ScrollAnchor = { key: string; top: number }[] | null;
    function rowKeyOf(row: HTMLElement): string | undefined {
      return row.dataset.prKey ?? row.dataset.issueKey;
    }
    function captureScrollAnchor(): ScrollAnchor {
      if (window.scrollY <= 0) return null;
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(
          "#pr-rows .row, #issue-rows .row",
        ),
      ).flatMap((row) => {
        const key = rowKeyOf(row);
        const rect = row.getBoundingClientRect();
        return key ? [{ key, top: rect.top, bottom: rect.bottom }] : [];
      });
      const first = rows.findIndex((r) => r.bottom > 0);
      if (first < 0) return null;
      return [...rows.slice(first), ...rows.slice(0, first).reverse()].slice(
        0,
        60,
      );
    }
    function restoreScrollAnchor(anchor: ScrollAnchor) {
      if (!anchor) return;
      const now = new Map<string, HTMLElement>();
      for (const row of document.querySelectorAll<HTMLElement>(
        "#pr-rows .row, #issue-rows .row",
      )) {
        const key = rowKeyOf(row);
        if (key && !now.has(key)) now.set(key, row);
      }
      for (const candidate of anchor) {
        const row = now.get(candidate.key);
        if (!row) continue;
        const delta = row.getBoundingClientRect().top - candidate.top;
        if (Math.abs(delta) >= 0.5) {
          window.scrollBy(0, delta);
          ownScrollY = window.scrollY;
        }
        return;
      }
    }

    // Returns true when it rendered the board.
    function reconcilePRs(): boolean {
      if (!latestPRs) {
        return false;
      }
      // Whether the newest snapshot still has the open dialog's pull request,
      // held or not, so it is never left saying "gone" once it is back.
      if (dialogKey !== null) {
        const key = dialogKey;
        const fresh = latestPRs.find((p) => prKey(p) === key);
        dialogGone = !fresh;
        // The board behind the dialog may be held, so this reads the newest
        // snapshot: a later updatedAt means the details on show are stale.
        if (fresh && fresh.updatedAt > dialogUpdatedAt) {
          const seen = fresh.updatedAt;
          dialogUpdatedAt = seen;
          // A refresh that failed is tried again on the next snapshot.
          void detailsDialog?.reload().then((ok) => {
            if (!ok && dialogUpdatedAt === seen) dialogUpdatedAt = "";
          });
        }
      }
      // A refresh the user asked for (Refresh now, or the one after their own
      // merge) lands in full even with the pointer on the list: they just
      // clicked a row, and what they are waiting to see is that row's outcome
      // (gone, merged). Holding it would leave a merged pull request on screen.
      const userAsked = latestIsUserAsked || shownPRs.length === 0;
      const diff = Filters.diffItems(shownPRs, latestPRs);
      const structural = diff.added + diff.removed + diff.moved;
      const held = interactionFreezesBoard() || (updatesPaused() && !userAsked);

      if (held) {
        // Rows stay where they are, but a row a bot just acted on takes
        // its fresh data in place: otherwise it reads "Rebasing…" next to
        // a stale "Out of date" until the other row's action ends (#787).
        const fresh = new Map(latestPRs.map((p) => [prKey(p), p]));
        // The open dialog shows its own pull request as it is now; only the
        // list behind it waits.
        const settled = shownPRs.filter(
          (p) =>
            (botResolvedKeys.has(prKey(p)) ||
              (prKey(p) === dialogKey && diff.changed.includes(prKey(p)))) &&
            fresh.has(prKey(p)),
        );
        botResolvedKeys.clear();
        if (settled.length > 0) {
          const settledKeys = new Set(settled.map(prKey));
          shownPRs = shownPRs.map((p) =>
            settledKeys.has(prKey(p)) ? (fresh.get(prKey(p)) ?? p) : p,
          );
          keepFocusAcross(() => prBoard.setItems(shownPRs, true));
        }

        refreshDialogChrome();

        return settled.length > 0;
      }
      botResolvedKeys.clear();
      if (userAsked) {
        retireFailuresOfRemoved(latestPRs);
        shownPRs = latestPRs;
        latestPRs = null;
        latestIsUserAsked = false;
        keepFocusAcross(() => prBoard.setItems(shownPRs));

        return true;
      }
      if (structural > 0 && !pointerRestsOnList()) {
        // Rows came, went or moved and nothing would be disturbed: the whole
        // snapshot lands in one render, a changed row marked as usual. Only
        // what the filters show is announced.
        const onList = (items: PullRequestItem[]) =>
          items.filter((item) =>
            Filters.matchesFilters(
              item,
              true,
              sharedState.shared,
              sharedState.pr,
            ),
          );
        const shownDiff = Filters.diffItems(
          onList(shownPRs),
          onList(latestPRs),
        );
        retireFailuresOfRemoved(latestPRs);
        shownPRs = latestPRs;
        latestPRs = null;
        markUpdated(diff.changed);
        keepFocusAcross(() => prBoard.setItems(shownPRs, true));
        if (view !== "issues") announceListUpdate(shownDiff);

        return true;
      }
      // Otherwise only content changes land, each row where it stands;
      // rows added, removed or moved wait for the pointer to leave.
      if (diff.changed.length > 0) {
        const fresh = new Map(latestPRs.map((p) => [prKey(p), p]));
        shownPRs = shownPRs.map((p) => fresh.get(prKey(p)) ?? p);
        markUpdated(diff.changed);
        keepFocusAcross(() => prBoard.setItems(shownPRs, true));
      }
      if (structural === 0) latestPRs = null;

      return diff.changed.length > 0;
    }

    function ingestPRs(
      prs: PullRequestItem[],
      userAsked: boolean,
      botChanged: Set<string>,
    ) {
      for (const key of botChanged) botResolvedKeys.add(key);
      rawPRs = prs;
      latestPRs = Filters.sortItems(prs, sharedState.view.sort);
      latestIsUserAsked = latestIsUserAsked || userAsked;
      reconcilePRs();
    }

    // Every merge/update-branch/Dependabot/Renovate/menu call site
    // re-renders the PR board through here, not prBoard.render()
    // directly, so a snapshot held by the guard lands the instant the
    // interaction that held it is over. The second pass is for the
    // re-render itself dropping focus from a row the user just left.
    function renderPRBoard() {
      if (reconcilePRs()) return;
      prBoard.render();
      reconcilePRs();
    }

    function doRenovateRebase(
      item: PullRequestItem,
      button: HTMLButtonElement,
    ) {
      const key = prKey(item);
      renovateRebaseState[key] = {
        phase: "queued",
        queued: queuedRequestInfo(item),
      };
      markPending(button, true);
      button.textContent = queuedBotLabel(true);
      const fkey = `renovate:${key}`;
      feedback.start({
        actionKey: fkey,
        ref: actionRef(item),
        label: "Renovate: Rebase",
        kind: "bot-rebase",
        phase: "queued",
        inline: "Renovate rebase requested",
        message: "Renovate rebase requested.",
        bot: botLineInfo("Renovate"),
        retry: () => doRenovateRebase(item, buttonEl("row-action")),
      });

      // Stays "queued" until the next snapshot, same as Dependabot.
      const requested = (alreadyTicked = false) => {
        confirmRequest(renovateRebaseState, key);
        feedback.update(fkey, {
          toast: true,
          ...(alreadyTicked && { message: "Rebase requested." }),
          announce: requestedAnnouncement("bot-rebase", "Renovate"),
        });
        renderPRBoard();
      };

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
          return readActionFailure(res).then((err) => {
            throw err;
          });
        })
        .then(() => requested())
        .catch((err: ActionRequestError) => {
          // The body's checkbox was already ticked: someone, or an earlier
          // click, got there first. That is the state the user asked for.
          if (err.code === "already_requested") {
            requested(true);
            return;
          }
          renderActionRefusal(
            item,
            err,
            fkey,
            "ask Renovate to rebase",
            (next) => {
              renovateRebaseState[key] = next;
            },
          );
        });
    }

    function renovateRebaseActionCell(
      item: PullRequestItem,
    ): HTMLElement | null {
      const offered = findAction(item, "renovate_rebase");
      if (!offered) return null;

      const key = prKey(item);
      const entry = renovateRebaseState[key] || { phase: "idle" };

      if (entry.phase === "locked")
        return lockedActionButton("Renovate: Rebase", lockOf(entry));

      if (entry.phase === "idle") {
        const proactiveReason = proactiveActionLockReason(item.forge);
        if (readOnlyBecauseRateLimited(proactiveReason)) return null;
        if (proactiveReason)
          return lockedActionButton("Renovate: Rebase", proactiveReason);
      }

      const queued = entry.phase === "queued" || entry.phase === "rebasing";

      // Renovate's rebase box is ticked, here or on the forge, so one is
      // already waiting: the server blocks a second and says why (#1349).
      // Shown disabled, the reason first and what happens next under it, as
      // Merge's is. A request made through this page has its own pending
      // button below, which says the same in fewer words, so this is for the
      // box someone ticked elsewhere. It clears on the next snapshot once
      // Renovate has rebased.
      if (offered.blocked && !queued)
        return lockedActionButton(
          "Renovate: Rebase",
          { reason: offered.blocked.message, code: offered.blocked.code },
          undefined,
          offered.blocked.next ?? "",
        );

      const button = buttonEl(
        "row-action",
        queued ? queuedBotLabel(true) : "Renovate: Rebase",
      );
      markPending(button, queued);
      button.addEventListener("click", () => {
        if (isPending(button)) return;
        doRenovateRebase(item, button);
      });
      return button;
    }

    // ---- queue a safe action for the rate limit reset (#756) ----
    // While a forge's REST budget is spent its row is read-only (#755), and
    // the one thing still worth offering is to do the safe, idempotent part
    // later: Update branch, or a Dependabot or Renovate rebase. The server
    // keeps the queue, re-reads the pull request at the reset and runs the
    // action only if it still applies. Merge and Close are never offered
    // here: running them unattended is the case to avoid.
    const QUEUE_LABELS: Record<QueuedActionItem["action"], string> = {
      update_branch: "Update branch",
      dependabot_rebase: "Dependabot rebase",
      renovate_rebase: "Renovate rebase",
    };
    const QUEUE_VERBS: Record<QueuedActionItem["action"], string> = {
      update_branch: "update",
      dependabot_rebase: "rebase",
      renovate_rebase: "rebase",
    };

    // What can be queued on this row, if anything: an action the server
    // lists as usable, and a pull request that is behind.
    function queueableAction(
      item: PullRequestItem,
    ): QueuedActionItem["action"] | null {
      if (!item.behind) return null;
      for (const action of [
        "update_branch",
        "dependabot_rebase",
        "renovate_rebase",
      ] as const) {
        const offered = findAction(item, action);
        if (offered && !offered.blocked) return action;
      }
      return null;
    }

    function queuedText(q: QueuedActionItem): string {
      switch (q.status) {
        case "queued":
          return `${QUEUE_LABELS[q.action]} queued for ${formatTime(q.runAt)}`;
        case "done":
          return `${QUEUE_LABELS[q.action]} done`;
        case "skipped":
          return `${QUEUE_LABELS[q.action]} skipped: ${q.message ?? "it no longer applied"}`;
        default:
          return `${QUEUE_LABELS[q.action]} failed: ${q.message ?? "the forge refused it"}`;
      }
    }

    // The waiting chip for an action queued for the reset, with Cancel
    // inside it (#1229). The offer to queue is queueActionCell's.
    function queuedWaitChip(item: PullRequestItem): HTMLElement | null {
      const queued = item.queued;
      if (!queued) return null;
      const chip = queuedChip({
        time: formatClock(queued.runAt),
        at: formatTime(queued.runAt),
        verb: QUEUE_VERBS[queued.action],
      });
      const cancel = buttonEl("row-action wait-chip-action", "Cancel");
      cancel.type = "button";
      cancel.setAttribute(
        "aria-label",
        `Cancel queued ${QUEUE_VERBS[queued.action]} for ${item.repo}#${item.number}`,
      );
      cancel.addEventListener("click", () => cancelQueued(queued));
      const resets = el("span", "queued-resets", resetsInText(queued.runAt));
      resets.setAttribute("aria-hidden", "true");
      resets.dataset.runAt = queued.runAt;
      return buildWaitChip(chip, {
        source: "queued",
        subject: `${item.repo}#${item.number}`,
        button: cancel,
        resets,
      });
    }

    function resetsInText(runAt: string): string {
      const minutes = Math.max(
        0,
        Math.ceil((Date.parse(runAt) - Date.now()) / 60_000),
      );
      return minutes === 0 ? "Resetting now" : `Resets in ${minutes}m`;
    }

    function queueActionCell(item: PullRequestItem): HTMLElement | null {
      if (item.queued) return null;
      // Only while the forge's REST budget is spent: with budget left the
      // direct button is there, and there is nothing to wait for.
      const lock = proactiveActionLockReason(item.forge);
      if (lock?.code !== "rate_limited") return null;
      const action = queueableAction(item);
      if (!action) return null;
      const health = lastForges.find((f) => f.forge === item.forge);
      if (!isRateLimited(health?.rateLimitREST)) return null;
      const resets = health?.rateLimitREST?.resetsAt ?? "";
      const button = buttonEl(
        "row-action",
        `Queue ${QUEUE_VERBS[action]} for ${formatTime(resets)}`,
      );
      button.type = "button";
      button.addEventListener("click", () =>
        queueForReset(item, action, button),
      );
      return button;
    }

    function queueForReset(
      item: PullRequestItem,
      action: QueuedActionItem["action"],
      button: HTMLButtonElement,
    ) {
      button.disabled = true;
      fetch("/api/queued-actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          action,
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
          if (res.status === 201 || res.status === 200)
            return res.json().then((q: QueuedActionItem) => {
              feedback.announce(
                `${queuedText(q)} for ${item.repo}#${item.number}.`,
              );
              return refreshDashboardNow();
            });
          return readActionFailure(res).then((err) => {
            throw err;
          });
        })
        .catch((err: Error) => {
          button.disabled = false;
          showError(
            `Couldn't queue the ${QUEUE_VERBS[action]} for ${item.repo}#${item.number}: ${err.message}`,
          );
        });
    }

    function cancelQueued(q: QueuedActionItem) {
      fetch(`/api/queued-actions/${encodeURIComponent(q.id)}`, {
        method: "DELETE",
        headers: { Accept: "application/json" },
      })
        .then((res) => {
          if (res.status === 401) {
            window.location.href = "/login.html";
            throw new Error("session expired");
          }
          if (!res.ok && res.status !== 404)
            throw new Error(`backend answered ${res.status}`);
          feedback.announce(
            q.status === "queued"
              ? `Cancelled ${QUEUE_LABELS[q.action]} for ${q.fullName}#${q.number}.`
              : "Cleared.",
          );
          return refreshDashboardNow();
        })
        .catch((err: Error) => {
          showError(`Couldn't cancel the queued action: ${err.message}`);
        });
    }

    // The Activity panel's list of queued actions, and the one polite toast
    // for each outcome that arrives while the page is open. What was
    // already final when the page loaded is only listed.
    const announcedQueued = new Set<string>();
    let queuedSeen = false;

    function syncQueuedActions(items: QueuedActionItem[]) {
      for (const q of items) {
        if (q.status === "queued" || announcedQueued.has(q.id)) continue;
        announcedQueued.add(q.id);
        if (!queuedSeen) continue;
        const text = `${queuedText(q)}.`;
        feedback.notify({
          title: `${q.fullName}#${q.number}`,
          message: text,
          announce: `${q.fullName}#${q.number}: ${text}`,
        });
      }
      queuedSeen = true;
      const wrap = document.getElementById("activity-queued");
      const list = document.getElementById("activity-queued-list");
      if (!wrap || !list) return;
      wrap.hidden = items.length === 0;
      list.replaceChildren();
      for (const q of items) {
        const li = el("li", "activity-queued-item");
        li.dataset.status = q.status;
        li.appendChild(
          el("span", "activity-queued-ref", `${q.fullName}#${q.number}`),
        );
        li.appendChild(document.createTextNode(" "));
        li.appendChild(el("span", "activity-queued-text", queuedText(q)));
        const button = buttonEl(
          "row-action",
          q.status === "queued" ? "Cancel" : "Clear",
        );
        button.type = "button";
        button.setAttribute(
          "aria-label",
          `${q.status === "queued" ? "Cancel" : "Clear"} ${QUEUE_LABELS[q.action]} for ${q.fullName}#${q.number}`,
        );
        button.addEventListener("click", () => cancelQueued(q));
        li.appendChild(button);
        list.appendChild(li);
      }
    }

    // ---- pipeline checks panel ----
    // The per-check status labels (CHECK_STATE_LABELS) are distinct from
    // CI_LABELS above, which only ever describes the combined, row-level
    // CIStatus, never one individual job.
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

    // Which row's dialog this is — closing it (via Escape, a backdrop
    // click, or the close button itself) moves focus back to that row's
    // own CI pill, the same "return focus to what opened
    // it" contract every other transient UI in this file already honors
    // (see retryLockedAction moving focus back to a just-re-rendered
    // locked button). Not a direct element reference: a later render
    // rebuilds the whole row from scratch (applySnapshot's own 30s poll,
    // or this very dialog's own "close" handler below), which leaves any
    // node reference captured at open time stale — refocusing by
    // pipelineActionCell's own stable id, once the rebuild has happened,
    // is what actually reaches the live node.
    let pipelineDialogRowKey: string | null = null;

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

    // A required check that failed (or timed out), or a required workflow
    // held for approval, is what actually blocks the merge — flagged in text,
    // not colour alone (#1946).
    function isBlocking(check: Check): boolean {
      return (
        check.required === true &&
        (check.state === "failure" ||
          check.state === "timed_out" ||
          check.state === "awaiting_approval")
      );
    }

    // One inline glyph per state, so the states differ by shape and not
    // colour alone (#1473). The shapes live in #lib/check-glyphs.js, which
    // the Branches page draws from too.
    function pipelineCheckGlyphs(state: string): SVGElement[] {
      return (CHECK_GLYPHS[state] ?? []).map(({ name, body }) => {
        const svg = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("class", `check-glyph check-glyph-${name}`);
        svg.setAttribute("data-glyph", name);
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.innerHTML = body;
        return svg;
      });
    }

    function pipelineCheckRow(check: Check): HTMLElement {
      const row = el("li", "pipeline-check");
      const status = el("span", `pipeline-check-status ${check.state}`);
      const glyphs = pipelineCheckGlyphs(check.state);
      if (glyphs.length > 0) glyphs.forEach((g) => status.appendChild(g));
      else status.appendChild(el("span", "dot"));
      status.appendChild(
        document.createTextNode(CHECK_STATE_LABELS[check.state] || check.state),
      );
      row.appendChild(status);
      row.appendChild(el("span", "pipeline-check-name", check.name));
      if (check.durationSeconds !== undefined) {
        row.appendChild(
          el(
            "span",
            "pipeline-check-duration",
            formatCheckDuration(check.durationSeconds),
          ),
        );
      }
      if (isBlocking(check)) {
        row.appendChild(el("span", "pipeline-check-flag", "Blocking"));
      }
      // A skipped check never ran — its own page on the forge has
      // nothing to show beyond "this was skipped," which the status
      // label right above already says. No link rather than one that
      // leads nowhere useful. Same reasoning for an empty check.url: a
      // legacy commit status can be set with no target_url at all, and
      // an empty href resolves to the current page — silently sending
      // "View run" to the dashboard's own homepage instead of nowhere.
      if (check.state !== "skipped" && check.url) {
        const link = document.createElement("a");
        link.className = "pipeline-check-link";
        link.href = check.url;
        link.target = "_blank";
        link.rel = "noopener";
        // A held workflow's own page is where GitHub's approve button is.
        const linkText =
          check.state === "awaiting_approval"
            ? "Approve on GitHub"
            : "View run";
        link.textContent = linkText;
        link.setAttribute("aria-label", `${linkText}: ${check.name}`);
        row.appendChild(link);
      }
      if (check.failedStep) {
        row.appendChild(
          el("p", "pipeline-check-step", `Failed step: ${check.failedStep}`),
        );
      }
      // textContent only (el sets it): the log is never parsed as markup.
      if (check.excerpt) {
        const excerpt = el("pre", "pipeline-check-excerpt", check.excerpt);
        excerpt.tabIndex = 0;
        excerpt.setAttribute("aria-label", `Log excerpt: ${check.name}`);
        row.appendChild(excerpt);
      }
      return row;
    }

    function pipelineCheckList(checks: Check[]): HTMLElement {
      const list = el("ul", "pipeline-check-list");
      checks.forEach((check) => list.appendChild(pipelineCheckRow(check)));
      return list;
    }

    function pipelineGroup(title: string, checks: Check[], id: string) {
      const group = el("div", "pipeline-group");
      group.setAttribute("role", "group");
      group.setAttribute("aria-labelledby", id);
      const heading = el(
        "h3",
        "pipeline-group-title",
        `${title} (${checks.length})`,
      );
      heading.id = id;
      group.appendChild(heading);
      group.appendChild(pipelineCheckList(checks));
      return group;
    }

    // The one request behind every "Rerun failed checks" button: the pipeline
    // dialog's and the details dialog's footer. The forge queues the jobs.
    function postRerunChecks(item: PullRequestItem): Promise<void> {
      return fetch("/api/pull-requests/rerun-checks", {
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
      }).then((res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          throw new Error("session expired");
        }
        if (res.status === 204) return;
        return readActionFailure(res).then((err) => {
          throw err;
        });
      });
    }

    // "Rerun failed checks" (#698), shown only where the server lists
    // rerun_checks for this pull request and something actually failed. The
    // forge queues the jobs; the next refresh carries their result.
    function pipelineRerunControl(
      item: PullRequestItem,
      checks: Check[],
    ): HTMLElement | null {
      if (!findAction(item, "rerun_checks")) return null;
      if (!checks.some((c) => c.state === "failure" || c.state === "timed_out"))
        return null;
      const wrap = el("div", "pipeline-rerun");
      const key = prKey(item);
      const button = buttonEl("row-action", "Rerun failed checks");
      button.type = "button";
      const status = el("p", "pipeline-rerun-status");
      status.setAttribute("role", "status");
      // The failure sentence is the alert; Copy sits beside it, outside, so
      // it is not announced again (#1323).
      const failureBox = el("div", "pipeline-rerun-failure");
      const failure = el("p", "pipeline-error");
      failure.setAttribute("role", "alert");
      failureBox.appendChild(failure);
      // Draws the control from the one rerun state the row and the details
      // dialog read too, so a request still in flight or a hold survives the
      // panel closing (#1941). The button is marked pending, not disabled,
      // so it keeps focus and Tab still reaches it (#690).
      const sync = () => {
        const held = rerunQueued(item);
        const state = rerunState[key];
        const sending = state?.phase === "requesting";
        button.textContent = held ? "Rerun queued" : "Rerun failed checks";
        markPending(button, held || sending);
        status.textContent = held
          ? "Rerun queued. The new results show here after the next refresh."
          : sending
            ? "Queuing the rerun…"
            : "";
        for (const extra of failureBox.querySelectorAll(
          ".pipeline-rerun-copy, .feedback-details",
        ))
          extra.remove();
        if (state?.phase === "failed") {
          failure.textContent = state.message;
          failureBox.hidden = false;
          failureBox.appendChild(
            copyButton(state.details, "row-action pipeline-rerun-copy"),
          );
        } else {
          failureBox.hidden = true;
          failure.textContent = "";
        }
      };
      sync();
      button.addEventListener("click", () => {
        if (isPending(button)) return;
        doRerunChecks(item, sync);
      });
      wrap.append(button, status, failureBox);
      return wrap;
    }

    function renderPipelineChecks(checks: Check[], item: PullRequestItem) {
      if (!pipelineDialogBody) return;
      pipelineDialogBody.innerHTML = "";
      if (checks.length === 0) {
        pipelineDialogBody.appendChild(
          el("p", "pipeline-status", "No CI configured for this pull request."),
        );
        return;
      }
      const rerun = pipelineRerunControl(item, checks);
      if (rerun) pipelineDialogBody.appendChild(rerun);
      // Without a single known `required` value the forge told us nothing
      // about branch protection: the flat list, as before.
      if (!checks.some((check) => check.required !== undefined)) {
        pipelineDialogBody.appendChild(pipelineCheckList(checks));
        return;
      }
      // Blocking failures first within Required; a stable sort keeps the
      // forge's own order otherwise.
      const required = checks
        .filter((check) => check.required === true)
        .sort((a, b) => Number(isBlocking(b)) - Number(isBlocking(a)));
      const advisory = checks.filter((check) => check.required === false);
      // Never filed under Advisory on a guess.
      const unknown = checks.filter((check) => check.required === undefined);
      if (required.length)
        pipelineDialogBody.appendChild(
          pipelineGroup("Required", required, "pipeline-group-required"),
        );
      if (advisory.length)
        pipelineDialogBody.appendChild(
          pipelineGroup("Advisory", advisory, "pipeline-group-advisory"),
        );
      if (unknown.length)
        pipelineDialogBody.appendChild(
          pipelineGroup("Status unknown", unknown, "pipeline-group-unknown"),
        );
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
          renderPipelineChecks(data.checks || [], item);
        })
        .catch((err: Error & { status?: number }) => {
          if (token !== pipelineRequestToken) return;
          const message = `Couldn't load pipeline checks for ${item.repo}#${item.number}: ${err.message}`;
          renderPipelineError(message, () => loadPipelineChecks(item));
        });
    }

    function openPipelineDialog(item: PullRequestItem) {
      if (!pipelineDialog) return;
      pipelineDialogRowKey = prKey(item);
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
    // own CI pill no matter which one was used to get
    // here. renderPRBoard() rebuilds the row from scratch first (the same
    // poll-driven rebuild every other row action already lives with), so
    // the refocus below has to find the freshly built node by its stable
    // id rather than holding a reference captured at open time.
    pipelineDialog?.addEventListener("close", () => {
      const rowKey = pipelineDialogRowKey;
      pipelineDialogRowKey = null;
      renderPRBoard();
      if (rowKey) {
        document
          .getElementById(`pipeline-trigger-${domSafeId(rowKey)}`)
          ?.focus();
      }
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

    function modalDialogOpen(): boolean {
      return document.querySelector("dialog[open]") !== null;
    }

    // ---- shared filter state ----
    // One object for forge/repo/label/author/title/created/updated/
    // groupBy, applied to both boards at once, plus the two fields with
    // no equivalent on the other entity type (status,
    // hideDependencyDashboard). allPRs/allIssues is the pool the shared
    // bar's dynamic controls (repo/author/label/title) are populated
    // from — only the current page's own entity type (#1071), though a
    // picked filter still applies to both boards, so it carries over.
    const sharedState = Filters.loadState();
    // The cookie has every pick, including ones an earlier page held back.
    Filters.releaseAllHeld();
    let allPRs: PullRequestItem[] = [];
    // repos[] from the last snapshot, keyed forge+fullName, for the host
    // chip and sync status on a "Group by repository" header (#679).
    let reposByKey = new Map<string, Filters.RepoRef>();
    let allIssues: IssueItem[] = [];
    // The latest snapshot's own forges array — mergeActionCell/
    // updateBranchActionCell read this to pre-emptively lock a row's
    // action button when its forge is unreachable or its rate-limit
    // budget is already exhausted.
    let lastForges: Forge[] = [];
    let sharedControlsRestored = false;

    // #353: the cookie above is a fast local cache for this page's very
    // first paint, not the source of truth across devices — this fetch
    // is what makes a second browser see filters set on the first one.
    // Runs in parallel with everything else below, and reconciles into
    // sharedState whichever of "the first dashboard snapshot" or "this
    // resolving" happens second, via sharedControlsRestored below — a
    // real server value always wins, but this page never sits idle
    // waiting for it first.
    const page = Filters.currentPage();
    Filters.loadStateFromServer().then((got) => {
      // Another page has loaded, or this one is gone: its state and touched
      // keys are not ours any more.
      if (destroyed || page !== Filters.currentPage()) return;
      const before = JSON.stringify(sharedState);
      if (got) Filters.applyServerState(sharedState, got);
      // An edit made while the copy loaded was saved on top of the cookie's
      // values; save the merged state so the server keeps the copy's other
      // fields too (#1713).
      if (got && Filters.hasTouched()) Filters.saveState(sharedState);
      syncDraftsPreference();
      // Only when the server's copy actually differs from what the cookie
      // already gave the page: a re-render for nothing replaces every row
      // under the reader (#827).
      if (sharedControlsRestored && JSON.stringify(sharedState) !== before) {
        updateSharedFilterOptions(false, true);
        syncSharedControlsToState();
        applyPendingNow();
        renderBoth();
      }
    });

    // Leave-one-out narrowing (#550): each shared select's own options
    // come from the combined pool filtered by every *other* active
    // shared facet, not by excludeKey's own current selection — or a
    // selected value could exclude itself from its own option list.
    // excludeKey === "" scopes by all four (forge/repo/author/label),
    // which is what the Title datalist wants: free text has no "own
    // selection" to exclude itself from. The pull request board's own
    // fields (CI status, quick pills, Auto-merge) narrow every choice list
    // too, bar the one being populated, so a pick never leaves an empty list
    // and no choice names something the list on screen lacks (#1427). The
    // Issues page's default hiding of a bot's housekeeping issue is in,
    // since a repo with nothing else has nothing to show.
    function sharedPoolExcluding(
      excludeKey: Filters.PoolKey,
      board:
        | "apply"
        | "applyExceptStatus"
        | "applyExceptQuick"
        | "applyExceptAutoMerge" = "apply",
    ): FilterableItem[] {
      // Only this page's own entity: a repo, author or label that exists
      // only on the other page would be an option that matches no row
      // here (#1071).
      const items: FilterableItem[] = pullsView ? allPRs : allIssues;
      // The Issues page hides a bot's housekeeping issue by default, so a
      // repo that has nothing else isn't a choice while it's hidden (#1427).
      const withBoard = pullsView;
      return Filters.optionPool(
        items,
        withBoard,
        sharedState.shared,
        excludeKey,
        pullsView
          ? withBoard
            ? {
                ...sharedState.pr,
                ...(board === "applyExceptStatus" ? { status: "" } : {}),
                ...(board === "applyExceptQuick" ? { quick: "" } : {}),
                ...(board === "applyExceptAutoMerge" ? { autoMerge: "" } : {}),
              }
            : undefined
          : withSettings(sharedState.issue),
      );
    }

    // The items a forge pill is worth clicking for (#1427): choosing a forge
    // clears the repo, author, label and age picks that no longer match, so
    // only the title (which stays) and the board's own CI filter narrow it.
    function forgePillPool(): FilterableItem[] {
      const items: FilterableItem[] = pullsView ? allPRs : allIssues;
      return Filters.optionPool(
        items,
        pullsView,
        { title: sharedState.shared.title ?? "" },
        "",
        pullsView
          ? { ...sharedState.pr, quick: "" }
          : withSettings(sharedState.issue),
      );
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
    // skipTitleSuggestions: set while someone types in the title box, so the
    // suggestion list isn't rebuilt under them (#1427).
    // holdPicks: this is the page reconciling its saved picks with what it
    // offers (the first snapshot, the server's copy), so a pick it does not
    // offer is cleared here only, and stays in the saved copy for the page
    // that does (#1620). A later change that makes a pick stale is the
    // user's own, and clears it for good.
    function updateSharedFilterOptions(
      skipTitleSuggestions = false,
      holdPicks = !sharedControlsRestored,
    ) {
      const staleRepo = Filters.populateRepoSelect(
        document.getElementById(
          "shared-repo-select",
        ) as HTMLSelectElement | null,
        sharedPoolExcluding("repo"),
        sharedState.shared.repo,
      );
      const staleAuthor = Filters.populateSelect(
        document.getElementById(
          "shared-author-select",
        ) as HTMLSelectElement | null,
        Filters.distinctValues(
          (item) => item.author,
          sharedPoolExcluding("author"),
        ),
        sharedState.shared.author,
      );
      if (!skipTitleSuggestions)
        Filters.populateDatalist(
          document.getElementById(
            "shared-title-options",
          ) as HTMLDataListElement | null,
          Filters.distinctValues((item) => item.title, sharedPoolExcluding("")),
        );
      const staleLabel = Filters.populateSelect(
        document.getElementById(
          "shared-label-select",
        ) as HTMLSelectElement | null,
        Filters.distinctValues(
          (item) => (item.labels || []).map((l) => l.name),
          sharedPoolExcluding("label"),
        ),
        sharedState.shared.label,
      );
      // The fixed choices offer only what the results have too (#1427): the
      // age ranges something falls in, and the CI states pull requests are in.
      const staleCreated = populateEvery(
        'select[data-col="created"]',
        Filters.ageChoices(sharedPoolExcluding("created"), "createdAt"),
        sharedState.shared.created,
      );
      const staleUpdated = populateEvery(
        'select[data-col="updated"]',
        Filters.ageChoices(sharedPoolExcluding("updated"), "updatedAt"),
        sharedState.shared.updated,
      );
      const staleStatus =
        pullsView &&
        populateEvery(
          'select[data-col="status"]',
          Filters.ciChoices(sharedPoolExcluding("", "applyExceptStatus")),
          sharedState.pr.status,
        );
      updateGroupByOptions();
      const clearPick = (
        stale: boolean,
        group: "shared" | "pr",
        key: string,
      ) => {
        if (!stale) return;
        if (holdPicks) Filters.holdStale(sharedState, group, key);
        else {
          Filters.releaseHeld(group, key);
          sharedState[group][key] = "";
        }
      };
      clearPick(staleRepo, "shared", "repo");
      clearPick(staleAuthor, "shared", "author");
      clearPick(staleLabel, "shared", "label");
      clearPick(staleCreated, "shared", "created");
      clearPick(staleUpdated, "shared", "updated");
      clearPick(Boolean(staleStatus), "pr", "status");
      if (
        !holdPicks &&
        (staleRepo ||
          staleAuthor ||
          staleLabel ||
          staleCreated ||
          staleUpdated ||
          staleStatus)
      )
        Filters.saveState(sharedState);
      // A quick pill is offered only if clicking it would show something
      // (#1427); the one active stays. Worked out after the stale picks are
      // cleared, since the pools are built from what is left.
      if (pullsView)
        Filters.offerAutoMerge(
          document.querySelectorAll<HTMLElement>(".am-group"),
          sharedPoolExcluding("", "applyExceptAutoMerge"),
          sharedState.pr.autoMerge ?? "",
        );
      Filters.offerPills(
        document.querySelectorAll<HTMLElement>(".quick-pill"),
        forgePillPool(),
        sharedPoolExcluding("forge", "applyExceptQuick"),
        Filters.activePill(sharedState),
      );
    }

    // The same control can sit in the bar or in the Filters sheet (#828), so
    // every match gets the choices. True if the pick was stale in any of them.
    function populateEvery(
      selector: string,
      choices: Filters.Choice[],
      previous: string,
    ): boolean {
      let stale = false;
      for (const select of document.querySelectorAll<HTMLSelectElement>(
        selector,
      ))
        if (Filters.populateChoices(select, choices, previous)) stale = true;
      return stale;
    }

    // Restores the shared bar's controls to match the filters just
    // loaded from the cookie. Only meaningful once real items exist:
    // repo/author/label are dynamic <select>s populated from what's on
    // screen. Runs once, right after the first combined item set — a
    // later refresh must never repeat it, or it would stomp the title
    // filter back to its lowercase canonical form over whatever case
    // the user is mid-typing.
    // The shared controls, wherever they currently are: in the bar, or in
    // the Filters sheet while it's open (#828).
    const FILTER_CONTROLS =
      ".filter-bar .col-filter, #filter-sheet .col-filter";

    function syncSharedControlsToState() {
      syncQuickPills();
      syncAutoMerge();
      document
        .querySelectorAll<HTMLInputElement | HTMLSelectElement>(FILTER_CONTROLS)
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
      const titleRegexField = document.getElementById(
        "issue-hide-title-regex",
      ) as HTMLInputElement | null;
      if (titleRegexField)
        titleRegexField.value = sharedState.issue.hideTitleRegex ?? "";
      const hideDependencyDashboardField = document.getElementById(
        "issue-hide-dependency-dashboard",
      ) as HTMLInputElement | null;
      if (hideDependencyDashboardField)
        hideDependencyDashboardField.checked =
          sharedState.issue.hideDependencyDashboard === "1";
      const sortSelect = document.getElementById(
        "pr-sort-select",
      ) as HTMLSelectElement | null;
      if (sortSelect) sortSelect.value = sharedState.view.sort || "";
      syncPauseControl();
    }

    function renderBoth() {
      renderPRBoard();
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
      Filters.touchKey("shared", "label");
      Filters.releaseHeld("shared", "label");
      prBoard.resetPage();
      issueBoard.resetPage();
      Filters.saveState(sharedState);
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

    // ---- board state + render ----
    // Each board (pull requests, issues) owns its own items, pagination,
    // and — for the one field with no equivalent on the other entity
    // type — its own extraState (status for pull requests,
    // hideDependencyDashboard for issues). Everything else it filters
    // and groups by comes from the shared state above.
    type Board = {
      setItems: (
        items: (PullRequestItem | IssueItem)[],
        keepPage?: boolean,
      ) => void;
      // Swaps the list without rendering: a user-driven change applies the
      // pending snapshot, then renders once itself (#710).
      replaceItems: (items: (PullRequestItem | IssueItem)[]) => void;
      render: () => void;
      resetPage: () => void;
      // Show row (#723): the item with this key, if the board holds it, and
      // a move to the page it sits on under the current filters.
      find: (key: string) => (PullRequestItem | IssueItem) | undefined;
      showPageOf: (key: string) => number | null;
    };

    function createBoard(
      containerId: string,
      emptyId: string,
      noResultsId: string,
      isPR: boolean,
      idPrefix: string,
      extraState: Record<string, string>,
      onUserChange?: () => void,
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
      // Forge badge, instance host chip, repo name and sync status
      // (#679). Host and status come from repos[]; a repo missing from
      // it gets neither rather than a guess.
      function appendRepoHeading(
        heading: HTMLElement,
        forge: string,
        repo: string,
      ) {
        const badge = el("span", `forge-badge ${FORGE_CLASSES[forge]}`);
        badge.appendChild(el("span", "dot"));
        badge.appendChild(
          document.createTextNode(FORGE_LABELS[forge] || forge),
        );
        heading.appendChild(badge);
        const info = reposByKey.get(Filters.repoKey(forge, repo));
        const host = Filters.hostFromUrl(info?.url);
        if (host) heading.appendChild(el("span", "group-host", host));
        heading.appendChild(el("span", "group-name", repo));
        if (info) {
          const status = Filters.repoSyncStatus(info);
          heading.appendChild(
            el("span", `group-sync ${status.toLowerCase()}`, status),
          );
        }
      }

      // What goes on screen for these items: stacked pull requests laid out
      // together, everything else as it came (#861).
      function entriesFor(
        items: (PullRequestItem | IssueItem)[],
      ): Stacks.Entry<PullRequestItem | IssueItem>[] {
        if (!isPR)
          return items.map((item) => ({ kind: "single" as const, item }));
        return Stacks.arrange(
          items as PullRequestItem[],
          state.items as PullRequestItem[],
        );
      }

      function appendEntries(
        container: HTMLElement,
        entries: Stacks.Entry<PullRequestItem | IssueItem>[],
      ) {
        const build = (item: PullRequestItem | IssueItem) =>
          buildRow(item, isPR, handleLabelClick, sharedState.shared.label);
        for (const entry of entries) {
          if (entry.kind === "single") {
            container.appendChild(build(entry.item));
            continue;
          }
          // A stack is a plain nested list: its members in order, each
          // saying what it depends on in words (#861).
          const group = el("ul", "stack-group");
          group.setAttribute(
            "aria-label",
            `Stack of ${entry.members.length} pull requests`,
          );
          for (const member of entry.members) {
            const li = el("li", "stack-member");
            const row = build(member.item);
            const position =
              (member.item as PullRequestItem).stack?.position ?? 1;
            li.style.setProperty(
              "--stack-depth",
              String(Math.min(position - 1, 3)),
            );
            if (!member.matched) {
              // Kept so the stack stays whole, but not what was asked for.
              row.classList.add("stack-dim");
              row
                .querySelector(".title-cell")
                ?.appendChild(
                  el("span", "sr-only", "Doesn't match the filters."),
                );
            }
            li.appendChild(row);
            group.appendChild(li);
          }
          container.appendChild(group);
        }
      }

      function renderGrouped(
        container: HTMLElement,
        items: (PullRequestItem | IssueItem)[],
        groupBy: string,
      ) {
        const keyOf =
          groupBy === "forge"
            ? (item: FilterableItem) => FORGE_LABELS[item.forge] || item.forge
            : (item: FilterableItem) => Filters.repoKey(item.forge, item.repo);

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
        // Sorted by what the heading reads, so "forge:" prefixes on a
        // repo key never change the visible order.
        const labelOf = (key: string) => {
          const first = groups[key][0];

          return groupBy === "forge" ? key : first.repo;
        };
        order.sort((a, b) => labelOf(a).localeCompare(labelOf(b)));

        for (const key of order) {
          const first = groups[key][0];
          const heading = document.createElement("h3");
          heading.className = "group-heading";
          if (groupBy === "repo") {
            appendRepoHeading(heading, first.forge, first.repo);
          } else {
            heading.appendChild(document.createTextNode(key));
          }
          heading.appendChild(
            el("span", "group-count", String(groups[key].length)),
          );
          container.appendChild(heading);
          const callout = isPR ? groupAutoMergeCallout(first.forge) : null;
          if (callout) container.appendChild(callout);
          appendEntries(container, entriesFor(groups[key]));
        }
      }

      function setPage(page: number) {
        onUserChange?.();
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

      // What the board filters by: the saved rules, less what Settings
      // replaces (#1630). Pull requests have no such rules.
      function ruleState(): Record<string, string> {
        return isPR ? extraState : withSettings(extraState);
      }

      function render() {
        const container = document.getElementById(containerId);
        if (!container) return;
        const visible = state.items.filter((item) =>
          Filters.matchesFilters(item, isPR, sharedState.shared, ruleState()),
        );

        container.innerHTML = "";
        titleHover.prune();

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
          // Pages hold whole stacks (#861).
          const pages = Stacks.pagesOf(entriesFor(visible), state.pageSize);
          const totalPages = Math.max(1, pages.length);
          if (state.page > totalPages) state.page = totalPages;
          appendEntries(container, pages[state.page - 1] ?? []);
          renderPagination(totalPages);
        }

        const emptyEl = document.getElementById(emptyId);
        if (emptyEl) emptyEl.hidden = state.items.length !== 0;
        const noResults = document.getElementById(noResultsId);
        if (noResults)
          noResults.hidden = visible.length !== 0 || state.items.length === 0;

        if (isPR === pullsView) {
          visibleResultCount = visible.length;
        }
        const count = document.getElementById(`${idPrefix}-count`);
        if (count)
          count.textContent = shownCountText(
            visible.length,
            state.items.length,
          );
        // Every state change this app makes ends in a render() on one
        // or both boards (directly, or via renderBoth()) —
        // updateClearFiltersButton is declared later in this same
        // closure but hoists, so this stays the one place the button's
        // disabled state can go stale.
        renderTitleRuleNotes();
        updateClearFiltersButton();
        // The open details dialog follows its pull request's row.
        if (isPR) refreshDialogChrome();
      }

      const pageSizeSelect = document.getElementById(
        `${idPrefix}-page-size`,
      ) as HTMLSelectElement | null;
      pageSizeSelect?.addEventListener("change", () => {
        onUserChange?.();
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
            onUserChange?.();
            extraState.status = statusSelect.value.trim().toLowerCase();
            Filters.touchKey("pr", "status");
            Filters.releaseHeld("pr", "status");
            state.page = 1;
            Filters.saveState(sharedState);
            // The age ranges are worth choosing only if something in this CI
            // state falls in them (#1427).
            updateSharedFilterOptions();
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
          Filters.touchKey("issue", "hideDependencyDashboard");
          state.page = 1;
          Filters.saveState(sharedState);
          // What it hides or shows changes which repos, authors and labels
          // are worth choosing (#1427).
          updateSharedFilterOptions();
          render();
        });
      }

      // The pattern box feeds the same matchesFilters/optionPool path the
      // checkbox above does, so the list, count, pages and the other filters'
      // choices follow with no second implementation (#1593).
      const titleRegexInput = document.getElementById(
        `${idPrefix}-hide-title-regex`,
      ) as HTMLInputElement | null;
      if (titleRegexInput) {
        titleRegexInput.value = extraState.hideTitleRegex ?? "";
        titleRegexInput.addEventListener("input", () => {
          onUserChange?.();
          extraState.hideTitleRegex = titleRegexInput.value;
          Filters.touchKey("issue", "hideTitleRegex");
          state.page = 1;
          Filters.saveState(sharedState, "hideTitleRegex");
          updateSharedFilterOptions();
          render();
        });
      }

      // What the rule does right now: the error when the pattern can't be
      // used, else how many issues it hides on top of the other filters.
      function renderTitleRuleNotes() {
        const field = document.getElementById(`${idPrefix}-hide-title-regex`);
        const errorEl = document.getElementById(
          `${idPrefix}-hide-title-regex-error`,
        );
        const noteEl = document.getElementById(`${idPrefix}-hide-title-note`);
        if (isPR || !field || !errorEl || !noteEl) return;
        const status = Filters.compileTitleRule(
          ruleState().hideTitleRegex,
        ).status;
        const invalid = status === "invalid" || status === "complex";
        errorEl.hidden = !invalid;
        errorEl.textContent =
          status === "complex"
            ? "That pattern is too complex to check safely. Try a simpler one."
            : status === "invalid"
              ? "That pattern isn't valid."
              : "";
        if (invalid) {
          field.setAttribute("aria-invalid", "true");
          field.setAttribute("aria-describedby", errorEl.id);
        } else {
          field.removeAttribute("aria-invalid");
          field.removeAttribute("aria-describedby");
        }
        const hidden = state.items.filter(
          (item) =>
            Filters.failingFilters(
              item,
              isPR,
              sharedState.shared,
              ruleState(),
            ).join() === "hideTitleRegex",
        ).length;
        noteEl.hidden = hidden === 0;
        noteEl.textContent =
          hidden === 0 ? "" : `${hidden} hidden by this pattern`;
      }

      return {
        setItems: (items, keepPage) => {
          state.items = items;
          if (!keepPage) state.page = 1;
          render();
        },
        replaceItems: (items) => {
          state.items = items;
        },
        render,
        resetPage: () => {
          onUserChange?.();
          state.page = 1;
        },
        find: (key) => state.items.find((item) => prKey(item) === key),
        showPageOf: (key) => {
          // Grouped mode has no pages: every filtered row is on screen.
          if (sharedState.shared.groupBy) return null;
          const visible = state.items.filter((item) =>
            Filters.matchesFilters(item, isPR, sharedState.shared, ruleState()),
          );
          const pages = Stacks.pagesOf(entriesFor(visible), state.pageSize);
          const page =
            pages.findIndex((entries) =>
              entries.some((entry) =>
                entry.kind === "single"
                  ? prKey(entry.item) === key
                  : entry.members.some((m) => prKey(m.item) === key),
              ),
            ) + 1;
          if (page === 0 || page === state.page) return null;
          state.page = page;
          render();
          return page;
        },
      };
    }

    const prBoard = createBoard(
      "pr-rows",
      "pr-empty",
      "pr-no-results",
      true,
      "pr",
      sharedState.pr,
      applyPendingNow,
    );
    const issueBoard = createBoard(
      "issue-rows",
      "issue-empty",
      "issue-no-results",
      false,
      "issue",
      sharedState.issue,
      applyPendingIssuesNow,
    );

    pauseUpdatesButton?.addEventListener("click", () => {
      sharedState.view.paused = updatesPaused() ? "" : "1";
      Filters.touchKey("view", "paused");
      Filters.saveState(sharedState);
      syncPauseControl();
      if (view === "issues") reconcileIssues();
      else reconcilePRs();
    });
    syncPauseControl();
    showDraftsButton?.addEventListener("click", () => {
      sharedState.view.drafts = draftsOn() ? "" : "1";
      Filters.touchKey("view", "drafts");
      Filters.saveState(sharedState);
      syncDraftsPreference();
    });
    syncDraftsToggle();
    // Focus leaving a row (or a dialog closing) lifts the hold. Deferred a
    // tick so document.activeElement has settled on the new target.
    document.getElementById("pr-rows")?.addEventListener("focusout", () => {
      setTimeout(reconcilePRs, 0);
    });
    document.getElementById("issue-rows")?.addEventListener("focusout", () => {
      setTimeout(reconcileIssues, 0);
    });
    // Scrolling back to the top lifts the hold, so what was waiting lands
    // where the reader can see it arrive.
    if (view === "issues") {
      let scrollFrame = 0;
      window.addEventListener(
        "scroll",
        () => {
          if (scrollFrame) return;
          scrollFrame = requestAnimationFrame(() => {
            scrollFrame = 0;
            if (latestIssues) reconcileIssues();
          });
        },
        { passive: true },
      );
    }
    document
      .getElementById("pipeline-dialog")
      ?.addEventListener("close", () => {
        setTimeout(reconcilePRs, 0);
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
          Filters.touchKey("shared", col);
          Filters.releaseHeld("shared", col);
          prBoard.resetPage();
          issueBoard.resetPage();
          // Repo/Author/Label options (and "Group by forge") are scoped
          // to the other active shared facets (leave-one-out, #550), so
          // a change to any of the three — plus Forge, which narrows all
          // three unconditionally — has to re-narrow the others right
          // away rather than waiting for the next poll's setItems
          // (#112). Title stays out of this: it's debounced free text
          // and deliberately suggestions-only, not a restrictive facet.
          // Created and Updated narrow the pool as well (#1427).
          if (
            col === "forge" ||
            col === "repo" ||
            col === "author" ||
            col === "label" ||
            col === "created" ||
            col === "updated"
          )
            updateSharedFilterOptions();
          // The title narrows the pool too, so the choices follow it as it is
          // typed (#1427). Only the suggestions wait: they are rebuilt on the
          // next snapshot.
          else if (col === "title") updateSharedFilterOptions(true);
          // debouncedCol: only Title fires on 'input' per keystroke;
          // every other control here only ever fires on 'change' (a
          // discrete, already-complete pick), so passing col
          // unconditionally is safe — saveState itself only debounces
          // when it's 'title'.
          Filters.saveState(sharedState, col);
          renderBoth();
        };
        c.addEventListener("input", apply);
        c.addEventListener("change", apply);
      });

    // ---- quick filter pills (#678) ----
    // Toggle buttons with aria-pressed: exactly one is active at a time.
    // The pill logic itself lives in #lib/filters (setPill/activePill).
    const quickPills = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".quick-pill"),
    );
    function syncQuickPills() {
      let active = Filters.activePill(sharedState);
      // The issues page has no pull-request-only pills, and they don't
      // filter issues, so All is what's in effect there (#827).
      if (
        view === "issues" &&
        (Filters.QUICK_FILTERS as readonly string[]).includes(active)
      )
        active = "all";
      for (const b of quickPills)
        b.setAttribute("aria-pressed", String(b.dataset.pill === active));
    }
    for (const b of quickPills) {
      b.addEventListener("click", () => {
        Filters.setPill(sharedState, b.dataset.pill ?? "all");
        Filters.touchKey("shared", "forge");
        Filters.touchKey("pr", "quick");
        prBoard.resetPage();
        issueBoard.resetPage();
        updateSharedFilterOptions();
        Filters.saveState(sharedState);
        syncQuickPills();
        renderBoth();
      });
    }
    syncQuickPills();

    // ---- auto-merge segment (#1455) ----
    // On and Off filter on what the forge says; the choice is the pull request
    // board's own (sharedState.pr), so it combines with a quick pill.
    const amButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".am-group [data-am]"),
    );
    function syncAutoMerge() {
      const picked = sharedState.pr.autoMerge || "any";
      for (const b of amButtons)
        b.setAttribute("aria-pressed", String(b.dataset.am === picked));
    }
    for (const b of amButtons) {
      b.addEventListener("click", () => {
        const value = b.dataset.am ?? "any";
        if (value === "any") delete sharedState.pr.autoMerge;
        else sharedState.pr.autoMerge = value;
        Filters.touchKey("pr", "autoMerge");
        prBoard.resetPage();
        updateSharedFilterOptions();
        Filters.saveState(sharedState);
        syncAutoMerge();
        renderBoth();
      });
    }
    syncAutoMerge();

    // "/" focuses the title search, as on GitHub — only when nothing
    // editable has focus and no modifier is held, so typing a slash into
    // a field, or a browser/OS shortcut, is untouched.
    const titleSearch = document.querySelector<HTMLInputElement>(
      '.filter-bar .col-filter[data-col="title"]',
    );
    function onSlashShortcut(e: KeyboardEvent) {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)
        return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable ||
          t instanceof HTMLInputElement ||
          t instanceof HTMLTextAreaElement ||
          t instanceof HTMLSelectElement)
      )
        return;
      if (!titleSearch) return;
      e.preventDefault();
      titleSearch.focus();
    }
    document.addEventListener("keydown", onSlashShortcut);

    const sharedGroupSelect = document.getElementById(
      "shared-group-select",
    ) as HTMLSelectElement | null;
    sharedGroupSelect?.addEventListener("change", () => {
      sharedState.shared.groupBy = sharedGroupSelect.value || "";
      Filters.touchKey("shared", "groupBy");
      prBoard.resetPage();
      issueBoard.resetPage();
      Filters.saveState(sharedState);
      renderBoth();
    });

    // #710: the sort control. Applies any pending snapshot too, in the one
    // render, through prBoard.resetPage's own user-change hook.
    const sortSelect = document.getElementById(
      "pr-sort-select",
    ) as HTMLSelectElement | null;
    if (sortSelect) sortSelect.value = sharedState.view.sort || "";
    sortSelect?.addEventListener("change", () => {
      sharedState.view.sort = sortSelect.value;
      Filters.touchKey("view", "sort");
      prBoard.resetPage();
      issueBoard.resetPage();
      Filters.saveState(sharedState);
      renderBoth();
    });

    // #354: true once nothing in sharedState differs from Filters' own
    // defaultState() — shared is empty, no CI status, no title pattern, and
    // hideDependencyDashboard is back at its default-checked '1'.
    function filtersAreDefault(): boolean {
      return (
        Object.keys(sharedState.shared).every((k) => !sharedState.shared[k]) &&
        !sharedState.pr.status &&
        !sharedState.pr.quick &&
        !sharedState.pr.autoMerge &&
        // A saved pick this page does not offer is still a filter (#1620).
        Filters.heldPicks().length === 0 &&
        // A field the Settings page replaced is not drawn, so what the
        // page saved in it is not something to clear (#1630).
        (settingsHideDependencyDashboard ||
          sharedState.issue.hideDependencyDashboard === "1") &&
        (settingsIgnoreTitles || !sharedState.issue.hideTitleRegex)
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
      renderFilterChrome();
    }

    // ---- phones: the Filters sheet, active-filter chips (#828) ----
    // Below 760px the bar is a search row, one scrolling row of quick
    // filters and chips for what's active. Everything else lives in a
    // bottom sheet (a <dialog>): the controls move into it while it's open
    // and back when it closes, so their ids and handlers are the ones they
    // always had. Filters apply as you change them, and the sheet's "Show
    // N results" says what you'd see, so a refresh can't disturb an edit.
    const phoneQuery = window.matchMedia("(max-width: 760px)");
    const filtersButton = document.getElementById(
      "filters-button",
    ) as HTMLButtonElement | null;
    const filterSheet = document.getElementById(
      "filter-sheet",
    ) as HTMLDialogElement | null;
    const filterControls = document.getElementById("filter-controls");
    const filterSheetBody = document.getElementById("filter-sheet-body");
    const filterSheetShow = document.getElementById(
      "filter-sheet-show",
    ) as HTMLButtonElement | null;
    const filterSheetClear = document.getElementById(
      "filter-sheet-clear",
    ) as HTMLButtonElement | null;
    const activeFiltersEl = document.getElementById("active-filters");
    let filterControlsHome: {
      parent: HTMLElement;
      before: Node | null;
    } | null = null;

    function selectText(col: string, value: string): string {
      const select = document.querySelector<HTMLSelectElement>(
        `.col-filter[data-col="${col}"]`,
      );
      const option = Array.from(select?.options ?? []).find(
        (o) => o.value.toLowerCase() === value,
      );
      return option?.textContent?.trim() || value;
    }

    // Set a shared select back to "all" the way a person would, so the
    // control's own handler applies it and saves it.
    function clearSelect(col: string) {
      const select = document.querySelector<HTMLSelectElement>(
        `.col-filter[data-col="${col}"]`,
      );
      if (!select) return;
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    type FilterChip = { label: string; clear: () => void };

    function activeFilterChips(): FilterChip[] {
      const chips: FilterChip[] = [];
      const shared = sharedState.shared;
      if (shared.forge)
        chips.push({
          label: `Forge ${Filters.FORGE_LABELS[shared.forge] || shared.forge}`,
          clear: () =>
            document
              .querySelector<HTMLButtonElement>('.quick-pill[data-pill="all"]')
              ?.click(),
        });
      if (shared.repo)
        chips.push({
          label: `Repo ${shared.repo.slice(shared.repo.indexOf(":") + 1)}`,
          clear: () => clearSelect("repo"),
        });
      if (shared.author)
        chips.push({
          label: `Author ${shared.author}`,
          clear: () => clearSelect("author"),
        });
      if (shared.label)
        chips.push({
          label: `Label ${shared.label}`,
          clear: () => clearSelect("label"),
        });
      if (shared.created)
        chips.push({
          label: `Created ${selectText("created", shared.created)}`,
          clear: () => clearSelect("created"),
        });
      if (shared.updated)
        chips.push({
          label: `Updated ${selectText("updated", shared.updated)}`,
          clear: () => clearSelect("updated"),
        });
      if (pullsView && sharedState.pr.status)
        chips.push({
          label: `CI ${selectText("status", sharedState.pr.status)}`,
          clear: () => clearSelect("status"),
        });
      if (pullsView && sharedState.pr.autoMerge)
        chips.push({
          label: `Auto-merge ${sharedState.pr.autoMerge}`,
          clear: () =>
            document
              .querySelector<HTMLButtonElement>('.am-group [data-am="any"]')
              ?.click(),
        });
      if (pullsView && draftsOn())
        chips.push({
          label: "Drafts shown",
          clear: () => showDraftsButton?.click(),
        });
      return chips;
    }

    let renderedChips = "";

    // A saved pick this page does not offer is kept for the page that does;
    // say so, with a way to drop it (#1620).
    const heldPicksEl = document.getElementById("held-picks");
    function renderHeldNote() {
      if (!heldPicksEl) return;
      Filters.renderHeldPicks(heldPicksEl, (pick) => {
        Filters.releaseHeld(pick.group, pick.key);
        Filters.touchKey(pick.group, pick.key);
        Filters.saveState(sharedState);
        updateClearFiltersButton();
      });
    }

    function renderFilterChrome() {
      renderHeldNote();
      const chips = activeFilterChips();
      if (filtersButton)
        filtersButton.textContent =
          chips.length > 0 ? `Filters (${chips.length})` : "Filters";
      if (filterSheetShow)
        filterSheetShow.textContent =
          visibleResultCount === 1
            ? "Show 1 result"
            : `Show ${visibleResultCount} results`;
      if (filterSheetClear) filterSheetClear.disabled = filtersAreDefault();

      // Only rebuilt when what's shown would change, so a chip the reader
      // is about to tap isn't replaced under their finger by a refresh.
      const signature = chips.map((c) => c.label).join("|");
      if (!activeFiltersEl || signature === renderedChips) return;
      renderedChips = signature;
      activeFiltersEl.replaceChildren();
      activeFiltersEl.hidden = chips.length === 0;
      for (const chip of chips) {
        const button = el("button", "filter-chip");
        button.setAttribute("type", "button");
        button.setAttribute("aria-label", `Remove filter: ${chip.label}`);
        button.appendChild(el("span", "filter-chip-label", chip.label));
        const x = el("span", "filter-chip-x", "×");
        x.setAttribute("aria-hidden", "true");
        button.appendChild(x);
        button.addEventListener("click", chip.clear);
        activeFiltersEl.appendChild(button);
      }
    }

    function openFilterSheet() {
      if (!phoneQuery.matches || !filterSheet || !filterControls) return;
      filterControlsHome = {
        parent: filterControls.parentElement as HTMLElement,
        before: filterControls.nextSibling,
      };
      filterSheetBody?.appendChild(filterControls);
      filterSheet.showModal();
      filtersButton?.setAttribute("aria-expanded", "true");
    }

    // Closing, however it happens (Escape, the buttons, a tap on the
    // backdrop): the controls go home and focus returns to the button.
    filterSheet?.addEventListener("close", () => {
      if (filterControls && filterControlsHome)
        filterControlsHome.parent.insertBefore(
          filterControls,
          filterControlsHome.before,
        );
      filterControlsHome = null;
      filtersButton?.setAttribute("aria-expanded", "false");
      filtersButton?.focus();
    });
    filtersButton?.addEventListener("click", openFilterSheet);
    filterSheetShow?.addEventListener("click", () => filterSheet?.close());
    document
      .getElementById("filter-sheet-close")
      ?.addEventListener("click", () => filterSheet?.close());
    filterSheetClear?.addEventListener("click", () =>
      document.getElementById("clear-filters-button")?.click(),
    );
    filterSheet?.addEventListener("click", (e) => {
      // A tap on the backdrop (the dialog element itself, outside its box).
      if (e.target === filterSheet) filterSheet.close();
    });
    // Rotating or resizing past the breakpoint with the sheet open puts
    // the controls back in the bar.
    phoneQuery.addEventListener("change", () => {
      if (!phoneQuery.matches && filterSheet?.open) filterSheet.close();
    });

    // Show row (#723): make the row reachable. A row hidden by filters has
    // exactly those filters cleared, and a row on another page gets that
    // page. Says what it did so the feedback line can announce it.
    function revealRow(key: string): RevealOutcome {
      if (view !== "pulls") return { kind: "unavailable" };
      const item = prBoard.find(key);
      if (!item) return { kind: "gone" };
      const failing = Filters.failingFilters(
        item,
        true,
        sharedState.shared,
        sharedState.pr,
      );
      // Each filter is cleared in the group the page keeps it in: the
      // pull-request ones live in sharedState.pr, the rest in shared.
      const prKeys = ["status", "quick", "autoMerge"];
      for (const filter of failing) {
        const group = prKeys.includes(filter) ? "pr" : "shared";
        Filters.touchKey(group, filter);
        sharedState[group][filter] = "";
        Filters.releaseHeld(group, filter);
      }
      if (failing.length > 0) {
        syncQuickPills();
        syncAutoMerge();
        document
          .querySelectorAll<HTMLInputElement | HTMLSelectElement>(
            `${FILTER_CONTROLS}`,
          )
          .forEach((c) => {
            if (
              failing.includes(c.dataset.col ?? "") &&
              !(c instanceof HTMLInputElement && c.type === "radio")
            )
              c.value = "";
          });
        updateSharedFilterOptions();
        prBoard.resetPage();
        issueBoard.resetPage();
        Filters.saveState(sharedState);
        renderBoth();
      }
      const page = prBoard.showPageOf(key);
      return {
        kind: "ready",
        cleared: failing.map((f) => Filters.FILTER_NAMES[f] ?? f),
        page,
      };
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
      // The page's own saved values for a field the Settings page replaced
      // stay: they come back when the setting is turned off (#1630).
      const keptDependencyDashboard = sharedState.issue.hideDependencyDashboard;
      const keptTitleRegex = sharedState.issue.hideTitleRegex;
      for (const k of Object.keys(sharedState.issue))
        delete sharedState.issue[k];
      sharedState.issue.hideDependencyDashboard =
        settingsHideDependencyDashboard
          ? (keptDependencyDashboard ?? "1")
          : "1";
      if (settingsIgnoreTitles && keptTitleRegex)
        sharedState.issue.hideTitleRegex = keptTitleRegex;
      Filters.releaseAllHeld();
      Filters.touchAll();
      syncQuickPills();
      syncAutoMerge();

      document
        .querySelectorAll<HTMLInputElement | HTMLSelectElement>(FILTER_CONTROLS)
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
      if (hideDependencyDashboardCheckbox && !settingsHideDependencyDashboard)
        hideDependencyDashboardCheckbox.checked = true;
      const hideTitleRegexInput = document.getElementById(
        "issue-hide-title-regex",
      ) as HTMLInputElement | null;
      if (hideTitleRegexInput && !settingsIgnoreTitles)
        hideTitleRegexInput.value = "";

      updateSharedFilterOptions();
      prBoard.resetPage();
      issueBoard.resetPage();
      Filters.saveState(sharedState);
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

    // What the health live region says: each forge's reachability, and
    // whether a budget is spent or running low. The counts and times in the
    // visible pill change on every poll and are left out, so an unchanged
    // state yields the same string.
    function healthAnnouncement(forges: Forge[]): string {
      return forges
        .map((f) => {
          const name = FORGE_LABELS[f.forge] || f.forge;
          const limited =
            isRateLimited(f.rateLimitREST) || isRateLimited(f.rateLimitGraphQL);
          // A spent budget outranks a low one, so the text changes at low
          // and again at spent, never on the count in between.
          // The band is spoken with it, so a drain from under 5% to under 1%
          // is told as it happens and the count inside a band is not.
          const lows = [f.rateLimitREST, f.rateLimitGraphQL].filter(
            (l): l is RateLimit => l?.severity === "low",
          );
          const band = lows
            .map((l) => remainingBand(l))
            .filter((b): b is string => b !== null)
            .sort((a, b) => parseInt(a.slice(6)) - parseInt(b.slice(6)))[0];
          return (
            name +
            (f.reachable ? " reachable" : " unreachable") +
            (limited
              ? ", rate limited"
              : lows.length > 0
                ? `, rate limit low${band ? `, ${band} left` : ""}`
                : "")
          );
        })
        .join(". ");
    }

    let lastHealthAnnouncement = "";
    function announceForgeHealth(forges: Forge[]) {
      const live = document.getElementById("forge-health-live");
      if (!live) return;
      const next = healthAnnouncement(forges);
      if (next === lastHealthAnnouncement) return;
      lastHealthAnnouncement = next;
      live.textContent = next;
    }

    function renderForgeHealth(forges: Forge[]) {
      const container = document.getElementById("forge-health");
      if (!container) return;
      announceForgeHealth(forges);
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
        // The rows of an unreachable forge are its last good ones, not
        // current ones (#933). Plain text, for every error kind: the
        // rate-limit banner doesn't say the data is old.
        if (!f.reachable && f.staleSince) {
          item.appendChild(
            el(
              "span",
              "forge-health-stale",
              `Showing data from ${relativeTime(f.staleSince)}`,
            ),
          );
        }
        // The remaining budget and when it comes back, as text (#732). Kept
        // out of the live region: the numbers change on every poll.
        // Each budget the forge has, labelled, so this never describes a
        // different one from the banner (#1433).
        for (const [kind, budget] of [
          ["GraphQL", f.rateLimitGraphQL],
          ["REST", f.rateLimitREST],
        ] as const) {
          if (!budget) continue;
          const text = el(
            "span",
            "forge-health-budget",
            budgetText(
              `${FORGE_SHORT_LABELS[f.forge] || f.forge} ${kind}`,
              budget,
            ),
          );
          text.setAttribute("aria-live", "off");
          item.appendChild(text);
        }
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
    // of the page, with the same critical prominence as the nav's red failed
    // count, so it's visible at a glance.
    // One row per forge that went read-only (#755), and one per budget that is
    // merely running low.
    type RateLimitAlert =
      | {
          kind: "readonly";
          forge: string;
          label: string;
          // Which budgets are spent, and when the last one comes back.
          rest: boolean;
          graphql: boolean;
          resetsAt: string;
        }
      | {
          kind: "low";
          label: string;
          resetsAt: string;
          remaining: number;
          limit: number;
          // The share left in words, steady within a band.
          band: string | null;
        };
    let rateLimitAlerts: RateLimitAlert[] = [];

    function computeRateLimitAlerts(forges: Forge[]): RateLimitAlert[] {
      const out: RateLimitAlert[] = [];
      for (const f of forges) {
        const name = FORGE_LABELS[f.forge] || f.forge;
        const rest = isRateLimited(f.rateLimitREST) ? f.rateLimitREST : null;
        const graphql = isRateLimited(f.rateLimitGraphQL)
          ? f.rateLimitGraphQL
          : null;
        if (rest || graphql) {
          const resets = [rest, graphql]
            .filter((l): l is RateLimit => l !== null)
            .map((l) => l.resetsAt)
            .sort((a, b) => Date.parse(b) - Date.parse(a));
          out.push({
            kind: "readonly",
            forge: f.forge,
            label: name,
            rest: rest !== null,
            // A forge that reports no GraphQL budget (Forgejo) has nothing
            // there to keep working.
            graphql: graphql !== null || !f.rateLimitGraphQL,
            resetsAt: resets[0],
          });
        }
        for (const [kind, rl] of [
          ["GraphQL", f.rateLimitGraphQL],
          ["REST", f.rateLimitREST],
        ] as const) {
          // The server grades each budget from its own threshold, so the
          // page holds none (#806). Exceeded is the read-only row above; a
          // warning is the gauge's amber stage and nothing here acts on it.
          if (!rl || rl.severity !== "low") continue;
          out.push({
            kind: "low",
            label: `${name} ${kind}`,
            resetsAt: rl.resetsAt,
            remaining: rl.remaining,
            limit: rl.limit,
            band: remainingBand(rl),
          });
        }
      }
      return out;
    }

    // ---- unreachable-forge banner (#1199) ----
    // One row per forge that can't be reached, as a spent rate limit gets
    // one: what is wrong in plain words, how old the rows on screen are, and
    // a single Retry that forces a refresh. A forge held back by its rate
    // limit has that banner instead.
    function unreachableCause(f: Forge): string {
      switch (f.errorKind) {
        case "unreachable":
          return "It isn’t answering. This page tries again on its own.";
        case "unauthorized":
          return "Check the token in Settings.";
        case "not_found":
          return "Check the instance URL in Settings.";
        default:
          return "Something went wrong talking to it.";
      }
    }

    const GITHUB_STATUS_PAGE = "https://www.githubstatus.com/";

    function renderUnreachableBanner() {
      const existing = document.getElementById("unreachable-banner");
      const readOnlyByLimit = new Set(
        rateLimitAlerts
          .filter((a) => a.kind === "readonly")
          .map((a) => a.label),
      );
      const down = lastForges.filter(
        (f) =>
          !f.reachable &&
          !readOnlyByLimit.has(FORGE_LABELS[f.forge] || f.forge),
      );
      if (down.length === 0) {
        existing?.remove();
        return;
      }
      // The zone is part of it: a changed zone redraws the times.
      const signature = [
        effectiveZone(),
        ...down.map((f) => `${f.forge}|${f.errorKind}|${f.staleSince}`),
      ].join(";");
      if (existing && existing.dataset.signature === signature) return;
      existing?.remove();
      const banner = el("div", "unreachable-banner");
      banner.id = "unreachable-banner";
      banner.dataset.signature = signature;
      banner.setAttribute("role", "status");
      for (const f of down) {
        const label = FORGE_LABELS[f.forge] || f.forge;
        const row = el("div", "unreachable-banner-row");
        const text = el("p", "unreachable-banner-text");
        text.appendChild(
          el(
            "strong",
            "",
            f.staleSince
              ? `${label} is unreachable. Showing the last data from ${formatTime(f.staleSince)}.`
              : `${label} is unreachable.`,
          ),
        );
        text.appendChild(document.createTextNode(` ${unreachableCause(f)}`));
        row.appendChild(text);
        // GitHub's own status page says whether the fault is theirs. A
        // Forgejo instance is self-hosted, so it has none to link (#1301).
        if (f.forge === "github") {
          const status = el(
            "a",
            "unreachable-banner-retry unreachable-banner-link",
            "GitHub status",
          ) as HTMLAnchorElement;
          status.href = GITHUB_STATUS_PAGE;
          status.target = "_blank";
          status.rel = "noopener noreferrer";
          status.setAttribute(
            "aria-label",
            "GitHub status (opens in a new tab)",
          );
          row.appendChild(status);
        }
        const retry = buttonEl("unreachable-banner-retry", "Retry");
        retry.type = "button";
        retry.addEventListener("click", () => forceRefreshButton?.click());
        row.appendChild(retry);
        banner.appendChild(row);
      }
      // Above the filter bar, the first thing on the page after the
      // connection line (#1325: the stat tiles used to be the anchor).
      document
        .querySelector(".filter-bar")
        ?.parentElement?.insertBefore(
          banner,
          document.querySelector(".filter-bar"),
        );
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

    // Rebuilt only when what it says changes. The ticking countdown and a
    // low row's remaining count are updated in place and hidden from
    // assistive tech (WCAG 4.1.3): replacing the banner every second or every
    // poll would have a screen reader read it out each time. The reset time in the label is the
    // static, spoken version of the same fact (#732).
    function renderRateLimitBanner() {
      renderUnreachableBanner();
      const existing = document.getElementById("rate-limit-banner");
      if (rateLimitAlerts.length === 0) {
        existing?.remove();
        return;
      }
      // The zone is part of it: a changed zone redraws the reset times.
      const signature = [
        effectiveZone(),
        ...rateLimitAlerts.map((a) =>
          a.kind === "readonly"
            ? `${a.label}|readonly|${a.rest}|${a.graphql}|${a.resetsAt}`
            : `${a.label}|low|${a.resetsAt}|${a.band}`,
        ),
      ].join(";");
      if (existing && existing.dataset.signature === signature) {
        existing
          .querySelectorAll<HTMLElement>(".rate-limit-banner-timer")
          .forEach((timer, i) => {
            timer.textContent = bannerTimerText(rateLimitAlerts[i]);
          });
        return;
      }
      existing?.remove();
      const banner = el("div", "rate-limit-banner");
      banner.id = "rate-limit-banner";
      banner.dataset.signature = signature;
      // A budget running low is news, not an emergency, and its count
      // moves on every poll; only a spent one is assertive (#1791). The
      // health live region says "rate limit low" once, so a banner that
      // appears as a status is a second, polite mention of the same event.
      banner.setAttribute(
        "role",
        rateLimitAlerts.some((a) => a.kind === "readonly") ? "alert" : "status",
      );
      for (const alert of rateLimitAlerts) {
        const readonly = alert.kind === "readonly";
        const row = el("div", `rate-limit-banner-row${readonly ? "" : " low"}`);
        row.appendChild(
          el("span", "rate-limit-banner-label", bannerLabel(alert)),
        );
        const timer = el(
          "span",
          "rate-limit-banner-timer",
          bannerTimerText(alert),
        );
        timer.setAttribute("aria-hidden", "true");
        row.appendChild(timer);
        banner.appendChild(row);
        if (alert.kind === "readonly") banner.appendChild(whyDisclosure(alert));
      }
      if (rateLimitAlerts.some((a) => a.kind === "readonly"))
        banner.appendChild(stillWorksDisclosure());
      // Above the filter bar, the first thing on the page after the
      // connection line (#1325: the stat tiles used to be the anchor).
      document
        .querySelector(".filter-bar")
        ?.parentElement?.insertBefore(
          banner,
          document.querySelector(".filter-bar"),
        );
    }

    // Say what is off, not just that something is. Which actions need which
    // budget follows proactiveActionLockReason: Merge, Update branch, Close
    // and the bot commands are REST calls, auto-merge is GraphQL.
    function bannerLabel(alert: RateLimitAlert): string {
      const until = formatTime(alert.resetsAt);
      if (alert.kind === "low")
        return `Rate limit running low — ${alert.label}, ${alert.band ? `${alert.band} left, ` : ""}resets at ${until}`;
      if (alert.rest && alert.graphql)
        return `${alert.label} is rate limited. Read-only until ${until}.`;
      if (alert.rest)
        return `${alert.label}'s REST budget is spent. Merge, Update branch, rebase and Close are unavailable until ${until}. Enable auto-merge still works.`;
      return `${alert.label}'s GraphQL budget is spent. Enable auto-merge is unavailable until ${until}; everything else works.`;
    }

    function bannerTimerText(alert: RateLimitAlert): string {
      return alert.kind === "low"
        ? `${alert.remaining.toLocaleString()} of ${alert.limit.toLocaleString()} requests left — ${countdownLabel(alert.resetsAt)}`
        : countdownLabel(alert.resetsAt);
    }

    // "Why?" under a read-only row (#735): what the limit is, so it isn't
    // taken for a fault in the dashboard. GitHub publishes its rules, so it
    // links to them. Forgejo's limit comes from a proxy in front of it, with
    // nothing to link to.
    const GITHUB_RATE_LIMIT_DOCS =
      "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api";

    function whyDisclosure(alert: {
      forge: string;
      label: string;
    }): HTMLElement {
      const details = el("details", "rate-limit-why");
      const summary = el("summary", "", "Why?");
      summary.setAttribute(
        "aria-label",
        `Why? About ${alert.label}'s rate limit`,
      );
      details.appendChild(summary);
      const github = alert.forge === "github";
      details.appendChild(
        el(
          "p",
          "",
          github
            ? "GitHub gives each token a request budget for every hour, and everything using that token spends it, this dashboard included. When it runs out GitHub refuses requests until the reset time, so this is the forge's limit and not a fault in the dashboard. The dashboard stops asking until then so it doesn't use up what comes back."
            : `${alert.label} itself doesn't count requests; a proxy in front of it does. When the proxy's budget runs out it refuses requests until the reset time, so this is a limit on the way to the forge and not a fault in the dashboard. The dashboard stops asking until then so it doesn't use up what comes back.`,
        ),
      );
      if (github) {
        const link = el(
          "a",
          "",
          "GitHub's rate limit rules (opens in a new tab)",
        ) as HTMLAnchorElement;
        link.href = GITHUB_RATE_LIMIT_DOCS;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        details.appendChild(link);
      }
      return details;
    }

    // A closed disclosure under the banner: the reader sees the read-only
    // state first and opens this only if they wonder what is left.
    function stillWorksDisclosure(): HTMLElement {
      const details = el("details", "rate-limit-still-works");
      details.appendChild(el("summary", "", "What still works"));
      const list = el("ul", "");
      for (const text of [
        "View pipeline: the CI pill on a row opens its checks.",
        "Open a pull request on the forge: the title links straight to it.",
        "Browsing, search and filters, over the last data the dashboard has. Refreshed shows how old it is.",
      ])
        list.appendChild(el("li", "", text));
      details.appendChild(list);
      return details;
    }

    // ---- automatic re-enable at the reset time (#732) ----
    // Locked actions derive from the clock (isRateLimited), so all a timer
    // has to do is draw the board again at the reset time, drop any lock a
    // 429 left behind, and say so once. The next snapshot then confirms:
    // if the forge still reports an exhausted budget with a later reset,
    // the actions lock again.
    let rateLimitResetTimer: number | undefined;

    function scheduleRateLimitReset() {
      window.clearTimeout(rateLimitResetTimer);
      rateLimitResetTimer = undefined;
      let soonest: number | null = null;
      for (const f of lastForges) {
        for (const limit of [f.rateLimitREST, f.rateLimitGraphQL]) {
          if (!isRateLimited(limit)) continue;
          const wait = msUntilReset(limit.resetsAt);
          if (wait !== null && (soonest === null || wait < soonest))
            soonest = wait;
        }
      }
      if (soonest === null) return;
      rateLimitResetTimer = window.setTimeout(onRateLimitReset, soonest);
    }

    function onRateLimitReset() {
      for (const state of [
        mergeState,
        closeState,
        updateBranchState,
        autoMergeState,
        dependabotActionState,
        renovateRebaseState,
      ]) {
        for (const key of Object.keys(state)) {
          const entry = state[key];
          if (entry.phase === "locked" && entry.code === "rate_limited")
            delete state[key];
        }
      }
      rateLimitAlerts = computeRateLimitAlerts(lastForges).filter(
        (a) => Date.parse(a.resetsAt) > Date.now(),
      );
      renderRateLimitBanner();
      renderPRBoard();
      feedback.notify({
        title: "Rate limit",
        message: "Rate limit reset, actions available again",
        announce: "Rate limit reset, actions available again",
      });
      scheduleRateLimitReset();
    }

    const tickTimer = setInterval(() => {
      tickRefreshedAt();
      feedbackUI.tick();
      for (const el of document.querySelectorAll<HTMLElement>(".queued-resets"))
        el.textContent = resetsInText(el.dataset.runAt ?? "");
      // Cheap to call unconditionally — it removes and, only if there's
      // still something exhausted, redraws a handful of rows.
      renderRateLimitBanner();
    }, 1000);

    function showError(message: string) {
      if (destroyed) return;
      document.getElementById("error-banner")?.remove();
      const banner = el("div", "error-banner", message);
      banner.id = "error-banner";
      // role="alert" carries an implicit aria-live="assertive" — this
      // was never actually wired up to announce to a screen reader
      // before, despite being the one place a failed write to a forge
      // surfaces.
      banner.setAttribute("role", "alert");
      // Above the filter bar, the first thing on the page after the
      // connection line (#1325: the stat tiles used to be the anchor).
      document
        .querySelector(".filter-bar")
        ?.parentElement?.insertBefore(
          banner,
          document.querySelector(".filter-bar"),
        );
    }

    function clearError() {
      document.getElementById("error-banner")?.remove();
    }

    // ---- queued actions (#680, #714) ----
    // Update branch and the Dependabot/Renovate rebases are requests the
    // forge or a bot acts on later, so the page can't confirm the result
    // until a refresh. The row says so inline, with a countdown to the
    // next poll that sits in an aria-hidden span (feedback-ui.ts) so a
    // screen reader isn't read a new number every second.

    // The pending button's label while a bot has the request: it names
    // what was asked for (#792).
    function queuedBotLabel(rebase: boolean): string {
      return rebase ? "Rebase requested" : "Recreate requested";
    }

    // Recreate rebuilds the whole pull request, so a Rebase on top of it
    // has no point while it's pending (#792). A pending Rebase keeps
    // Recreate: that's still a different outcome.
    function dependabotRebaseHidden(item: PullRequestItem): boolean {
      const phase = dependabotActionState[`${prKey(item)}:recreate`]?.phase;
      return phase === "queued" || phase === "rebasing";
    }

    function queuedRequestInfo(item: PullRequestItem) {
      return {
        prKey: prKey(item),
        // Until the server has answered 204 it has no record to show.
        posted: false,
        // The last fetch started before this click (#691): an answer to
        // it or to anything earlier can't show what the click did.
        seq: requestSeq,
      };
    }

    // The server has the request now (204, or 202 for Update branch): from
    // here a snapshot without a botRequest or updateRequest means it was
    // settled. A fetch that started before this moment can't have seen it,
    // so the bar moves up to now (#691).
    function confirmRequest(
      stateMap: Record<string, ActionState>,
      key: string,
    ) {
      const queued = stateMap[key]?.queued;
      if (!queued) return;
      queued.posted = true;
      queued.seq = requestSeq;
    }

    // What a snapshot says about one request: the server's record and the
    // key its row state is stored under.
    type SyncedRequest = {
      key: string;
      request: ServerBotRequest | ServerUpdateRequest;
    };

    function botRequestOf(
      bot: ServerBotRequest["bot"],
      keyOf: (pk: string, request: ServerBotRequest) => string,
    ) {
      return (pr: PullRequestItem): SyncedRequest | undefined => {
        const request = pr.botRequest;
        if (!request || request.bot !== bot) return undefined;
        return { key: keyOf(prKey(pr), request), request };
      };
    }

    // The kinds of request the server tracks and the page draws: the two
    // bot rebases (#808) and Update branch (#982). Each one's row state,
    // where its record sits on the pull request, and its own words.
    const requestKinds = [
      {
        stateMap: dependabotActionState,
        fkeyOf: (key: string) => `dependabot:${key}`,
        requestOf: botRequestOf(
          "dependabot",
          (pk, request) => `${pk}:${request.action}`,
        ),
        finishedMessage: "Dependabot rebase finished.",
        expiredMessage: (reason: string) =>
          `Dependabot hasn't acted: ${reason}`,
        // A rebase with no thumbs-up after the wait may have been dropped;
        // one that was acknowledged but never pushed is a different story
        // (#1082).
        expiredReason: (request: ServerBotRequest) => {
          if (request.action !== "rebase") return undefined;
          return request.acknowledgedAt
            ? "Dependabot acknowledged it but hasn't pushed a rebase."
            : "No reply from Dependabot yet. The command may have been dropped or rate limited.";
        },
        askAgainLabel: (request: ServerBotRequest) =>
          request.action === "rebase" && !request.acknowledgedAt
            ? "Ask again"
            : undefined,
        pickedUpMessage: "Dependabot picked up the rebase.",
        restoredFeedback: (pr: PullRequestItem, request: SyncedRequest) => {
          const server = request.request as ServerBotRequest;
          const action = server.action;
          return {
            label: DEPENDABOT_ACTION_LABELS[action],
            kind: (action === "rebase"
              ? "bot-rebase"
              : "bot-recreate") as WaitKind,
            inline: "Rebase requested",
            message: `Dependabot ${action} requested.`,
            bot:
              action === "rebase"
                ? botLineInfo("Dependabot", Boolean(server.acknowledgedAt))
                : undefined,
            retry: () => doDependabotAction(pr, action, buttonEl("row-action")),
          };
        },
      },
      {
        stateMap: renovateRebaseState,
        fkeyOf: (key: string) => `renovate:${key}`,
        requestOf: botRequestOf("renovate", (pk) => pk),
        finishedMessage: "Renovate rebase finished.",
        expiredMessage: (reason: string) => `Renovate hasn't acted: ${reason}`,
        expiredReason: (_request: ServerBotRequest) => undefined,
        askAgainLabel: (_request: ServerBotRequest) => undefined,
        pickedUpMessage: "Renovate picked up the rebase.",
        restoredFeedback: (pr: PullRequestItem, request: SyncedRequest) => ({
          label: "Renovate: Rebase",
          kind: "bot-rebase" as WaitKind,
          inline: "Rebase requested",
          message: `Renovate ${(request.request as ServerBotRequest).action} requested.`,
          bot:
            (request.request as ServerBotRequest).action === "rebase"
              ? botLineInfo("Renovate")
              : undefined,
          retry: () => doRenovateRebase(pr, buttonEl("row-action")),
        }),
      },
      {
        stateMap: updateBranchState,
        fkeyOf: (key: string) => `update-branch:${key}`,
        requestOf: (pr: PullRequestItem): SyncedRequest | undefined =>
          pr.updateRequest
            ? { key: prKey(pr), request: pr.updateRequest }
            : undefined,
        finishedMessage: "Branch updated.",
        expiredMessage: (reason: string) =>
          `The branch update hasn't landed: ${reason}`,
        expiredReason: (_request: ServerBotRequest) => undefined,
        askAgainLabel: (_request: ServerBotRequest) => undefined,
        pickedUpMessage: "",
        restoredFeedback: (pr: PullRequestItem) => ({
          label: "Update branch",
          kind: "update-branch" as WaitKind,
          inline: "Branch update requested",
          message: "Branch update requested.",
          bot: undefined,
          retry: () => doUpdateBranch(pr, buttonEl("row-action")),
        }),
      },
    ];

    // The server owns these requests (#808, #982): each is on the pull
    // request as botRequest or updateRequest, queued, rebasing (bots only)
    // or expired, and it is gone once the server has settled it. This only
    // draws that. A click shows queued at once; each snapshot then takes
    // over:
    //   - a record in phase rebasing moves the row to Rebasing…
    //   - phase expired ends it with an error toast and Retry
    //   - no record ends it as finished, unless the fetch can't have seen
    //     the request yet (it started before the server had it)
    //   - a record this page never clicked (a reload, another tab)
    //     starts the same row state, so a wait survives a reload.
    // Returns the pull requests whose request state changed.
    function syncServerRequests(
      prs: PullRequestItem[],
      startedSeq: number | undefined,
    ): Set<string> {
      const changed = new Set<string>();
      const byKey = new Map(prs.map((p) => [prKey(p), p]));
      for (const kind of requestKinds) {
        const stateMap: Record<string, ActionState> = kind.stateMap;
        for (const key of Object.keys(stateMap)) {
          const entry = stateMap[key];
          const queued = entry.queued;
          if (
            !queued ||
            (entry.phase !== "queued" && entry.phase !== "rebasing")
          )
            continue;
          const fkey = kind.fkeyOf(key);
          const pr = byKey.get(queued.prKey);
          const found = pr && kind.requestOf(pr);
          const current =
            found && found.key === key ? found.request : undefined;
          if (!current) {
            // Not there yet, or already settled? Only a fetch that started
            // after the server had it can tell. A push from the live
            // stream has no start to compare, so it counts.
            if (!queued.posted) continue;
            if (startedSeq !== undefined && startedSeq <= queued.seq) continue;
            finishRequest(stateMap, key, fkey, kind.finishedMessage);
            changed.add(queued.prKey);
            continue;
          }
          // The row the server's record is on takes it in place, even
          // while this click holds the board: the record is no news to
          // the user, so it must not read as "1 update available".
          const shown = shownPRs.find((p) => prKey(p) === queued.prKey);
          const shownRecord = shown && kind.requestOf(shown)?.request;
          if (JSON.stringify(shownRecord) !== JSON.stringify(current))
            changed.add(queued.prKey);
          if (current.phase === "expired") {
            delete stateMap[key];
            // Only a bot request has these; an update request has none.
            const bot = current as ServerBotRequest;
            const reason =
              kind.expiredReason(bot) ?? "No change seen in the time allowed.";
            const message = kind.expiredMessage(reason);
            feedback.update(fkey, {
              phase: "expired",
              inline: reason,
              message,
              toast: true,
              announce: message,
              canRetry: true,
              retryLabel: kind.askAgainLabel(bot),
              commentUrl: bot.commentUrl,
            });
          } else if (
            current.phase === "queued" &&
            (current as ServerBotRequest).acknowledgedAt &&
            !feedback.entries().find((e) => e.actionKey === fkey)?.bot
              ?.acknowledged
          ) {
            // Dependabot thumbed up the command (#1082): say so, once.
            feedback.update(fkey, {
              acknowledged: true,
              announce: "Dependabot acknowledged your rebase.",
            });
          } else if (current.phase === "rebasing" && entry.phase === "queued") {
            entry.phase = "rebasing";
            feedback.update(fkey, {
              phase: "rebasing",
              message: kind.pickedUpMessage,
              announce: kind.pickedUpMessage,
            });
          }
        }
      }
      // A request this page didn't click.
      for (const pr of prs) {
        for (const kind of requestKinds) {
          const found = kind.requestOf(pr);
          if (!found || found.request.phase === "expired") continue;
          const stateMap: Record<string, ActionState> = kind.stateMap;
          if (stateMap[found.key]) continue;
          const pk = prKey(pr);
          stateMap[found.key] = {
            phase: found.request.phase,
            queued: { prKey: pk, posted: true, seq: 0, restored: true },
          };
          changed.add(pk);
          const fkey = kind.fkeyOf(found.key);
          feedback.start({
            actionKey: fkey,
            ref: actionRef(pr),
            phase: "queued",
            startedAt: Date.parse(found.request.requestedAt) || undefined,
            ...kind.restoredFeedback(pr, found),
          });
          if (found.request.phase === "rebasing")
            feedback.update(fkey, {
              phase: "rebasing",
              message: kind.pickedUpMessage,
            });
        }
      }
      return changed;
    }

    function finishRequest(
      stateMap: Record<string, ActionState>,
      key: string,
      fkey: string,
      message: string,
    ) {
      delete stateMap[key];
      feedback.update(fkey, {
        phase: "done",
        message,
        toast: true,
        announce: message,
      });
    }

    function queuedCountdownText(): string {
      const seconds = Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1000));
      // The snapshot is late, not lost: say so instead of "0s".
      return seconds === 0 ? "Refreshing…" : `Next refresh in ${seconds}s`;
    }

    // ---- force-refresh: retry right now instead of waiting out the
    // rest of the background poll's own interval ----
    const forceRefreshButton = document.getElementById(
      "force-refresh-button",
    ) as HTMLButtonElement | null;

    // Shared by this button and every locked merge/update-branch row's
    // own "Retry" — a locked reason can only be known to have cleared by
    // asking the forge again right now, not by staring at data already
    // on screen. POSTs, not the plain GET refresh() polls with — this
    // forces a real re-fetch from the forge instead of possibly
    // answering from a cache.
    // Resolves to how many seconds the server wants this client to wait
    // before forcing another one: the Retry-After of an answer given inside
    // the per-user cooldown, which carries the current snapshot instead of a
    // fetch. undefined when the server did fetch.
    function refreshDashboardNow(): Promise<number | undefined> {
      const seq = ++requestSeq;
      return fetch(withDrafts("/api/dashboard/refresh"), {
        method: "POST",
        headers: { Accept: "application/json" },
      }).then((res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          throw new Error("session expired");
        }
        if (!res.ok) throw new Error(`backend answered ${res.status}`);
        const wait = Number.parseInt(res.headers.get("Retry-After") ?? "", 10);
        return res.json().then((data) => {
          applySnapshot(data, true, seq);
          return wait >= 1 ? wait : undefined;
        });
      });
    }

    forceRefreshButton?.addEventListener("click", () => {
      forceRefreshButton.disabled = true;
      forceRefreshButton.classList.add("is-refreshing");
      let lockSeconds: number | undefined;
      refreshDashboardNow()
        .then((wait) => {
          lockSeconds = wait;
        })
        .catch((err: Error) => {
          showError(`Could not refresh: ${err.message}`);
        })
        .finally(() => {
          forceRefreshButton.classList.remove("is-refreshing");
          // The server enforces the cooldown. A click inside it was answered
          // with the current snapshot and a Retry-After, and the button
          // stays locked that long; a click that fetched needs no lock, the
          // next one is the server's to answer.
          if (lockSeconds === undefined) {
            forceRefreshButton.disabled = false;
            return;
          }
          setTimeout(() => {
            forceRefreshButton.disabled = false;
          }, lockSeconds * 1000);
        });
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
      refresh(true);
    });

    // ---- main fetch/render loop ----
    // Each pull request this app auto-merged is announced once, matched on
    // forge, repository, number and merge time. The server lists them for
    // ten minutes, so a reload inside that window must not say it again.
    const AUTO_MERGED_SEEN_KEY = "forge-dashboard.auto-merged-seen";
    const autoMergedSeen = new Set<string>(
      (() => {
        try {
          return JSON.parse(
            localStorage.getItem(AUTO_MERGED_SEEN_KEY) ?? "[]",
          ) as string[];
        } catch {
          return [];
        }
      })(),
    );

    function announceAutoMerged(merged: ServerAutoMerged[]) {
      let changed = false;
      for (const m of merged) {
        const id = `${m.forge}/${m.fullName}#${m.number}@${m.mergedAt}`;
        if (autoMergedSeen.has(id)) continue;
        autoMergedSeen.add(id);
        changed = true;
        feedback.notify({
          title: "Auto-merge",
          message: m.message,
          announce: m.message,
        });
      }
      if (!changed) return;
      try {
        localStorage.setItem(
          AUTO_MERGED_SEEN_KEY,
          JSON.stringify([...autoMergedSeen].slice(-100)),
        );
      } catch {
        // Storage is a convenience: without it a reload may repeat a toast.
      }
    }

    function applySnapshot(
      data: DashboardSnapshot,
      userAsked = false,
      startedSeq?: number,
    ) {
      if (destroyed) return;
      // A refresh answer can land after a pushed snapshot that is newer than
      // it, and would put back what the push already moved on from, such as
      // a request drawn as queued again after it expired (#1124). An equal
      // time is not older: a cooldown answer repeats the current snapshot.
      if (
        lastGeneratedAt &&
        Date.parse(data.generatedAt) < Date.parse(lastGeneratedAt)
      )
        return;
      clearError();
      // The zero time a snapshot carries before the first refresh is no
      // moment: keep the last real one and show no "Refreshed ... ago" for it.
      refreshedKnown = hasTimestamp(data.generatedAt);
      if (refreshedKnown) lastGeneratedAt = data.generatedAt;
      followReadInterval(data.readIntervalSeconds);
      tickRefreshedAt();

      renderForgeHealth(data.forges || []);
      const wasUnreachable = new Set(
        lastForges.filter((f) => !f.reachable).map((f) => f.forge),
      );
      lastForges = data.forges || [];
      // Rows that didn't change aren't redrawn, but their controls follow
      // whether the forge can be reached: a forge going down or coming back
      // has to redraw them (#1199).
      const reachabilityChanged = lastForges.some(
        (f) => wasUnreachable.has(f.forge) === f.reachable,
      );
      // A forge that answers again gets its controls back, and one polite
      // line saying so.
      for (const f of lastForges) {
        if (!f.reachable || !wasUnreachable.has(f.forge)) continue;
        const label = FORGE_LABELS[f.forge] || f.forge;
        feedback.notify({
          title: "Forge",
          message: `${label} is reachable again, actions available`,
          announce: `${label} is reachable again, actions available`,
        });
      }
      rateLimitAlerts = computeRateLimitAlerts(lastForges);
      renderRateLimitBanner();
      scheduleRateLimitReset();

      // A locked merge/update-branch reason only reflects what the
      // forge said at the moment of the last attempt — re-derived here
      // from this fresh snapshot instead of latching indefinitely. A
      // lock whose root cause is still real reappears right away on the
      // next render — proactiveActionLockReason already re-checks
      // lastForges fresh every time from the
      // values just updated above — while one that's resolved simply
      // doesn't.
      clearStaleLocks(mergeState);
      clearStaleLocks(closeState);
      clearStaleLocks(updateBranchState);
      announceAutoMerged(data.autoMerged ?? []);
      // Release pull requests have their own page: the pull request board
      // shows none of them and the Releases board only them. The server says
      // which are which (#716). The nav counts both from the full list.
      setFirstRefresh(data.firstRefreshDone);
      setNavCounts(
        firstRefreshPending(data.firstRefreshDone) ? null : data.navCounts,
      );
      // The snapshot carries the viewer's two flags (#1630), so no second
      // request decides which fields to draw.
      settingsHideDependencyDashboard = data.hideDependencyDashboard === true;
      settingsIgnoreTitles = data.ignoredTitlesSet === true;
      issueSettingsKnown = true;
      settingsHiddenIssues = data.settingsHiddenIssueCount ?? 0;
      syncQueuedActions(data.queuedActions ?? []);
      const prs = (data.pullRequests || []).filter((p) =>
        viewKind
          ? p.kind === viewKind
          : p.kind !== "release" && p.kind !== "dependency",
      );
      hiddenDrafts = data.hiddenDrafts ?? 0;
      syncDraftsToggle();
      hiddenPullRequests = data.hiddenPullRequests ?? 0;
      syncHiddenToggle();
      // Only a snapshot that shows the request settled ends a queued bot
      // rebase or Update branch — not just any snapshot (#706, #982). Cleared before
      // anyRowActionInFlight is consulted below, so a resolved row
      // doesn't also hold the board back.
      const botChanged = syncServerRequests(prs, startedSeq);
      const issues = data.issues || [];
      allPRs = prs;
      evictRerunState();
      allIssues = issues;
      reposByKey = new Map(
        (data.repos || []).map((r) => [
          Filters.repoKey(r.forge, r.fullName),
          r,
        ]),
      );
      updateSharedFilterOptions();
      if (!sharedControlsRestored) {
        sharedControlsRestored = true;
        syncSharedControlsToState();
      }
      // ingestPRs compares this against what the board shows and either
      // applies it, updates rows in place, or holds a structural change
      // until nothing is disturbed — see reconcilePRs.
      ingestPRs(prs, userAsked, botChanged);
      if (reachabilityChanged) renderPRBoard();
      // A bot request changing state (picked up, finished, expired) changes
      // the row's button, pill and line even when the pull request's own
      // data didn't, so the board redraws for it (#707).
      if (botChanged.size > 0) keepFocusAcross(renderPRBoard);
      if (view === "issues") ingestIssues(issues, userAsked);
      else issueBoard.setItems(issues);
    }

    // Reused by refresh() below and by the WebMCP tool further down --
    // one fetch layer for /api/dashboard, not two.
    function fetchDashboardData(
      signal?: AbortSignal,
    ): Promise<DashboardSnapshot> {
      const url = withDrafts(
        "/api/dashboard" +
          (currentOwner ? `?owner=${encodeURIComponent(currentOwner)}` : ""),
      );

      return fetch(url, {
        headers: { Accept: "application/json" },
        signal,
      }).then((res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          throw new Error("session expired");
        }
        if (!res.ok) throw new Error(`backend answered ${res.status}`);

        return res.json();
      });
    }

    const READ_TIMEOUT_MS = 20_000;
    function refresh(userAsked = false, fromPoll = false) {
      const seq = ++requestSeq;
      if (fromPoll) pollReadInFlight = true;
      // The next poll is timed from this one's answer or failure, so a server
      // that holds the read never has two of the poll's reads in flight.
      // Neither the first read nor a poll may hang for good: a half-open
      // connection leaves fetch pending, which would keep the skeleton up and
      // stop the poll. The server holds a read for 15 s at most. A read the
      // user asked for keeps its own behaviour. The page's timer, not
      // AbortSignal.timeout, so the clock the tests control also drives it.
      const abort = userAsked ? undefined : new AbortController();
      const abortTimer = abort
        ? setTimeout(() => abort.abort(), READ_TIMEOUT_MS)
        : undefined;
      const settled = () => {
        clearTimeout(abortTimer);
        if (!fromPoll) return;
        pollReadInFlight = false;
        if (!destroyed) schedulePoll();
      };
      fetchDashboardData(abort?.signal)
        .then((data) => {
          applySnapshot(data, userAsked, seq);
          streamFailures = 0;
          ensureStream();
          armFirstPoll();
          settled();
        })
        .catch((err: Error) => {
          // No answer means no flag: show the real state, not a skeleton
          // that would never end.
          settleFirstRefresh();
          showError(
            `Could not reach the backend: ${
              abort?.signal.aborted ? "it did not answer in time" : err.message
            }`,
          );
          armFirstPoll();
          settled();
        });
    }

    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let pollReadInFlight = false;
    // The first poll is armed when the first request ends, answered or failed,
    // not at load: the server can hold that request for 15 s on a cold start,
    // and a timer started at load would send a second held request meanwhile.
    function armFirstPoll() {
      if (destroyed || pollTimer !== undefined) return;
      schedulePoll();
    }
    function schedulePoll() {
      clearTimeout(pollTimer);
      nextPollAt = Date.now() + readIntervalMs;
      pollTimer = setTimeout(() => {
        // A re-arm by new advice can land while a poll read is out; that
        // read's answer arms the next one.
        if (pollReadInFlight) return;
        refresh(false, true);
      }, readIntervalMs);
    }
    // Follows the server's advice, and only re-arms when it changes, so a
    // snapshot that arrives between polls doesn't push the next one back.
    function followReadInterval(seconds: number | undefined) {
      const next = adviseReadIntervalMs(seconds, readIntervalMs);
      if (next === readIntervalMs) return;
      readIntervalMs = next;
      schedulePoll();
    }

    refresh();

    // ---- WebMCP (webmachinelearning/webmcp) tools, defined in webmcp-tools.ts ----
    // Experimental browser API -- document.modelContext only exists in
    // Chrome 149+/Edge 150+ behind an Origin Trial (or the local
    // about:flags#enable-webmcp-testing flag) as of this writing, so this
    // is a no-op everywhere else rather than something to feature-detect
    // around at every call site. Lets an in-browser AI agent call this
    // page's own already-authenticated fetch layer directly -- the exact
    // same fetchDashboardData()/applySnapshot() pair refresh() above
    // already uses, never a parallel path to the same data, and riding
    // on the browser's own session cookie exactly like the page's own
    // poll does, so no token or credential ever passes through this
    // tool. Calling it also syncs the visible UI (applySnapshot), so an
    // agent and the person watching the page never see it disagree —
    // the WebMCP explainer's own "synchronize visual UI state" guidance.
    if (document.modelContext) {
      const { modelContext } = document;
      const tools = createWebMCPTools({
        async getDashboard() {
          const seq = ++requestSeq;
          const data = await fetchDashboardData();
          applySnapshot(data, false, seq);

          return data;
        },
        onSessionExpired() {
          window.location.href = "/login.html";
        },
      });
      for (const { operationId: _operationId, ...tool } of tools) {
        modelContext.registerTool(tool);
      }
    }

    // ---- live updates over Server-Sent Events, on top of the poll above ----
    // The poll keeps running unconditionally — this only ever makes the
    // dashboard update sooner than the next one, never a replacement
    // for it. A browser or proxy that can't hold this connection open
    // just never benefits from it: EventSource retries a dropped connection on
    // its own (not a non-200, see below), and
    // if it never connects at all the poll still keeps the data fresh.
    // The stream reads includeDrafts once, when it opens, so a changed
    // choice reopens it (#791).
    //
    // It opens after the first poll has answered with something to stream:
    // the server answers 404 until it runs a background refresh for the user,
    // and EventSource never retries a non-200, so opening it earlier (or for
    // a user with no forge configured) logged a console error and lost the
    // live updates for good (#1569). One that did close is opened again after
    // a backoff, and the next poll that finds it closed does too.
    let eventSource: EventSource | null = null;
    let streamDrafts = false;
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    let streamRetryMs = 2000;
    const streamRetryMaxMs = 30000;
    // Consecutive closes; retries stop at the limit until a poll answers.
    const streamFailureLimit = 5;
    let streamFailures = 0;
    function ensureStream() {
      // A shared dashboard's forges are the owner's, but the stream is always
      // the viewer's own, and its pushes are ignored there anyway.
      if (destroyed || streamTimer || currentOwner) return;
      if (lastForges.length === 0 || streamFailures >= streamFailureLimit)
        return;
      if (eventSource && eventSource.readyState !== EventSource.CLOSED) return;
      openStream();
    }
    function openStream() {
      if (!window.EventSource) return;
      eventSource?.close();
      streamDrafts = draftsOn();
      const source = new EventSource(withDrafts("/api/dashboard/stream"));
      eventSource = source;
      source.onopen = () => {
        streamRetryMs = 2000;
        streamFailures = 0;
      };
      source.onerror = () => {
        // CONNECTING means the browser is retrying on its own. CLOSED means
        // it gave up, as it does for any non-200 answer.
        if (source !== eventSource || source.readyState !== EventSource.CLOSED)
          return;
        streamFailures++;
        clearTimeout(streamTimer);
        streamTimer = setTimeout(() => {
          streamTimer = undefined;
          ensureStream();
        }, streamRetryMs);
        streamRetryMs = Math.min(streamRetryMs * 2, streamRetryMaxMs);
      };
      source.onmessage = (event) => {
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

    // A saved choice that arrives after the first fetch (the server's copy
    // beating a stale cookie) needs the data and the stream redone.
    syncDraftsPreference = () => {
      syncDraftsToggle();
      if (draftsOn() === streamDrafts) return;
      if (lastForges.length > 0) openStream();
      refresh(true);
    };

    // The saved time zone arrives after the first render, and Settings can
    // change it: redraw everything that shows a reset time (#996).
    const stopTimezone = onTimezoneChange(() => {
      if (!lastGeneratedAt) return; // nothing drawn yet; the first snapshot reads the zone
      renderForgeHealth(lastForges);
      renderRateLimitBanner();
      renderPRBoard();
    });

    return () => {
      destroyed = true;
      Filters.leavePage(page);
      titleHover.destroy();
      stopTimezone();
      document.removeEventListener("keydown", onSlashShortcut);
      for (const stop of stopListening) stop();
      clearTimeout(touchTimer);
      clearTimeout(pollTimer);
      clearTimeout(streamTimer);
      clearInterval(tickTimer);
      window.clearTimeout(rateLimitResetTimer);
      eventSource?.close();
    };
  }
</script>

<svelte:head>
  <title
    >{view === "issues"
      ? "Issues — Forge Board"
      : view === "releases"
        ? "Releases — Forge Board"
        : view === "bots"
          ? "Bots — Forge Board"
          : "Pull requests — Forge Board"}</title
  >
  <meta
    name="description"
    content={view === "issues"
      ? "Open issues across your GitHub and Forgejo repositories, in one list."
      : view === "releases"
        ? "Release pull requests waiting to ship across your GitHub and Forgejo repositories, with Merge and Update branch on each."
        : view === "bots"
          ? "Dependabot and Renovate pull requests across your GitHub and Forgejo repositories, with the actions you can take on each."
          : "Open pull requests across your GitHub and Forgejo repositories, with the actions you can take on each."}
  />
</svelte:head>

<div class="wrap">
  <!--
    This page's own genuinely-unique content — connected forges, the
    sharing dropdown, the forge-health panel, the ticking "refreshed"
    clock, the manual refresh button — used to be injected into the
    shared layout's <header> landmark (see the script block's own
    comment for why that broke under SSR). It's plain, non-landmark
    markup here instead, styled to read as a continuation of the header
    above it (see .dashboard-toolbar in style.css) without actually being
    one.
  -->
  <!-- #714: the Activity control stays in view while the page scrolls;
       its panel lists in-flight and recent per-pull-request actions. -->
  <div class="activity-bar">
    <button
      type="button"
      class="activity-toggle"
      id="activity-toggle"
      aria-expanded="false"
      aria-controls="activity-panel">Activity 0</button
    >
    <div
      class="activity-panel"
      id="activity-panel"
      role="region"
      aria-label="Activity"
      hidden
    >
      <div class="activity-panel-head">
        <p class="activity-title">Recent actions</p>
        <button type="button" class="activity-clear" disabled
          >Clear finished</button
        >
      </div>
      <ul class="activity-list"></ul>
      <!-- Actions queued for a rate limit reset (#756), from the snapshot. -->
      <div class="activity-queued" id="activity-queued" hidden>
        <p class="activity-title">Queued for a rate limit reset</p>
        <ul class="activity-queued-list" id="activity-queued-list"></ul>
      </div>
    </div>
  </div>
  <div class="dashboard-toolbar">
    <!-- No longer sits directly under the "Forge Board" <h1> the way it
         used to as the brand's subtitle, so the sr-only prefix below
         gives it the same "these are the connected forges" context a
         screen-reader user previously got for free from that
         positioning; sighted users still get it from this toolbar's own
         placement right under the header. forgeNames.innerHTML (below)
         only ever replaces #forge-names's own children, never this
         label, since the label is a sibling, not a child. -->
    <p class="dashboard-toolbar-forges">
      <span class="sr-only">Connected forges: </span>
      <span id="forge-names"><span class="mono">&hellip;</span></span>
    </p>
    <label for="dashboard-owner-select" class="sr-only">Viewing dashboard</label
    >
    <select
      id="dashboard-owner-select"
      class="mono"
      style="font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--border-strong);background:var(--surface-sunken);color:var(--ink);"
      hidden
    >
      <option value="">My dashboard</option>
    </select>
    <div id="forge-health"></div>
    <!-- The one polite live region for forge health. #forge-health is
         redrawn on every snapshot, so it can't be live itself: this text
         changes only when the state it states does (WCAG 4.1.3). It exists
         from first paint so the first announcement is spoken. -->
    <span
      id="forge-health-live"
      class="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    ></span>
    <span class="refreshed" hidden={!refreshedKnown || loadingFirst}
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
  </div>
  <div
    class="filter-bar"
    role="search"
    aria-label={view === "issues" ? "Filter issues" : "Filter pull requests"}
  >
    <div class="quick-pills" role="group" aria-label="Quick filters">
      <button
        type="button"
        class="quick-pill"
        data-pill="all"
        aria-pressed="true">All</button
      >
      <button
        type="button"
        class="quick-pill forge-pill"
        data-pill="github"
        aria-pressed="false">GitHub</button
      >
      <button
        type="button"
        class="quick-pill forge-pill"
        data-pill="forgejo"
        aria-pressed="false">Forgejo</button
      >
      {#if pullsView}
        <button
          type="button"
          class="quick-pill"
          data-pill="failing"
          aria-pressed="false">Failing CI</button
        >
        <button
          type="button"
          class="quick-pill"
          data-pill="running"
          aria-pressed="false">Running CI</button
        >
        <button
          type="button"
          class="quick-pill"
          data-pill="passing"
          aria-pressed="false">Passing CI</button
        >
        <button
          type="button"
          class="quick-pill"
          data-pill="conflicting"
          aria-pressed="false">Conflicts</button
        >
        <button
          type="button"
          class="quick-pill"
          data-pill="ready"
          aria-pressed="false">Ready to Merge</button
        >
        <button
          type="button"
          class="quick-pill"
          data-pill="needs-review"
          aria-pressed="false">Needs Review</button
        >
        <button
          type="button"
          class="quick-pill"
          data-pill="review-requested"
          aria-pressed="false">Review requested from me</button
        >
      {/if}
    </div>
    {#if pullsView}
      <div class="am-group" role="group" aria-label="Auto-merge">
        <span class="am-label" aria-hidden="true">Auto-merge</span>
        <button type="button" data-am="any" aria-pressed="true">Any</button>
        <button
          type="button"
          data-am="on"
          aria-label="Auto-merge on"
          aria-pressed="false">On</button
        >
        <button
          type="button"
          data-am="off"
          aria-label="Auto-merge off"
          aria-pressed="false">Off</button
        >
      </div>
    {/if}
    <!-- Phones (#828): this row stays when the rest of the controls fold
         into the Filters sheet. Everywhere else it just flows. -->
    <div class="filter-bar-top">
      <span class="search-wrap">
        <input
          class="col-filter"
          data-col="title"
          type="text"
          placeholder="Title"
          aria-label="Filter by title"
          aria-keyshortcuts="/"
          list="shared-title-options"
          autocomplete="off"
        />
        <kbd class="search-hint" aria-hidden="true">/</kbd>
      </span>
      <datalist id="shared-title-options"></datalist>
      <button
        type="button"
        class="filters-trigger"
        id="filters-button"
        aria-haspopup="dialog"
        aria-expanded="false"
        aria-controls="filter-sheet">Filters</button
      >
    </div>
    <div
      class="active-filters"
      id="active-filters"
      role="group"
      aria-label="Active filters"
      hidden
    ></div>
    <div class="filter-controls" id="filter-controls">
      <div class="forge-group sheet-only" role="group" aria-label="Forge">
        <button
          type="button"
          class="quick-pill"
          data-pill="all"
          aria-pressed="true">All</button
        >
        <button
          type="button"
          class="quick-pill"
          data-pill="github"
          aria-pressed="false">GitHub</button
        >
        <button
          type="button"
          class="quick-pill"
          data-pill="forgejo"
          aria-pressed="false">Forgejo</button
        >
      </div>
      {#if pullsView}
        <div class="am-group sheet-only" role="group" aria-label="Auto-merge">
          <span class="am-label" aria-hidden="true">Auto-merge</span>
          <button type="button" data-am="any" aria-pressed="true">Any</button>
          <button
            type="button"
            data-am="on"
            aria-label="Auto-merge on"
            aria-pressed="false">On</button
          >
          <button
            type="button"
            data-am="off"
            aria-label="Auto-merge off"
            aria-pressed="false">Off</button
          >
        </div>
        <button
          type="button"
          class="drafts-toggle"
          id="show-drafts-toggle"
          aria-pressed="false"
          >Show drafts<span
            class="drafts-hidden"
            id="drafts-hidden-count"
            hidden
          ></span></button
        >
      {/if}
      <select
        class="group-select"
        id="pr-sort-select"
        aria-label={view === "issues"
          ? "Sort issues by"
          : "Sort pull requests by"}
      >
        <option value="">Sort: Last activity</option>
        <option value="created">Sort: Created</option>
        <option value="repo">Sort: Repository</option>
      </select>
      <select
        class="group-select"
        id="shared-group-select"
        aria-label="Group rows by"
      >
        <option value="">Flat list</option>
        <option value="repo">Group by repository</option>
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
  </div>

  <!-- Saved picks this page does not offer (#1620). Always in the page, so a
       screen reader hears a line appear in it. -->
  <div class="held-picks" id="held-picks" role="status" tabindex="-1"></div>

  <!-- The Filters sheet (#828), phones only: the controls move in here
       while it's open and back when it closes, so every id and handler
       they already have survives. -->
  <dialog
    id="filter-sheet"
    class="filter-sheet"
    aria-labelledby="filter-sheet-title"
  >
    <div class="filter-sheet-head">
      <h2 id="filter-sheet-title">Filters</h2>
      <button
        type="button"
        class="filter-sheet-close"
        id="filter-sheet-close"
        aria-label="Close filters">&times;</button
      >
    </div>
    <div class="filter-sheet-body" id="filter-sheet-body"></div>
    <div class="filter-sheet-foot">
      <button type="button" class="filter-sheet-clear" id="filter-sheet-clear"
        >Clear all</button
      >
      <button type="button" class="filter-sheet-show" id="filter-sheet-show"
        >Show results</button
      >
    </div>
  </dialog>

  <div class="updates-bar" id="updates-bar">
    <span
      class="sr-only"
      id="list-updates-status"
      role="status"
      aria-live="polite"
    ></span>
    <span class="updates-paused" id="updates-paused-hint" hidden
      >Live updates paused</span
    >
    <button
      type="button"
      class="updates-pause"
      id="pause-updates-button"
      aria-pressed="false">Pause live updates</button
    >
  </div>

  {#if pullsView}
    <section class="board" aria-label="Open pull requests">
      <div class="board-head">
        <h2>
          {view === "releases"
            ? "Releases"
            : view === "bots"
              ? "Bots"
              : "Pull requests"}
        </h2>
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
          <button
            type="button"
            class="hidden-prs-toggle"
            id="hidden-prs-toggle"
            aria-expanded="false"
            aria-controls="hidden-prs-panel"
            hidden>Hidden (0)</button
          >
          <span class="count" id="pr-count">&ndash;</span>
        </div>
      </div>

      <p class="hide-status" id="hide-status" role="status" hidden></p>
      <div
        class="hidden-prs-panel"
        id="hidden-prs-panel"
        role="region"
        aria-label="Hidden pull requests"
        hidden
      >
        <ul class="hidden-prs-list" id="hidden-prs-list"></ul>
      </div>

      <FirstRefreshStatus pending={loadingFirst} />
      <div class="list-region" aria-busy={loadingFirst ? "true" : undefined}>
        {#if loadingFirst}<ListSkeleton />{/if}
        <div hidden={loadingFirst}>
          <div id="pr-rows"></div>
          <p class="empty-state" id="pr-empty" hidden>
            {view === "releases"
              ? "No release pull requests are open. Nothing is waiting to ship."
              : view === "bots"
                ? "No bot pull requests are open. Nothing to review."
                : "No open pull requests."}
          </p>
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
        </div>
      </div>
    </section>
  {:else}
    <section class="board" aria-label="Open issues">
      <div class="board-head">
        <h2>Issues</h2>
        <div class="board-head-controls">
          <label
            class="checkbox-filter"
            hidden={!issueSettingsKnown || settingsHideDependencyDashboard}
          >
            <input
              type="checkbox"
              id="issue-hide-dependency-dashboard"
              checked
            />
            Hide Dependency Dashboard
          </label>
          <label
            class="text-filter"
            hidden={!issueSettingsKnown || settingsIgnoreTitles}
          >
            Hide titles matching (regex)
            <input
              type="text"
              id="issue-hide-title-regex"
              maxlength="200"
              autocomplete="off"
              spellcheck="false"
              placeholder="^Weekly report"
            />
          </label>
          <p class="rule-error" id="issue-hide-title-regex-error" hidden></p>
          <span class="count" id="issue-count">&ndash;</span>
        </div>
        <p
          class="rule-note"
          id="issue-hide-title-note"
          role="status"
          hidden
        ></p>
        {#if settingsHiddenIssues > 0}
          <p class="rule-note" id="issue-settings-note" role="status">
            {settingsHiddenIssues} hidden by your settings.
            <a href="/settings.html#issue-settings">Settings</a>
          </p>
        {/if}
      </div>

      <FirstRefreshStatus pending={loadingFirst} />
      <div class="list-region" aria-busy={loadingFirst ? "true" : undefined}>
        {#if loadingFirst}<ListSkeleton />{/if}
        <div hidden={loadingFirst}>
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
        </div>
      </div>
    </section>
  {/if}
</div>

<!-- Pull request rows and issue rows both open it. -->
<PullRequestDetailsDialog
  bind:this={detailsDialog}
  onEscape={() => escapeDetails()}
  onClosed={() => detailsClosed()}
/>

{#if pullsView}
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
{/if}

<!-- #714: the one polite live region for per-pull-request feedback, and
     the toast stack. Neither the toasts nor the Activity panel is live
     itself, so each event is spoken once. -->
<div
  id="feedback-live"
  class="sr-only"
  role="status"
  aria-live="polite"
  aria-atomic="true"
></div>
<ul
  id="feedback-toasts"
  class="feedback-toasts"
  aria-label="Notifications"
></ul>
