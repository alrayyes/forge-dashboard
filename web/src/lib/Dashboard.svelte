<script lang="ts">
  // The dashboard is two pages sharing one script: pull requests at "/" and
  // issues at "/issues" (#827). Each view renders only its own board and
  // controls; every id the script looks up that the other view lacks is
  // already null-guarded.
  let { view }: { view: "pulls" | "issues" } = $props();

  import { onMount } from "svelte";
  import * as Filters from "#lib/filters.js";
  import { issueCount } from "#lib/issue-count.svelte.js";
  import { findAction, type AllowedAction } from "#lib/allowed-actions.js";
  import * as Stacks from "#lib/stacks.js";
  import type { FilterableItem, SharedFilterState } from "#lib/filters.js";
  import {
    type ActionCode,
    type ActionRequestError,
    interpretActionFailure,
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
    type BotRequest,
    createFeedbackStore,
  } from "#lib/feedback.js";
  import { mountFeedbackUI } from "#lib/feedback-ui.js";
  import type { RevealOutcome } from "#lib/feedback-ui.js";
  import {
    budgetText,
    isRateLimited,
    msUntilReset,
    PERMISSION_REASON,
    type RateLimit,
    rateLimitReasonText,
  } from "#lib/rate-limit.js";
  import {
    formatTime,
    onTimezoneChange,
    effectiveZone,
  } from "#lib/time.svelte.js";

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

  type PullRequestItem = FilterableItem & {
    number: number;
    url: string;
    draft: boolean;
    ci: string;
    mergeStatus: string;
    autoMergeEnabled: boolean | null;
    behind: boolean;
    empty: boolean;
    // What the server offers on this pull request (#805).
    allowedActions?: AllowedAction[];
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
  };
  // Matches components.schemas.Check in api/openapi.yaml — one job/check
  // run against a pull request's head commit, as returned by
  // GET /api/pull-requests/checks.
  // `required` is absent when the forge couldn't tell (#681) — not the
  // same as false.
  type Check = {
    name: string;
    state: string;
    url: string;
    required?: boolean;
    durationSeconds?: number;
    failedStep?: string;
    excerpt?: string;
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
    forges: Forge[];
    pullRequests: PullRequestItem[];
    issues: IssueItem[];
    // How many issues are real work, from the server (#980).
    openIssueCount?: number;
    repos?: Filters.RepoRef[];
    // Drafts the API left out (#791). 0 when the request asked for them.
    hiddenDrafts?: number;
    // What this app auto-merged in the last ten minutes (Forgejo).
    autoMerged?: ServerAutoMerged[];
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
    const REFRESH_INTERVAL_MS = 30000;
    // Counts the snapshot fetches started so far, so a queued bot rebase
    // can tell a fetch begun before its click from one begun after (#691).
    let requestSeq = 0;
    // When the background poll next fires — what the queued-action
    // banner's countdown reads, so it tracks the real cadence instead of
    // a number hard-coded next to REFRESH_INTERVAL_MS. Re-armed by the
    // setInterval(refresh) callback itself.
    let nextPollAt = Date.now() + REFRESH_INTERVAL_MS;

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
      countdownText: () => queuedCountdownText(),
      revealRow: (key) => revealRow(key),
    });
    function actionRef(item: PullRequestItem): ActionRef {
      return { key: prKey(item), repo: item.repo, number: item.number };
    }
    // A failed action: the row gets a Failed line (with Retry unless the
    // failure locked the button), and an error toast that stays.
    function failAction(
      actionKey: string,
      what: string,
      reason: string,
      canRetry: boolean,
    ) {
      const message = `Couldn't ${what}: ${reason}`;
      feedback.update(actionKey, {
        phase: "failed",
        inline: reason,
        message,
        toast: true,
        announce: message,
        canRetry,
      });
    }
    const CI_LABELS: Record<string, string> = {
      success: "Passing",
      failure: "Failing",
      pending: "Running",
      none: "No checks",
    };
    const FORGE_LABELS = Filters.FORGE_LABELS;
    const FORGE_SHORT_LABELS: Record<string, string> = {
      github: "GH",
      forgejo: "FJ",
    };
    const FORGE_CLASSES: Record<string, string> = {
      github: "gh",
      forgejo: "fj",
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
    // "Passing" reads fine right next to a Merge button already
    // prompting action on the same row — "Passed" there is just a
    // second, redundant way of saying "ready." Once there's no merge
    // action on the row for the pill to sit beside, "Passed" is the
    // plainer, more finished-sounding word, matching GitHub's and
    // GitLab's own terminal-state convention (both say "passed", not
    // "passing", for a completed successful run).
    function ciPill(
      status: string,
      onStatusClick: ((status: string) => void) | undefined,
      showsMergeButton: boolean,
    ): HTMLButtonElement {
      const label =
        status === "success" && !showsMergeButton
          ? "Passed"
          : CI_LABELS[status] || status;
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = `ci-pill ${status}`;
      pill.appendChild(el("span", "dot"));
      pill.appendChild(document.createTextNode(label));
      pill.setAttribute(
        "aria-label",
        `Filter pull requests by CI status: ${label}`,
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

    // Dependabot and Renovate pull requests never get
    // updateBranchActionCell's own inline button — that function returns
    // null for them on purpose (see its own doc comment: their own Rebase
    // actions do that job). release-please does get the button (#728),
    // so it's left out here the same way a plain pull request is. Without this
    // pill a bot-managed row that's actually behind had no visible sign
    // of it at all — confirmed live against a real Dependabot PR
    // (hush-hush-python#153) that GitHub itself flagged "out-of-date
    // with the base branch" while this dashboard showed nothing, with
    // the one relevant action (Dependabot: Rebase) sitting unlabeled
    // inside "More actions." Silent for every non-bot pull request:
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
      const pill = el("span", "merge-pill behind");
      pill.appendChild(el("span", "dot"));
      pill.appendChild(document.createTextNode("Out of date"));
      return pill;
    }

    // #707: a bot rebase the bot has picked up. The Out of date pill is
    // already gone (the pull request isn't behind any more); this one
    // stays until CI shows as restarted, so the row doesn't go quiet in
    // between. Words, not just a tint.
    function rebasingPill(item: PullRequestItem): HTMLElement | null {
      const rebasing =
        dependabotActionState[`${prKey(item)}:rebase`]?.phase === "rebasing" ||
        renovateRebaseState[prKey(item)]?.phase === "rebasing";
      if (!rebasing) return null;
      const pill = el("span", "merge-pill rebasing");
      pill.appendChild(el("span", "dot"));
      pill.appendChild(document.createTextNode("Rebasing…"));
      return pill;
    }

    // Silent unless auto-merge is genuinely enabled — autoMergeEnabled
    // is `null` for a forge that can't report this at all (Forgejo,
    // today), which must never render as "not enabled": strict ===
    // true, not a truthy check.
    function autoMergePill(pr: PullRequestItem): HTMLElement | null {
      if (pr.autoMergeEnabled !== true) return null;
      const pill = el("span", "merge-pill auto-merge");
      pill.appendChild(el("span", "dot"));
      // On Forgejo this app does the merging, not the forge, and the pill
      // says so in words (it has no GitHub-style setting to point at).
      if (pr.forge === "forgejo") {
        pill.appendChild(document.createTextNode("Auto-merge on"));
        pill.appendChild(el("span", "pill-note", "Managed by Forge Dashboard"));
        return pill;
      }
      pill.appendChild(document.createTextNode("Auto-merge"));
      return pill;
    }

    // Why an armed Forgejo pull request hasn't merged yet, as text led by
    // the state, so it never rests on colour alone.
    function autoMergeStatusLine(pr: PullRequestItem): HTMLElement | null {
      if (pr.forge !== "forgejo" || !pr.autoMerge) return null;
      const lead = pr.autoMerge.state === "stopped" ? "Stopped" : "Waiting";
      const line = el("span", `auto-merge-status ${pr.autoMerge.state}`);
      line.appendChild(el("strong", "", `${lead}: `));
      line.appendChild(document.createTextNode(pr.autoMerge.message));
      return line;
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

    function buildRow(
      item: PullRequestItem | IssueItem,
      isPR: boolean,
      onStatusClick: ((status: string) => void) | undefined,
      onLabelClick: (name: string) => void,
      activeLabel: string,
    ): HTMLElement {
      const row = el("div", "row");

      row.appendChild(repoCell(item));
      const titleCellEl = titleCell(item, onLabelClick, activeLabel);
      row.appendChild(titleCellEl);
      if (!isPR) row.dataset.issueKey = prKey(item);
      if (isPR && (item as PullRequestItem).stack)
        titleCellEl.appendChild(stackInfo(item as PullRequestItem));
      if (isPR) {
        row.dataset.prKey = prKey(item);
        if (updatedMarkers.has(prKey(item)))
          titleCellEl.appendChild(
            el("span", "updated-just-now", "Updated just now"),
          );
      }

      const meta = el("div", "row-meta");
      meta.appendChild(el("div", "author", item.author));
      meta.appendChild(timeCell("created", "Created", item.createdAt));
      meta.appendChild(timeCell("updated", "Updated", item.updatedAt));
      if (isPR) {
        const pr = item as PullRequestItem;
        // One cell, possibly several pills — keeps .row's fixed
        // grid-template-columns unchanged regardless of how many of
        // them this particular row has anything to say.
        const statusCell = el("div", "status-cell");
        const mergeAction = mergeActionCell(pr);
        statusCell.appendChild(
          ciPill(
            pr.ci,
            onStatusClick,
            mergeAction !== null &&
              !mergeAction.classList.contains("row-action-locked"),
          ),
        );
        const conflictPill = mergeStatusPill(pr.mergeStatus, pr.ci);
        if (conflictPill) statusCell.appendChild(conflictPill);
        const outOfDatePill = behindPill(pr);
        if (outOfDatePill) statusCell.appendChild(outOfDatePill);
        const rebasing = rebasingPill(pr);
        if (rebasing) statusCell.appendChild(rebasing);
        const mergePill = autoMergePill(pr);
        if (mergePill) statusCell.appendChild(mergePill);
        const mergeStatusLine = autoMergeStatusLine(pr);
        if (mergeStatusLine) statusCell.appendChild(mergeStatusLine);

        // Found already merged or closed: the badge replaces Merge, and
        // nothing else on the row has anything left to do.
        const settledRow = isSettled(pr);
        const cancelAutoMerge = settledRow ? null : cancelAutoMergeCell(pr);
        if (cancelAutoMerge) statusCell.appendChild(cancelAutoMerge);
        const updateBranchAction = settledRow
          ? null
          : updateBranchActionCell(pr);
        if (updateBranchAction) statusCell.appendChild(updateBranchAction);
        // Dependabot/Renovate's own Rebase asks for exactly what Update
        // branch does on every other row — bring the branch back in sync
        // — just through the bot's own comment command instead of this
        // app writing to the branch directly (see updateBranchActionCell's
        // doc comment for why those rows never get that button).
        // Promoted inline the same way, and only the once, when it's
        // actually the thing to do: Recreate is rarer and stays in "More
        // actions" regardless (#527).
        const dependabotRebasePromoted =
          !settledRow &&
          pr.behind &&
          !pr.empty &&
          Boolean(findAction(pr, "dependabot_rebase"));
        const renovateRebasePromoted =
          !settledRow &&
          pr.behind &&
          !pr.empty &&
          Boolean(findAction(pr, "renovate_rebase"));
        if (dependabotRebasePromoted) {
          if (!dependabotRebaseHidden(pr))
            statusCell.appendChild(dependabotActionButton(pr, "rebase"));
        } else if (renovateRebasePromoted) {
          const promoted = renovateRebaseActionCell(pr);
          if (promoted) statusCell.appendChild(promoted);
        }
        // Inline like every other row action, not collapsed into "More
        // actions" (#636): it's a read-only drill-down into data the row
        // is already summarizing (the CI pill), not a rare or mutating
        // action the way Dependabot/Renovate's own actions are.
        const pipelineAction = pipelineActionCell(pr);
        if (pipelineAction) statusCell.appendChild(pipelineAction);
        if (mergeAction) statusCell.appendChild(mergeAction);
        // Close lives in "More actions" behind its confirm step (#705):
        // it's rarely what the row needs, and the one button left beside
        // a waiting Merge read as "close is what you do next".
        const secondaryActions = (
          settledRow
            ? []
            : [
                autoMergeActionCell(pr),
                dependabotRebasePromoted
                  ? dependabotRecreateOnlyCell(pr)
                  : dependabotActionCell(pr),
                renovateRebasePromoted ? null : renovateRebaseActionCell(pr),
                closeActionCell(pr),
              ]
        ).filter((cell): cell is HTMLElement => cell !== null);
        const moreActions = moreActionsCell(pr, secondaryActions);
        if (moreActions) statusCell.appendChild(moreActions);
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

    // One line under a group heading while that forge's REST budget is
    // spent, so the reset time is stated once instead of on every row
    // (#732). Plain text, not a live region: the same sentence is already
    // each disabled button's accessible description.
    function groupRateLimitNote(forgeName: string): HTMLElement | null {
      const health = lastForges.find((f) => f.forge === forgeName);
      if (!isRateLimited(health?.rateLimitREST)) return null;
      return el(
        "p",
        "group-rate-limit",
        rateLimitedReason(forgeName, health?.rateLimitREST),
      );
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
    ): HTMLElement {
      const reasonText = typeof lock === "string" ? lock : lock.reason;
      const code = typeof lock === "string" ? undefined : lock.code;
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
      const reasonId = `action-locked-reason-${actionLockReasonCounter++}`;
      button.setAttribute("aria-describedby", reasonId);
      if (onRetry) {
        button.addEventListener("click", onRetry);
      } else {
        button.setAttribute("aria-disabled", "true");
      }
      wrap.appendChild(button);
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
        // The specific reason (unreachable, rate-limited, ...) is
        // already stated once in the forge-health panel above, via
        // forgeErrorHeadline — repeating the same system-wide fact
        // under every affected row read as noise, not information
        // (#360).
        return { reason: "See the forge status above." };
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
    ) {
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
        failAction(fkey, what, outcome.reason, false);
      } else {
        setState({ phase: "idle" });
        failAction(fkey, what, outcome.reason, true);
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
        phase: "working",
        inline: "Merging…",
        message: "Merging…",
        announce: "Merging…",
        // A merge is never re-sent without the confirm step.
        retry: () => {
          feedback.drop(fkey);
          armConfirm("merge", item);
          renderPRBoard();
          document.getElementById(`merge-confirm-${domSafeId(key)}`)?.focus();
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
                failAction(fkey, "merge", err.message, true);
              })
              .catch(() => {
                mergeState[key] = { phase: "idle" };
                failAction(fkey, "merge", err.message, true);
                renderPRBoard();
              });
            return;
          }

          renderActionRefusal(item, err, fkey, "merge", (next) => {
            mergeState[key] = next;
          });
        });
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
      if (merge.blocked)
        return lockedActionButton(
          "Merge",
          merge.blocked.message,
          undefined,
          merge.blocked.next,
        );

      const key = prKey(item);
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
      mergeButton.id = `merge-arm-${domSafeId(key)}`;
      mergeButton.addEventListener("click", () => {
        armConfirm("merge", item);
        renderPRBoard();
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
          // Same "close the popover this button lives in, once it has
          // nothing left to say" reasoning doDependabotAction's own
          // success handler uses.
          closeAllActionMenus();
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

    // ---- cancel this app's auto-merge (Forgejo) ----
    // The intent is stored here, so cancelling sends nothing to the forge
    // and has nothing to confirm: arming it again is one click.
    const cancelAutoMergeState: Record<string, ActionState> = {};

    function doCancelAutoMerge(item: PullRequestItem) {
      const key = prKey(item);
      cancelAutoMergeState[key] = { phase: "requesting" };
      keepFocusAcross(renderPRBoard);
      const fkey = `cancel-auto-merge:${key}`;
      feedback.start({
        actionKey: fkey,
        ref: actionRef(item),
        label: "Cancel auto-merge",
        phase: "working",
        inline: "Cancelling auto-merge…",
        message: "Cancelling auto-merge…",
        announce: "Cancelling auto-merge…",
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
            message: "Auto-merge cancelled.",
            toast: true,
            announce: "Auto-merge cancelled.",
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

    function cancelAutoMergeCell(item: PullRequestItem): HTMLElement | null {
      if (!findAction(item, "cancel_auto_merge")) return null;

      const requesting =
        cancelAutoMergeState[prKey(item)]?.phase === "requesting";
      const button = buttonEl(
        "row-action",
        requesting ? "Cancelling…" : "Cancel auto-merge",
      );
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
        document.getElementById(`${kind}-arm-${domSafeId(key)}`)?.focus();
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

    function armedGroup(): Element | null {
      const armKey = confirmArm.armedKey();
      if (!armKey) return null;
      for (const group of Array.from(
        document.querySelectorAll(".confirm-group"),
      ))
        if ((group as HTMLElement).dataset.armKey === armKey) return group;

      return null;
    }
    const inArmedGroup = (target: EventTarget | null) => {
      const group = armedGroup();

      return Boolean(group && target instanceof Node && group.contains(target));
    };

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
        setTimeout(() => confirmArm.disarm("outside", armKey), 0);
      },
      true,
    );

    // Registered before the More actions menu's own Escape handler below,
    // so Escape on an armed Close ends the confirm and leaves the menu open;
    // a second Escape closes the menu.
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
        phase: "working",
        inline: "Closing…",
        message: "Closing…",
        announce: "Closing…",
        // Like merge, a close is never re-sent without its confirm step.
        retry: () => {
          feedback.drop(fkey);
          // The confirm lives in the menu, so the menu has to be open.
          openActionMenus[key] = true;
          armConfirm("close", item);
          renderPRBoard();
          document.getElementById(`close-confirm-${domSafeId(key)}`)?.focus();
        },
      });

      // The confirm was the menu's last job, and progress shows on the row
      // itself (Closing…, then a toast). Leaving it open would also hold
      // back the next snapshot, so the closed pull request would linger
      // until someone dismissed the menu (#705). Focus goes back to the
      // trigger rather than falling to the page when the confirm button
      // disappears.
      if (openActionMenus[key]) {
        delete openActionMenus[key];
        renderPRBoard();
        document
          .getElementById(`row-actions-trigger-${domSafeId(key)}`)
          ?.focus();
      }

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

    // Shown for every open pull request row, gated only on the forge
    // itself being reachable/within budget — unlike Merge, Close needs
    // no particular mergeability or CI state to make sense. Rendered
    // inside "More actions" (#705), so its confirm step has to survive
    // the menu: openActionMenus persists across the re-render, and the
    // confirm button is focused by id the same as before.
    function closeActionCell(item: PullRequestItem): HTMLElement | null {
      if (!findAction(item, "close")) return null;
      const key = prKey(item);
      const entry = closeState[key] || { phase: "idle" };

      if (entry.phase === "locked") {
        // Confirming closes the menu, so the lock would only show after
        // reopening it. The trigger reads these to say so itself (#747).
        const locked = markClose(
          lockedActionButton("Close", lockOf(entry), () =>
            retryLockedAction(item),
          ),
        );
        locked.dataset.lockLabel = "Close";
        locked.dataset.lockReason = entry.reason ?? "";
        return locked;
      }

      if (entry.phase === "idle") {
        const proactiveReason = proactiveActionLockReason(item.forge);
        if (proactiveReason)
          return markClose(
            lockedActionButton("Close", proactiveReason, () =>
              retryLockedAction(item),
            ),
          );
      }

      const wrap = el("span", "row-action-group close-group");

      const confirming = entry.phase === "confirming";
      if (confirming || entry.phase === "closing") {
        const confirmButton = buttonEl(
          "row-action confirm",
          confirming ? "Confirm close?" : "Closing…",
        );
        confirmButton.id = `close-confirm-${domSafeId(key)}`;
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

      // "suggested" when there's nothing to merge (mergeActionCell's own
      // item.empty branch) -- Merge stays visible-and-locked there rather
      // than disappearing (a past incident: a vanished Merge button with
      // no explanation read as broken, not as "nothing to do here"), so
      // Close gets the visual nudge instead of Merge losing its own.
      const closeButton = buttonEl(
        item.empty ? "row-action suggested" : "row-action close",
        "Close",
      );
      closeButton.type = "button";
      closeButton.id = `close-arm-${domSafeId(key)}`;
      closeButton.addEventListener("click", () => {
        armConfirm("close", item);
        renderPRBoard();
        const justConfirmed = document.getElementById(
          `close-confirm-${domSafeId(key)}`,
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
        phase: "queued",
        inline: "Queued",
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
            announce: "Branch update requested. Awaiting the next refresh.",
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
        phase: "queued",
        inline: "Waiting for Dependabot",
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
          //
          // Closes the "More actions" popover this button may have been
          // reached through — left open on success, it had nothing left
          // to say and no way to close itself short of a click elsewhere
          // on the page (confirmed live). Left open on failure/lock
          // below, since that's exactly when the popover is still
          // showing something the user needs to see.
          confirmRequest(dependabotActionState, key);
          feedback.update(fkey, {
            toast: true,
            announce:
              action === "rebase"
                ? "Dependabot rebase requested. It will pick this up shortly."
                : `Dependabot ${action} requested. Awaiting the next refresh.`,
          });
          closeMenuKeepingFocus(prKey(item));
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
          );
        });
    }

    function dependabotActionButton(
      item: PullRequestItem,
      action: "rebase" | "recreate",
    ): HTMLElement {
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

    // GitHub only — Dependabot doesn't run on Forgejo, so there's no
    // equivalent comment command to send there.
    function dependabotActionCell(item: PullRequestItem): HTMLElement | null {
      const rebase = findAction(item, "dependabot_rebase");
      const recreate = findAction(item, "dependabot_recreate");
      if (!rebase && !recreate) return null;

      const wrap = el("span", "row-action-group");
      if (rebase && !dependabotRebaseHidden(item))
        wrap.appendChild(dependabotActionButton(item, "rebase"));
      if (recreate) wrap.appendChild(dependabotActionButton(item, "recreate"));
      return wrap;
    }

    // Just Recreate, for a row whose Rebase button already moved inline
    // (see buildRow's dependabotRebasePromoted) — Recreate still belongs
    // in "More actions" on its own rather than disappearing along with
    // the button it used to share a wrapper with.
    function dependabotRecreateOnlyCell(
      item: PullRequestItem,
    ): HTMLElement | null {
      if (!findAction(item, "dependabot_recreate")) return null;
      return dependabotActionButton(item, "recreate");
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

    // #710: rows stay where they are until the user asks. shownPRs is what
    // the board is showing; latestPRs is the newest snapshot's list that
    // hasn't been applied yet. Each incoming snapshot is compared with
    // what's shown:
    //   - a row whose own content changed (CI, merge status, behind,
    //     labels, title) is updated where it stands and marked briefly;
    //   - rows added, removed or reordered wait behind the "N updates
    //     available" bar until Show updates, or a filter, sort or page
    //     change, applies the whole snapshot in one render.
    // Nothing is applied at all while the guard below holds or updates
    // are paused, and a refresh the user asked for (Refresh now, or the
    // one after their own merge/close/rebase) applies in full unless that
    // guard holds, in which case it lands the moment the guard lifts.
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

    // The issues page's counterpart (#827, #718). Same idea, a simpler rule:
    // a change that would add, remove or move rows is held only while
    // you're scrolled below the top, a control in the list has focus, or
    // updates are paused. Otherwise it applies at once. A row whose own
    // content changed is replaced where it stands, and a snapshot that
    // changes nothing renders nothing.
    let shownIssues: IssueItem[] = [];
    let latestIssues: IssueItem[] | null = null;
    let rawIssues: IssueItem[] = [];
    let latestIssuesAsked = false;

    // How long "Updated just now" stays on a row changed in place.
    const UPDATED_MARKER_MS = 2500;
    const updatedMarkers = new Set<string>();

    // Extends #212's anyRowActionInFlight: also while focus is inside a
    // row, a More actions menu is open or a dialog is open. A re-render
    // under any of those would drop focus or close the menu.
    //
    // A refresh the user asked for from inside a row (Retry, an action's
    // own follow-up refresh) is the one case focus-in-row doesn't hold:
    // the click that triggered it is what's focused there.
    function interactionHoldsBoard(userAsked: boolean): boolean {
      const focusInRow =
        !userAsked && Boolean(document.activeElement?.closest("#pr-rows"));

      return (
        anyRowActionInFlight() ||
        Object.keys(openActionMenus).length > 0 ||
        modalDialogOpen() ||
        focusInRow
      );
    }

    const updatesCount = document.getElementById("updates-count");
    const showUpdatesButton = document.getElementById(
      "show-updates-button",
    ) as HTMLButtonElement | null;
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

    // The live region's text only changes when the count does, so a poll
    // that finds the same pending changes announces nothing.
    function showUpdatesBar(count: number) {
      const text =
        count === 0
          ? ""
          : `${count} ${count === 1 ? "update" : "updates"} available`;
      if (updatesCount && updatesCount.textContent !== text)
        updatesCount.textContent = text;
      if (showUpdatesButton) showUpdatesButton.hidden = count === 0;
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
      showUpdatesBar(0);
    }

    function applyPendingIssuesNow() {
      shownIssues = Filters.sortItems(rawIssues, sharedState.view.sort);
      issueBoard.replaceItems(shownIssues);
      latestIssues = null;
      latestIssuesAsked = false;
      showUpdatesBar(0);
    }

    // Below the top (a little slack for a resting scroll position) or a
    // control in the list has focus: rows must not move under the reader.
    function issuesHoldBoard(userAsked: boolean): boolean {
      if (userAsked) return false;
      const scrolled = window.scrollY > 8;
      const focusInList = Boolean(
        document.activeElement?.closest("#issue-rows"),
      );
      return scrolled || focusInList || updatesPaused();
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
          buildRow(
            item,
            false,
            undefined,
            handleLabelClick,
            sharedState.shared.label,
          ),
        );
      }
    }

    // Returns true when it rendered the board.
    function reconcileIssues(): boolean {
      if (!latestIssues) {
        showUpdatesBar(0);

        return false;
      }
      const userAsked = latestIssuesAsked || shownIssues.length === 0;
      const diff = Filters.diffItems(shownIssues, latestIssues);
      const structural = diff.added + diff.removed + diff.moved;

      if (structural === 0 && diff.changed.length === 0) {
        latestIssues = null;
        showUpdatesBar(0);

        return false;
      }
      const held = issuesHoldBoard(userAsked);
      if (!held && (structural > 0 || userAsked)) {
        shownIssues = latestIssues;
        latestIssues = null;
        latestIssuesAsked = false;
        showUpdatesBar(0);
        issueBoard.setItems(shownIssues, true);

        return true;
      }
      // Anything else lands only as content changes, each row where it
      // stands; structural changes (held here) wait behind the bar.
      if (diff.changed.length > 0) {
        const fresh = new Map(latestIssues.map((i) => [prKey(i), i]));
        const changed = shownIssues
          .filter((i) => diff.changed.includes(prKey(i)))
          .map((i) => fresh.get(prKey(i)) ?? i);
        shownIssues = shownIssues.map((i) => fresh.get(prKey(i)) ?? i);
        replaceIssueRows(changed);
      }
      if (structural === 0) latestIssues = null;
      showUpdatesBar(structural);

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
      const active = document.activeElement;
      const key =
        active instanceof HTMLButtonElement
          ? active.closest<HTMLElement>("#pr-rows .row")?.dataset.prKey
          : undefined;
      const label = active?.textContent;
      const className = active?.className;
      draw();
      if (!key) return;
      const row = Array.from(
        document.querySelectorAll<HTMLElement>("#pr-rows .row"),
      ).find((r) => r.dataset.prKey === key);
      Array.from(row?.querySelectorAll("button") ?? [])
        .find((b) => b.className === className && b.textContent === label)
        ?.focus();
    }

    // Returns true when it rendered the board.
    function reconcilePRs(): boolean {
      if (!latestPRs) {
        showUpdatesBar(0);

        return false;
      }
      const userAsked = latestIsUserAsked || shownPRs.length === 0;
      const diff = Filters.diffItems(shownPRs, latestPRs);
      const structural = diff.added + diff.removed + diff.moved;
      const held =
        interactionHoldsBoard(userAsked) || (updatesPaused() && !userAsked);

      if (held) {
        // Rows stay where they are, but a row a bot just acted on takes
        // its fresh data in place: otherwise it reads "Rebasing…" next to
        // a stale "Out of date" until the other row's action ends (#787).
        const fresh = new Map(latestPRs.map((p) => [prKey(p), p]));
        const settled = shownPRs.filter(
          (p) => botResolvedKeys.has(prKey(p)) && fresh.has(prKey(p)),
        );
        botResolvedKeys.clear();
        if (settled.length > 0) {
          const settledKeys = new Set(settled.map(prKey));
          shownPRs = shownPRs.map((p) =>
            settledKeys.has(prKey(p)) ? (fresh.get(prKey(p)) ?? p) : p,
          );
          keepFocusAcross(() => prBoard.setItems(shownPRs, true));
        }
        const heldDiff = Filters.diffItems(shownPRs, latestPRs);
        showUpdatesBar(
          heldDiff.added +
            heldDiff.removed +
            heldDiff.moved +
            heldDiff.changed.length,
        );

        return settled.length > 0;
      }
      botResolvedKeys.clear();
      if (userAsked) {
        retireFailuresOfRemoved(latestPRs);
        shownPRs = latestPRs;
        latestPRs = null;
        latestIsUserAsked = false;
        showUpdatesBar(0);
        prBoard.setItems(shownPRs);

        return true;
      }
      if (diff.changed.length > 0) {
        const fresh = new Map(latestPRs.map((p) => [prKey(p), p]));
        shownPRs = shownPRs.map((p) => fresh.get(prKey(p)) ?? p);
        markUpdated(diff.changed);
        prBoard.setItems(shownPRs, true);
      }
      if (structural === 0) latestPRs = null;
      showUpdatesBar(structural);

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
        phase: "queued",
        inline: "Waiting for Renovate",
        message: "Renovate rebase requested.",
        bot: botLineInfo("Renovate"),
        retry: () => doRenovateRebase(item, buttonEl("row-action")),
      });

      // Stays "queued" until the next snapshot, same as Dependabot.
      // Same "close the popover this button lives in, once it has
      // nothing left to say" reasoning doDependabotAction's own
      // success handler uses.
      const requested = (alreadyTicked = false) => {
        confirmRequest(renovateRebaseState, key);
        feedback.update(fkey, {
          toast: true,
          ...(alreadyTicked && { message: "Rebase requested." }),
          announce: "Renovate rebase requested. It will pick this up shortly.",
        });
        closeMenuKeepingFocus(prKey(item));
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
      if (!findAction(item, "renovate_rebase")) return null;

      const key = prKey(item);
      const entry = renovateRebaseState[key] || { phase: "idle" };

      if (entry.phase === "locked")
        return lockedActionButton("Renovate: Rebase", lockOf(entry));

      if (entry.phase === "idle") {
        const proactiveReason = proactiveActionLockReason(item.forge);
        if (proactiveReason)
          return lockedActionButton("Renovate: Rebase", proactiveReason);
      }

      const queued = entry.phase === "queued" || entry.phase === "rebasing";
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

    // Which row's dialog this is — closing it (via Escape, a backdrop
    // click, or the close button itself) moves focus back to that row's
    // own "View pipeline" button, the same "return focus to what opened
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

    // A required check that failed (or timed out) is what actually blocks
    // the merge — flagged in text, not colour alone.
    function isBlocking(check: Check): boolean {
      return (
        check.required === true &&
        (check.state === "failure" || check.state === "timed_out")
      );
    }

    // 125 -> "2m 5s", 42 -> "42s", 3700 -> "1h 1m": a duration the way a
    // person reads it, not a bare second count.
    function formatDuration(seconds: number): string {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const sec = seconds % 60;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m ${sec}s`;
      return `${sec}s`;
    }

    function pipelineCheckRow(check: Check): HTMLElement {
      const row = el("li", "pipeline-check");
      const status = el("span", `pipeline-check-status ${check.state}`);
      status.appendChild(el("span", "dot"));
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
            formatDuration(check.durationSeconds),
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
        link.textContent = "View run";
        link.setAttribute("aria-label", `View run: ${check.name}`);
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
      const button = buttonEl("row-action", "Rerun failed checks");
      const status = el("p", "pipeline-rerun-status");
      status.setAttribute("role", "status");
      const failure = el("p", "pipeline-error");
      failure.setAttribute("role", "alert");
      button.addEventListener("click", () => {
        button.disabled = true;
        failure.textContent = "";
        status.textContent = "Queuing the rerun…";
        fetch("/api/pull-requests/rerun-checks", {
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
            if (res.status === 204) return;
            return readActionFailure(res).then((err) => {
              throw err;
            });
          })
          .then(() => {
            status.textContent =
              "Rerun queued. The new results show here after the next refresh.";
          })
          .catch((err: ActionRequestError) => {
            status.textContent = "";
            failure.textContent = err.message;
            button.disabled = false;
          });
      });
      wrap.append(button, status, failure);
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
    // own "View pipeline" button no matter which one was used to get
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

    // Visible whenever the row has any CI at all — "none" already has
    // nothing to show a panel about, the same signal ciPill's own
    // CI_LABELS.none already reads. Inline on the row itself (#636), not
    // collapsed into "More actions": a read-only drill-down into data the
    // CI pill is already summarizing, reached on nearly every row with CI
    // configured, not the rare, mutating kind of action that menu exists
    // for. Given a stable id — openPipelineDialog's own "close" handler
    // refocuses it by this id once the row it lives on has been rebuilt
    // from scratch by a later render.
    function pipelineActionCell(item: PullRequestItem): HTMLElement | null {
      if (item.ci === "none") return null;
      const button = buttonEl("row-action", "View pipeline");
      button.id = `pipeline-trigger-${domSafeId(prKey(item))}`;
      button.addEventListener("click", () => {
        openPipelineDialog(item);
      });
      return button;
    }

    // ---- "More actions" overflow menu ----
    // Merge/Update branch/Close/View pipeline stay inline — every PR row
    // has at most one of the first two, Close is universal, and View
    // pipeline is a read-only drill-down reached on nearly every row with
    // CI configured (#636), not the rare, mutating kind of action this
    // menu exists for. Dependabot Recreate, and Dependabot/Renovate
    // Rebase while it isn't currently the promoted, out-of-date-only
    // inline action (#635), are what's left to stack up on a bot-managed
    // row — reached rarely enough that collapsing them behind one trigger
    // reads as tidying up rather than hiding something anyone reaches for
    // often.
    //
    // Keyed by prKey, not a per-row DOM flag: applySnapshot rebuilds
    // every row from scratch on each 30s poll (REFRESH_INTERVAL_MS), so
    // an open/closed flag living only in the DOM would slam shut on its
    // own mid-decision. Persisting it here is the same reason
    // mergeState/closeState/etc. all live outside the DOM node too.
    const openActionMenus: Record<string, boolean> = {};

    function closeAllActionMenus() {
      for (const key of Object.keys(openActionMenus)) {
        // A "Confirm close?" armed inside the menu doesn't outlive it:
        // reopening the menu later shouldn't find a destructive confirm
        // already waiting (#705).
        confirmArm.disarm("dropped", `close:${key}`);
        if (closeState[key]?.phase === "confirming") delete closeState[key];
        delete openActionMenus[key];
      }
    }

    // Closing the menu a just-clicked action lived in removes the button
    // focus was on, so focus goes back to that row's trigger instead of
    // falling to the page (#690), as Close already does.
    function closeMenuKeepingFocus(key: string) {
      closeAllActionMenus();
      renderPRBoard();
      document.getElementById(`row-actions-trigger-${domSafeId(key)}`)?.focus();
    }

    // Collapses actions into a single trailing "More actions" trigger —
    // absent entirely when there's nothing to collapse, the same "don't
    // render a control with nothing behind it" rule every other action
    // cell here already follows.
    function moreActionsCell(
      item: PullRequestItem,
      actions: HTMLElement[],
    ): HTMLElement | null {
      if (actions.length === 0) return null;

      const key = prKey(item);
      const domKey = domSafeId(key);
      const open = Boolean(openActionMenus[key]);
      const popoverId = `row-actions-popover-${domKey}`;
      const triggerId = `row-actions-trigger-${domKey}`;

      const wrap = el("span", "row-actions-menu");

      const trigger = buttonEl("row-action", "More actions");
      trigger.type = "button";
      trigger.id = triggerId;
      trigger.setAttribute("aria-haspopup", "true");
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
      trigger.setAttribute("aria-controls", popoverId);
      trigger.addEventListener("click", (e) => {
        // Bubbling to the document-level click-outside listener below
        // would immediately re-close whatever this click just opened.
        e.stopPropagation();
        const willOpen = !openActionMenus[key];
        closeAllActionMenus();
        if (willOpen) openActionMenus[key] = true;
        renderPRBoard();
        if (willOpen) {
          // Moves focus into the popover once it exists — same "make
          // the state change reach someone not looking at that exact
          // spot" reasoning mergeActionCell's own focus() call already
          // uses for Confirm merge?.
          //
          // The frame can run late on a busy page. By then the user may
          // already have reached an item, so focus only moves when it
          // isn't inside the popover yet (#770).
          requestAnimationFrame(() => {
            const popover = document.getElementById(popoverId);
            if (!popover || popover.contains(document.activeElement)) return;
            popover.querySelector<HTMLElement>("button")?.focus();
          });
        }
      });
      wrap.appendChild(trigger);

      // A lock found only inside a closed menu would go unseen, so the
      // row carries a visible cue and the trigger the reason (#747). The
      // cue is aria-hidden: the same words reach assistive tech through
      // the trigger's description.
      const locks = actions.filter((a) => a.dataset.lockLabel);
      if (locks.length > 0 && !open) {
        const labels = locks.map((a) => a.dataset.lockLabel).join(", ");
        const cue = el("span", "row-actions-lock", `${labels} locked`);
        cue.setAttribute("aria-hidden", "true");
        wrap.appendChild(cue);
        const why = el(
          "span",
          "sr-only",
          locks
            .map(
              (a) =>
                `${a.dataset.lockLabel} is locked. ${a.dataset.lockReason}`,
            )
            .join(" "),
        );
        why.id = `row-actions-lock-${domKey}`;
        wrap.appendChild(why);
        trigger.setAttribute("aria-describedby", why.id);
      }

      if (open) {
        const popover = el("div", "row-actions-popover");
        popover.id = popoverId;
        popover.setAttribute("role", "group");
        popover.setAttribute("aria-label", "More actions");
        for (const action of actions) popover.appendChild(action);
        wrap.appendChild(popover);
      }

      return wrap;
    }

    // View pipeline opens its own real, modal <dialog> — pipelineDialog
    // further down — independently of this menu (#636: it's an inline row
    // button now, not one of this menu's own actions). A modal dialog
    // still owns Escape and outside clicks while it's open (native
    // showModal() semantics), and this menu's own click-outside/Escape
    // handling has to stand down while one is open: a row's own "More
    // actions" popover can legitimately be open at the same time (View
    // pipeline is a sibling button, not something reached through that
    // popover), and without this guard a stray Escape or outside click
    // while the pipeline dialog is showing would close that unrelated
    // popover out from under the dialog rather than doing nothing, as a
    // native modal's own top-layer behavior already implies it should.
    function modalDialogOpen(): boolean {
      return document.querySelector("dialog[open]") !== null;
    }

    // Closes whichever menu is open on any click outside it — the
    // standard disclosure-pattern behavior, and what stops a stale
    // popover surviving a click on an unrelated row. Wired once at
    // module scope rather than per-row: there's at most one open menu
    // at a time (moreActionsCell's own trigger handler already closes
    // every other one before opening its own), so one listener covers
    // the whole board.
    document.addEventListener("click", (e) => {
      if (modalDialogOpen()) return;
      const target = e.target as HTMLElement | null;
      // A dialog's own close button (or its backdrop) closes the
      // dialog synchronously as part of handling this same click,
      // before it ever bubbles here — modalDialogOpen() above would
      // already read false by then. Checking the click's own target
      // for "was this inside a dialog" catches that case too, so a
      // dialog-closing click never also collapses the menu underneath
      // it out from under whatever focus the dialog's own close
      // handling just restored.
      if (target?.closest("dialog")) return;
      if (Object.keys(openActionMenus).length === 0) return;
      if (target?.closest(".row-actions-menu")) return;
      closeAllActionMenus();
      renderPRBoard();
    });

    // Escape closes the open menu and returns focus to its own trigger
    // — the same "a locked/expanded control never just vanishes out
    // from under keyboard focus" care lockedActionButton's own
    // aria-describedby wiring already takes.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (modalDialogOpen()) return;
      const openKeys = Object.keys(openActionMenus);
      if (openKeys.length === 0) return;
      const [openKey] = openKeys;
      closeAllActionMenus();
      renderPRBoard();
      document
        .getElementById(`row-actions-trigger-${domSafeId(openKey)}`)
        ?.focus();
    });

    // ---- shared filter state ----
    // One object for forge/repo/label/author/title/created/updated/
    // groupBy, applied to both boards at once, plus the two fields with
    // no equivalent on the other entity type (status,
    // hideDependencyDashboard). allPRs/allIssues is the pool the shared
    // bar's dynamic controls (repo/author/label/title) are populated
    // from — only the current page's own entity type (#1071), though a
    // picked filter still applies to both boards, so it carries over.
    const sharedState = Filters.loadState();
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
    Filters.loadStateFromServer().then((got) => {
      const before = JSON.stringify(sharedState);
      if (got) Filters.applyServerState(sharedState, got);
      syncDraftsPreference();
      // Only when the server's copy actually differs from what the cookie
      // already gave the page: a re-render for nothing replaces every row
      // under the reader (#827).
      if (sharedControlsRestored && JSON.stringify(sharedState) !== before) {
        updateSharedFilterOptions();
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
    // selection" to exclude itself from. Board-owned fields (PR status,
    // hideDependencyDashboard) stay out of this by design — matchesFilters
    // is called with isPR: false and extra: undefined, which short-circuits
    // both of those checks to false regardless of isPR.
    function sharedPoolExcluding(
      excludeKey: "" | "repo" | "author" | "label",
    ): FilterableItem[] {
      // Only this page's own entity: a repo, author or label that exists
      // only on the other page would be an option that matches no row
      // here (#1071).
      const items: FilterableItem[] = view === "pulls" ? allPRs : allIssues;
      const shared: Record<string, string> = { ...sharedState.shared };
      if (excludeKey) shared[excludeKey] = "";
      return items.filter((item) =>
        Filters.matchesFilters(item, false, shared, undefined),
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
    function updateSharedFilterOptions() {
      const staleRepo = Filters.populateRepoSelect(
        document.getElementById(
          "shared-repo-select",
        ) as HTMLSelectElement | null,
        sharedPoolExcluding("repo"),
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
      updateGroupByOptions();
      if (staleRepo) sharedState.shared.repo = "";
      if (staleAuthor) sharedState.shared.author = "";
      if (staleLabel) sharedState.shared.label = "";
      if (staleRepo || staleAuthor || staleLabel)
        Filters.saveState(sharedState);
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
      setItems: (
        items: (PullRequestItem | IssueItem)[],
        keepPage?: boolean,
      ) => void;
      // Swaps the list without rendering: a user-driven change applies the
      // pending snapshot, then renders once itself (#710).
      replaceItems: (items: (PullRequestItem | IssueItem)[]) => void;
      render: () => void;
      resetPage: () => void;
      toggleStatus?: (value: string) => string;
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
      onStatusClick: ((status: string) => void) | undefined,
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
          buildRow(
            item,
            isPR,
            onStatusClick,
            handleLabelClick,
            sharedState.shared.label,
          );
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
          const note = isPR ? groupRateLimitNote(first.forge) : null;
          if (note) container.appendChild(note);
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

      function render() {
        const container = document.getElementById(containerId);
        if (!container) return;
        const visible = state.items.filter((item) =>
          Filters.matchesFilters(item, isPR, sharedState.shared, extraState),
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

        if (isPR === (view === "pulls")) {
          visibleResultCount = visible.length;
        }
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
            state.page = 1;
            Filters.saveState(sharedState);
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
          Filters.saveState(sharedState);
          render();
        });
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
            Filters.matchesFilters(item, isPR, sharedState.shared, extraState),
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
        toggleStatus: isPR
          ? (value: string) => {
              onUserChange?.();
              const next = extraState.status === value ? "" : value;
              extraState.status = next;
              state.page = 1;
              Filters.saveState(sharedState);
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
      applyPendingNow,
    );
    const issueBoard = createBoard(
      "issue-rows",
      "issue-empty",
      "issue-no-results",
      false,
      undefined,
      "issue",
      sharedState.issue,
      applyPendingIssuesNow,
    );

    showUpdatesButton?.addEventListener("click", () => {
      if (view === "issues") {
        applyPendingIssuesNow();
        issueBoard.render();
        pauseUpdatesButton?.focus();
        return;
      }
      applyPendingNow();
      prBoard.render();
      // The button hides itself once nothing's pending; keep focus on the
      // bar instead of dropping it to the page.
      pauseUpdatesButton?.focus();
    });
    pauseUpdatesButton?.addEventListener("click", () => {
      sharedState.view.paused = updatesPaused() ? "" : "1";
      Filters.saveState(sharedState);
      syncPauseControl();
      if (view === "issues") reconcileIssues();
      else reconcilePRs();
    });
    syncPauseControl();
    showDraftsButton?.addEventListener("click", () => {
      sharedState.view.drafts = draftsOn() ? "" : "1";
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
          // to the other active shared facets (leave-one-out, #550), so
          // a change to any of the three — plus Forge, which narrows all
          // three unconditionally — has to re-narrow the others right
          // away rather than waiting for the next poll's setItems
          // (#112). Title stays out of this: it's debounced free text
          // and deliberately suggestions-only, not a restrictive facet.
          if (
            col === "forge" ||
            col === "repo" ||
            col === "author" ||
            col === "label"
          )
            updateSharedFilterOptions();
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
        prBoard.resetPage();
        issueBoard.resetPage();
        updateSharedFilterOptions();
        Filters.saveState(sharedState);
        syncQuickPills();
        renderBoth();
      });
    }
    syncQuickPills();

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
      prBoard.resetPage();
      issueBoard.resetPage();
      Filters.saveState(sharedState);
      renderBoth();
    });

    // #354: true once nothing in sharedState differs from Filters' own
    // defaultState() — shared is empty, no CI status, and
    // hideDependencyDashboard is back at its default-checked '1'.
    function filtersAreDefault(): boolean {
      return (
        Object.keys(sharedState.shared).every((k) => !sharedState.shared[k]) &&
        !sharedState.pr.status &&
        !sharedState.pr.quick &&
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
      if (view === "pulls" && sharedState.pr.status)
        chips.push({
          label: `CI ${selectText("status", sharedState.pr.status)}`,
          clear: () => clearSelect("status"),
        });
      if (view === "pulls" && draftsOn())
        chips.push({
          label: "Drafts shown",
          clear: () => showDraftsButton?.click(),
        });
      return chips;
    }

    let renderedChips = "";

    function renderFilterChrome() {
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
      for (const filter of failing) {
        if (filter === "quick") sharedState.pr.quick = "";
        else sharedState.shared[filter] = "";
      }
      if (failing.length > 0) {
        syncQuickPills();
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
      for (const k of Object.keys(sharedState.issue))
        delete sharedState.issue[k];
      sharedState.issue.hideDependencyDashboard = "1";
      syncQuickPills();

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
      if (hideDependencyDashboardCheckbox)
        hideDependencyDashboardCheckbox.checked = true;

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
        const budget = f.rateLimitREST;
        if (budget) {
          const text = el(
            "span",
            "forge-health-budget",
            budgetText(FORGE_SHORT_LABELS[f.forge] || f.forge, budget),
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
    // of the page, with the same critical prominence as the "CI failing"
    // stat tile, so it's visible at a glance.
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
          // The server grades each budget from its own threshold, so the
          // page holds none (#806). A warning is the gauge's amber stage;
          // nothing here needs to act on it.
          if (!rl || rl.severity === "ok" || rl.severity === "warning")
            continue;
          out.push({
            label: `${name} ${kind}`,
            severity: rl.severity,
            resetsAt: rl.resetsAt,
            remaining: rl.remaining,
            limit: rl.limit,
          });
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

    // Rebuilt only when what it says changes. The ticking countdown is
    // updated in place and hidden from assistive tech (WCAG 4.1.3): the
    // banner is an alert, so replacing it every second would have a screen
    // reader read it out every second. The reset time in the label is the
    // static, spoken version of the same fact (#732).
    function renderRateLimitBanner() {
      const existing = document.getElementById("rate-limit-banner");
      if (rateLimitAlerts.length === 0) {
        existing?.remove();
        return;
      }
      // The zone is part of it: a changed zone redraws the reset times.
      const signature = [
        effectiveZone(),
        ...rateLimitAlerts.map(
          (a) => `${a.label}|${a.severity}|${a.resetsAt}|${a.remaining}`,
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
      banner.setAttribute("role", "alert");
      for (const alert of rateLimitAlerts) {
        const exceeded = alert.severity === "exceeded";
        const row = el("div", `rate-limit-banner-row${exceeded ? "" : " low"}`);
        const resetAt = `resets at ${formatTime(alert.resetsAt)}`;
        row.appendChild(
          el(
            "span",
            "rate-limit-banner-label",
            exceeded
              ? `Rate limit exceeded — ${alert.label}, ${resetAt}`
              : `Rate limit running low — ${alert.label}, ${resetAt}`,
          ),
        );
        const timer = el(
          "span",
          "rate-limit-banner-timer",
          bannerTimerText(alert),
        );
        timer.setAttribute("aria-hidden", "true");
        row.appendChild(timer);
        banner.appendChild(row);
      }
      document
        .querySelector(".stats")
        ?.parentElement?.insertBefore(banner, document.querySelector(".stats"));
    }

    function bannerTimerText(alert: RateLimitAlert): string {
      return alert.severity === "exceeded"
        ? countdownLabel(alert.resetsAt)
        : `${alert.remaining.toLocaleString()} of ${alert.limit.toLocaleString()} requests left — ${countdownLabel(alert.resetsAt)}`;
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

    setInterval(() => {
      tickRefreshedAt();
      feedbackUI.tick();
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
        .querySelector(".stats")
        ?.parentElement?.insertBefore(banner, document.querySelector(".stats"));
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
            inline: "Waiting for Dependabot",
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
          inline: "Waiting for Renovate",
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
          inline: "Queued",
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
              inline: "Rebasing…",
              message: kind.pickedUpMessage,
              announce: `${kind.pickedUpMessage} Waiting for CI to restart.`,
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
              inline: "Rebasing…",
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
      return seconds === 0 ? " Refreshing…" : ` (next refresh in ${seconds}s)`;
    }

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
      const seq = ++requestSeq;
      return fetch(withDrafts("/api/dashboard/refresh"), {
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
        .then((data) => applySnapshot(data, true, seq));
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
      clearError();
      lastGeneratedAt = data.generatedAt;
      tickRefreshedAt();

      renderForgeHealth(data.forges || []);
      lastForges = data.forges || [];
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
      const prs = data.pullRequests || [];
      hiddenDrafts = data.hiddenDrafts ?? 0;
      syncDraftsToggle();
      // Only a snapshot that shows the request settled ends a queued bot
      // rebase or Update branch — not just any snapshot (#706, #982). Cleared before
      // anyRowActionInFlight is consulted below, so a resolved row
      // doesn't also hold the board back.
      const botChanged = syncServerRequests(prs, startedSeq);
      const issues = data.issues || [];
      issueCount.value = data.openIssueCount ?? 0;
      allPRs = prs;
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
      // Each board's own render() sets its stat tile's text too (the
      // same filtered-vs-total wording its own count already uses), so
      // the tile never disagrees with the board sitting right below it.
      //
      // #212, #710: ingestPRs compares this against what the board shows
      // and either updates rows in place or holds the change behind the
      // updates bar — see reconcilePRs.
      ingestPRs(prs, userAsked, botChanged);
      // A bot request changing state (picked up, finished, expired) changes
      // the row's button, pill and line even when the pull request's own
      // data didn't, so the board redraws for it (#707).
      if (botChanged.size > 0) keepFocusAcross(renderPRBoard);
      if (view === "issues") ingestIssues(issues, userAsked);
      else issueBoard.setItems(issues);

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

    // Reused by refresh() below and by the WebMCP tool further down --
    // one fetch layer for /api/dashboard, not two.
    function fetchDashboardData(): Promise<DashboardSnapshot> {
      const url = withDrafts(
        "/api/dashboard" +
          (currentOwner ? `?owner=${encodeURIComponent(currentOwner)}` : ""),
      );

      return fetch(url, { headers: { Accept: "application/json" } }).then(
        (res) => {
          if (res.status === 401) {
            window.location.href = "/login.html";
            throw new Error("session expired");
          }
          if (!res.ok) throw new Error(`backend answered ${res.status}`);

          return res.json();
        },
      );
    }

    function refresh(userAsked = false) {
      const seq = ++requestSeq;
      fetchDashboardData()
        .then((data) => applySnapshot(data, userAsked, seq))
        .catch((err: Error) => {
          showError(`Could not reach the backend: ${err.message}`);
        });
    }

    refresh();
    setInterval(() => {
      nextPollAt = Date.now() + REFRESH_INTERVAL_MS;
      refresh();
    }, REFRESH_INTERVAL_MS);

    // ---- WebMCP (webmachinelearning/webmcp) tool: get_dashboard ----
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
      document.modelContext.registerTool({
        name: "get_dashboard",
        description:
          "Fetch the aggregated open pull requests, issues, and CI/forge health this dashboard already tracks across GitHub and Forgejo -- the same read-only data currently rendered on this page. Read-only: this never writes to either forge.",
        async execute() {
          const seq = ++requestSeq;
          const data = await fetchDashboardData();
          applySnapshot(data, false, seq);

          return data;
        },
      });
    }

    // ---- live updates over Server-Sent Events, on top of the poll above ----
    // The poll keeps running unconditionally — this only ever makes the
    // dashboard update sooner than the next one, never a replacement
    // for it. A browser or proxy that can't hold this connection open
    // just never benefits from it: EventSource retries on its own, and
    // if it never connects at all the poll still keeps the data fresh.
    // The stream reads includeDrafts once, when it opens, so a changed
    // choice reopens it (#791).
    let eventSource: EventSource | null = null;
    let streamDrafts = false;
    function openStream() {
      if (!window.EventSource) return;
      eventSource?.close();
      streamDrafts = draftsOn();
      eventSource = new EventSource(withDrafts("/api/dashboard/stream"));
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
    openStream();

    // A saved choice that arrives after the first fetch (the server's copy
    // beating a stale cookie) needs the data and the stream redone.
    syncDraftsPreference = () => {
      syncDraftsToggle();
      if (draftsOn() === streamDrafts) return;
      openStream();
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
      stopTimezone();
      document.removeEventListener("keydown", onSlashShortcut);
    };
  }
</script>

<svelte:head>
  <title>{view === "issues" ? "Issues — Forge Board" : "Forge Board"}</title>
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
  </div>
  <div class="stats">
    {#if view === "pulls"}
      <div class="stat">
        <div class="n" id="stat-prs">&ndash;</div>
        <div class="label">Open pull requests</div>
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
    {:else}
      <div class="stat">
        <div class="n" id="stat-issues">&ndash;</div>
        <div class="label">Open issues</div>
      </div>
    {/if}
    <div class="stat">
      <div class="n" id="stat-repos">&ndash;</div>
      <div class="label">Repos tracked</div>
    </div>
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
      {#if view === "pulls"}
        <button
          type="button"
          class="quick-pill"
          data-pill="failing"
          aria-pressed="false">Failing CI</button
        >
        <button
          type="button"
          class="quick-pill"
          data-pill="bots"
          aria-pressed="false">Bot PRs</button
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
      {#if view === "pulls"}
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
      class="updates-count"
      id="updates-count"
      role="status"
      aria-live="polite"
    ></span>
    <button type="button" class="updates-show" id="show-updates-button" hidden
      >Show updates</button
    >
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

  {#if view === "pulls"}
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
  {:else}
    <section class="board" aria-label="Open issues">
      <div class="board-head">
        <h2>Issues</h2>
        <div class="board-head-controls">
          <label class="checkbox-filter">
            <input
              type="checkbox"
              id="issue-hide-dependency-dashboard"
              checked
            />
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
  {/if}
</div>

{#if view === "pulls"}
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
