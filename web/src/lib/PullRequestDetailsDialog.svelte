<script module lang="ts">
  import type { ItemReference } from "./issue-references";
  import type { RelatedBandData } from "./related-band";

  // The header's status, drawn by the row's own builders in Dashboard.svelte
  // so the two cannot drift (#1563): the CI slot and merge state, and the
  // attribute chips.
  export type DetailsStatus = {
    state: HTMLElement;
    attributes: HTMLElement;
    // The Related band between the title block and the description (#4220);
    // absent when nothing is related.
    related?: RelatedBandData;
  };

  // The part of a row this dialog needs. An issue row opens the same dialog
  // with subject "issue": its own endpoint and wording, no release notes and
  // no footer actions. A published release (from the Main branches page) is
  // subject "release": found by its tag, with its notes and nothing else.
  type TargetBase = {
    forge: string;
    repo: string;
    title: string;
    url: string;
    // Drawn from the row the dialog was opened from, as it was then. Nothing
    // here is fetched.
    status?: DetailsStatus;
  };

  // A pull request or an issue: found by its number.
  export type ItemTarget = TargetBase & {
    subject?: "pull-request" | "issue";
    number: number;
    kind?: "release" | "dependency" | "regular";
    // Who filed an issue and the forge's avatar for them, from its row. Only
    // the issue dialog shows them.
    author?: string;
    authorAvatarUrl?: string;
    // The filer's page on the forge, built by the server; empty when none.
    authorUrl?: string;
  };

  // A release has a tag and no number, so there is nothing to fake.
  export type ReleaseTarget = TargetBase & {
    subject: "release";
    tag: string;
  };

  export type DetailsTarget = ItemTarget | ReleaseTarget;

  // The one place that tells the two cases apart.
  const isReleaseTarget = (t: DetailsTarget): t is ReleaseTarget =>
    t.subject === "release";

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
  // GET /api/v1/pull-requests/details or GET /api/v1/issues/details, fetched when
  // the dialog opens and never as part of the snapshot. Dashboard.svelte calls
  // open() from a row's trigger and holds nothing else of this dialog's state.
  import RelatedBand from "#lib/RelatedBand.svelte";
  import { onDestroy, tick } from "svelte";
  import { createDwell } from "#lib/reference-dwell.js";
  import { syncScrollRegion } from "#lib/scroll-region.js";
  import { avatarSrc } from "#lib/avatar.js";
  import { profileHref } from "#lib/profile-link.js";
  import { forgeClassOf, forgeLabelOf } from "#lib/forges.js";
  import { imageFallback } from "#lib/image-fallback.js";
  import { patchHtml } from "#lib/patch-html.js";
  import { imageSourceFor } from "#lib/image-source.js";
  import { renderMarkdown } from "#lib/markdown.js";
  import {
    type ClickedReference,
    referenceAt,
    referenceFromClick,
  } from "#lib/reference-links.js";
  import {
    detailsCache,
    detailsKey,
    type DetailsRef,
  } from "#lib/details-cache.js";
  import { titleSegments } from "#lib/title-code.js";
  import { repoUrlOf } from "#lib/repo-url.js";

  // Puts a node the row's builders made into the header. A node already in
  // place stays put: moving it would drop keyboard focus from inside it
  // whenever the dialog redraws for another reason (the details arriving).
  const adopt = (content: HTMLElement) => (node: HTMLElement) => {
    if (node.firstChild !== content || node.childNodes.length !== 1)
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
    // Only an issue's details say it: open or closed in the forge right now.
    state?: "open" | "closed";
    // Only the issues endpoint says it: a forge shares one number space, so
    // what was asked for as an issue can be a pull request (#4188).
    kind?: "issue" | "pullRequest";
    // Only the issues endpoint says it: the items that refer to this one.
    references?: ItemReference[];
    // With kind `pullRequest`: the title, author and state the board has no
    // row for, so the header can say them. The server says the facts, the
    // dialog words them.
    pullRequest?: {
      title: string;
      state: "open" | "closed" | "merged";
      author: { login: string; avatarUrl: string; url: string } | null;
    };
  };

  // Dashboard.svelte's hooks: Escape first backs out of an armed confirm, and
  // it hears when the dialog has closed.
  let {
    onEscape,
    onClosed,
    onIssueState,
    onPullRequestFound,
    onReferences,
    onReference,
    onWarmReference,
    trackedRepo,
  }: {
    onEscape?: () => boolean;
    onClosed?: () => void;
    // An issue's details arrived: whether the forge has it closed.
    onIssueState?: (closed: boolean) => void;
    // What was opened as an issue turned out to be a pull request (#4188), and
    // the dialog now shows it as one. The page drops the issue's own state.
    onPullRequestFound?: () => void;
    // An issue's details arrived with the items that refer to it (#4271).
    onReferences?: (references: ItemReference[]) => void;
    // A `#12` or `owner/repo#12` in the text was clicked (#3744): the page
    // swaps this dialog for that item's. Without it, references are forge
    // links.
    // Returns false when it left the click alone (an item of an untracked
    // repository the forge has not answered for yet): the link is followed.
    onReference?: (
      reference: ClickedReference & { forge: string },
      triggerId: string,
    ) => boolean;
    // The pointer or focus is on a reference to an untracked repository (#4269):
    // time to ask the forge whether it can show it.
    onWarmReference?: (reference: {
      forge: string;
      repo: string;
      number: number;
    }) => void;
    // Whether the dashboard tracks this repository (`owner/name`) on a forge,
    // which decides if a reference is a dashboard link or goes to the forge.
    // Without `onReference` that link is followed as a plain link to the
    // Issues page, which opens the item (#4230).
    trackedRepo?: (forge: string, repo: string) => boolean;
  } = $props();

  let dialogEl = $state<HTMLDialogElement>();
  let bodyEl = $state<HTMLElement>();
  // These three hosts exist from the start so the page can fill them in the
  // same tick it opens the dialog, and move focus into them at once.
  let statusHost = $state<HTMLElement>();
  let feedbackHost = $state<HTMLElement>();
  let optionHost = $state<HTMLElement>();
  let actionsHost = $state<HTMLElement>();
  let target = $state<DetailsTarget | null>(null);
  let returnFocusId = "";
  let returnFocusFallbackId = $state("");
  let phase = $state<"loading" | "error" | "ready">("loading");
  let errorMessage = $state("");
  let details = $state<Details | null>(null);
  // The cache key of a pull request that was opened from a bare number. Only
  // the issues endpoint says its title, author and state, so every read of it,
  // the quiet one after a cached open and a reload alike, goes there.
  let referencedKey: string | null = null;
  // Markdown rendered to safe HTML, by "description", "notes" or comment id.
  let html = $state<Record<string, string>>({});
  // Avatars that failed to load, by comment id: they fall back to an initial.
  let brokenAvatars = $state<Record<string, boolean>>({});
  // The same for the avatar of whoever filed the issue, in the header.
  let brokenFilerAvatar = $state(false);

  // Bumped on every open and every close: a slow answer for a closed dialog,
  // or for another pull request, never lands.
  let token = 0;

  const forgeId = $derived(target?.forge ?? "");
  const forgeLabel = $derived(target ? forgeLabelOf(target.forge) : "");
  const releaseNotes = $derived(details?.releaseNotes ?? null);
  const releaseTarget = $derived(
    target && isReleaseTarget(target) ? target : null,
  );
  const itemTarget = $derived(
    target && !isReleaseTarget(target) ? target : null,
  );
  // A pull request opened from a bare number has no row to draw from: its
  // header words what the server said instead.
  const facts = $derived(
    itemTarget && !itemTarget.status ? (details?.pullRequest ?? null) : null,
  );
  const STATE_WORDS = { open: "Open", closed: "Closed", merged: "Merged" };
  // The status chip of a header with no row behind it: a pull request's from
  // the facts, an issue's from its details. Empty while they are on the way,
  // when the row is held at the chip's height so nothing below it moves.
  const stateWord = $derived(
    !itemTarget || itemTarget.status
      ? null
      : facts
        ? STATE_WORDS[facts.state]
        : details?.state
          ? STATE_WORDS[details.state]
          : "",
  );
  // Who opened it: the filer on an issue's row, the author the server named
  // on a pull request found by number.
  const byline = $derived.by(() => {
    if (itemTarget?.subject === "issue" && itemTarget.author)
      return {
        label: "Filed by",
        name: itemTarget.author,
        avatar: itemTarget.authorAvatarUrl,
        url: itemTarget.authorUrl,
      };
    if (facts?.author)
      return {
        label: "Opened by",
        name: facts.author.login,
        avatar: facts.author.avatarUrl,
        url: facts.author.url,
      };
    return null;
  });
  const isBot = $derived(itemTarget?.kind === "dependency");
  const subjectName = $derived(
    releaseTarget
      ? "Release"
      : itemTarget?.subject === "issue"
        ? "Issue"
        : "Pull request",
  );
  // What names the thing on its forge: a release's tag, an item's number.
  const refText = $derived(
    releaseTarget
      ? releaseTarget.tag
      : itemTarget
        ? `#${itemTarget.number}`
        : "",
  );

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

  // Swaps the attributes under the title (labels, and for an issue the pull
  // requests that will close it) for another set the page built, so the open
  // dialog follows the board without closing.
  //
  // The swap replaces the nodes, so a pill link holding keyboard focus would
  // drop it to the page. Focus goes back to the same link (by href) in the
  // new set, or to the close button when that pull request is gone.
  export function setAttributes(
    attributes: HTMLElement,
    related?: RelatedBandData,
  ) {
    if (!target?.status) return;
    const held = document.activeElement;
    const href =
      held instanceof HTMLAnchorElement &&
      (target.status.attributes.contains(held) ||
        dialogEl?.querySelector(".related-band")?.contains(held))
        ? held.getAttribute("href")
        : null;
    target = { ...target, status: { ...target.status, attributes, related } };
    if (href === null) return;
    void tick().then(() => {
      if (!dialogEl?.open) return;
      const same = [
        ...dialogEl.querySelectorAll<HTMLAnchorElement>(
          ".details-attributes a[href], .related-band a[href]",
        ),
      ].find((a) => a.getAttribute("href") === href);
      if (same) same.focus();
      else focusClose();
    });
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
    older = null;
    referencedKey = null;
    const ref = refOf(item);
    let hit = ref ? detailsCache.get(detailsKey(ref)) : undefined;
    if (!isReleaseTarget(item) && item.subject === "issue") {
      // An earlier read found this reference is a pull request, and kept it
      // under that key: open it as one now, with no flip after the read.
      const asPr = asPullRequest(item);
      const known = detailsCache.get(detailsKey(refOf(asPr) as DetailsRef));
      if (known && (!hit || (hit.details as Details).kind === "pullRequest")) {
        target = asPr;
        hit = known;
        referencedKey = detailsKey(refOf(asPr) as DetailsRef);
        onPullRequestFound?.();
      }
    }
    if (hit?.html) {
      // Seen before and already rendered: on screen in this very tick, and the
      // read below swaps in the fresh answer only if it differs (#4194).
      token++;
      details = hit.details as Details;
      html = hit.html;
      phase = "ready";
      shownReaction = null;
      showIssueState(target ?? item, hit.details as Details);
      load(true);
    } else {
      load(false, hit?.details as Details | undefined);
    }
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

  // The cache key's parts for a pull request or an issue; a release has none.
  function refOf(item: DetailsTarget): DetailsRef | null {
    if (isReleaseTarget(item)) return null;

    return {
      forge: item.forge,
      repo: item.repo,
      subject: item.subject === "issue" ? "issue" : "pull-request",
      number: item.number,
    };
  }

  const isReferenced = (item: ItemTarget) =>
    referencedKey !== null &&
    item.subject !== "issue" &&
    referencedKey === detailsKey(refOf(item) as DetailsRef);

  // The same reference as a pull request, once the server says it is one.
  function asPullRequest(current: ItemTarget): ItemTarget {
    return {
      ...current,
      subject: "pull-request",
      title: `Pull request #${current.number}`,
      url: current.url.replace(
        /\/issues\/(\d+)$/,
        current.forge === "github" ? "/pull/$1" : "/pulls/$1",
      ),
      status: undefined,
    };
  }

  function showIssueState(item: DetailsTarget, shown: Details) {
    if (item.subject !== "issue") return;
    if (shown.state) onIssueState?.(shown.state === "closed");
    onReferences?.(shown.references ?? []);
  }

  // Set when a refresh failed while earlier details are on screen; cleared by
  // the next one that lands.
  let older = $state<string | null>(null);
  // The next change is the user's own: it is not announced.
  let ownAction = false;
  const OLDER_NOTE =
    "These details may be out of date: the latest could not be read.";

  // Drops what is remembered for the open pull request or issue, for the
  // user's own comment, close or reopen: the next open reads the forge.
  export function forget() {
    ownAction = true;
    const ref = target ? refOf(target) : null;
    if (ref) detailsCache.delete(detailsKey(ref));
  }

  async function renderAll(
    current: DetailsTarget,
    loaded: Details,
  ): Promise<Record<string, string>> {
    const rendered: Record<string, string> = {};
    const jobs: Promise<void>[] = [];
    const add = (key: string, text: string, comment?: string) =>
      jobs.push(
        renderMarkdown(text, {
          repoUrl: repoUrlOf(current.url),
          references: trackedRepo
            ? {
                forge: current.forge,
                tracked: (repo) => trackedRepo?.(current.forge, repo) ?? false,
              }
            : undefined,
          imageSource: imageSourceFor(
            current.forge,
            repoUrlOf(current.url),
            isReleaseTarget(current)
              ? { fullName: current.repo, tag: current.tag }
              : { fullName: current.repo, number: current.number, comment },
          ),
        }).then((out) => {
          rendered[key] = out;
        }),
      );
    if (!isReleaseTarget(current)) add("description", loaded.description.text);
    if (loaded.releaseNotes) add("notes", loaded.releaseNotes.text);
    for (const c of loaded.comments) add(c.id, c.text, c.id);
    await Promise.all(jobs);

    return rendered;
  }

  // `seed` is what the prefetch left for this item: shown as soon as it is
  // rendered, while the read below goes out at once.
  async function load(quiet = false, seed?: Details): Promise<boolean> {
    const current = target;
    if (!current) return true;
    const mine = ++token;
    const generation = detailsCache.generation();
    if (!quiet) {
      phase = "loading";
      details = null;
      html = {};
    }
    let seeded: Promise<void> = Promise.resolve();
    if (seed) {
      seeded = renderAll(current, seed).then((rendered) => {
        if (mine !== token || phase === "ready") return;
        html = rendered;
        details = seed;
        phase = "ready";
        shownReaction = null;
        showIssueState(current, seed);
      });
    }
    try {
      const where = `forge=${encodeURIComponent(current.forge)}&fullName=${encodeURIComponent(current.repo)}`;
      const res = await fetch(
        isReleaseTarget(current)
          ? `/api/v1/releases/details?${where}&tag=${encodeURIComponent(current.tag)}`
          : `/api/v1/${current.subject === "issue" || isReferenced(current) ? "issues" : "pull-requests"}/details?${where}&number=${current.number}`,
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
      if (isReleaseTarget(current)) {
        const release = data as { name: string; notes: Body };
        loaded = {
          description: release.notes,
          comments: [],
          commentCount: 0,
          commentsTruncated: false,
          releaseNotes: release.notes,
        };
        if (release.name && mine === token)
          target = { ...current, title: release.name };
      } else {
        loaded = data as Details;
      }
      // A reference the board doesn't list opens as an issue, and the server
      // says when the number is a pull request. Show it as one, from the same
      // answer, so a reload reads the issues endpoint again.
      const foundPullRequest =
        !isReleaseTarget(current) &&
        current.subject === "issue" &&
        loaded.kind === "pullRequest";
      if (foundPullRequest && mine === token) {
        target = asPullRequest(current as ItemTarget);
        referencedKey = detailsKey(refOf(target) as DetailsRef);
        onPullRequestFound?.();
      }
      // Remembered under what it turned out to be.
      const ref = refOf(
        foundPullRequest ? asPullRequest(current as ItemTarget) : current,
      );
      const key = ref ? detailsKey(ref) : "";
      await seeded;
      if (mine !== token) return true;
      const onScreen = phase === "ready" ? details : null;
      if (onScreen && JSON.stringify(onScreen) === JSON.stringify(loaded)) {
        // Nothing changed: the DOM stays exactly as it is.
        older = null;
        ownAction = false;
        const kept = detailsCache.get(key);
        if (kept) detailsCache.set(key, { ...kept, readAt: Date.now() });
        return true;
      }
      const rendered = await renderAll(current, loaded);
      if (mine !== token) return true;
      const changed = onScreen !== null;
      html = rendered;
      details = loaded;
      phase = "ready";
      older = null;
      // Not after the user's own action began while this read was out: what
      // came back may predate it.
      if (ref && detailsCache.generation() === generation)
        detailsCache.set(key, {
          details: loaded,
          html: rendered,
          readAt: Date.now(),
        });
      // What was on screen changed under the reader: one polite note, but not
      // for a change the reader just made themselves.
      if (changed && liveHost && !ownAction)
        liveHost.textContent = "Details updated.";
      ownAction = false;
      if (!foundPullRequest) showIssueState(current, loaded);
      // A quiet swap leaves a list the reader has open alone; a full load
      // replaces everything, so the old content's state goes with it.
      if (!quiet) {
        shownReaction = null;
        brokenAvatars = {};
      }

      return true;
    } catch (err) {
      if (mine !== token) return true;
      await seeded;
      if (mine !== token) return true;
      if (quiet || phase === "ready") {
        older = OLDER_NOTE;

        return false;
      }
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

  // A description that scrolls and holds nothing focusable would be out of a
  // keyboard user's reach (#3454). The body becomes a named tab stop while it
  // overflows. The watch starts again whenever the pull request or what is
  // drawn changes, so the new children are observed and the answer is judged
  // on the content that arrived, not the skeleton before it.
  $effect(() => {
    void [target, phase, details, html];
    const el = bodyEl;
    if (!el) return;
    return syncScrollRegion(el, {
      label: "Description",
      skipIfFocusableDescendant: true,
    });
  });

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

  // The in-dialog image viewer (#3414). An embedded image is a link to the
  // proxied file; a plain click opens it here instead, and a modified click
  // (new tab, new window, download) keeps the link's own behaviour.
  let lightboxEl = $state<HTMLDialogElement>();
  let lightbox = $state<{ src: string; alt: string } | null>(null);
  let lightboxOpener: HTMLElement | null = null;

  function imageOpener(event: MouseEvent): HTMLAnchorElement | null {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    ) {
      return null;
    }
    // The "View larger" button after a capped image acts as the image's link.
    const expand = event.target.closest("button.md-expand");
    const link =
      expand?.previousElementSibling instanceof HTMLAnchorElement
        ? expand.previousElementSibling
        : event.target.closest("a");
    const img = link?.firstElementChild;
    return link &&
      img instanceof HTMLImageElement &&
      img.classList.contains("md-image") &&
      link.childNodes.length === 1
      ? link
      : null;
  }

  function openLightbox(link: HTMLAnchorElement, from: HTMLElement = link) {
    const img = link.firstElementChild as HTMLImageElement;
    lightbox = { src: link.getAttribute("href") ?? img.src, alt: img.alt };
    lightboxOpener = from;
    lightboxEl?.showModal();
    lightboxEl?.querySelector<HTMLElement>(".lightbox-close")?.focus();
  }

  // A modal <dialog> inerts the page, but Tab off its last control still
  // leaves for the browser's own chrome; wrap it round instead.
  function onLightboxKeydown(event: KeyboardEvent) {
    if (event.key !== "Tab" || !lightboxEl) return;
    const stops = [
      ...lightboxEl.querySelectorAll<HTMLElement>("a[href], button"),
    ];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const at = document.activeElement;
    if (event.shiftKey && (at === first || at === lightboxEl)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && at === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onLightboxClose() {
    lightbox = null;
    const back = lightboxOpener;
    lightboxOpener = null;
    if (back?.isConnected) back.focus();
  }

  function onClose() {
    lightboxEl?.close();
    shownReaction = null;
    // Nothing said inside the dialog is still true once it is gone.
    if (liveHost) liveHost.textContent = "";
    token++;
    const id = returnFocusId;
    const fallbackId = returnFocusFallbackId;
    returnFocusId = "";
    returnFocusFallbackId = "";
    onClosed?.();
    const drawn = (el: Element | null): el is HTMLElement =>
      el instanceof HTMLElement && el.getClientRects().length > 0;
    // The title box hides over one row (#3823), and a hidden control can't
    // take focus, so the first drawn control in the filter bar stands in.
    const back =
      [
        id ? document.getElementById(id) : null,
        fallbackId ? document.getElementById(fallbackId) : null,
        ...document.querySelectorAll(
          ".filter-bar :is(button, select, input):not(:disabled)",
        ),
      ].find(drawn) ?? null;
    back?.focus();
  }

  // A click that lands on the <dialog> itself, not on something inside it,
  // is a click on the backdrop.
  function onBackdrop(event: MouseEvent) {
    if (event.target === dialogEl) {
      dialogEl?.close();
      return;
    }
    const opener = imageOpener(event);
    if (opener) {
      event.preventDefault();
      openLightbox(
        opener,
        (event.target as Element).closest<HTMLElement>("button.md-expand") ??
          opener,
      );
      return;
    }
    const reference = onReference ? referenceFromClick(event) : null;
    if (!reference || !target) return;
    const handled = onReference?.(
      { ...reference, forge: target.forge },
      returnFocusId,
    );
    if (handled !== false) event.preventDefault();
  }

  // A reference to an untracked repository under the pointer or focus is
  // asked of the forge now, so a click can open its dialog (#4269).
  function warmReference(event: Event) {
    dwell.cancel();
    const reference = untrackedReference(event);
    if (reference) onWarmReference?.(reference);
  }

  function untrackedReference(event: Event) {
    const found = referenceAt(event.target);
    if (!found?.untracked || !target) return null;
    return { forge: target.forge, repo: found.repo, number: found.number };
  }

  // A pointer passing over only asks after it rests for a moment; focus and
  // pointer-down above ask at once.
  const dwell = createDwell<{ forge: string; repo: string; number: number }>(
    (reference) => onWarmReference?.(reference),
  );
  onDestroy(() => dwell.cancel());

  function restOnReference(event: Event) {
    const found = referenceAt(event.target);
    const reference = untrackedReference(event);
    if (reference && found) dwell.rest(found.anchor, reference);
    else dwell.cancel();
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
  data-return-focus-fallback={returnFocusFallbackId || undefined}
  aria-label={target
    ? `${subjectName} details: ${target.repo} ${refText}`
    : "Pull request details"}
  onclose={onClose}
  oncancel={onCancel}
  onclick={onBackdrop}
  onpointerover={restOnReference}
  onpointerleave={() => dwell.cancel()}
  onpointerdown={warmReference}
  onfocusin={warmReference}
>
  {#if target}
    <div class="details-header">
      <div class="details-heading">
        {#if target.status}
          <div
            class="details-status"
            {@attach adopt(target.status.state)}
          ></div>
        {:else if stateWord !== null}
          <div class="details-status">
            <div
              class="details-state"
              role={stateWord ? "group" : undefined}
              aria-label={stateWord ? "Status" : undefined}
              aria-hidden={stateWord ? undefined : true}
            >
              <span class="attr-chip" class:held={!stateWord}
                >{stateWord || "Open"}</span
              >
            </div>
          </div>
        {/if}
        <p class="details-ref">
          <span class="forge-badge {forgeClassOf(target.forge)}"
            ><span class="dot"></span>{forgeLabel}</span
          >
          <!-- The repository is a link to it on the forge, named by its own
            text. A pull request's or issue's number is plain text (#3744): the dialog is already
            this item's, and "Open on <forge>" in the footer is the way to
            the forge. Without a repository address (an item address of an
            unknown shape) both stay plain text. -->
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
              {#if releaseTarget}
                <a
                  class="ref-link"
                  href={target.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  >{refText}<span class="visually-hidden">
                    (opens in a new tab)</span
                  ></a
                >
              {:else}
                {refText}
              {/if}
            {:else}
              {target.repo}
              {refText}
            {/if}
          </span>
        </p>
        <h2 class="details-title">
          {#each titleSegments(facts?.title ?? target.title) as seg}{#if seg.code}<code
                class="title-code">{seg.text}</code
              >{:else}{seg.text}{/if}{/each}
        </h2>
        {#if byline}
          {#snippet filer()}
            {#if avatarSrc(forgeId, byline?.avatar) && !brokenFilerAvatar}
              <img
                class="filer-avatar"
                src={avatarSrc(forgeId, byline?.avatar) ?? undefined}
                alt=""
                width="20"
                height="20"
                loading="lazy"
                referrerpolicy="no-referrer"
                onerror={() => (brokenFilerAvatar = true)}
              />
            {/if}
            <span class="filer-name">{byline?.name}</span>
          {/snippet}
          <p class="details-author">
            <span>{byline.label}</span>
            <!-- The avatar and the name are one link to the filer's page on
              the forge, as on the row. Without an address, or for a deleted
              account, they are plain text. -->
            {#if profileHref(byline.url)}
              <a
                class="filer-link"
                href={profileHref(byline.url) ?? undefined}
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

  {#if target?.status?.related}
    <RelatedBand band={target.status.related} />
  {/if}

  <!-- What the pull request is waiting on or blocked by, in words. -->
  <div class="details-status-block" bind:this={statusHost} hidden></div>

  {#if target}
    <div class="details-body" bind:this={bodyEl}>
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
              <!-- nosemgrep: svelte-at-html -- patchHtml sets only renderMarkdown() output: markdown-it with raw HTML narrowed to an allow-list and rebuilt as tokens (no attribute but a checked href survives), images only through the server proxy and non-http(s)/mailto links turned to text, never raw forge text -->
              <div
                class="markdown"
                use:imageFallback
                use:patchHtml={html.notes}
              ></div>
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
                <!-- nosemgrep: svelte-at-html -- patchHtml sets only renderMarkdown() output: markdown-it with raw HTML narrowed to an allow-list and rebuilt as tokens (no attribute but a checked href survives), images only through the server proxy and non-http(s)/mailto links turned to text, never raw forge text -->
                <div
                  class="markdown"
                  use:imageFallback
                  use:patchHtml={html.description}
                ></div>
              </details>
            {:else}
              <!-- nosemgrep: svelte-at-html -- patchHtml sets only renderMarkdown() output: markdown-it with raw HTML narrowed to an allow-list and rebuilt as tokens (no attribute but a checked href survives), images only through the server proxy and non-http(s)/mailto links turned to text, never raw forge text -->
              <div
                class="markdown"
                use:imageFallback
                use:patchHtml={html.description}
              ></div>
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

        {#if !releaseTarget}
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
                        {#if avatarSrc(forgeId, c.author?.avatarUrl) && !brokenAvatars[c.id]}
                          <img
                            class="avatar"
                            src={avatarSrc(forgeId, c.author?.avatarUrl) ??
                              undefined}
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
                    <!-- nosemgrep: svelte-at-html -- patchHtml sets only renderMarkdown() output: markdown-it with raw HTML narrowed to an allow-list and rebuilt as tokens (no attribute but a checked href survives), images only through the server proxy and non-http(s)/mailto links turned to text, never raw forge text -->
                    <div
                      class="markdown"
                      use:imageFallback
                      use:patchHtml={html[c.id]}
                    ></div>
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
        <!-- After the content, so a failed refresh moves nothing the reader sees. -->
        {#if older}
          <p class="details-note details-older" role="status">{older}</p>
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

<dialog
  bind:this={lightboxEl}
  class="image-lightbox"
  aria-label={lightbox?.alt || "Image"}
  onclose={onLightboxClose}
  onkeydown={onLightboxKeydown}
  onclick={(event) => {
    if (event.target === lightboxEl) lightboxEl?.close();
  }}
>
  {#if lightbox}
    <h2 class="lightbox-title">{lightbox.alt || "Image"}</h2>
    <a
      class="lightbox-original"
      href={lightbox.src}
      target="_blank"
      rel="noopener noreferrer"
      >Open original in new tab<span aria-hidden="true"> &#8599;</span></a
    >
    <button
      type="button"
      class="lightbox-close"
      onclick={() => lightboxEl?.close()}>Close</button
    >
    <div class="lightbox-stage">
      <img
        src={lightbox.src}
        alt={lightbox.alt}
        referrerpolicy="no-referrer"
        decoding="async"
      />
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
    font-size: 0.78125rem;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .details-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .title-code {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 0.92em;
    font-weight: 500;
    padding: 0 0.3em;
    border-radius: 4px;
    background: var(--surface-sunken);
    overflow-wrap: normal;
    white-space: nowrap;
  }
  .details-author {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 0;
    font-size: 0.78125rem;
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
    /* A swap above what the reader is looking at keeps that text in place. */
    overflow-anchor: auto;
  }
  /* Room for the skeleton and the content alike, and a dialog pinned to the
     top, so neither the swap nor a body that grows moves the header (#4194).
     A window too short for it scrolls the body inside the dialog. A phone's
     dialog already fills the screen. */
  @media (min-width: 481px) {
    .details-dialog[open] {
      margin: 4vh auto auto;
      max-height: min(92vh, 900px);
    }
  }
  .details-body {
    min-height: min(360px, 40vh);
  }
  .details-body:focus-visible {
    outline-offset: -2px;
  }
  .details-section + .details-section {
    margin-top: 22px;
  }
  .details-section h3 {
    margin: 0 0 8px;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--ink-2);
  }
  .details-note {
    margin: 8px 0 0;
    font-size: 0.78125rem;
    color: var(--ink-2);
  }
  .details-note a,
  .ref-link,
  .markdown :global(a) {
    color: var(--accent);
    overflow-wrap: anywhere;
  }
  .markdown :global(img.md-image) {
    display: block;
    max-width: 100%;
    /* A tall image is capped; opening it in the viewer is the way to see
       the rest (#3468). */
    max-height: min(480px, 70vh);
    width: auto;
    height: auto;
    object-fit: contain;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  /* Holds the space until the bytes arrive, so the text doesn't jump. */
  .markdown :global(img.md-image:not(.md-image-loaded)) {
    min-height: 160px;
    min-width: 160px;
    background: linear-gradient(
      90deg,
      var(--border) 25%,
      var(--surface-2, var(--border)) 50%,
      var(--border) 75%
    );
    background-size: 200% 100%;
    animation: md-image-skeleton 1.4s linear infinite;
  }
  @keyframes md-image-skeleton {
    to {
      background-position: -200% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .markdown :global(img.md-image:not(.md-image-loaded)) {
      animation: none;
    }
  }
  .markdown :global(a:has(> img.md-image)) {
    cursor: zoom-in;
  }
  /* A capped image needs a visible way to open it: touch has no cursor. */
  .markdown :global(button.md-expand) {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    min-width: 44px;
    margin: 6px 0 12px;
    padding: 0 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }
  .markdown :global(button.md-expand:hover) {
    background: var(--surface-2, var(--border));
  }
  .markdown :global(button.md-expand:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .markdown :global(.md-expand-alt) {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .markdown :global(.md-image-missing) {
    color: var(--ink-2);
    font-style: italic;
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
    font-size: 0.8125rem;
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
    font-size: 0.8125rem;
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
    font-size: 0.84375rem;
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
    font-size: 0.875rem;
    margin: 14px 0 6px;
  }
  /* The tags a bot's description is written in (#4241). */
  .markdown :global(summary) {
    cursor: pointer;
  }
  .markdown :global(details) {
    margin: 8px 0;
  }
  .markdown :global(blockquote) {
    margin: 8px 0;
    padding-left: 12px;
    border-left: 3px solid var(--border);
  }
  .markdown :global(pre) {
    overflow-x: auto;
    padding: 10px;
    border-radius: 8px;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
  }
  .markdown :global(pre:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .markdown :global(code) {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 0.78125rem;
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
  .markdown :global(label.task input) {
    position: relative;
    /* The tick is white on the accent; the accent is light in the dark scheme,
       so the tick is dark there. */
    --tick: #fff;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme="light"]))
      .markdown
      :global(label.task input) {
      --tick: #06181a;
    }
  }
  :global(:root[data-theme="dark"]) .markdown :global(label.task input) {
    --tick: #06181a;
  }
  .markdown :global(label.task input:checked) {
    background: var(--accent);
    border-color: var(--accent);
  }
  /* Drawn with borders, not an image, so the image policy needs no data: URL. */
  .markdown :global(label.task input:checked::before) {
    content: "";
    position: absolute;
    left: 3.5px;
    top: 0.5px;
    width: 3px;
    height: 6.5px;
    border: solid var(--tick);
    border-width: 0 1.8px 1.8px 0;
    transform: rotate(45deg);
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
    .markdown :global(label.task input:checked::before) {
      content: none;
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
    font-size: 0.8125rem;
    color: var(--ink-2);
    /* 24px tall (2.5.8). The margin gives back what the height took. */
    min-height: 24px;
    margin-bottom: 2px;
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
    font-size: 0.78125rem;
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
    font-size: 0.875rem;
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
  /* Holds the chip's height while the details are on the way. */
  .attr-chip.held {
    visibility: hidden;
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
    font-size: 0.78125rem;
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
    font-size: 0.75rem;
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
      margin-bottom: 8px;
      display: flex;
      align-items: center;
    }
  }

  /* A short screen (a phone held sideways, 400% zoom): the header and footer
     are flex: none and would squeeze the body to a strip. The body keeps a
     readable height and the dialog, which scrolls, takes the rest, so the
     footer actions stay reachable by scrolling (#3271). */
  @media (max-height: 500px) {
    .details-body {
      min-height: 120px;
    }
    .details-header {
      padding: 10px 18px 8px;
    }
    /* Top only: the phone rule below owns the bottom (safe-area inset). */
    .details-footer {
      padding-top: 8px;
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

  /* The image viewer (#3414): one grid whose visual order is its DOM order
     (title, original, Close, image), so Tab follows what the eye sees. */
  .image-lightbox {
    width: min(1100px, calc(100vw - 32px));
    max-width: 100vw;
    max-height: calc(100dvh - 32px);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--ink);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .image-lightbox[open] {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-areas: "title title" "original close" "stage stage";
  }
  .image-lightbox::backdrop {
    background: var(--backdrop);
  }
  .lightbox-title {
    grid-area: title;
    margin: 0;
    padding: 12px 16px;
    align-self: center;
    font-size: 1rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .lightbox-close {
    grid-area: close;
    min-width: 48px;
    min-height: 48px;
    margin: 4px 12px 8px 0;
    padding: 0 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    cursor: pointer;
  }
  .lightbox-close:hover {
    background: var(--surface-2, var(--border));
  }
  .lightbox-close:focus-visible,
  .lightbox-original:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .lightbox-stage {
    grid-area: stage;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
    padding: 12px;
    overflow: auto;
    border-top: 1px solid var(--border);
    background: var(--surface-2, var(--surface));
  }
  .lightbox-stage img {
    display: block;
    max-width: 100%;
    max-height: calc(100dvh - 260px);
    object-fit: contain;
  }
  .lightbox-original {
    grid-area: original;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 0 16px;
    color: var(--accent);
  }
  @media (min-width: 720px) {
    .image-lightbox[open] {
      grid-template-columns: minmax(0, 1fr) auto auto;
      grid-template-rows: auto minmax(0, 1fr);
      grid-template-areas: "title original close" "stage stage stage";
    }
  }
</style>
