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

  // Theme toggle wiring lives in theme-toggle.js now, shared with every
  // other page instead of duplicated here -- see index.html's script tag.

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
    var updateBranchAction;
    var mergeAction;
    var dependabotAction;
    var renovateRebaseAction;

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
      updateBranchAction = updateBranchActionCell(item);
      if (updateBranchAction) statusCell.appendChild(updateBranchAction);
      mergeAction = mergeActionCell(item);
      if (mergeAction) statusCell.appendChild(mergeAction);
      dependabotAction = dependabotActionCell(item);
      if (dependabotAction) statusCell.appendChild(dependabotAction);
      renovateRebaseAction = renovateRebaseActionCell(item);
      if (renovateRebaseAction) statusCell.appendChild(renovateRebaseAction);
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

  // A stable, DOM-safe id derived from a PR's own key — used to find a
  // just-re-rendered action button again after prBoard.render() rebuilds
  // every row from scratch, so a click handler can move focus to it.
  function domSafeId(key) {
    return key.replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  // ---- bot-managed PR detection ----
  // release-please, Dependabot, and Renovate all keep their own pull
  // requests current on their own schedule — a manual Update branch click
  // is redundant at best and, for release-please specifically (which
  // regenerates the branch and changelog together on every push to the
  // base branch), a genuine risk of fighting its own next run. Detection
  // signals verified live against this account's own repos (Settings'
  // own field hint links the research); Renovate's author login is
  // best-effort, unconfirmed against a live Renovate PR in this account.

  // release-please labels every PR it manages with "autorelease: pending"
  // or "autorelease: tagged" — the author is a human in this account's
  // setup, not release-please itself, so the label is the only signal.
  function isReleasePleasePr(item) {
    return (item.labels || []).some((l) => l.name.startsWith('autorelease:'));
  }

  // Dependabot's author login is its GitHub App identity, "app/dependabot"
  // — not "dependabot[bot]", which is the older, now-secondary identity.
  function isDependabotPr(item) {
    return item.author === 'app/dependabot';
  }

  // Renovate's author login varies by how it's installed (a GitHub App vs.
  // a classic bot account) — checking both forms this account has seen
  // documented, rather than picking one and risking silent non-detection.
  function isRenovatePr(item) {
    return item.author === 'renovate[bot]' || item.author === 'app/renovate';
  }

  function isBotManagedPr(item) {
    return (
      isReleasePleasePr(item) || isDependabotPr(item) || isRenovatePr(item)
    );
  }

  // Strips the "github: <method> <path>: " / "forgejo: <method> <path>: "
  // diagnostic prefix restError/forgejoError wrap every message in —
  // useful in the full error banner, just noise in a locked-row reason
  // read right next to the button it's locking.
  function forgeMessageOnly(message) {
    var match = /^(?:github|forgejo): \S+ \S+: (.+)$/.exec(message || '');
    return match ? match[1] : message;
  }

  // Mirrors webhooks.js's reactiveLockReason, plus 409 — GitHub's merge
  // endpoint uses that one status for two different causes: a PR that's
  // genuinely no longer mergeable, and a merge method the repo doesn't
  // allow (#349, collapsed into the same status by forgeErrorKindFromStatus
  // — see its own comment). The forge's own message, already reaching the
  // client (see the error banner this same catch block also shows), is
  // what decides which reason to show, rather than a second,
  // independently-authored guess keyed only on the status code. The
  // genuine case keeps its existing wording; anything else surfaces the
  // forge's own message.
  function reactiveMergeLockReason(status, message) {
    var real;
    if (status === 403)
      return 'Missing permission — check your token in Settings.';
    if (status === 429)
      return 'Rate limit exceeded — try again once it resets.';
    if (status === 409) {
      real = forgeMessageOnly(message);
      if (!real || /not mergeable/i.test(real)) {
        return 'No longer mergeable — refresh to see the current state.';
      }
      return real;
    }
    return null;
  }

  var actionLockReasonCounter = 0;

  // Same aria-disabled + visible, wired-up reason shape webhooks.js's own
  // lockedButton uses, not a native disabled attribute or a title-only
  // tooltip — native disabled would drop it from the tab order and hide
  // the reason from keyboard and screen-reader users. Shared by every
  // row action that can lock for good (merge, update branch, Dependabot,
  // Renovate), not just one of them.
  //
  // onRetry, when given, makes this a real clickable "Retry" instead of
  // a dead end — merge/update-branch's own lock reasons used to say
  // "refresh" with nothing on the button that actually did that. Left
  // undefined for the actions that don't pass it (Dependabot/Renovate),
  // which keep today's plain disabled-button behavior.
  function lockedActionButton(label, reasonText, onRetry) {
    var wrap = el('span', 'row-action-locked');
    var button = el('button', 'row-action', onRetry ? 'Retry' : label);
    button.type = 'button';
    var reasonId = `action-locked-reason-${actionLockReasonCounter++}`;
    button.setAttribute('aria-describedby', reasonId);
    if (onRetry) {
      button.addEventListener('click', onRetry);
    } else {
      button.setAttribute('aria-disabled', 'true');
    }
    wrap.appendChild(button);
    var reason = el('span', 'row-action-reason', reasonText);
    reason.id = reasonId;
    wrap.appendChild(reason);
    return wrap;
  }

  // Clears every "locked for good" entry in a merge/update-branch state
  // map — called on every fresh snapshot (applySnapshot), so a lock only
  // ever reflects the most recent data instead of latching until a full
  // page reload. Leaves in-flight phases ('confirming', 'merging',
  // 'updating') alone; those track a request actually in progress, not a
  // stale conclusion from a previous one.
  function clearStaleLocks(stateMap) {
    Object.keys(stateMap).forEach((key) => {
      if (stateMap[key].phase === 'locked') delete stateMap[key];
    });
  }

  // The "Retry" click every locked merge/update-branch button now has —
  // re-fetches the dashboard for real (not from a cache) so the lock
  // re-derives from current data immediately (clearStaleLocks, inside
  // applySnapshot) instead of waiting out the rest of the poll interval.
  function retryLockedAction(item) {
    showStatus(`Checking ${item.repo}#${item.number}…`);
    refreshDashboardNow()
      .then(() => {
        clearStatus();
      })
      .catch((err) => {
        showError(`Could not refresh: ${err.message}`);
      });
  }

  // Set once any merge/update-branch call against a forge comes back 403
  // — a token's write permission is an account-wide property, not a
  // per-PR one, so a permission failure on one PR means every other PR
  // on that same forge is doomed the same way, not just the one that
  // happened to be tried first. Persists for the session, the same
  // lifetime mergeState/updateBranchState's own per-PR locks have —
  // cleared only by a full page reload, never automatically, since nothing
  // here re-checks whether the token changed.
  var forgePermissionDenied = {};

  // Known-doomed before ever calling the API, the same pre-click check
  // addWebhookButton (webhooks.js) already does from ForgeHealth — a
  // forge that's currently unreachable or already out of rate-limit
  // budget will fail the exact same way after a real, wasted request as
  // it would before one.
  function proactiveActionLockReason(forgeName) {
    var health = lastForges.find((f) => f.forge === forgeName);
    var resetTime;
    if (health && health.reachable === false) {
      return `${FORGE_LABELS[forgeName] || forgeName} is currently unreachable.`;
    }
    if (health && health.rateLimit && health.rateLimit.remaining === 0) {
      resetTime = new Date(health.rateLimit.resetsAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      return `Rate limit exhausted · resets ${resetTime}`;
    }
    if (forgePermissionDenied[forgeName]) {
      return 'Missing permission — check your token in Settings.';
    }
    return null;
  }

  // Actually calls the merge endpoint, once the confirm click lands —
  // mergeActionCell's own click handler only ever flips into "confirming",
  // so a single accidental click can never merge anything.
  function doMerge(item, confirmButton) {
    var key = prKey(item);
    mergeState[key] = { phase: 'merging' };
    confirmButton.disabled = true;
    confirmButton.textContent = 'Merging…';
    showStatus(`Merging ${item.repo}#${item.number}…`);

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
        showStatus(`Merged ${item.repo}#${item.number}.`);
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
        var lockReason = reactiveMergeLockReason(err.status, err.message);
        mergeState[key] = lockReason
          ? { phase: 'locked', reason: lockReason }
          : { phase: 'idle' };
        if (err.status === 403) forgePermissionDenied[item.forge] = true;
        clearStatus();
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
    var proactiveReason;

    if (entry.phase === 'locked')
      return lockedActionButton('Merge', entry.reason, () =>
        retryLockedAction(item),
      );

    // Only checked from idle — once a confirm/merge is already in
    // flight, let it finish and report its own real outcome rather than
    // yanking the button out from under a click that's already landed.
    if (entry.phase === 'idle') {
      proactiveReason = proactiveActionLockReason(item.forge);
      if (proactiveReason)
        return lockedActionButton('Merge', proactiveReason, () =>
          retryLockedAction(item),
        );
    }

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
      confirmButton.id = `merge-confirm-${domSafeId(key)}`;
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
      // Moves focus to the confirm button that render() just built —
      // the browser's own scroll-into-view + focus ring is what actually
      // makes this state change noticeable, not just relying on someone
      // watching the exact pixels the button occupies. Real bug this
      // guards against: a click on "Merge" reading as doing nothing at
      // all, confirmed live.
      var justConfirmed = document.getElementById(
        `merge-confirm-${domSafeId(key)}`,
      );
      if (justConfirmed) justConfirmed.focus();
    });
    wrap.appendChild(mergeButton);
    return wrap;
  }

  // ---- pull request update-branch action ----
  // Its own state map, parallel to mergeState — a Forgejo pull request can
  // be mergeable and behind at once (see dashboard.PullRequest.Behind's
  // own doc comment), so both actions can legitimately show on the same
  // row at the same time and need independent lock/in-flight state rather
  // than sharing one.
  var updateBranchState = {};

  // Mirrors reactiveMergeLockReason's 403/429 handling exactly; 409 reads
  // differently here since the forge is reporting the two branches can't
  // be merged cleanly, not that the pull request itself stopped being
  // mergeable.
  function reactiveUpdateBranchLockReason(status) {
    if (status === 403)
      return 'Missing permission — check your token in Settings.';
    if (status === 429)
      return 'Rate limit exceeded — try again once it resets.';
    if (status === 409)
      return "Can't update cleanly — resolve the conflict on the forge.";
    return null;
  }

  // No confirm step, unlike doMerge — bringing a branch up to date is
  // routine and reversible in a way completing the pull request isn't, so
  // a single click matches the webhook button's own one-click pattern
  // instead of the merge button's two-step one.
  function doUpdateBranch(item, button) {
    var key = prKey(item);
    updateBranchState[key] = { phase: 'updating' };
    button.disabled = true;
    button.textContent = 'Updating…';
    showStatus(`Updating the branch for ${item.repo}#${item.number}…`);

    fetch('/api/pull-requests/update-branch', {
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
        // 202: the forge scheduled the update as a background job rather
        // than finishing it inline (GitHub) — not a failure, same as 204.
        if (res.status === 204 || res.status === 202) return null;
        return res.json().then((body) => {
          var err = new Error(body?.error || `backend answered ${res.status}`);
          err.status = res.status;
          throw err;
        });
      })
      .then(() => {
        delete updateBranchState[key];
        showStatus(`Updated the branch for ${item.repo}#${item.number}.`);
        // Same immediate-refresh pattern doMerge uses, for the same
        // reason: reflect the real state as soon as the forge has it,
        // not up to 30 seconds later.
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
        var lockReason = reactiveUpdateBranchLockReason(err.status);
        updateBranchState[key] = lockReason
          ? { phase: 'locked', reason: lockReason }
          : { phase: 'idle' };
        if (err.status === 403) forgePermissionDenied[item.forge] = true;
        clearStatus();
        showError(
          `Couldn't update the branch for ${item.repo}#${item.number}: ${err.message}`,
        );
        prBoard.render();
      });
  }

  // Only rendered when the forge reports this pull request as behind its
  // base — independent of mergeStatus, so it can show alongside the merge
  // button rather than instead of it.
  function updateBranchActionCell(item) {
    if (!item.behind) return null;
    if (isBotManagedPr(item) && !allowBotPrUpdates) return null;

    var key = prKey(item);
    var entry = updateBranchState[key] || { phase: 'idle' };
    var proactiveReason;

    if (entry.phase === 'locked')
      return lockedActionButton('Update branch', entry.reason, () =>
        retryLockedAction(item),
      );

    if (entry.phase === 'idle') {
      proactiveReason = proactiveActionLockReason(item.forge);
      if (proactiveReason)
        return lockedActionButton('Update branch', proactiveReason, () =>
          retryLockedAction(item),
        );
    }

    var updating = entry.phase === 'updating';
    var button = el(
      'button',
      'row-action',
      updating ? 'Updating…' : 'Update branch',
    );
    button.type = 'button';
    button.disabled = updating;
    button.addEventListener('click', () => {
      doUpdateBranch(item, button);
    });
    return button;
  }

  // ---- Dependabot rebase/recreate actions ----
  // Keyed by `${prKey}:${action}`, not just prKey — Rebase and Recreate are
  // independent actions on the same PR, each with its own in-flight/locked
  // state, so one locking (say, a 409 mid-recreate) can't hide the other
  // still being clickable.
  var dependabotActionState = {};

  // Mirrors reactiveUpdateBranchLockReason's 403/429 handling; 409 reads as
  // Dependabot's own comment command not applying right now (already
  // rebasing, or the PR's in a state it won't act on) rather than a merge
  // conflict.
  function reactiveDependabotActionLockReason(status) {
    if (status === 403)
      return 'Missing permission — check your token in Settings.';
    if (status === 429)
      return 'Rate limit exceeded — try again once it resets.';
    if (status === 409)
      return "Dependabot can't act on this pull request right now.";
    return null;
  }

  var DEPENDABOT_ACTION_LABELS = {
    rebase: 'Dependabot: Rebase',
    recreate: 'Dependabot: Recreate',
  };
  var DEPENDABOT_ACTION_PROGRESS_LABELS = {
    rebase: 'Requesting rebase…',
    recreate: 'Requesting recreate…',
  };

  // No confirm step — same reasoning as doUpdateBranch: this only asks
  // Dependabot to redo its own routine, reversible work, not a merge.
  function doDependabotAction(item, action, button) {
    var key = `${prKey(item)}:${action}`;
    dependabotActionState[key] = { phase: 'requesting' };
    button.disabled = true;
    button.textContent = DEPENDABOT_ACTION_PROGRESS_LABELS[action];
    showStatus(`Asking Dependabot to ${action} ${item.repo}#${item.number}…`);

    fetch('/api/pull-requests/dependabot-action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        forge: item.forge,
        fullName: item.repo,
        number: item.number,
        action: action,
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
        delete dependabotActionState[key];
        showStatus(
          `Asked Dependabot to ${action} ${item.repo}#${item.number}.`,
        );
        // No immediate /api/dashboard/refresh, unlike doMerge/
        // doUpdateBranch: posting the comment doesn't change anything
        // about this pull request itself — Dependabot's own rebase/
        // recreate run is what would, and that happens on its own
        // schedule, outside this request.
        prBoard.render();
      })
      .catch((err) => {
        var lockReason = reactiveDependabotActionLockReason(err.status);
        dependabotActionState[key] = lockReason
          ? { phase: 'locked', reason: lockReason }
          : { phase: 'idle' };
        if (err.status === 403) forgePermissionDenied[item.forge] = true;
        clearStatus();
        showError(
          `Couldn't ask Dependabot to ${action} ${item.repo}#${item.number}: ${err.message}`,
        );
        prBoard.render();
      });
  }

  function dependabotActionButton(item, action) {
    var key = `${prKey(item)}:${action}`;
    var entry = dependabotActionState[key] || { phase: 'idle' };
    var proactiveReason;

    if (entry.phase === 'locked')
      return lockedActionButton(DEPENDABOT_ACTION_LABELS[action], entry.reason);

    if (entry.phase === 'idle') {
      proactiveReason = proactiveActionLockReason(item.forge);
      if (proactiveReason)
        return lockedActionButton(
          DEPENDABOT_ACTION_LABELS[action],
          proactiveReason,
        );
    }

    var requesting = entry.phase === 'requesting';
    var button = el(
      'button',
      'row-action',
      requesting
        ? DEPENDABOT_ACTION_PROGRESS_LABELS[action]
        : DEPENDABOT_ACTION_LABELS[action],
    );
    button.type = 'button';
    button.disabled = requesting;
    button.addEventListener('click', () => {
      doDependabotAction(item, action, button);
    });
    return button;
  }

  // GitHub only — Dependabot doesn't run on Forgejo, so there's no
  // equivalent comment command to send there.
  function dependabotActionCell(item) {
    if (item.forge !== 'github' || !isDependabotPr(item)) return null;

    var wrap = el('span', 'row-action-group');
    wrap.appendChild(dependabotActionButton(item, 'rebase'));
    wrap.appendChild(dependabotActionButton(item, 'recreate'));
    return wrap;
  }

  // ---- Renovate rebase action ----
  // Unlike Dependabot, Renovate runs on both forges and has only the one
  // trigger (no separate "recreate") — the server resolves which label to
  // add from the signed-in user's own saved setting
  // (RenovateRebaseLabelOrDefault), so the request here carries no action
  // field the way the Dependabot one does.
  var renovateRebaseState = {};

  // Same 403/429 handling as reactiveDependabotActionLockReason; 404 reads
  // as the configured label not existing on this repo (Forgejo requires
  // the label to already exist — see forgejo.Client.AddLabel) rather than
  // the pull request itself being missing.
  function reactiveRenovateRebaseLockReason(status) {
    if (status === 403)
      return 'Missing permission — check your token in Settings.';
    if (status === 429)
      return 'Rate limit exceeded — try again once it resets.';
    if (status === 404) return "Rebase label doesn't exist on this repo.";
    return null;
  }

  function doRenovateRebase(item, button) {
    var key = prKey(item);
    renovateRebaseState[key] = { phase: 'requesting' };
    button.disabled = true;
    button.textContent = 'Requesting rebase…';
    showStatus(`Asking Renovate to rebase ${item.repo}#${item.number}…`);

    fetch('/api/pull-requests/renovate-rebase', {
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
        delete renovateRebaseState[key];
        showStatus(`Asked Renovate to rebase ${item.repo}#${item.number}.`);
        prBoard.render();
      })
      .catch((err) => {
        var lockReason = reactiveRenovateRebaseLockReason(err.status);
        renovateRebaseState[key] = lockReason
          ? { phase: 'locked', reason: lockReason }
          : { phase: 'idle' };
        if (err.status === 403) forgePermissionDenied[item.forge] = true;
        clearStatus();
        showError(
          `Couldn't ask Renovate to rebase ${item.repo}#${item.number}: ${err.message}`,
        );
        prBoard.render();
      });
  }

  function renovateRebaseActionCell(item) {
    if (!isRenovatePr(item)) return null;

    var key = prKey(item);
    var entry = renovateRebaseState[key] || { phase: 'idle' };
    var proactiveReason;

    if (entry.phase === 'locked')
      return lockedActionButton('Renovate: Rebase', entry.reason);

    if (entry.phase === 'idle') {
      proactiveReason = proactiveActionLockReason(item.forge);
      if (proactiveReason)
        return lockedActionButton('Renovate: Rebase', proactiveReason);
    }

    var requesting = entry.phase === 'requesting';
    var button = el(
      'button',
      'row-action',
      requesting ? 'Requesting rebase…' : 'Renovate: Rebase',
    );
    button.type = 'button';
    button.disabled = requesting;
    button.addEventListener('click', () => {
      doRenovateRebase(item, button);
    });
    return button;
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
  // The latest snapshot's own forges array — mergeActionCell/
  // updateBranchActionCell read this to pre-emptively lock a row's
  // action button when its forge is unreachable or its rate-limit
  // budget is already exhausted, the same "known-doomed before the
  // click" check addWebhookButton already does from ForgeHealth.
  var lastForges = [];
  var sharedControlsRestored = false;
  // Fetched once at startup below — updateBranchActionCell reads this to
  // decide whether a bot-managed PR's row gets the button at all.
  var allowBotPrUpdates = false;

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
    // role="alert" carries an implicit aria-live="assertive" — this was
    // never actually wired up to announce to a screen reader before,
    // despite being the one place a failed write to a forge surfaces.
    banner.setAttribute('role', 'alert');
    document
      .querySelector('.wrap')
      .insertBefore(banner, document.querySelector('.stats'));
  }

  function clearError() {
    var existing = document.getElementById('error-banner');
    if (existing) existing.remove();
  }

  // showStatus/clearStatus: the same shape as showError/clearError, for a
  // row action's own in-progress/success text rather than a failure — a
  // real click otherwise had nothing to show for it beyond the row
  // silently vanishing on the next refresh (or not, if the click did
  // nothing at all, indistinguishable from a genuine bug from here).
  // aria-live="polite" rather than showError's role="alert": routine
  // progress/success isn't urgent enough to interrupt a screen reader the
  // way a failure is.
  function showStatus(message) {
    var existing = document.getElementById('status-banner');
    if (existing) existing.remove();
    var banner = el('div', 'status-banner', message);
    banner.id = 'status-banner';
    banner.setAttribute('aria-live', 'polite');
    document
      .querySelector('.wrap')
      .insertBefore(banner, document.querySelector('.stats'));
    // Auto-dismisses — unlike the error banner, which stays until the
    // next successful action clears it, a routine "Merged x#42." isn't
    // meant to linger.
    setTimeout(() => {
      if (banner.parentNode) banner.remove();
    }, 4000);
  }

  function clearStatus() {
    var existing = document.getElementById('status-banner');
    if (existing) existing.remove();
  }

  // Session/admin-link/logout are nav.js's job now — shared by every
  // page's header, not just the dashboard's own.

  // ---- force-refresh: retry right now instead of waiting out the rest
  // of the background poll's own interval ----
  var FORCE_REFRESH_COOLDOWN_MS = 5000;
  var forceRefreshButton = document.getElementById('force-refresh-button');

  // Shared by this button and every locked merge/update-branch row's own
  // "Retry" — a locked reason (permission, rate limit, not-mergeable, a
  // disallowed merge method) can only be known to have cleared by asking
  // the forge again right now, not by staring at data already on screen.
  // POSTs, not the plain GET refresh() polls with — this forces a real
  // re-fetch from the forge instead of possibly answering from a cache.
  function refreshDashboardNow() {
    return fetch('/api/dashboard/refresh', {
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
      .then(applySnapshot);
  }

  forceRefreshButton.addEventListener('click', () => {
    forceRefreshButton.disabled = true;
    forceRefreshButton.classList.add('is-refreshing');
    refreshDashboardNow()
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

  // ---- bot-managed PR update setting, fetched once at startup ----
  // /api/settings/bot-pr-updates, not /api/settings itself — that GET
  // also provisions webhook credentials on first call
  // (EnsureWebhookCredentials), which the dashboard silently triggering
  // on behalf of a user who's never opened Settings would be a real,
  // surprising side effect (confirmed live: it flips
  // GET /api/dashboard/stream from 404 to 200 for that user).
  //
  // The first refresh() call below waits on this (settingsLoaded.then
  // (refresh)) rather than firing independently and re-rendering a
  // second time on its own resolve — both requests still go out
  // concurrently, so this doesn't add a real sequential round trip, and
  // it means there's exactly one render trigger for the first paint
  // instead of two independent promise chains racing to call render().
  var settingsLoaded = fetch('/api/settings/bot-pr-updates', {
    headers: { Accept: 'application/json' },
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data) allowBotPrUpdates = !!data.allowBotPrUpdates;
    })
    .catch(() => {
      // A transient failure here just leaves bot-managed PRs suppressed
      // (the safer default) rather than blocking the page over it.
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
    lastForges = data.forges || [];

    // A locked merge/update-branch reason only reflects what the forge
    // said at the moment of the last attempt — re-derived here from this
    // fresh snapshot instead of latching indefinitely (the bug: only a
    // full page reload used to clear it, even after "Refresh now"). A
    // lock whose root cause is still real reappears right away on the
    // next render — proactiveActionLockReason already re-checks
    // lastForges/forgePermissionDenied fresh every time from the values
    // just updated above — while one that's resolved (the PR is
    // mergeable again, a merge method got allowed, the rate limit reset)
    // simply doesn't.
    clearStaleLocks(mergeState);
    clearStaleLocks(updateBranchState);

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

  settingsLoaded.then(refresh);
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
