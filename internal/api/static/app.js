(() => {
  var REFRESH_INTERVAL_MS = 30000;
  var CI_LABELS = {
    success: 'Passing',
    failure: 'Failing',
    pending: 'Running',
    none: 'No checks',
  };
  var FORGE_LABELS = Filters.FORGE_LABELS;
  var FORGE_CLASSES = { github: 'gh', forgejo: 'fj' };

  var lastGeneratedAt = null;

  // ---- cookies ----
  // A cookie, not localStorage: it rides along on the request that renders
  // the page, and it's the one storage mechanism shared identically by
  // this file and theme.js (a separate script, loaded synchronously in
  // <head> on other pages, with no module system to share state through).
  // Filter persistence has its own copy of this in filters.js — this one
  // is only for the theme cookie now.
  function getCookie(name) {
    var match = document.cookie.match(
      new RegExp(
        `(?:^|; )${name.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`,
      ),
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value) {
    var maxAgeSeconds = 365 * 24 * 60 * 60;
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API isn't in Safari yet, and this repo targets more than just Chromium (browser-compat.md).
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
  }

  // ---- theme toggle ----
  (function initTheme() {
    var root = document.documentElement;
    var toggle = document.getElementById('theme-toggle');
    var THEME_COOKIE = 'forge-board-theme';

    function systemPrefersDark() {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    }

    function applyTheme(theme) {
      if (theme === 'dark' || theme === 'light') {
        root.setAttribute('data-theme', theme);
      } else {
        root.removeAttribute('data-theme');
      }
      var isDark =
        theme === 'dark' || (theme !== 'light' && systemPrefersDark());
      toggle.setAttribute('aria-pressed', String(isDark));
      toggle.setAttribute(
        'aria-label',
        isDark ? 'Switch to light theme' : 'Switch to dark theme',
      );
    }

    applyTheme(getCookie(THEME_COOKIE));

    toggle.addEventListener('click', () => {
      var currentlyDark =
        root.getAttribute('data-theme') === 'dark' ||
        (!root.getAttribute('data-theme') && systemPrefersDark());
      var next = currentlyDark ? 'light' : 'dark';
      applyTheme(next);
      setCookie(THEME_COOKIE, next);
    });
  })();

  // ---- formatting ----
  function relativeTime(iso) {
    var mins = Filters.minutesAgo(iso);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    var hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    var days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Used by each board's own small count next to its heading — the full
  // phrase reads fine at that size. The top stat tile below gets its own,
  // more compact treatment: shownCountText would wrap a 26px bold number
  // onto two lines.
  function shownCountText(shown, total) {
    return shown === total ? `${total} open` : `${shown} of ${total} shown`;
  }

  // idPrefix ('pr'/'issue') -> the top stat tile for that entity type.
  var STAT_TILE_IDS = { pr: 'stat-prs', issue: 'stat-issues' };

  // The stat tile's headline number is the filtered count — what's
  // actually visible in the board below it right now — with a small
  // muted "/ total" only when a filter is actually narrowing it, so an
  // unfiltered tile looks exactly as it always has. Without this, the
  // tile kept showing the raw total forever, which read as though it
  // had stopped updating the moment any filter got applied.
  function renderStatTile(tileId, shown, total) {
    var tile = document.getElementById(tileId);
    if (!tile) return;
    tile.innerHTML = '';
    tile.appendChild(document.createTextNode(String(shown)));
    if (shown !== total) {
      tile.appendChild(el('span', 'n-total', ` / ${total}`));
    }
  }

  // ---- row rendering ----
  function repoCell(item) {
    var wrap = el('div', 'repo');
    var badge = el('span', `forge-badge ${FORGE_CLASSES[item.forge]}`);
    badge.appendChild(el('span', 'dot'));
    badge.appendChild(
      document.createTextNode(FORGE_LABELS[item.forge] || item.forge),
    );
    wrap.appendChild(badge);
    wrap.appendChild(el('span', 'repo-name', item.repo));
    return wrap;
  }

  // WCAG relative-luminance/contrast math (same formula this codebase's
  // own design tokens were hand-verified against) — picks whichever of
  // near-black/near-white ink actually reads against a label's real
  // background color, since that color is arbitrary and forge-supplied,
  // not one of our own palette's pre-checked pairs.
  function relativeLuminance(hex) {
    function channel(c) {
      c = c / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }
    var r = channel(parseInt(hex.substr(0, 2), 16));
    var g = channel(parseInt(hex.substr(2, 2), 16));
    var b = channel(parseInt(hex.substr(4, 2), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastRatio(l1, l2) {
    var lighter = Math.max(l1, l2);
    var darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function labelTextColor(bgHex) {
    // True black/white, not this app's own --ink/--ink-3 tokens — a
    // themed near-black measurably under-performs pure black against an
    // arbitrary background (caught live: GitHub's own default "bug" red,
    // #d73a4a, cleared 4.5:1 against pure black at 4.59:1 but only hit
    // 4.2:1 against this app's #0b0f14 — the decision math and the
    // applied color have to agree on which black they mean, or a label
    // can fail axe-core's contrast check despite this function "picking
    // the higher-contrast option").
    var bg = relativeLuminance(bgHex);
    var blackContrast = contrastRatio(bg, 0);
    var whiteContrast = contrastRatio(bg, 1);
    return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
  }

  // A real button — see the comment above ciPill on why the row isn't an
  // <a> around everything.
  function labelChip(label, onLabelClick, activeLabel) {
    var chip = document.createElement('button');
    chip.type = 'button';
    // activeLabel (the shared label filter) is always lowercase — set
    // that way by both a chip click and the shared Label <select>'s
    // generic .col-filter wiring, which lowercases every filter value
    // uniformly — so the comparison here has to lowercase label.name to
    // match.
    var isActive = label.name.toLowerCase() === activeLabel;
    chip.className = `label-chip${isActive ? ' active' : ''}`;
    chip.textContent = label.name;
    if (label.color && !isActive) {
      // The active state has its own fixed accent styling (see
      // .label-chip.active in style.css) — a per-label background would
      // fight with "this is the one currently filtering" as a signal.
      chip.style.backgroundColor = `#${label.color}`;
      chip.style.borderColor = `#${label.color}`;
      chip.style.color = labelTextColor(label.color);
    }
    chip.setAttribute('aria-label', `Filter by label: ${label.name}`);
    chip.setAttribute('aria-pressed', String(isActive));
    chip.addEventListener('click', () => {
      onLabelClick(label.name);
    });
    return chip;
  }

  function titleCell(item, onLabelClick, activeLabel) {
    var wrap = el('div', 'title-cell');
    // The real, keyboard-focusable link — a "stretched link" (see
    // .title-cell .title::after in style.css) makes the whole row
    // clickable, without the row itself being an <a> that would make the
    // CI pill and label chips invalid/inaccessible nested interactive
    // elements. https://css-tricks.com/block-links-the-search-for-a-perfect-solution/
    var title = document.createElement('a');
    title.className = 'title';
    title.href = item.url;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    // The ellipsis truncation lives on this inner span, not .title itself
    // — overflow:hidden on .title would clip its own ::after stretched
    // overlay down to .title's box instead of letting it cover the whole
    // row (see the comment on .title in style.css).
    var text = el('span', 'title-text');
    text.appendChild(el('span', 'num', `#${item.number}`));
    text.appendChild(document.createTextNode(item.title));
    title.appendChild(text);
    wrap.appendChild(title);
    if (item.draft) wrap.appendChild(el('span', 'draft-badge', 'Draft'));
    (item.labels || []).slice(0, 3).forEach((label) => {
      wrap.appendChild(labelChip(label, onLabelClick, activeLabel));
    });
    return wrap;
  }

  // status is a real button — see titleCell's comment on why the row
  // isn't an <a> around everything. onStatusClick is only ever passed for
  // the pull requests board (isPR).
  function ciPill(status, onStatusClick) {
    var pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `ci-pill ${status}`;
    pill.appendChild(el('span', 'dot'));
    pill.appendChild(document.createTextNode(CI_LABELS[status] || status));
    pill.setAttribute(
      'aria-label',
      `Filter pull requests by CI status: ${CI_LABELS[status] || status}`,
    );
    pill.addEventListener('click', () => {
      onStatusClick(status);
    });
    return pill;
  }

  var MERGE_STATUS_LABELS = { conflicting: 'Conflicting', blocked: 'Blocked' };

  // Silent for "mergeable" and "unknown" — flagging every clean row would
  // just be noise (the same restraint .forge-health-error already uses:
  // shown only when there's actually a problem). Not a button, unlike
  // ciPill: there's no filter dimension for this, just a fact about the
  // row.
  function mergeStatusPill(status) {
    var label = MERGE_STATUS_LABELS[status];
    if (!label) return null;
    var pill = el('span', `merge-pill ${status}`);
    pill.appendChild(el('span', 'dot'));
    pill.appendChild(document.createTextNode(label));
    return pill;
  }

  // Silent unless auto-merge is genuinely enabled — autoMergeEnabled is
  // `null` for a forge that can't report this at all (Forgejo, today),
  // which must never render as "not enabled": strict === true, not a
  // truthy check.
  function autoMergePill(autoMergeEnabled) {
    if (autoMergeEnabled !== true) return null;
    var pill = el('span', 'merge-pill auto-merge');
    pill.appendChild(el('span', 'dot'));
    pill.appendChild(document.createTextNode('Auto-merge'));
    return pill;
  }

  function buildRow(item, isPR, onStatusClick, onLabelClick, activeLabel) {
    var row = el('div', 'row');
    var statusCell;
    var conflictPill;
    var mergePill;
    var mergeAction;

    row.appendChild(repoCell(item));
    row.appendChild(titleCell(item, onLabelClick, activeLabel));

    var meta = el('div', 'row-meta');
    meta.appendChild(el('div', 'author', item.author));
    meta.appendChild(el('div', 'created', relativeTime(item.createdAt)));
    meta.appendChild(el('div', 'updated', relativeTime(item.updatedAt)));
    if (isPR) {
      // One cell, possibly several pills — keeps .row's fixed
      // grid-template-columns unchanged regardless of how many of them
      // this particular row has anything to say.
      statusCell = el('div', 'status-cell');
      statusCell.appendChild(ciPill(item.ci, onStatusClick));
      conflictPill = mergeStatusPill(item.mergeStatus);
      if (conflictPill) statusCell.appendChild(conflictPill);
      mergePill = autoMergePill(item.autoMergeEnabled);
      if (mergePill) statusCell.appendChild(mergePill);
      mergeAction = mergeActionCell(item);
      if (mergeAction) statusCell.appendChild(mergeAction);
      meta.appendChild(statusCell);
    } else {
      meta.appendChild(el('div', 'empty-cell'));
    }
    row.appendChild(meta);
    row.appendChild(el('div', 'go', '→'));
    return row;
  }

  // ---- pull request merge action ----
  // mergeState persists per-PR merge-button UI state across renders — the
  // dashboard polls and pushes fresh snapshots (applySnapshot) that rebuild
  // every row from scratch, unlike the webhooks page's one-shot render, so
  // a lock earned from a real permission/rate-limit/conflict failure has to
  // live outside the DOM node itself, or the next poll would silently hand
  // back a re-clickable button and undo the whole point of locking it (see
  // webhooks.js's own reactiveLockReason/lockedButton, the same pattern
  // this mirrors).
  var mergeState = {};

  function prKey(item) {
    return `${item.forge}:${item.repo}#${item.number}`;
  }

  // Mirrors webhooks.js's reactiveLockReason, plus 409 — the forge itself
  // reports the PR is no longer mergeable (a real conflict, or its state
  // changed since the dashboard's last refresh), which a retry can't fix
  // any more than a missing permission or an exhausted rate limit can.
  function reactiveMergeLockReason(status) {
    if (status === 403)
      return 'Missing permission — check your token in Settings.';
    if (status === 429)
      return 'Rate limit exceeded — try again once it resets.';
    if (status === 409)
      return 'No longer mergeable — refresh to see the current state.';
    return null;
  }

  var mergeLockReasonCounter = 0;

  // Same aria-disabled + visible, wired-up reason shape webhooks.js's own
  // lockedButton uses, not a native disabled attribute or a title-only
  // tooltip — native disabled would drop it from the tab order and hide
  // the reason from keyboard and screen-reader users.
  function lockedMergeButton(reasonText) {
    var wrap = el('span', 'row-action-locked');
    var button = el('button', 'row-action', 'Merge');
    button.type = 'button';
    button.setAttribute('aria-disabled', 'true');
    var reasonId = `merge-locked-reason-${mergeLockReasonCounter++}`;
    button.setAttribute('aria-describedby', reasonId);
    wrap.appendChild(button);
    var reason = el('span', 'row-action-reason', reasonText);
    reason.id = reasonId;
    wrap.appendChild(reason);
    return wrap;
  }

  // Actually calls the merge endpoint, once the confirm click lands —
  // mergeActionCell's own click handler only ever flips into "confirming",
  // so a single accidental click can never merge anything.
  function doMerge(item, confirmButton) {
    var key = prKey(item);
    mergeState[key] = { phase: 'merging' };
    confirmButton.disabled = true;
    confirmButton.textContent = 'Merging…';

    fetch('/api/pull-requests/merge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        forge: item.forge,
        fullName: item.repo,
        number: item.number,
      }),
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          throw new Error('session expired');
        }
        if (res.status === 204) return null;
        return res.json().then((body) => {
          var err = new Error(body?.error || `backend answered ${res.status}`);
          err.status = res.status;
          throw err;
        });
      })
      .then(() => {
        delete mergeState[key];
        // Pulls a fresh snapshot right away rather than waiting out the
        // rest of the background poll's own interval — the same call the
        // "Refresh now" button makes — so the just-merged PR drops off
        // the board as soon as the forge itself reflects the merge.
        return fetch('/api/dashboard/refresh', {
          method: 'POST',
          headers: { Accept: 'application/json' },
        })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (data) applySnapshot(data);
          });
      })
      .catch((err) => {
        var lockReason = reactiveMergeLockReason(err.status);
        mergeState[key] = lockReason
          ? { phase: 'locked', reason: lockReason }
          : { phase: 'idle' };
        showError(`Couldn't merge ${item.repo}#${item.number}: ${err.message}`);
        prBoard.render();
      });
  }

  // Only rendered at all when mergeStatus is "mergeable" — the same
  // restraint mergeStatusPill/autoMergePill already use for a row that has
  // nothing to say. First click only arms a confirm step (doMerge is never
  // reachable from it directly); merging is a real, hard-to-reverse write
  // to the real repo, not a filter toggle like the CI pill next to it.
  function mergeActionCell(item) {
    if (item.mergeStatus !== 'mergeable') return null;

    var key = prKey(item);
    var entry = mergeState[key] || { phase: 'idle' };

    if (entry.phase === 'locked') return lockedMergeButton(entry.reason);

    var wrap = el('span', 'row-action-group');

    var confirming = entry.phase === 'confirming';
    var cancelButton;
    var confirmButton;
    if (confirming || entry.phase === 'merging') {
      confirmButton = el(
        'button',
        'row-action confirm',
        confirming ? 'Confirm merge?' : 'Merging…',
      );
      confirmButton.type = 'button';
      confirmButton.disabled = !confirming;
      confirmButton.addEventListener('click', () => {
        doMerge(item, confirmButton);
      });
      wrap.appendChild(confirmButton);

      if (confirming) {
        cancelButton = el('button', 'row-action cancel', 'Cancel');
        cancelButton.type = 'button';
        cancelButton.addEventListener('click', () => {
          delete mergeState[key];
          prBoard.render();
        });
        wrap.appendChild(cancelButton);
      }
      return wrap;
    }

    var mergeButton = el('button', 'row-action', 'Merge');
    mergeButton.type = 'button';
    mergeButton.addEventListener('click', () => {
      mergeState[key] = { phase: 'confirming' };
      prBoard.render();
    });
    wrap.appendChild(mergeButton);
    return wrap;
  }

  // ---- shared filter state ----
  // One object for forge/repo/label/author/title/created/updated/groupBy,
  // applied to both boards at once, plus the two fields with no
  // equivalent on the other entity type (status, hideDependencyDashboard)
  // — see design.md's "one shared filter object, plus two board-owned
  // extra fields" decision. allPRs/allIssues is the pool the shared
  // bar's dynamic controls (repo/author/label/title) are populated from —
  // both entity types combined, forge-scoped, not just one board's own
  // items, since picking "author: alice" should narrow both boards.
  var sharedState = Filters.loadState();
  var allPRs = [];
  var allIssues = [];
  var sharedControlsRestored = false;

  function forgeScopedItems() {
    var items = allPRs.concat(allIssues);
    if (!sharedState.shared.forge) return items;
    return items.filter((item) => item.forge === sharedState.shared.forge);
  }

  // "Group by forge" is a no-op once the Forge filter already narrows
  // every visible row to one forge — grouping by it would produce
  // exactly one cluster, telling the user nothing a flat list didn't
  // already. Hidden in that case; resets to no grouping if it was the
  // active mode when a forge got picked (#112).
  function updateGroupByOptions() {
    var groupSelect = document.getElementById('shared-group-select');
    var forgeOption = groupSelect
      ? groupSelect.querySelector('option[value="forge"]')
      : null;
    var forgeFilterActive;
    if (!forgeOption) return;
    forgeFilterActive = Boolean(sharedState.shared.forge);
    forgeOption.hidden = forgeFilterActive;
    if (forgeFilterActive && sharedState.shared.groupBy === 'forge') {
      sharedState.shared.groupBy = '';
      if (groupSelect) groupSelect.value = '';
    }
  }

  // Repopulates the shared bar's dynamic controls (repo/author/label/
  // title suggestions) from the combined, forge-scoped item pool. A
  // filter left pointing at a value that no longer exists gets cleared
  // here too — otherwise it keeps silently filtering out everything on a
  // value nothing can match, with no visible cause (#112).
  function updateSharedFilterOptions() {
    var scoped = forgeScopedItems();
    var staleRepo = Filters.populateRepoSelect(
      document.getElementById('shared-repo-select'),
      scoped,
    );
    var staleAuthor = Filters.populateSelect(
      document.getElementById('shared-author-select'),
      Filters.distinctValues((item) => item.author, scoped),
      sharedState.shared.author,
    );
    Filters.populateDatalist(
      document.getElementById('shared-title-options'),
      Filters.distinctValues((item) => item.title, scoped),
    );
    var staleLabel = Filters.populateSelect(
      document.getElementById('shared-label-select'),
      Filters.distinctValues(
        (item) => (item.labels || []).map((l) => l.name),
        scoped,
      ),
      sharedState.shared.label,
    );
    updateGroupByOptions();
    if (staleRepo) sharedState.shared.repo = '';
    if (staleAuthor) sharedState.shared.author = '';
    if (staleLabel) sharedState.shared.label = '';
    if (staleRepo || staleAuthor || staleLabel) Filters.saveState(sharedState);
  }

  // Restores the shared bar's controls to match the filters just loaded
  // from the cookie. Only meaningful once real items exist: repo/author/
  // label are dynamic <select>s populated from what's on screen, and
  // setting a <select>'s value to one it has no matching <option> for yet
  // is silently dropped rather than queued. Runs once, right after the
  // first combined item set — a later refresh must never repeat it, or it
  // would stomp the title filter back to its lowercase canonical form
  // over whatever case the user is mid-typing.
  function syncSharedControlsToState() {
    var bar = document.querySelector('.filter-bar');
    if (!bar) return;
    bar.querySelectorAll('.col-filter').forEach((c) => {
      var value = sharedState.shared[c.dataset.col];
      var option;
      if (c.type === 'radio') {
        c.checked = c.value === (value || '');
        return;
      }
      if (!value) return;
      if (c.tagName === 'SELECT') {
        option = Array.from(c.options).find(
          (o) => o.value.toLowerCase() === value,
        );
        if (option) c.value = option.value;
      } else {
        c.value = value;
      }
    });
    var groupSelect = document.getElementById('shared-group-select');
    if (groupSelect) groupSelect.value = sharedState.shared.groupBy || '';
  }

  function renderBoth() {
    prBoard.render();
    issueBoard.render();
  }

  // Toggles the one shared label filter and re-renders both boards — a
  // chip click on either board's rows affects the other board too, the
  // same as the Label <select> in the shared bar does.
  function handleLabelClick(label) {
    // The shared label filter is always lowercase (Filters.matchesFilters
    // and labelChip's active check both expect that) — but a real
    // <option>'s value keeps its real case, so select.value can't just be
    // assigned next directly; the browser only accepts an exact
    // (case-sensitive) option value, silently clearing the selection on
    // any case mismatch otherwise.
    var lower = label.toLowerCase();
    var next = sharedState.shared.label === lower ? '' : lower;
    sharedState.shared.label = next;
    prBoard.resetPage();
    issueBoard.resetPage();
    Filters.saveState(sharedState);
    var select = document.getElementById('shared-label-select');
    var option;
    if (select) {
      option = Array.from(select.options).find(
        (o) => o.value.toLowerCase() === next,
      );
      select.value = option ? option.value : '';
    }
    renderBoth();
  }

  // Clicking a CI pill or the "CI failing" stat tile jumps to the pull
  // requests board filtered to that status — declared before prBoard is
  // assigned below since it's only ever called later, after a user click,
  // by which point prBoard exists (function declarations hoist, so this
  // is safe to reference here). Status has no equivalent on the issues
  // board, so this only ever re-renders the Pull Requests board.
  function handleStatusClick(status) {
    var next = prBoard.toggleStatus(status);
    var select = document.querySelector(
      'section[aria-label="Open pull requests"] .col-filter[data-col="status"]',
    );
    if (select) select.value = next;
    var section = document.querySelector(
      'section[aria-label="Open pull requests"]',
    );
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- board state + render ----
  // Each board (pull requests, issues) owns its own items, pagination,
  // and — for the one field with no equivalent on the other entity type —
  // its own extraState (status for pull requests, hideDependencyDashboard
  // for issues). Everything else it filters and groups by comes from the
  // shared state above.
  function createBoard(
    containerId,
    emptyId,
    noResultsId,
    isPR,
    onStatusClick,
    idPrefix,
    extraState,
  ) {
    var section = document.getElementById(containerId).closest('section.board');
    var state = {
      items: [],
      page: 1,
      pageSize: 25,
    };

    // Grouped by repo or by forge, alphabetically (forge by its display
    // label, not the raw "github"/"forgejo" value, since that's what a
    // screen reader announces), under a real heading (not a styled div)
    // so it's announced as structure, not decoration. Off by default —
    // this is a chosen mode, not a permanent change to how the flat list
    // already reads.
    function renderGrouped(container, items, groupBy) {
      var keyOf =
        groupBy === 'forge'
          ? (item) => FORGE_LABELS[item.forge] || item.forge
          : (item) => item.repo;

      var groups = {};
      var order = [];
      items.forEach((item) => {
        var key = keyOf(item);
        if (!groups[key]) {
          groups[key] = [];
          order.push(key);
        }
        groups[key].push(item);
      });
      order.sort();

      order.forEach((key) => {
        var heading = document.createElement('h3');
        heading.className = 'group-heading';
        heading.appendChild(document.createTextNode(key));
        heading.appendChild(
          el('span', 'group-count', String(groups[key].length)),
        );
        container.appendChild(heading);
        groups[key].forEach((item) => {
          container.appendChild(
            buildRow(
              item,
              isPR,
              onStatusClick,
              handleLabelClick,
              sharedState.shared.label,
            ),
          );
        });
      });
    }

    function setPage(page) {
      state.page = page;
      render();
    }

    function renderPagination(totalPages) {
      var wrap = document.getElementById(`${idPrefix}-pagination`);
      if (!wrap) return;

      var needed = totalPages > 1;
      wrap.hidden = !needed;
      if (!needed) return;

      var pages = document.getElementById(`${idPrefix}-pagination-pages`);
      pages.innerHTML = '';

      var prev = el('button', 'pagination-nav', 'Previous');
      prev.type = 'button';
      prev.disabled = state.page <= 1;
      prev.addEventListener('click', () => {
        setPage(state.page - 1);
      });
      pages.appendChild(prev);

      var p;
      var button;
      for (p = 1; p <= totalPages; p++) {
        button = el('button', 'pagination-page', String(p));
        button.type = 'button';
        if (p === state.page) {
          button.classList.add('active');
          button.setAttribute('aria-current', 'page');
        }
        button.addEventListener(
          'click',
          ((page) => () => {
            setPage(page);
          })(p),
        );
        pages.appendChild(button);
      }

      var next = el('button', 'pagination-nav', 'Next');
      next.type = 'button';
      next.disabled = state.page >= totalPages;
      next.addEventListener('click', () => {
        setPage(state.page + 1);
      });
      pages.appendChild(next);
    }

    function render() {
      var container = document.getElementById(containerId);
      var visible = state.items.filter((item) =>
        Filters.matchesFilters(item, isPR, sharedState.shared, extraState),
      );

      container.innerHTML = '';

      var groupBy = sharedState.shared.groupBy;
      var groupedPagination;
      var totalPages;
      var start;
      var pageItems;
      if (groupBy) {
        // Grouping and pagination stay mutually exclusive — paginating
        // grouped clusters coherently is a bigger problem than either
        // feature's own acceptance criteria asked for, so grouped mode
        // just renders the whole filtered set and the pager hides.
        renderGrouped(container, visible, groupBy);
        groupedPagination = document.getElementById(`${idPrefix}-pagination`);
        if (groupedPagination) groupedPagination.hidden = true;
      } else {
        totalPages = Math.max(1, Math.ceil(visible.length / state.pageSize));
        if (state.page > totalPages) state.page = totalPages;
        start = (state.page - 1) * state.pageSize;
        pageItems = visible.slice(start, start + state.pageSize);
        pageItems.forEach((item) => {
          container.appendChild(
            buildRow(
              item,
              isPR,
              onStatusClick,
              handleLabelClick,
              sharedState.shared.label,
            ),
          );
        });
        renderPagination(totalPages);
      }

      document.getElementById(emptyId).hidden = state.items.length !== 0;
      var noResults = document.getElementById(noResultsId);
      if (noResults)
        noResults.hidden = visible.length !== 0 || state.items.length === 0;

      var count = document.getElementById(`${idPrefix}-count`);
      if (count)
        count.textContent = shownCountText(visible.length, state.items.length);
      renderStatTile(
        STAT_TILE_IDS[idPrefix],
        visible.length,
        state.items.length,
      );
    }

    var pageSizeSelect = document.getElementById(`${idPrefix}-page-size`);
    if (pageSizeSelect) {
      pageSizeSelect.addEventListener('change', () => {
        state.pageSize = Number(pageSizeSelect.value) || 25;
        state.page = 1;
        render();
      });
    }

    // CI status has no equivalent on the issues board, so it's wired
    // locally here rather than through the shared bar — a change only
    // ever re-renders this one board.
    var statusSelect;
    if (isPR) {
      statusSelect = section
        ? section.querySelector('.col-filter[data-col="status"]')
        : null;
      if (statusSelect) {
        statusSelect.value = extraState.status || '';
        statusSelect.addEventListener('change', () => {
          extraState.status = statusSelect.value.trim().toLowerCase();
          state.page = 1;
          Filters.saveState(sharedState);
          render();
        });
      }
    }

    // Not a generic .col-filter: it's a checkbox (driven by .checked, not
    // .value) and its default is "on" rather than "no filter applied" —
    // both break the generic wiring the shared bar's own controls share.
    // Only the issues board's markup has this element at all, and it has
    // no equivalent on the pull requests board.
    var hideDependencyDashboardCheckbox = document.getElementById(
      `${idPrefix}-hide-dependency-dashboard`,
    );
    if (hideDependencyDashboardCheckbox) {
      hideDependencyDashboardCheckbox.checked =
        extraState.hideDependencyDashboard === '1';
      hideDependencyDashboardCheckbox.addEventListener('change', () => {
        extraState.hideDependencyDashboard =
          hideDependencyDashboardCheckbox.checked ? '1' : '';
        state.page = 1;
        Filters.saveState(sharedState);
        render();
      });
    }

    return {
      setItems: (items) => {
        state.items = items;
        state.page = 1;
        render();
      },
      render: render,
      resetPage: () => {
        state.page = 1;
      },
      toggleStatus: isPR
        ? (value) => {
            var next = extraState.status === value ? '' : value;
            extraState.status = next;
            state.page = 1;
            Filters.saveState(sharedState);
            render();
            return next;
          }
        : undefined,
    };
  }

  var prBoard = createBoard(
    'pr-rows',
    'pr-empty',
    'pr-no-results',
    true,
    handleStatusClick,
    'pr',
    sharedState.pr,
  );
  var issueBoard = createBoard(
    'issue-rows',
    'issue-empty',
    'issue-no-results',
    false,
    undefined,
    'issue',
    sharedState.issue,
  );

  var statFailingTile = document.getElementById('stat-failing-tile');
  if (statFailingTile)
    statFailingTile.addEventListener('click', () => {
      handleStatusClick('failure');
    });

  // The shared bar's own controls (forge, group-by, repo, title, author,
  // label, created, updated) apply to both boards at once — a single
  // wiring loop, not one per board.
  document.querySelectorAll('.filter-bar .col-filter').forEach((c) => {
    var apply = () => {
      var value = c.type === 'radio' ? c.value : c.value.trim().toLowerCase();
      sharedState.shared[c.dataset.col] = value;
      prBoard.resetPage();
      issueBoard.resetPage();
      // Repo/Author/Label options (and "Group by forge") are scoped to
      // the active forge, so a forge change has to re-narrow them right
      // away rather than waiting for the next poll's setItems (#112).
      if (c.dataset.col === 'forge') updateSharedFilterOptions();
      Filters.saveState(sharedState);
      renderBoth();
    };
    c.addEventListener('input', apply);
    c.addEventListener('change', apply);
  });

  var sharedGroupSelect = document.getElementById('shared-group-select');
  if (sharedGroupSelect) {
    sharedGroupSelect.addEventListener('change', () => {
      sharedState.shared.groupBy = sharedGroupSelect.value || '';
      prBoard.resetPage();
      issueBoard.resetPage();
      Filters.saveState(sharedState);
      renderBoth();
    });
  }

  // ---- forge health ----
  // One friendly, actionable line per ForgeErrorKind, taking precedence
  // over the raw error string as the primary visible text. "unreachable"
  // names the refresh button as the way to retry now, not just "wait."
  var ERROR_HEADLINES = {
    unreachable:
      'Temporarily unreachable — try the refresh button above, or it’ll retry automatically.',
    unauthorized: 'Check the token in Settings.',
    not_found: 'Check the instance URL in Settings.',
    rate_limited: 'Rate limit exceeded.',
  };

  function forgeErrorHeadline(f) {
    return (
      ERROR_HEADLINES[f.errorKind] ||
      `Something went wrong talking to ${FORGE_LABELS[f.forge] || f.forge}.`
    );
  }

  function renderForgeHealth(forges) {
    var container = document.getElementById('forge-health');
    container.innerHTML = '';
    forges.forEach((f) => {
      var item = el('div', 'forge-health-item');
      var chip = el('span', `forge-health${f.reachable ? '' : ' unreachable'}`);
      chip.appendChild(el('span', 'pulse-dot'));
      var label =
        (FORGE_LABELS[f.forge] || f.forge) +
        (f.reachable ? ' reachable' : ' unreachable');
      chip.appendChild(document.createTextNode(label));
      item.appendChild(chip);
      // The reason has to be real text, not just chip.title — a hover
      // tooltip never reaches a touch device and isn't reliably announced
      // by a screen reader either. The raw technical string stays available
      // in a native, keyboard-accessible <details> disclosure instead.
      var details;
      var summary;
      if (!f.reachable && f.error) {
        item.appendChild(
          el('span', 'forge-health-error', forgeErrorHeadline(f)),
        );
        details = document.createElement('details');
        details.className = 'forge-health-detail';
        summary = document.createElement('summary');
        summary.textContent = 'Show details';
        details.appendChild(summary);
        details.appendChild(document.createTextNode(f.error));
        item.appendChild(details);
      }
      container.appendChild(item);
    });
    document.getElementById('forge-names').innerHTML = forges
      .map(
        (f) =>
          '<span class="mono">' +
          (FORGE_LABELS[f.forge] || f.forge) +
          '</span>',
      )
      .join(' + ');
  }

  // ---- ticking "refreshed Xs ago" clock, independent of the poll interval ----
  function tickRefreshedAt() {
    var target = document.getElementById('refreshed-at');
    if (!lastGeneratedAt) return;
    target.textContent = relativeTime(lastGeneratedAt);
  }
  setInterval(tickRefreshedAt, 1000);

  function showError(message) {
    var existing = document.getElementById('error-banner');
    if (existing) existing.remove();
    var banner = el('div', 'error-banner', message);
    banner.id = 'error-banner';
    document
      .querySelector('.wrap')
      .insertBefore(banner, document.querySelector('.stats'));
  }

  function clearError() {
    var existing = document.getElementById('error-banner');
    if (existing) existing.remove();
  }

  // Session/admin-link/logout are nav.js's job now — shared by every
  // page's header, not just the dashboard's own.

  // ---- force-refresh: retry right now instead of waiting out the rest
  // of the background poll's own interval ----
  var FORCE_REFRESH_COOLDOWN_MS = 5000;
  var forceRefreshButton = document.getElementById('force-refresh-button');

  forceRefreshButton.addEventListener('click', () => {
    forceRefreshButton.disabled = true;
    forceRefreshButton.classList.add('is-refreshing');
    fetch('/api/dashboard/refresh', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          throw new Error('session expired');
        }
        if (!res.ok) throw new Error(`backend answered ${res.status}`);
        return res.json();
      })
      .then(applySnapshot)
      .catch((err) => {
        showError(`Could not refresh: ${err.message}`);
      })
      .finally(() => {
        forceRefreshButton.classList.remove('is-refreshing');
        // Cooldown starts once the response is already in hand, not from
        // the click — a user mashing the button gets one real refresh
        // and a short pause, not a queue of them landing back to back.
        setTimeout(() => {
          forceRefreshButton.disabled = false;
        }, FORCE_REFRESH_COOLDOWN_MS);
      });
  });

  // ---- switching to a dashboard someone else shared with you ----
  var currentOwner = '';
  var ownerSelect = document.getElementById('dashboard-owner-select');

  fetch('/api/sharing', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data?.sharedWithMe || data.sharedWithMe.length === 0) return;
      data.sharedWithMe.forEach((u) => {
        var option = document.createElement('option');
        option.value = u.username;
        option.textContent = `${u.displayName}’s dashboard`;
        ownerSelect.appendChild(option);
      });
      ownerSelect.hidden = false;
    })
    .catch(() => {
      /* a transient failure here isn't worth blocking the page over */
    });

  ownerSelect.addEventListener('change', () => {
    currentOwner = ownerSelect.value;
    // Force-refresh only ever hits the signed-in user's own dashboard
    // (POST /api/dashboard/refresh has no ?owner= support, same as the
    // SSE stream) — hidden rather than left clickable-but-wrong while
    // viewing someone else's shared one.
    forceRefreshButton.hidden = Boolean(currentOwner);
    refresh();
  });

  // ---- main fetch/render loop ----
  function applySnapshot(data) {
    clearError();
    lastGeneratedAt = data.generatedAt;
    tickRefreshedAt();

    renderForgeHealth(data.forges || []);

    var prs = data.pullRequests || [];
    var issues = data.issues || [];
    allPRs = prs;
    allIssues = issues;
    updateSharedFilterOptions();
    if (!sharedControlsRestored) {
      sharedControlsRestored = true;
      syncSharedControlsToState();
    }
    // Each board's own render() sets its stat tile's text too (the same
    // filtered-vs-total wording its own count already uses), so the tile
    // never disagrees with the board sitting right below it.
    prBoard.setItems(prs);
    issueBoard.setItems(issues);

    var failingCount = prs.filter((p) => p.ci === 'failure').length;
    document.getElementById('stat-failing').textContent = String(failingCount);
    // Red only once there's actually something failing — zero is good
    // news, not a tile that reads as an alarm nobody needs to act on —
    // and green, not just neutral, since zero failing is itself the
    // positive signal a CI status tile exists to show.
    statFailingTile.classList.toggle('critical', failingCount > 0);
    statFailingTile.classList.toggle('ok', failingCount === 0);
    document.getElementById('stat-repos').textContent = String(
      (data.forges || []).reduce((sum, f) => sum + (f.repoCount || 0), 0),
    );
  }

  function refresh() {
    var url =
      '/api/dashboard' +
      (currentOwner ? `?owner=${encodeURIComponent(currentOwner)}` : '');
    fetch(url, { headers: { Accept: 'application/json' } })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          throw new Error('session expired');
        }
        if (!res.ok) throw new Error(`backend answered ${res.status}`);
        return res.json();
      })
      .then(applySnapshot)
      .catch((err) => {
        showError(`Could not reach the backend: ${err.message}`);
      });
  }

  refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);

  // ---- live updates over Server-Sent Events, on top of the poll above ----
  // The poll keeps running unconditionally — this only ever makes the
  // dashboard update sooner than the next one, never a replacement for
  // it. A browser or proxy that can't hold this connection open just
  // never benefits from it: EventSource retries on its own, and if it
  // never connects at all the poll still keeps the data fresh.
  var eventSource;
  if (window.EventSource) {
    eventSource = new EventSource('/api/dashboard/stream');
    eventSource.onmessage = (event) => {
      // Only when looking at your own dashboard — a push here is always
      // this session's own aggregator, never the owner currently
      // selected in the sharing dropdown.
      if (currentOwner) return;
      try {
        applySnapshot(JSON.parse(event.data));
      } catch (_e) {
        /* a malformed event here isn't worth surfacing over the working poll */
      }
    };
  }
})();
